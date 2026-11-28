import { db } from "@dokploy/server/db";
import { isUniqueConstraintViolation } from "@dokploy/server/db/errors";
import {
	type apiAdoptCloudServer,
	type apiCreateCloudProviderAccount,
	type apiProvisionCloudServer,
	cloudProviderAccount,
	type ServerProvisioningStatus,
	server,
	serverProvisioning,
	sshKeys,
} from "@dokploy/server/db/schema";
import { serverSetup } from "@dokploy/server/setup/server-setup";
import {
	type CloudCredentials,
	type CloudProviderClient,
	CloudProviderError,
	createCloudProviderClient,
	getCloudProviderDefinition,
} from "@dokploy/server/utils/cloud-providers";
import { generateSSHKey } from "@dokploy/server/utils/filesystem/ssh";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Client, type ConnectConfig } from "ssh2";
import type { z } from "zod";
import { createServer } from "./server";

export type CloudProviderAccount = typeof cloudProviderAccount.$inferSelect;
export type ServerProvisioning = typeof serverProvisioning.$inferSelect;

const IN_PROGRESS_STATUSES: ServerProvisioningStatus[] = [
	"pending",
	"creating_server",
	"waiting_for_ssh",
	"installing",
];

// Provisioning runs inside the Dokploy process, so a restart mid-run leaves
// the row in progress forever. Anything older than this is treated as dead.
const STALE_AFTER_MS = 45 * 60_000;

const providerRemoval = (type: string) => {
	try {
		return getCloudProviderDefinition(type).removal ?? "delete";
	} catch {
		return "delete";
	}
};

const providerLabel = (type: string) => {
	try {
		return getCloudProviderDefinition(type).label;
	} catch {
		return type;
	}
};

const parseCredentials = (account: CloudProviderAccount): CloudCredentials => {
	try {
		return JSON.parse(account.credentials) as CloudCredentials;
	} catch {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"Stored credentials for this account could not be read. Re-enter them.",
		});
	}
};

const clientFor = (account: CloudProviderAccount) =>
	createCloudProviderClient(account.providerType, parseCredentials(account));

/** Secret fields are reduced to their last four characters. */
export const redactCloudProviderAccount = (account: CloudProviderAccount) => {
	const { credentials: _credentials, ...rest } = account;
	const credentials = parseCredentials(account);
	const definition = getCloudProviderDefinition(account.providerType);
	const credentialHints = Object.fromEntries(
		definition.credentialFields.map((field) => {
			const value = credentials[field.name] ?? "";
			return [
				field.name,
				field.secret ? (value ? `…${value.slice(-4)}` : "") : value,
			];
		}),
	);
	return { ...rest, credentialHints };
};

const toTRPCError = (error: unknown, fallback: string) => {
	if (error instanceof TRPCError) return error;
	if (error instanceof CloudProviderError) {
		return new TRPCError({
			code:
				error.kind === "unauthorized"
					? "UNAUTHORIZED"
					: error.kind === "unavailable"
						? "SERVICE_UNAVAILABLE"
						: "BAD_REQUEST",
			message:
				error.kind === "unavailable"
					? `The provider is unavailable or rate limiting requests (${error.message}). Try again in a minute.`
					: error.message,
			cause: error,
		});
	}
	return new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : fallback,
		cause: error,
	});
};

/** Keeps stored values for fields the user left blank, then checks every field is set. */
const resolveCredentials = (
	providerType: string,
	incoming: CloudCredentials,
	stored: CloudCredentials = {},
) => {
	const definition = getCloudProviderDefinition(providerType);
	const credentials: CloudCredentials = {};
	for (const field of definition.credentialFields) {
		const value = incoming[field.name]?.trim() || stored[field.name] || "";
		if (!value) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `${field.label} is required`,
			});
		}
		credentials[field.name] = value;
	}
	return credentials;
};

export const testCloudProviderCredentials = async (
	providerType: string,
	credentials: CloudCredentials,
) => {
	const definition = getCloudProviderDefinition(providerType);
	try {
		await definition.createClient(credentials).validateCredentials();
	} catch (error) {
		throw toTRPCError(error, `Could not connect to ${definition.label}`);
	}
};

export const resolveTestCredentials = async (
	input: {
		cloudProviderAccountId?: string;
		providerType: string;
		credentials: CloudCredentials;
	},
	organizationId: string,
) => {
	const stored = input.cloudProviderAccountId
		? parseCredentials(
				await findCloudProviderAccountInOrganization(
					input.cloudProviderAccountId,
					organizationId,
				),
			)
		: {};
	return resolveCredentials(input.providerType, input.credentials, stored);
};

const isUniqueNameViolation = (error: unknown) =>
	isUniqueConstraintViolation(error, "cloud_provider_account_org_name_idx");

const rethrowNameConflict = (error: unknown): never => {
	if (isUniqueNameViolation(error)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "An account with this name already exists",
		});
	}
	throw error;
};

export const createCloudProviderAccount = async (
	input: z.infer<typeof apiCreateCloudProviderAccount>,
	organizationId: string,
) => {
	const credentials = resolveCredentials(input.providerType, input.credentials);
	await testCloudProviderCredentials(input.providerType, credentials);
	const [account] = await db
		.insert(cloudProviderAccount)
		.values({
			name: input.name,
			providerType: input.providerType,
			credentials: JSON.stringify(credentials),
			organizationId,
		})
		.returning()
		.catch(rethrowNameConflict);
	if (!account) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error saving the account",
		});
	}
	return account;
};

export const updateCloudProviderAccount = async (
	account: CloudProviderAccount,
	input: { name: string; credentials: CloudCredentials },
) => {
	const credentials = resolveCredentials(
		account.providerType,
		input.credentials,
		parseCredentials(account),
	);
	const changed = JSON.stringify(credentials) !== account.credentials;
	if (changed) {
		await testCloudProviderCredentials(account.providerType, credentials);
	}
	const [updated] = await db
		.update(cloudProviderAccount)
		.set({
			name: input.name,
			...(changed && { credentials: JSON.stringify(credentials) }),
		})
		.where(
			eq(
				cloudProviderAccount.cloudProviderAccountId,
				account.cloudProviderAccountId,
			),
		)
		.returning()
		.catch(rethrowNameConflict);
	if (!updated) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
	}
	return updated;
};

export const removeCloudProviderAccount = async (
	cloudProviderAccountId: string,
) => {
	await db
		.delete(cloudProviderAccount)
		.where(
			eq(cloudProviderAccount.cloudProviderAccountId, cloudProviderAccountId),
		);
};

export const findCloudProviderAccountsByOrganizationId = (
	organizationId: string,
) =>
	db.query.cloudProviderAccount.findMany({
		where: eq(cloudProviderAccount.organizationId, organizationId),
		orderBy: desc(cloudProviderAccount.createdAt),
	});

export const findCloudProviderAccountInOrganization = async (
	cloudProviderAccountId: string,
	organizationId: string,
) => {
	const account = await db.query.cloudProviderAccount.findFirst({
		where: and(
			eq(cloudProviderAccount.cloudProviderAccountId, cloudProviderAccountId),
			eq(cloudProviderAccount.organizationId, organizationId),
		),
	});
	if (!account) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
	}
	return account;
};

export const getCloudCatalog = async (account: CloudProviderAccount) => {
	try {
		return await clientFor(account).getCatalog();
	} catch (error) {
		throw toTRPCError(error, "Could not load server options");
	}
};

export const findServerProvisioningInOrganization = async (
	serverProvisioningId: string,
	organizationId: string,
) => {
	const provisioning = await db.query.serverProvisioning.findFirst({
		where: and(
			eq(serverProvisioning.serverProvisioningId, serverProvisioningId),
			eq(serverProvisioning.organizationId, organizationId),
		),
	});
	if (!provisioning) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Provisioning job not found",
		});
	}
	return provisioning;
};

/** Jobs that will register a server once they finish, for quota checks. */
export const countInProgressProvisionings = async (organizationId: string) => {
	const rows = await db.query.serverProvisioning.findMany({
		where: and(
			eq(serverProvisioning.organizationId, organizationId),
			inArray(serverProvisioning.status, IN_PROGRESS_STATUSES),
			isNull(serverProvisioning.serverId),
		),
		columns: { serverProvisioningId: true },
	});
	return rows.length;
};

export const findServerProvisionings = async (organizationId: string) => {
	await db
		.update(serverProvisioning)
		.set({
			status: "failed",
			error:
				"Provisioning was interrupted, most likely because Dokploy restarted. If a server was created it is still running; delete it from here.",
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(serverProvisioning.organizationId, organizationId),
				inArray(serverProvisioning.status, IN_PROGRESS_STATUSES),
				lt(
					serverProvisioning.createdAt,
					new Date(Date.now() - STALE_AFTER_MS).toISOString(),
				),
			),
		);

	const rows = await db.query.serverProvisioning.findMany({
		where: and(
			eq(serverProvisioning.organizationId, organizationId),
			isNull(serverProvisioning.dismissedAt),
		),
		orderBy: desc(serverProvisioning.createdAt),
		limit: 50,
	});
	return rows.map((row) => ({
		...row,
		providerLabel: providerLabel(row.providerType),
		providerRemoval: providerRemoval(row.providerType),
	}));
};

export const findProvisioningByServerId = async (serverId: string) => {
	const row = await db.query.serverProvisioning.findFirst({
		where: eq(serverProvisioning.serverId, serverId),
		with: {
			account: { columns: { cloudProviderAccountId: true, name: true } },
		},
	});
	return row
		? {
				...row,
				providerLabel: providerLabel(row.providerType),
				providerRemoval: providerRemoval(row.providerType),
			}
		: null;
};

export const dismissServerProvisioning = async (
	serverProvisioningId: string,
) => {
	await db
		.update(serverProvisioning)
		.set({ dismissedAt: new Date().toISOString() })
		.where(eq(serverProvisioning.serverProvisioningId, serverProvisioningId));
};

const updateProvisioning = async (
	serverProvisioningId: string,
	values: Partial<typeof serverProvisioning.$inferInsert>,
) => {
	await db
		.update(serverProvisioning)
		.set({
			...values,
			...((values.status === "completed" || values.status === "failed") && {
				completedAt: new Date().toISOString(),
			}),
		})
		.where(eq(serverProvisioning.serverProvisioningId, serverProvisioningId));
};

const waitForRunning = async (
	client: CloudProviderClient,
	id: string,
	timeoutMs = 5 * 60_000,
) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const current = await client.getServer(id);
		if (current.status === "running") return current;
		if (current.status === "error") {
			throw new Error(
				current.statusMessage ??
					"The provider reported an error starting the server",
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
	throw new Error("Timed out waiting for the server to start");
};

const waitForSsh = async (
	host: string,
	username: string,
	privateKey: string,
	onAttempt: (elapsedSeconds: number) => void,
	timeoutMs = 5 * 60_000,
	port = 22,
) => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const connected = await new Promise<boolean>((resolve) => {
			const client = new Client();
			client
				.once("ready", () => {
					client.end();
					resolve(true);
				})
				.once("error", () => {
					client.end();
					resolve(false);
				})
				.connect({
					host,
					port,
					username,
					privateKey,
					readyTimeout: 15_000,
				});
		});
		if (connected) return;
		onAttempt(Math.round((Date.now() - startedAt) / 1000));
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	throw new Error("Timed out waiting for SSH on the new server");
};

export const startCloudServerProvisioning = async (
	input: z.infer<typeof apiProvisionCloudServer>,
	organizationId: string,
	onServerCreated?: (serverId: string) => Promise<void>,
) => {
	const account = await findCloudProviderAccountInOrganization(
		input.cloudProviderAccountId,
		organizationId,
	);

	const [provisioning] = await db
		.insert(serverProvisioning)
		.values({
			cloudProviderAccountId: account.cloudProviderAccountId,
			organizationId,
			providerType: account.providerType,
			status: "pending",
			message: "Queued",
			config: {
				name: input.name,
				location: input.location,
				serverType: input.serverType,
				image: input.image,
				role: input.role,
			},
		})
		.returning();
	if (!provisioning) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to start provisioning",
		});
	}

	void runProvisioning(provisioning, account, onServerCreated).catch(
		(error) => {
			console.error("Cloud server provisioning failed:", error);
		},
	);

	return provisioning;
};

/** Runs Dokploy's server setup, mirroring its progress onto the job. */
const installOnServer = async (
	serverProvisioningId: string,
	serverId: string,
) => {
	await updateProvisioning(serverProvisioningId, {
		status: "installing",
		serverId,
		message: "Installing Docker, Traefik and build tools",
	});

	let setupFailed = false;
	let lastLine = "";
	await serverSetup(serverId, (data) => {
		const text = String(data ?? "");
		if (text.includes("❌")) setupFailed = true;
		const line = text
			.split("\n")
			.map((part) =>
				part
					.replace(/[✅❌🔄]/gu, "")
					.replace(/:\s*$/, "")
					.trim(),
			)
			.filter(Boolean)
			.pop();
		if (line && line !== lastLine) {
			lastLine = line;
			void updateProvisioning(serverProvisioningId, {
				message: line.slice(0, 500),
			});
		}
	});

	if (setupFailed) {
		throw new Error(
			`Server setup did not finish: ${lastLine || "see the server's deployment logs"}`,
		);
	}

	await updateProvisioning(serverProvisioningId, {
		status: "completed",
		message: "Server is ready",
	});
};

const runProvisioning = async (
	provisioning: ServerProvisioning,
	account: CloudProviderAccount,
	onServerCreated?: (serverId: string) => Promise<void>,
) => {
	const id = provisioning.serverProvisioningId;
	const { config, organizationId } = provisioning;
	const definition = getCloudProviderDefinition(account.providerType);
	const client = clientFor(account);

	let providerServerId: string | undefined;
	let providerSshKeyId: string | undefined;
	let sshKeyId: string | undefined;
	let dokployServerId: string | undefined;

	try {
		await updateProvisioning(id, {
			status: "creating_server",
			message: "Generating an SSH key for the new server",
		});

		const keys = await generateSSHKey("ed25519");
		const [sshKey] = await db
			.insert(sshKeys)
			.values({
				name: `${config.name} (${definition.label})`,
				description: `Generated for the ${definition.label} server ${config.name}`,
				publicKey: keys.publicKey,
				privateKey: keys.privateKey,
				organizationId,
			})
			.returning();
		if (!sshKey) throw new Error("Failed to store the SSH key");
		sshKeyId = sshKey.sshKeyId;

		providerSshKeyId = await client.importSshKey(
			`dokploy-${config.name}-${nanoid(6)}`,
			keys.publicKey,
		);
		await updateProvisioning(id, {
			providerSshKeyId,
			message: `Creating ${config.serverType} in ${config.location}`,
		});

		const created = await client.createServer({
			name: config.name,
			serverType: config.serverType,
			location: config.location,
			image: config.image,
			sshKeyId: providerSshKeyId,
		});
		providerServerId = created.id;
		await updateProvisioning(id, {
			providerServerId,
			ipAddress: created.ipv4,
			message: `Waiting for ${definition.label} to boot the server`,
		});

		const running = await waitForRunning(
			client,
			created.id,
			definition.bootTimeoutMs,
		);
		const ipAddress = running.ipv4 ?? created.ipv4;
		const sshUsername =
			running.sshUsername ?? created.sshUsername ?? definition.sshUsername;
		if (!ipAddress) {
			throw new Error(
				`${definition.label} did not assign a public IPv4 address`,
			);
		}

		await updateProvisioning(id, {
			status: "waiting_for_ssh",
			ipAddress,
			message: `Waiting for SSH on ${ipAddress}`,
		});
		await waitForSsh(ipAddress, sshUsername, keys.privateKey, (elapsed) => {
			void updateProvisioning(id, {
				message: `Waiting for SSH on ${ipAddress} (${elapsed}s)`,
			});
		});

		const dokployServer = await createServer(
			{
				name: config.name,
				description: `${definition.label} ${config.serverType} in ${config.location}`,
				ipAddress,
				port: 22,
				username: sshUsername,
				sshKeyId,
				serverType: config.role,
				enableDockerCleanup: true,
			},
			organizationId,
		);
		dokployServerId = dokployServer.serverId;
		await onServerCreated?.(dokployServerId).catch((error) =>
			console.error("Post-create hook failed for provisioned server:", error),
		);

		await installOnServer(id, dokployServerId);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";

		// Once the server is registered in Dokploy, keep the VM so the user can
		// inspect it and retry "Setup Server" instead of paying to recreate it.
		if (dokployServerId) {
			await updateProvisioning(id, {
				status: "failed",
				error: `${message}. The server was kept; open it and run Setup Server to retry.`,
			});
			return;
		}

		// The term is billed from creation, so cancelling would only throw away
		// a paid server the user may still want to register by hand.
		if (providerServerId && definition.removal === "cancel") {
			await updateProvisioning(id, {
				status: "failed",
				error: `${message}. ${definition.label} servers can't be deleted, only cancelled for the end of their term, so it was kept. Cancel it from here if you don't need it.`,
			});
			return;
		}

		await updateProvisioning(id, { status: "failed", error: message });

		if (providerServerId) {
			await client
				.deleteServer(providerServerId)
				.then(() =>
					updateProvisioning(id, {
						providerServerDeletedAt: new Date().toISOString(),
					}),
				)
				.catch((cleanupError) =>
					console.error("Failed to delete provider server:", cleanupError),
				);
		}
		if (providerSshKeyId) {
			await client
				.deleteSshKey(providerSshKeyId)
				.catch((cleanupError) =>
					console.error("Failed to delete provider SSH key:", cleanupError),
				);
		}
		if (sshKeyId) {
			await db
				.delete(sshKeys)
				.where(eq(sshKeys.sshKeyId, sshKeyId))
				.catch((cleanupError) =>
					console.error("Failed to delete SSH key:", cleanupError),
				);
		}
	}
};

export const destroyProvisionedServer = async (
	provisioning: ServerProvisioning,
) => {
	if (!provisioning.providerServerId || provisioning.providerServerDeletedAt) {
		return;
	}
	const { label } = getCloudProviderDefinition(provisioning.providerType);
	if (provisioning.serverId) {
		const stillRegistered = await db.query.server.findFirst({
			where: eq(server.serverId, provisioning.serverId),
			columns: { serverId: true },
		});
		if (stillRegistered) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Remove the server from Dokploy before deleting it on ${label}`,
			});
		}
	}
	if (!provisioning.cloudProviderAccountId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `The ${label} account used to create this server was removed. Delete the server from the ${label} console.`,
		});
	}
	const account = await findCloudProviderAccountInOrganization(
		provisioning.cloudProviderAccountId,
		provisioning.organizationId,
	);
	const client = clientFor(account);
	try {
		await client.deleteServer(provisioning.providerServerId);
		if (provisioning.providerSshKeyId) {
			await client.deleteSshKey(provisioning.providerSshKeyId).catch(() => {});
		}
	} catch (error) {
		throw toTRPCError(error, `Failed to delete the server on ${label}`);
	}
	await updateProvisioning(provisioning.serverProvisioningId, {
		providerServerDeletedAt: new Date().toISOString(),
	});
};

/**
 * Resolves with the Dokploy server ID once provisioning completes, reporting
 * each progress message, and rejects if it fails.
 */
export const waitForServerProvisioning = async (
	serverProvisioningId: string,
	onMessage: (message: string) => void,
	pollMs = 3_000,
) => {
	const deadline = Date.now() + STALE_AFTER_MS;
	let lastMessage: string | null = null;
	while (Date.now() < deadline) {
		const row = await db.query.serverProvisioning.findFirst({
			where: eq(serverProvisioning.serverProvisioningId, serverProvisioningId),
		});
		if (!row) throw new Error("The provisioning job was removed");
		if (row.message && row.message !== lastMessage) {
			lastMessage = row.message;
			onMessage(row.message);
		}
		if (row.status === "failed") {
			throw new Error(row.error ?? "Provisioning failed");
		}
		if (row.status === "completed" && row.serverId) return row.serverId;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	throw new Error("Timed out waiting for the server to be provisioned");
};

const openSsh = (config: ConnectConfig) =>
	new Promise<Client>((resolve, reject) => {
		const client = new Client();
		client
			.once("ready", () => resolve(client))
			.once("error", (error) => {
				client.end();
				reject(error);
			});
		if (config.password) {
			// Servers that turn off plain password auth usually still accept the
			// same password through keyboard-interactive.
			client.on(
				"keyboard-interactive",
				(_name, _instr, _lang, prompts, finish) =>
					finish(prompts.map(() => config.password as string)),
			);
		}
		client.connect({
			readyTimeout: 20_000,
			tryKeyboard: !!config.password,
			...config,
		});
	});

const runSsh = (client: Client, command: string) =>
	new Promise<{ code: number; output: string }>((resolve, reject) => {
		client.exec(command, (error, stream) => {
			if (error) return reject(error);
			let output = "";
			stream
				.on("data", (data: Buffer) => {
					output += data.toString();
				})
				.on("close", (code: number | null) =>
					resolve({ code: code ?? 0, output }),
				)
				.stderr.on("data", (data: Buffer) => {
					output += data.toString();
				});
		});
	});

const sshFailure = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	if (/authentication methods failed/i.test(message))
		return "login was refused";
	if (/timed out/i.test(message)) return "the connection timed out";
	if (/ECONNREFUSED/.test(message)) return "nothing is listening on that port";
	if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND/.test(message)) {
		return "the address can't be reached";
	}
	return message;
};

/** Appends the key to the user's authorized_keys unless it's already there. */
const installPublicKey = async (
	connection: ConnectConfig,
	publicKey: string,
) => {
	const key = publicKey.trim();
	if (!/^[A-Za-z0-9@.+/=_ -]+$/.test(key)) {
		throw new Error("The SSH key's public key has unexpected characters");
	}
	const file = "~/.ssh/authorized_keys";
	const command = [
		"umask 077",
		"mkdir -p ~/.ssh",
		`touch ${file}`,
		// Appending to a file without a final newline would join two keys.
		`if [ -s ${file} ] && [ -n "$(tail -c1 ${file})" ]; then echo >> ${file}; fi`,
		`grep -qxF '${key}' ${file} || echo '${key}' >> ${file}`,
	].join(" && ");
	const client = await openSsh(connection);
	try {
		const result = await runSsh(client, command);
		if (result.code !== 0) {
			throw new Error(
				`Adding the key failed: ${result.output.trim() || `exit code ${result.code}`}`,
			);
		}
	} finally {
		client.end();
	}
};

export const generateCloudServerKey = async (
	name: string,
	organizationId: string,
) => {
	const keys = await generateSSHKey("ed25519");
	const [sshKey] = await db
		.insert(sshKeys)
		.values({
			name,
			description: "Generated by Dokploy to connect to an existing server",
			publicKey: keys.publicKey,
			privateKey: keys.privateKey,
			organizationId,
		})
		.returning();
	if (!sshKey) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to store the SSH key",
		});
	}
	return {
		sshKeyId: sshKey.sshKeyId,
		name: sshKey.name,
		publicKey: sshKey.publicKey,
	};
};

const existingClientFor = (account: CloudProviderAccount) => {
	const definition = getCloudProviderDefinition(account.providerType);
	const client = clientFor(account);
	if (!definition.existingServers || !client.listServers) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Existing ${definition.label} servers can't be added from here`,
		});
	}
	return { definition, client, listServers: client.listServers.bind(client) };
};

/** Servers on the account, with the Dokploy server each is already registered as. */
export const listExistingCloudServers = async (
	account: CloudProviderAccount,
) => {
	const { listServers } = existingClientFor(account);
	const providerServers = await listServers().catch((error) => {
		throw toTRPCError(error, "Could not list servers");
	});
	const [registered, linked] = await Promise.all([
		db.query.server.findMany({
			where: eq(server.organizationId, account.organizationId),
			columns: { serverId: true, name: true, ipAddress: true },
		}),
		db.query.serverProvisioning.findMany({
			where: and(
				eq(
					serverProvisioning.cloudProviderAccountId,
					account.cloudProviderAccountId,
				),
				isNotNull(serverProvisioning.serverId),
			),
			columns: { providerServerId: true, serverId: true },
		}),
	]);
	return providerServers.map((providerServer) => {
		const linkedServerId = linked.find(
			(row) => row.providerServerId === providerServer.id,
		)?.serverId;
		const match = registered.find(
			(candidate) =>
				candidate.serverId === linkedServerId ||
				(!!providerServer.ipv4 && candidate.ipAddress === providerServer.ipv4),
		);
		return {
			...providerServer,
			dokployServer: match
				? { serverId: match.serverId, name: match.name }
				: null,
		};
	});
};

/**
 * Registers a server that already exists on the provider account. When the
 * key is already on the server or a password is given, the login is checked
 * before anything is saved; when the provider adds the key, that and the rest
 * run in the background like provisioning.
 */
export const adoptCloudServer = async (
	input: z.infer<typeof apiAdoptCloudServer>,
	organizationId: string,
	onServerCreated?: (serverId: string) => Promise<void>,
) => {
	const account = await findCloudProviderAccountInOrganization(
		input.cloudProviderAccountId,
		organizationId,
	);
	const { definition, client } = existingClientFor(account);
	if (
		input.access === "provider" &&
		(!definition.addsSshKeys || !client.setServerSshKeys)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${definition.label} can't add SSH keys to existing servers`,
		});
	}
	const providerServer = (await listExistingCloudServers(account)).find(
		(candidate) => candidate.id === input.providerServerId,
	);
	if (!providerServer) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `That server is no longer on the ${definition.label} account`,
		});
	}
	if (providerServer.dokployServer) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `This server is already in Dokploy as ${providerServer.dokployServer.name}`,
		});
	}
	const host = providerServer.ipv4;
	if (!host) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This server has no public IPv4 address",
		});
	}
	if (providerServer.status !== "running") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${definition.label} reports this server as ${providerServer.status}. Start it first.`,
		});
	}

	const sshKey = await db.query.sshKeys.findFirst({
		where: and(
			eq(sshKeys.sshKeyId, input.sshKeyId),
			eq(sshKeys.organizationId, organizationId),
		),
	});
	if (!sshKey) {
		throw new TRPCError({ code: "NOT_FOUND", message: "SSH key not found" });
	}

	const target = `${input.username}@${host}${input.port === 22 ? "" : `:${input.port}`}`;
	const connection = { host, port: input.port, username: input.username };

	if (input.access === "password") {
		await installPublicKey(
			{ ...connection, password: input.password },
			sshKey.publicKey,
		).catch((error) => {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Could not add the key to ${target} with the password: ${sshFailure(error)}`,
			});
		});
	}
	if (input.access !== "provider") {
		await openSsh({ ...connection, privateKey: sshKey.privateKey })
			.then((ssh) => ssh.end())
			.catch((error) => {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						input.access === "password"
							? `The key was added, but logging in to ${target} with it failed: ${sshFailure(error)}`
							: `Could not log in to ${target} with ${sshKey.name}: ${sshFailure(error)}. Add its public key to ~/.ssh/authorized_keys on the server, or choose another way to add it.`,
				});
			});
	}

	const [provisioning] = await db
		.insert(serverProvisioning)
		.values({
			cloudProviderAccountId: account.cloudProviderAccountId,
			organizationId,
			providerType: account.providerType,
			status:
				input.access === "provider" ? "creating_server" : "waiting_for_ssh",
			message:
				input.access === "provider"
					? `Asking ${definition.label} to add the SSH key`
					: "Connected over SSH",
			providerServerId: providerServer.id,
			ipAddress: host,
			config: {
				name: input.name,
				location: providerServer.location,
				serverType: providerServer.serverTypeLabel || providerServer.serverType,
				image: providerServer.image ?? "",
				role: input.role,
				existing: true,
			},
		})
		.returning();
	if (!provisioning) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to save the server",
		});
	}
	const id = provisioning.serverProvisioningId;

	const finish = async () => {
		if (input.access === "provider") {
			const providerSshKeyId = await client.importSshKey(
				`dokploy-${input.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${nanoid(6)}`,
				sshKey.publicKey,
			);
			await updateProvisioning(id, { providerSshKeyId });
			await client.setServerSshKeys?.(providerServer.id, [
				...providerServer.sshKeyIds,
				providerSshKeyId,
			]);
			await updateProvisioning(id, {
				message: `Waiting for ${definition.label} to restart the server`,
			});
			await waitForRunning(client, providerServer.id, definition.bootTimeoutMs);
			await updateProvisioning(id, {
				status: "waiting_for_ssh",
				message: `Waiting for the key to work on ${host}`,
			});
			await waitForSsh(
				host,
				input.username,
				sshKey.privateKey,
				(elapsed) => {
					void updateProvisioning(id, {
						message: `Waiting for the key to work on ${host} (${elapsed}s)`,
					});
				},
				15 * 60_000,
				input.port,
			);
		}

		const dokployServer = await createServer(
			{
				name: input.name,
				description: `${definition.label} ${providerServer.serverTypeLabel || providerServer.serverType} in ${providerServer.location}`,
				ipAddress: host,
				port: input.port,
				username: input.username,
				sshKeyId: sshKey.sshKeyId,
				serverType: input.role,
				enableDockerCleanup: true,
			},
			organizationId,
		);
		await updateProvisioning(id, {
			serverId: dokployServer.serverId,
			...(!input.runSetup && {
				status: "completed",
				message: "Added without running setup",
			}),
		});
		await onServerCreated?.(dokployServer.serverId).catch((error) =>
			console.error("Post-create hook failed for added server:", error),
		);
		if (input.runSetup) {
			await installOnServer(id, dokployServer.serverId);
		}
		return dokployServer.serverId;
	};

	const run = finish().catch(async (error) => {
		const message = error instanceof Error ? error.message : "Unknown error";
		const current = await db.query.serverProvisioning.findFirst({
			where: eq(serverProvisioning.serverProvisioningId, id),
			columns: { serverId: true },
		});
		// This server was the user's before Dokploy touched it, so a failure
		// never deletes or cancels it.
		await updateProvisioning(id, {
			status: "failed",
			error: current?.serverId
				? `${message}. Open the server and run Setup Server to retry.`
				: `${message}. The server on ${definition.label} wasn't changed by Dokploy beyond the SSH key; dismiss this and try again.`,
		});
		throw error;
	});

	// With the login already proven, registering is quick, so the caller
	// learns about a failure there; setup and provider key changes carry on.
	if (input.access !== "provider" && !input.runSetup) {
		await run;
	} else {
		void run.catch((error) =>
			console.error("Adding an existing cloud server failed:", error),
		);
	}

	return provisioning;
};
