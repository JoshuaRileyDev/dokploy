import {
	assertServerCommandAccess,
	findServerCommandById,
	isServerCommandRunning,
	readServerCommandLog,
	validateRequest,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import type { NextApiRequest, NextApiResponse } from "next";

const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;
const CHUNK_BYTES = 64 * 1024;

export const config = { api: { bodyParser: false, responseLimit: false } };

const parseOffset = (value: unknown) => {
	const offset = Number(value);
	return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
};

/**
 * Server-sent events with a command's output, from the start or from
 * `?offset=` / `Last-Event-ID` (a byte offset). Each `log` event's data is a
 * JSON string of output and its id is the offset to resume from; a final `end`
 * event carries the status and exit code before the stream closes.
 */
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).json({ message: "Method not allowed" });
	}

	const { user, session } = await validateRequest(req);
	if (!user || !session?.activeOrganizationId) {
		return res.status(401).json({ message: "Unauthorized" });
	}

	const serverCommandId = String(req.query.serverCommandId);
	let logPath: string;
	try {
		const command = await findServerCommandById(serverCommandId);
		logPath = command.logPath;
		await assertServerCommandAccess(
			{
				user: { id: user.id },
				session: { activeOrganizationId: session.activeOrganizationId },
			},
			command.serverId,
		);
	} catch (error) {
		if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
			return res.status(403).json({ message: error.message });
		}
		return res.status(404).json({ message: "Server command not found" });
	}

	let offset = parseOffset(req.headers["last-event-id"] ?? req.query.offset);
	let closed = false;
	req.on("close", () => {
		closed = true;
	});

	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		// no-transform keeps Next's compression from buffering the stream.
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders();

	const heartbeat = setInterval(() => {
		if (!closed) res.write(": ping\n\n");
	}, HEARTBEAT_INTERVAL_MS);

	const sendAvailable = async (finished: boolean) => {
		while (!closed) {
			const chunk = await readServerCommandLog(logPath, offset, CHUNK_BYTES, {
				allowPartial: finished,
			});
			if (chunk.nextOffset === offset) return;
			offset = chunk.nextOffset;
			res.write(
				`id: ${offset}\nevent: log\ndata: ${JSON.stringify(chunk.data)}\n\n`,
			);
		}
	};

	try {
		while (!closed) {
			const running = isServerCommandRunning(serverCommandId);
			await sendAvailable(!running);
			if (!running) {
				const command = await findServerCommandById(serverCommandId);
				res.write(
					`event: end\ndata: ${JSON.stringify({
						status: command.status,
						exitCode: command.exitCode,
						errorMessage: command.errorMessage,
					})}\n\n`,
				);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	} catch (error) {
		if (!closed) {
			res.write(
				`event: error\ndata: ${JSON.stringify({
					message: error instanceof Error ? error.message : "Unknown error",
				})}\n\n`,
			);
		}
	} finally {
		clearInterval(heartbeat);
		res.end();
	}
}
