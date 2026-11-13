import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@dokploy/server/db";
import {
	type apiSaveBoatBuildSettings,
	applications,
	boatBuildMachines,
	compose,
	deployments,
	legacyServerType,
	server,
	sshKeys,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { z } from "zod";
import { serverSetup } from "../setup/server-setup";
import {
	BoatApiError,
	BoatClient,
	boatSshTarget,
	STOPPED_STATES,
} from "../utils/boat/client";
import { generateSSHKey } from "../utils/filesystem/ssh";
import { execAsyncRemote } from "../utils/process/execAsync";
import { updateApplicationStatus } from "./application";
import {
	type BoatSettings,
	findBoatSettings,
	requireBoatSettings,
	updateBoatSettings,
} from "./boat";
import { updateCompose } from "./compose";
import {
	createDeployment,
	createDeploymentCompose,
	updateDeploymentStatus,
} from "./deployment";
import { updatePreviewDeployment } from "./preview-deployment";
import { deleteServer, updateServerById } from "./server";

export type BoatBuildMachine = typeof boatBuildMachines.$inferSelect;

const PARTITION_PREFIX = "boat-builds:";
// Boat stops the machine on its own after this long, in case Dokploy never gets to.
const MACHINE_TTL_SECONDS = 4 * 60 * 60;
const BUILD_TOOLS_CHECK =
	"docker info >/dev/null && command -v nixpacks && command -v railpack && command -v pack";

export const boatBuildPartition = (organizationId: string) =>
	`${PARTITION_PREFIX}${organizationId}`;

export const boatBuildPartitionOrganization = (partition: string) =>
	partition.startsWith(PARTITION_PREFIX)
		? partition.slice(PARTITION_PREFIX.length)
		: null;

export type BoatBuildTarget = {
	organizationId: string;
	serviceType: "application" | "compose";
	serviceId: string;
	deployServerId: string | null;
};

// Dev can evaluate this module more than once, so pool state lives on globalThis.
const globalForPool = globalThis as unknown as {
	__dokployBoatBuildPool?: {
		busy: Set<string>;
		idleTimers: Map<string, NodeJS.Timeout>;
		provisioning: Set<string>;
	};
};
globalForPool.__dokployBoatBuildPool ??= {
	busy: new Set(),
	idleTimers: new Map(),
	provisioning: new Set(),
};
const pool = globalForPool.__dokployBoatBuildPool;

const findMachines = (organizationId: string) =>
	db.query.boatBuildMachines.findMany({
		where: eq(boatBuildMachines.organizationId, organizationId),
		with: { server: { columns: { name: true } } },
		orderBy: (machines, { asc }) => [asc(machines.createdAt)],
	});

export const isBoatBuildMachine = async (serverId: string) =>
	!!(await db.query.boatBuildMachines.findFirst({
		where: eq(boatBuildMachines.serverId, serverId),
		columns: { serverId: true },
	}));

/** How many builds the pool runs at once: one per ready machine. */
export const boatBuildConcurrency = async (organizationId: string) => {
	const ready = await db.query.boatBuildMachines.findMany({
		where: and(
			eq(boatBuildMachines.organizationId, organizationId),
			eq(boatBuildMachines.status, "ready"),
		),
		columns: { serverId: true },
	});
	return Math.max(1, ready.length);
};

/** Where a deployment builds when its service is set to the Boat build pool, or null to build as usual. */
export const resolveBoatBuildTarget = async (job: {
	applicationType: "application" | "compose" | "application-preview";
	applicationId?: string;
	composeId?: string;
}): Promise<BoatBuildTarget | null> => {
	const projectColumns = {
		with: {
			environment: {
				columns: {},
				with: { project: { columns: { organizationId: true } } },
			},
		},
	} as const;
	const service =
		job.applicationType === "compose"
			? job.composeId
				? await db.query.compose.findFirst({
						where: eq(compose.composeId, job.composeId),
						columns: {
							boatBuildPool: true,
							buildRegistryId: true,
							serverId: true,
						},
						...projectColumns,
					})
				: undefined
			: job.applicationId
				? await db.query.applications.findFirst({
						where: eq(applications.applicationId, job.applicationId),
						columns: {
							boatBuildPool: true,
							buildRegistryId: true,
							serverId: true,
						},
						...projectColumns,
					})
				: undefined;
	// Building elsewhere only works when the image goes through a registry the deploy server can pull from.
	if (!service?.boatBuildPool || !service.buildRegistryId) return null;
	const organizationId = service.environment.project.organizationId;
	const settings = await findBoatSettings(organizationId);
	if (!settings?.buildsEnabled) return null;
	return {
		organizationId,
		serviceType: job.applicationType === "compose" ? "compose" : "application",
		serviceId: (job.applicationType === "compose"
			? job.composeId
			: job.applicationId)!,
		deployServerId: service.serverId ?? null,
	};
};

const ensurePoolSshKey = async (settings: BoatSettings) => {
	if (settings.buildSshKeyId) {
		const existing = await db.query.sshKeys.findFirst({
			where: eq(sshKeys.sshKeyId, settings.buildSshKeyId),
		});
		if (existing) return existing;
	}
	const keys = await generateSSHKey("ed25519");
	const [created] = await db
		.insert(sshKeys)
		.values({
			name: "Boat build pool",
			description: "Managed by Dokploy for its Boat build machines.",
			privateKey: keys.privateKey,
			publicKey: keys.publicKey,
			organizationId: settings.organizationId,
		})
		.returning();
	await updateBoatSettings(settings.organizationId, {
		buildSshKeyId: created!.sshKeyId,
	});
	return created!;
};

/** Starts the machine if it's stopped and points its server row at its current address, which changes on every resume. */
const wakeMachine = async (
	client: BoatClient,
	machine: BoatBuildMachine,
	settings: BoatSettings,
) => {
	const key = await ensurePoolSshKey(settings);
	const sandbox = await client.getSandbox(machine.sandboxId);
	if (STOPPED_STATES.has(sandbox.state)) {
		await client.resumeSandbox(machine.sandboxId, settings.buildMachineType);
	}
	await client.waitForSandbox(machine.sandboxId, undefined, { resuming: true });
	const access = await client.addSshKey(machine.sandboxId, key.publicKey);
	const target = boatSshTarget(access, key.privateKey);
	await updateServerById(machine.serverId, {
		ipAddress: target.ipAddress,
		port: target.port,
		username: target.username,
		sshKeyId: key.sshKeyId,
	});
};

const stopMachine = async (organizationId: string, serverId: string) => {
	const settings = await findBoatSettings(organizationId);
	const machine = await db.query.boatBuildMachines.findFirst({
		where: eq(boatBuildMachines.serverId, serverId),
	});
	if (!settings || !machine || pool.busy.has(serverId)) return;
	await new BoatClient(settings.apiKey)
		.stopSandbox(machine.sandboxId)
		.catch((error) =>
			console.error(`Failed to stop Boat build machine ${serverId}`, error),
		);
};

const scheduleIdleStop = (
	organizationId: string,
	serverId: string,
	minutes: number,
) => {
	clearTimeout(pool.idleTimers.get(serverId));
	pool.idleTimers.set(
		serverId,
		setTimeout(
			() => {
				pool.idleTimers.delete(serverId);
				stopMachine(organizationId, serverId);
			},
			minutes * 60 * 1000,
		),
	);
};

/** Creates the sandbox, registers it as a build server and installs the build tools; the machine is stopped afterwards. */
const setUpMachine = async (
	machine: BoatBuildMachine,
	settings: BoatSettings,
) => {
	pool.provisioning.add(machine.serverId);
	const client = new BoatClient(settings.apiKey);
	try {
		await wakeMachine(client, machine, settings);
		await serverSetup(machine.serverId);
		// serverSetup records failures on its own deployment instead of throwing.
		await execAsyncRemote(machine.serverId, BUILD_TOOLS_CHECK).catch(() => {
			throw new Error(
				"Installing the build tools failed. See the server's setup deployment in Remote Servers.",
			);
		});
		await db
			.update(boatBuildMachines)
			.set({ status: "ready", error: null })
			.where(eq(boatBuildMachines.serverId, machine.serverId));
	} catch (error) {
		await db
			.update(boatBuildMachines)
			.set({
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			})
			.where(eq(boatBuildMachines.serverId, machine.serverId));
	} finally {
		pool.provisioning.delete(machine.serverId);
		await client.stopSandbox(machine.sandboxId).catch(() => {});
	}
};

const createSandbox = (settings: BoatSettings, name: string) =>
	new BoatClient(settings.apiKey).createSandbox({
		type: settings.buildMachineType,
		name,
		ttlSeconds: MACHINE_TTL_SECONDS,
		labels: { dokploy: "build-pool" },
	});

const provisionMachine = async (settings: BoatSettings, name: string) => {
	const key = await ensurePoolSshKey(settings);
	const sandbox = await createSandbox(settings, `Dokploy ${name}`);
	const [created] = await db
		.insert(server)
		.values({
			name,
			description:
				"Boat build machine managed by Dokploy. Edit it under Settings → Boat.",
			// Replaced with the real address each time the machine wakes.
			ipAddress: "0.0.0.0",
			port: 22,
			username: "user",
			sshKeyId: key.sshKeyId,
			serverRoles: ["build"],
			serverType: legacyServerType(["build"]),
			organizationId: settings.organizationId,
			createdAt: new Date().toISOString(),
		})
		.returning();
	const [machine] = await db
		.insert(boatBuildMachines)
		.values({
			serverId: created!.serverId,
			organizationId: settings.organizationId,
			sandboxId: sandbox.id,
		})
		.returning();
	await setUpMachine(machine!, settings);
};

/** Replaces the sandbox behind a machine, e.g. after Boat deleted the disk of one stopped for over 14 days. */
const replaceSandbox = async (
	machine: BoatBuildMachine,
	settings: BoatSettings,
) => {
	const client = new BoatClient(settings.apiKey);
	await client.deleteSandbox(machine.sandboxId).catch(() => {});
	const sandbox = await createSandbox(settings, `Dokploy ${machine.serverId}`);
	const [updated] = await db
		.update(boatBuildMachines)
		.set({ sandboxId: sandbox.id, status: "provisioning", error: null })
		.where(eq(boatBuildMachines.serverId, machine.serverId))
		.returning();
	await setUpMachine(updated!, settings);
};

const removeMachine = async (machine: BoatBuildMachine, apiKey: string) => {
	clearTimeout(pool.idleTimers.get(machine.serverId));
	pool.idleTimers.delete(machine.serverId);
	await new BoatClient(apiKey)
		.deleteSandbox(machine.sandboxId)
		.catch((error) =>
			console.error(
				`Failed to delete Boat sandbox ${machine.sandboxId}`,
				error,
			),
		);
	await deleteServer(machine.serverId);
};

const nextMachineName = (taken: string[]) => {
	for (let index = 1; ; index++) {
		const name = `Boat build ${index}`;
		if (!taken.includes(name)) return name;
	}
};

/** Grows or shrinks the pool to the configured size; new machines are set up in the background. */
export const reconcileBoatBuildPool = async (organizationId: string) => {
	const settings = await requireBoatSettings(organizationId);
	const machines = await findMachines(organizationId);
	const missing = settings.buildPoolSize - machines.length;
	if (missing > 0) {
		const taken = machines.map((machine) => machine.server.name);
		for (let i = 0; i < missing; i++) {
			const name = nextMachineName(taken);
			taken.push(name);
			provisionMachine(settings, name).catch((error) =>
				console.error(`Failed to provision ${name}`, error),
			);
		}
		return;
	}
	const removable = machines
		.filter(
			(machine) =>
				!pool.busy.has(machine.serverId) &&
				!pool.provisioning.has(machine.serverId),
		)
		.sort(
			(a, b) =>
				Number(a.status === "ready") - Number(b.status === "ready") ||
				b.createdAt.localeCompare(a.createdAt),
		)
		.slice(0, -missing);
	for (const machine of removable)
		await removeMachine(machine, settings.apiKey);
};

export const saveBoatBuildSettings = async (
	input: z.infer<typeof apiSaveBoatBuildSettings>,
	organizationId: string,
) => {
	await requireBoatSettings(organizationId);
	await updateBoatSettings(organizationId, {
		buildsEnabled: input.enabled,
		buildPoolSize: input.poolSize,
		buildMachineType: input.machineType,
		buildIdleStopMinutes: input.idleStopMinutes,
	});
	if (input.enabled) await reconcileBoatBuildPool(organizationId);
};

export const retryBoatBuildMachine = async (
	serverId: string,
	organizationId: string,
) => {
	const settings = await requireBoatSettings(organizationId);
	const machine = await db.query.boatBuildMachines.findFirst({
		where: and(
			eq(boatBuildMachines.serverId, serverId),
			eq(boatBuildMachines.organizationId, organizationId),
		),
	});
	if (!machine) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Machine not found" });
	}
	if (pool.busy.has(serverId) || pool.provisioning.has(serverId)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "The machine is busy",
		});
	}
	await db
		.update(boatBuildMachines)
		.set({ status: "provisioning", error: null })
		.where(eq(boatBuildMachines.serverId, serverId));
	setUpMachine(machine, settings).catch((error) =>
		console.error(`Failed to set up ${serverId}`, error),
	);
};

export const removeBoatBuildPool = async (settings: BoatSettings) => {
	const machines = await db.query.boatBuildMachines.findMany({
		where: eq(boatBuildMachines.organizationId, settings.organizationId),
	});
	for (const machine of machines) await removeMachine(machine, settings.apiKey);
	if (settings.buildSshKeyId) {
		await db
			.delete(sshKeys)
			.where(eq(sshKeys.sshKeyId, settings.buildSshKeyId));
	}
};

export const findBoatBuildMachines = async (organizationId: string) => {
	const settings = await findBoatSettings(organizationId);
	const machines = await findMachines(organizationId);
	const client = settings ? new BoatClient(settings.apiKey) : null;
	return Promise.all(
		machines.map(async (machine) => ({
			serverId: machine.serverId,
			name: machine.server.name,
			status: machine.status,
			error: machine.error,
			lastUsedAt: machine.lastUsedAt,
			building: pool.busy.has(machine.serverId),
			settingUp: pool.provisioning.has(machine.serverId),
			state: client
				? await client
						.getSandbox(machine.sandboxId)
						.then((sandbox) => sandbox.state)
						.catch(() => "unknown")
				: "unknown",
		})),
	);
};

/** Prefers the machine that last built this service, since it holds that service's build cache. */
const acquireMachine = async (target: BoatBuildTarget) => {
	const machines = (await findMachines(target.organizationId)).filter(
		(machine) =>
			machine.status === "ready" &&
			!pool.busy.has(machine.serverId) &&
			!pool.provisioning.has(machine.serverId),
	);
	const machine =
		machines.find(
			(candidate) => candidate.lastServiceId === target.serviceId,
		) ??
		machines.sort((a, b) =>
			(a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""),
		)[0];
	if (!machine) {
		throw new Error(
			"No Boat build machine is ready. Check the build pool under Settings → Boat.",
		);
	}
	pool.busy.add(machine.serverId);
	clearTimeout(pool.idleTimers.get(machine.serverId));
	pool.idleTimers.delete(machine.serverId);
	return machine;
};

const setServiceBuildServer = (
	target: BoatBuildTarget,
	buildServerId: string | null,
) =>
	target.serviceType === "compose"
		? db
				.update(compose)
				.set({ buildServerId })
				.where(eq(compose.composeId, target.serviceId))
		: db
				.update(applications)
				.set({ buildServerId })
				.where(eq(applications.applicationId, target.serviceId));

/**
 * Build logs are written on the build server. The machine is stopped soon after, so copy them to
 * the deploy server (or the Dokploy host) at the same path and stop pointing the deployment at the machine.
 */
const bringLogsHome = async (
	machineServerId: string,
	deployServerId: string | null,
	since: string,
) => {
	const built = await db.query.deployments.findMany({
		where: and(
			eq(deployments.buildServerId, machineServerId),
			gte(deployments.createdAt, since),
		),
		columns: { deploymentId: true, logPath: true },
	});
	for (const deployment of built) {
		const { stdout } = await execAsyncRemote(
			machineServerId,
			`cat "${deployment.logPath}" 2>/dev/null || true`,
		);
		const directory = path.posix.dirname(deployment.logPath);
		if (deployServerId) {
			await execAsyncRemote(
				deployServerId,
				`mkdir -p "${directory}" && cat > "${deployment.logPath}"`,
				undefined,
				stdout,
			);
		} else {
			await mkdir(directory, { recursive: true });
			await writeFile(deployment.logPath, stdout);
		}
	}
	if (built.length > 0) {
		await db
			.update(deployments)
			.set({ buildServerId: null })
			.where(
				inArray(
					deployments.deploymentId,
					built.map((deployment) => deployment.deploymentId),
				),
			);
	}
};

/** Runs a deployment job with a pool machine awake and set as the service's build server. */
export const runOnBoatBuildMachine = async (
	target: BoatBuildTarget,
	run: () => Promise<void>,
) => {
	const settings = await requireBoatSettings(target.organizationId);
	let machine = await acquireMachine(target);
	const startedAt = new Date().toISOString();
	try {
		const client = new BoatClient(settings.apiKey);
		try {
			await wakeMachine(client, machine, settings);
		} catch (error) {
			const gone =
				error instanceof BoatApiError &&
				(error.status === 404 || error.code === "snapshot_data_expired");
			if (!gone) throw error;
			await replaceSandbox(machine, settings);
			machine = (await db.query.boatBuildMachines.findFirst({
				where: eq(boatBuildMachines.serverId, machine.serverId),
				with: { server: { columns: { name: true } } },
			}))!;
			if (machine.status !== "ready") {
				throw new Error(machine.error ?? "Recreating the build machine failed");
			}
			await wakeMachine(client, machine, settings);
		}
		await setServiceBuildServer(target, machine.serverId);
		await run();
	} finally {
		await setServiceBuildServer(target, null).catch(() => {});
		await bringLogsHome(
			machine.serverId,
			target.deployServerId,
			startedAt,
		).catch((error) => console.error("Failed to copy Boat build logs", error));
		await db
			.update(boatBuildMachines)
			.set({
				lastServiceId: target.serviceId,
				lastUsedAt: new Date().toISOString(),
			})
			.where(eq(boatBuildMachines.serverId, machine.serverId));
		pool.busy.delete(machine.serverId);
		scheduleIdleStop(
			target.organizationId,
			machine.serverId,
			settings.buildIdleStopMinutes,
		);
	}
};

/** At startup nothing is building, so stop any pool machine a previous process left running. */
export const initBoatBuildPools = async () => {
	const machines = await db.query.boatBuildMachines.findMany();
	const settingsByOrg = new Map<string, BoatSettings | null>();
	for (const machine of machines) {
		if (!settingsByOrg.has(machine.organizationId)) {
			settingsByOrg.set(
				machine.organizationId,
				await findBoatSettings(machine.organizationId),
			);
		}
		const settings = settingsByOrg.get(machine.organizationId);
		if (!settings) continue;
		if (machine.status === "provisioning") {
			await db
				.update(boatBuildMachines)
				.set({
					status: "failed",
					error: "Dokploy restarted while setting this machine up. Retry it.",
				})
				.where(eq(boatBuildMachines.serverId, machine.serverId));
		}
		await new BoatClient(settings.apiKey)
			.stopSandbox(machine.sandboxId)
			.catch(() => {});
	}
};

/** Shows why a Boat build couldn't start as a failed deployment, since the job never reached the normal deploy path. */
export const recordBoatBuildFailure = async (
	target: BoatBuildTarget,
	job: {
		applicationType: "application" | "compose" | "application-preview";
		titleLog: string;
		descriptionLog: string;
		previewDeploymentId?: string;
	},
	error: unknown,
) => {
	const message = `Couldn't start a Boat build machine: ${error instanceof Error ? error.message : String(error)}`;
	console.error(message);
	if (job.applicationType === "application-preview") {
		if (job.previewDeploymentId) {
			await updatePreviewDeployment(job.previewDeploymentId, {
				previewStatus: "error",
			});
		}
		return;
	}
	const deployment =
		target.serviceType === "compose"
			? await createDeploymentCompose({
					composeId: target.serviceId,
					title: job.titleLog,
					description: job.descriptionLog,
				})
			: await createDeployment({
					applicationId: target.serviceId,
					title: job.titleLog,
					description: job.descriptionLog,
				});
	const line = `${message}\n`;
	if (target.deployServerId) {
		await execAsyncRemote(
			target.deployServerId,
			`cat >> "${deployment.logPath}"`,
			undefined,
			line,
		).catch(() => {});
	} else {
		await appendFile(deployment.logPath, line).catch(() => {});
	}
	await updateDeploymentStatus(deployment.deploymentId, "error");
	if (target.serviceType === "compose") {
		await updateCompose(target.serviceId, { composeStatus: "error" });
	} else {
		await updateApplicationStatus(target.serviceId, "error");
	}
};
