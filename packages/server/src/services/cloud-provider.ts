import { db } from "@dokploy/server/db";
import {
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
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Client } from "ssh2";
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
	error instanceof Error &&
	error.message.includes("cloud_provider_account_org_name_idx");

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
		? { ...row, providerLabel: providerLabel(row.providerType) }
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
			throw new Error("The provider reported an error starting the server");
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
					port: 22,
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

		const running = await waitForRunning(client, created.id);
		const ipAddress = running.ipv4 ?? created.ipv4;
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
		await waitForSsh(
			ipAddress,
			definition.sshUsername,
			keys.privateKey,
			(elapsed) => {
				void updateProvisioning(id, {
					message: `Waiting for SSH on ${ipAddress} (${elapsed}s)`,
				});
			},
		);

		const dokployServer = await createServer(
			{
				name: config.name,
				description: `${definition.label} ${config.serverType} in ${config.location}`,
				ipAddress,
				port: 22,
				username: definition.sshUsername,
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

		await updateProvisioning(id, {
			status: "installing",
			serverId: dokployServerId,
			message: "Installing Docker, Traefik and build tools",
		});

		let setupFailed = false;
		let lastLine = "";
		await serverSetup(dokployServerId, (data) => {
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
				void updateProvisioning(id, { message: line.slice(0, 500) });
			}
		});

		if (setupFailed) {
			throw new Error(
				`Server setup did not finish: ${lastLine || "see the server's deployment logs"}`,
			);
		}

		await updateProvisioning(id, {
			status: "completed",
			message: "Server is ready",
		});
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
