import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type ServerCommandStatus,
	serverCommands,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { Client } from "ssh2";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsyncRemote } from "../utils/process/execAsync";
import { hasPermission, type PermissionCtx } from "./permission";
import { findServerById, getAccessibleServerIds } from "./server";

const MAX_LOG_BYTES = 50 * 1024 * 1024;
const RETENTION_DAYS = 30;
const FINISHED_STATUSES: ServerCommandStatus[] = [
	"success",
	"error",
	"cancelled",
];

type StopReason = { status: ServerCommandStatus; message: string };

type RunningCommand = { stop: (reason: StopReason) => void };

// Commands run inside this process, so whether one is still producing output
// is known here rather than from the database row. It lives on globalThis
// because Next bundles its own copy of this module for each API route.
const globalForCommands = globalThis as unknown as {
	__dokployServerCommands?: Map<string, RunningCommand>;
};
globalForCommands.__dokployServerCommands ??= new Map();
const runningCommands = globalForCommands.__dokployServerCommands;

const logsDirectory = () => path.join(paths().LOGS_PATH, "server-commands");

const pidFile = (serverCommandId: string) =>
	`/tmp/dokploy-server-command-${serverCommandId}.pid`;

// The user's login shell may not be POSIX (e.g. fish), so the wrapper itself
// is base64-encoded and handed to sh. The command runs in its own session so
// cancelling can signal its whole process group, and with stdin closed so a
// command that prompts fails instead of hanging until the timeout.
const wrapCommand = (serverCommandId: string, command: string) => {
	const script = [
		`pidfile=${pidFile(serverCommandId)}`,
		`cmd=$(printf %s ${encodeBase64(command)} | base64 -d)`,
		'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$cmd" </dev/null & else sh -c "$cmd" </dev/null & fi',
		"child=$!",
		'echo "$child" > "$pidfile"',
		'wait "$child"',
		"code=$?",
		'rm -f "$pidfile"',
		'exit "$code"',
	].join("\n");
	return `sh -c "$(printf %s ${encodeBase64(script)} | base64 -d)"`;
};

const killCommand = (serverCommandId: string) =>
	[
		`pidfile=${pidFile(serverCommandId)}`,
		'[ -f "$pidfile" ] || exit 0',
		'pid=$(cat "$pidfile")',
		// dash and busybox reject "--", so the group is addressed as -PID right after the signal.
		'kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
		'for _ in 1 2 3 4 5; do sleep 1; kill -0 "-$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null || exit 0; done',
		'kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null',
		'rm -f "$pidfile"',
	].join("\n");

const killRemoteCommand = (serverId: string, serverCommandId: string) =>
	execAsyncRemote(
		serverId,
		`sh -c "$(printf %s ${encodeBase64(killCommand(serverCommandId))} | base64 -d)"`,
	).catch((error) =>
		console.error(
			`Failed to stop server command ${serverCommandId} on ${serverId}`,
			error,
		),
	);

/** Throws unless the caller may run commands on the server (the same rule as its SSH terminal). */
export const assertServerCommandAccess = async (
	ctx: PermissionCtx,
	serverId: string,
) => {
	const target = await findServerById(serverId);
	const accessible = await getAccessibleServerIds({
		userId: ctx.user.id,
		activeOrganizationId: ctx.session.activeOrganizationId,
	});
	if (
		target.organizationId !== ctx.session.activeOrganizationId ||
		!accessible.has(serverId) ||
		!(await hasPermission(ctx, { server: ["terminal"] }))
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to run commands on this server",
		});
	}
	return target;
};

export const findServerCommandById = async (serverCommandId: string) => {
	const command = await db.query.serverCommands.findFirst({
		where: eq(serverCommands.serverCommandId, serverCommandId),
	});
	if (!command) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Server command not found",
		});
	}
	return command;
};

export const findServerCommandsByServerId = (serverId: string, limit: number) =>
	db.query.serverCommands.findMany({
		where: eq(serverCommands.serverId, serverId),
		orderBy: desc(serverCommands.createdAt),
		limit,
	});

export const isServerCommandRunning = (serverCommandId: string) =>
	runningCommands.has(serverCommandId);

const appendCapped = (log: WriteStream) => {
	let written = 0;
	let truncated = false;
	return (chunk: Buffer) => {
		if (truncated) return;
		if (written + chunk.length > MAX_LOG_BYTES) {
			truncated = true;
			log.write(
				`\n[dokploy] Output exceeded ${MAX_LOG_BYTES / 1024 / 1024} MB; the rest was discarded. The command is still running.\n`,
			);
			return;
		}
		written += chunk.length;
		log.write(chunk);
	};
};

export const runServerCommand = async (input: {
	serverId: string;
	organizationId: string;
	userId: string;
	command: string;
	timeoutSeconds: number;
}) => {
	const target = await findServerById(input.serverId);
	if (!target.sshKeyId || !target.sshKey) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This server has no SSH key configured",
		});
	}

	await mkdir(logsDirectory(), { recursive: true });
	const [record] = await db
		.insert(serverCommands)
		.values({
			serverId: input.serverId,
			organizationId: input.organizationId,
			userId: input.userId,
			command: input.command,
			timeoutSeconds: input.timeoutSeconds,
			logPath: "",
		})
		.returning();
	if (!record) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to create server command",
		});
	}
	const { serverCommandId } = record;
	const logPath = path.join(logsDirectory(), `${serverCommandId}.log`);
	await db
		.update(serverCommands)
		.set({ logPath })
		.where(eq(serverCommands.serverCommandId, serverCommandId));

	const log = createWriteStream(logPath, { flags: "a" });
	const append = appendCapped(log);
	const conn = new Client();
	let stopReason: StopReason | undefined;
	let remoteStarted = false;
	let finished = false;

	const finish = async (exitCode: number | null, failure?: string) => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		conn.end();
		if (failure) log.write(`\n[dokploy] ${failure}\n`);
		await new Promise<void>((resolve) => log.end(resolve));

		// A dropped connection leaves the command running remotely with nobody reading its output.
		if (remoteStarted && exitCode === null && !stopReason) {
			void killRemoteCommand(input.serverId, serverCommandId);
		}

		const status: ServerCommandStatus =
			stopReason?.status ?? (exitCode === 0 && !failure ? "success" : "error");
		try {
			await db
				.update(serverCommands)
				.set({
					status,
					exitCode,
					errorMessage: stopReason?.message ?? failure ?? null,
					finishedAt: new Date().toISOString(),
				})
				.where(eq(serverCommands.serverCommandId, serverCommandId));
		} finally {
			runningCommands.delete(serverCommandId);
		}
	};

	const stop = (reason: StopReason) => {
		if (finished || stopReason) return;
		stopReason = reason;
		log.write(`\n[dokploy] ${reason.message}\n`);
		if (remoteStarted) {
			void killRemoteCommand(input.serverId, serverCommandId);
			// If the kill can't reach the server, stop waiting for an exit code that may never come.
			setTimeout(() => void finish(null), 30_000).unref();
		} else {
			void finish(null);
		}
	};

	const timer = setTimeout(
		() =>
			stop({
				status: "error",
				message: `Timed out after ${input.timeoutSeconds} seconds.`,
			}),
		input.timeoutSeconds * 1000,
	);
	runningCommands.set(serverCommandId, { stop });

	conn
		.once("ready", () => {
			if (stopReason) {
				void finish(null);
				return;
			}
			conn.exec(wrapCommand(serverCommandId, input.command), (err, stream) => {
				if (err) {
					void finish(null, `Failed to start command: ${err.message}`);
					return;
				}
				remoteStarted = true;
				stream
					.on("close", (code: number | null | undefined) => {
						void finish(
							typeof code === "number" ? code : null,
							typeof code === "number"
								? undefined
								: "The SSH session closed before the command reported an exit code.",
						);
					})
					.on("data", (data: Buffer) => append(data));
				stream.stderr.on("data", (data: Buffer) => append(data));
			});
		})
		.on("error", (err) => {
			void finish(null, `SSH connection error: ${err.message}`);
		})
		.connect({
			host: target.ipAddress,
			port: target.port,
			username: target.username,
			privateKey: target.sshKey.privateKey,
			readyTimeout: 30_000,
			keepaliveInterval: 30_000,
		});

	return { ...record, logPath };
};

export const cancelServerCommand = async (serverCommandId: string) => {
	const running = runningCommands.get(serverCommandId);
	if (running) {
		running.stop({ status: "cancelled", message: "Cancelled." });
		return;
	}
	const command = await findServerCommandById(serverCommandId);
	if (command.status !== "running") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This command has already finished",
		});
	}
	// A running row with no process here was orphaned by a restart before init reconciled it.
	await db
		.update(serverCommands)
		.set({
			status: "cancelled",
			errorMessage: "Cancelled.",
			finishedAt: new Date().toISOString(),
		})
		.where(eq(serverCommands.serverCommandId, serverCommandId));
	void killRemoteCommand(command.serverId, serverCommandId);
};

export const removeServerCommand = async (serverCommandId: string) => {
	if (runningCommands.has(serverCommandId)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Cancel the command before removing it",
		});
	}
	const [removed] = await db
		.delete(serverCommands)
		.where(eq(serverCommands.serverCommandId, serverCommandId))
		.returning();
	if (removed?.logPath) await rm(removed.logPath, { force: true });
	return removed;
};

// Returns the byte length of `buffer` without a trailing, incomplete UTF-8
// sequence, so a chunk never ends half-way through a character.
const completeUtf8Length = (buffer: Buffer) => {
	for (let i = buffer.length - 1; i >= 0 && i >= buffer.length - 4; i--) {
		const byte = buffer[i]!;
		if ((byte & 0xc0) === 0x80) continue;
		const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return buffer.length - i >= needed ? buffer.length : i;
	}
	return buffer.length;
};

/**
 * Reads up to `limit` bytes of a command's output starting at byte `offset`.
 * Pass the returned `nextOffset` back to continue where this read stopped.
 */
export const readServerCommandLog = async (
	logPath: string,
	offset: number,
	limit: number,
	{ allowPartial = false } = {},
) => {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(logPath, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { data: "", nextOffset: offset, size: 0 };
		}
		throw error;
	}
	try {
		const { size } = await file.stat();
		const length = Math.max(0, Math.min(limit, size - offset));
		if (length === 0) return { data: "", nextOffset: offset, size };
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await file.read(buffer, 0, length, offset);
		const read = buffer.subarray(0, bytesRead);
		const usable = allowPartial ? read.length : completeUtf8Length(read);
		return {
			data: read.subarray(0, usable).toString("utf8"),
			nextOffset: offset + usable,
			size,
		};
	} finally {
		await file.close();
	}
};

const cleanupOldServerCommands = async () => {
	const cutoff = new Date(
		Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();
	const removed = await db
		.delete(serverCommands)
		.where(
			and(
				lt(serverCommands.createdAt, cutoff),
				inArray(serverCommands.status, FINISHED_STATUSES),
			),
		)
		.returning({ logPath: serverCommands.logPath });
	for (const { logPath } of removed) {
		if (logPath) await rm(logPath, { force: true });
	}
};

export const initServerCommands = async () => {
	scheduleJob(
		"dokploy-server-command-cleanup",
		{ rule: "30 3 * * *", tz: "Etc/UTC" },
		() => {
			cleanupOldServerCommands().catch((error) =>
				console.error("Failed to clean up old server commands", error),
			);
		},
	);
	const interrupted = await db
		.update(serverCommands)
		.set({
			status: "error",
			errorMessage: "Dokploy restarted while this command was running.",
			finishedAt: new Date().toISOString(),
		})
		.where(eq(serverCommands.status, "running"))
		.returning({
			serverCommandId: serverCommands.serverCommandId,
			serverId: serverCommands.serverId,
		});
	for (const command of interrupted) {
		void killRemoteCommand(command.serverId, command.serverCommandId);
	}
};
