import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiTransferService,
	deployments,
	network,
	type ServiceType,
} from "@dokploy/server/db/schema";
import { removeService } from "@dokploy/server/utils/docker/utils";
import {
	removeDirectoryCode,
	removeMonitoringDirectory,
} from "@dokploy/server/utils/filesystem/directory";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { pipeBetweenServers } from "@dokploy/server/utils/process/remoteStream";
import {
	readConfig,
	readRemoteConfig,
	removeTraefikConfig,
	writeConfig,
	writeConfigRemote,
} from "@dokploy/server/utils/traefik/application";
import { manageDomain } from "@dokploy/server/utils/traefik/domain";
import { removeForwardAuthMiddleware } from "@dokploy/server/utils/traefik/forward-auth";
import {
	deleteAllMiddlewares,
	removePathMiddlewares,
} from "@dokploy/server/utils/traefik/middleware";
import { createRedirectMiddleware } from "@dokploy/server/utils/traefik/redirect";
import { createSecurityMiddleware } from "@dokploy/server/utils/traefik/security";
import { TRPCError } from "@trpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import {
	deployApplication,
	findApplicationById,
	updateApplication,
} from "./application";
import {
	deployCompose,
	findComposeById,
	removeCompose,
	startCompose,
	stopCompose,
	updateCompose,
} from "./compose";
import { deployLibsql, findLibsqlById, updateLibsqlById } from "./libsql";
import { deployMariadb, findMariadbById, updateMariadbById } from "./mariadb";
import { deployMongo, findMongoById, updateMongoById } from "./mongo";
import { createFileMount } from "./mount";
import { deployMySql, findMySqlById, updateMySqlById } from "./mysql";
import {
	deployPostgres,
	findPostgresById,
	updatePostgresById,
} from "./postgres";
import { deployRedis, findRedisById, updateRedisById } from "./redis";
import { findServerById } from "./server";
import {
	checkServicesArchitecture,
	detectServerArchitecture,
} from "./server-architecture";

export type TransferServiceInput = z.infer<typeof apiTransferService> & {
	organizationId: string;
};

type Logger = (line: string) => void;
type ServiceStatus = "idle" | "running" | "done" | "error";

const findService = async (serviceType: ServiceType, serviceId: string) => {
	switch (serviceType) {
		case "application":
			return await findApplicationById(serviceId);
		case "compose":
			return await findComposeById(serviceId);
		case "postgres":
			return await findPostgresById(serviceId);
		case "mysql":
			return await findMySqlById(serviceId);
		case "mariadb":
			return await findMariadbById(serviceId);
		case "mongo":
			return await findMongoById(serviceId);
		case "redis":
			return await findRedisById(serviceId);
		case "libsql":
			return await findLibsqlById(serviceId);
	}
};

type TransferableService = Awaited<ReturnType<typeof findService>>;
type ApplicationService = Awaited<ReturnType<typeof findApplicationById>>;
type ComposeService = Awaited<ReturnType<typeof findComposeById>>;

const isApplication = (
	service: TransferableService,
): service is ApplicationService => "applicationId" in service;

const isCompose = (service: TransferableService): service is ComposeService =>
	"composeId" in service;

const updateServer = async (
	serviceType: ServiceType,
	serviceId: string,
	data: { serverId: string | null; networkIds?: string[] | null },
) => {
	switch (serviceType) {
		case "application":
			return await updateApplication(serviceId, data);
		case "compose":
			return await updateCompose(serviceId, { serverId: data.serverId });
		case "postgres":
			return await updatePostgresById(serviceId, data);
		case "mysql":
			return await updateMySqlById(serviceId, data);
		case "mariadb":
			return await updateMariadbById(serviceId, data);
		case "mongo":
			return await updateMongoById(serviceId, data);
		case "redis":
			return await updateRedisById(serviceId, data);
		case "libsql":
			return await updateLibsqlById(serviceId, data);
	}
};

const updateStatus = async (
	serviceType: ServiceType,
	serviceId: string,
	status: ServiceStatus,
) => {
	switch (serviceType) {
		case "application":
			return await updateApplication(serviceId, { applicationStatus: status });
		case "compose":
			return await updateCompose(serviceId, { composeStatus: status });
		case "postgres":
			return await updatePostgresById(serviceId, {
				applicationStatus: status,
			});
		case "mysql":
			return await updateMySqlById(serviceId, { applicationStatus: status });
		case "mariadb":
			return await updateMariadbById(serviceId, { applicationStatus: status });
		case "mongo":
			return await updateMongoById(serviceId, { applicationStatus: status });
		case "redis":
			return await updateRedisById(serviceId, { applicationStatus: status });
		case "libsql":
			return await updateLibsqlById(serviceId, { applicationStatus: status });
	}
};

const q = (value: string) => quote([value]);

const runOn = (serverId: string | null, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const directoryExists = async (serverId: string | null, directory: string) => {
	const { stdout } = await runOn(
		serverId,
		`[ -d ${q(directory)} ] && echo yes || echo no`,
	);
	return stdout.trim() === "yes";
};

const formatBytes = (bytes: number) => {
	const mib = bytes / (1024 * 1024);
	if (mib < 1) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (mib < 1024) return `${mib.toFixed(1)} MiB`;
	return `${(mib / 1024).toFixed(2)} GiB`;
};

export const volumeExportCommand = (volume: string) =>
	`docker run --rm -v ${q(volume)}:/data:ro alpine tar -czf - --numeric-owner -C /data .`;

export const volumeImportCommand = (volume: string) =>
	`docker volume create ${q(volume)} >/dev/null && docker run --rm -i -v ${q(volume)}:/data alpine tar -xzf - --numeric-owner -C /data`;

export const directoryExportCommand = (directory: string) =>
	`COPYFILE_DISABLE=1 tar -czf - --numeric-owner -C ${q(directory)} .`;

export const directoryImportCommand = (directory: string) =>
	`mkdir -p ${q(directory)} && tar -xzf - --numeric-owner -C ${q(directory)}`;

const PROGRESS_STEP = 64 * 1024 * 1024;

const copyStream = async (
	label: string,
	source: { serverId: string | null; command: string },
	target: { serverId: string | null; command: string },
	log: Logger,
) => {
	let reported = 0;
	const bytes = await pipeBetweenServers({
		source,
		target,
		onProgress: (transferred) => {
			if (transferred - reported >= PROGRESS_STEP) {
				reported = transferred;
				log(`  ${label}: ${formatBytes(transferred)} transferred`);
			}
		},
	});
	log(`  ${label}: done (${formatBytes(bytes)})`);
};

const listVolumes = async (service: TransferableService) => {
	const names = new Set<string>();
	for (const mount of service.mounts) {
		if (mount.type === "volume" && mount.volumeName) {
			names.add(mount.volumeName);
		}
	}
	if (isCompose(service)) {
		const project = q(service.appName);
		const { stdout } = await runOn(
			service.serverId ?? null,
			`docker volume ls -q --filter label=com.docker.compose.project=${project}; docker volume ls -q --filter label=com.docker.stack.namespace=${project}`,
		);
		for (const line of stdout.split("\n")) {
			const name = line.trim();
			if (name) names.add(name);
		}
	}
	return [...names];
};

const listBindMounts = (service: TransferableService) => [
	...new Set(
		service.mounts
			.filter((mount) => mount.type === "bind" && mount.hostPath)
			.map((mount) => mount.hostPath as string),
	),
];

const stopOnSource = async (service: TransferableService, log: Logger) => {
	if (isCompose(service)) {
		try {
			await stopCompose(service.composeId);
		} catch (error) {
			log(`  Could not stop compose: ${errorMessage(error)}`);
		}
		return;
	}
	await runOn(
		service.serverId ?? null,
		`docker service scale ${q(service.appName)}=0 >/dev/null 2>&1 || true`,
	);
};

const startOnSource = async (service: TransferableService, log: Logger) => {
	if (isCompose(service)) {
		if (service.composeType === "stack") {
			log(
				"  Stack was removed on the source server, run Deploy to bring it back",
			);
			return;
		}
		try {
			await startCompose(service.composeId);
		} catch (error) {
			log(`  Could not start compose: ${errorMessage(error)}`);
		}
		return;
	}
	const replicas = isApplication(service) ? service.replicas : 1;
	await runOn(
		service.serverId ?? null,
		`docker service scale ${q(service.appName)}=${replicas} >/dev/null 2>&1 || true`,
	);
};

const resolveNetworkIds = async (
	networkIds: string[] | null | undefined,
	targetServerId: string | null,
) => {
	if (!networkIds || networkIds.length === 0) {
		return { kept: [] as string[], dropped: [] as string[] };
	}
	const rows = await db.query.network.findMany({
		where: inArray(network.networkId, networkIds),
		columns: { networkId: true, name: true, serverId: true },
	});
	return {
		kept: rows
			.filter((row) => (row.serverId ?? null) === targetServerId)
			.map((row) => row.networkId),
		dropped: rows
			.filter((row) => (row.serverId ?? null) !== targetServerId)
			.map((row) => row.name),
	};
};

const moveTraefikConfig = async (
	source: ApplicationService,
	moved: ApplicationService,
	log: Logger,
) => {
	const config = source.serverId
		? await readRemoteConfig(source.serverId, source.appName)
		: readConfig(source.appName);
	if (config) {
		if (moved.serverId) {
			await writeConfigRemote(moved.serverId, moved.appName, config);
		} else {
			writeConfig(moved.appName, config);
		}
	}
	for (const domain of moved.domains) {
		await manageDomain(moved, domain);
	}
	for (const security of moved.security) {
		await createSecurityMiddleware(moved, security);
	}
	for (const redirect of moved.redirects) {
		await createRedirectMiddleware(moved, redirect);
	}
	log(`  Traefik configuration recreated (${moved.domains.length} domains)`);
};

const removeSourceTraefikConfig = async (source: ApplicationService) => {
	for (const domain of source.domains) {
		await removePathMiddlewares(source, domain.uniqueConfigKey);
		await removeForwardAuthMiddleware(source, domain.uniqueConfigKey);
	}
	await deleteAllMiddlewares(source);
	await removeTraefikConfig(source.appName, source.serverId);
};

const moveDeploymentLogs = async (
	service: ApplicationService | ComposeService,
	targetServerId: string | null,
	log: Logger,
) => {
	const sourceServerId = service.serverId ?? null;
	const from = path.join(paths(!!sourceServerId).LOGS_PATH, service.appName);
	const to = path.join(paths(!!targetServerId).LOGS_PATH, service.appName);
	if (!(await directoryExists(sourceServerId, from))) return;

	log("Copying deployment logs");
	await copyStream(
		"deployment logs",
		{ serverId: sourceServerId, command: directoryExportCommand(from) },
		{ serverId: targetServerId, command: directoryImportCommand(to) },
		log,
	);
	if (from !== to) {
		await db
			.update(deployments)
			.set({ logPath: sql`replace(${deployments.logPath}, ${from}, ${to})` })
			.where(
				isCompose(service)
					? eq(deployments.composeId, service.composeId)
					: eq(deployments.applicationId, service.applicationId),
			);
	}
	await runOn(sourceServerId, `rm -rf ${q(from)}`);
};

const cleanupSource = async (
	service: TransferableService,
	volumes: string[],
	removeSourceData: boolean,
	log: Logger,
) => {
	const serverId = service.serverId ?? null;
	const steps: Array<() => Promise<unknown>> = [];

	if (isApplication(service)) {
		steps.push(
			() => removeSourceTraefikConfig(service),
			() => removeService(service.appName, serverId),
			() => removeDirectoryCode(service.appName, serverId),
			() => removeMonitoringDirectory(service.appName, serverId),
		);
	} else if (isCompose(service)) {
		steps.push(() => removeCompose(service, removeSourceData));
	} else {
		steps.push(
			() => removeService(service.appName, serverId),
			() => removeDirectoryCode(service.appName, serverId),
		);
	}
	if (removeSourceData && volumes.length > 0) {
		steps.push(() =>
			runOn(
				serverId,
				`docker volume rm ${volumes.map(q).join(" ")} >/dev/null 2>&1 || true`,
			),
		);
	}

	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			log(`  Warning: ${errorMessage(error)}`);
		}
	}
	if (!removeSourceData && volumes.length > 0) {
		log(`  Volumes kept on the source server: ${volumes.join(", ")}`);
	}
};

const deployOnTarget = async (
	serviceType: ServiceType,
	serviceId: string,
	targetName: string,
	log: Logger,
) => {
	log(`Deploying on ${targetName}`);
	const deployment = {
		titleLog: "Deploy after transfer",
		descriptionLog: `Transferred to ${targetName}`,
	};
	switch (serviceType) {
		case "application":
			log("Follow the Deployments tab for the build log");
			await updateStatus(serviceType, serviceId, "running");
			return await deployApplication({
				applicationId: serviceId,
				...deployment,
			});
		case "compose":
			log("Follow the Deployments tab for the build log");
			await updateStatus(serviceType, serviceId, "running");
			return await deployCompose({ composeId: serviceId, ...deployment });
		case "postgres":
			return await deployPostgres(serviceId, log);
		case "mysql":
			return await deployMySql(serviceId, log);
		case "mariadb":
			return await deployMariadb(serviceId, log);
		case "mongo":
			return await deployMongo(serviceId, log);
		case "redis":
			return await deployRedis(serviceId, log);
		case "libsql":
			return await deployLibsql(serviceId, log);
	}
};

const originalStatus = (service: TransferableService): ServiceStatus =>
	isCompose(service)
		? service.composeStatus
		: (service as { applicationStatus: ServiceStatus }).applicationStatus;

export interface StagedTransfer {
	serviceType: ServiceType;
	serviceId: string;
	/** The service as it was on the source server, before its record moved. */
	source: TransferableService;
	sourceServerId: string | null;
	targetServerId: string | null;
	sourceName: string;
	targetName: string;
	volumes: string[];
	bindMounts: string[];
	/** Has data that has to be copied with the source stopped, so it can't run on both servers at once. */
	stateful: boolean;
	status: ServiceStatus;
	sourceStopped: boolean;
	switched: boolean;
}

/** Validates the move and reads what it involves, without changing anything. */
export const prepareTransfer = async (
	input: Omit<TransferServiceInput, "removeSourceData">,
): Promise<StagedTransfer> => {
	const { serviceType, serviceId, targetServerId } = input;
	const service = await findService(serviceType, serviceId);

	if (service.environment.project.organizationId !== input.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to transfer this service",
		});
	}
	const sourceServerId = service.serverId ?? null;
	if (sourceServerId === targetServerId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The service is already on the selected server",
		});
	}
	const targetServer = targetServerId
		? await findServerById(targetServerId)
		: null;
	if (targetServer) {
		if (targetServer.organizationId !== input.organizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to use the target server",
			});
		}
		if (
			targetServer.serverStatus !== "active" ||
			!targetServer.serverRoles.includes("deploy")
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "The target server is not available for deployments",
			});
		}
	}

	const volumes = await listVolumes(service);
	const bindMounts = listBindMounts(service);
	return {
		serviceType,
		serviceId,
		source: service,
		sourceServerId,
		targetServerId,
		sourceName: service.server?.name ?? "Dokploy Server",
		targetName: targetServer?.name ?? "Dokploy Server",
		volumes,
		bindMounts,
		stateful:
			(!isApplication(service) && !isCompose(service)) ||
			volumes.length > 0 ||
			bindMounts.length > 0,
		status: originalStatus(service),
		sourceStopped: false,
		switched: false,
	};
};

/**
 * Brings the service up on the target. A stateless service keeps running on
 * the source meanwhile; a stateful one is stopped there so its data can be
 * copied consistently. Nothing is removed from the source, so a failure here
 * can always be undone with rollbackTransfer.
 */
export const stageTransfer = async (staged: StagedTransfer, log: Logger) => {
	const {
		serviceType,
		serviceId,
		source,
		sourceServerId,
		targetServerId,
		sourceName,
		targetName,
	} = staged;

	log(`Transferring ${source.appName} from ${sourceName} to ${targetName}`);
	await updateStatus(serviceType, serviceId, "running");

	if (staged.stateful) {
		log(`Stopping service on ${sourceName} to copy its data`);
		staged.sourceStopped = true;
		await stopOnSource(source, log);
		log(
			`Found ${staged.volumes.length} volume(s) and ${staged.bindMounts.length} bind mount(s)`,
		);
	} else {
		log(`No persistent data, ${sourceName} keeps serving it meanwhile`);
	}

	for (const volume of staged.volumes) {
		log(`Copying volume ${volume}`);
		await copyStream(
			volume,
			{ serverId: sourceServerId, command: volumeExportCommand(volume) },
			{ serverId: targetServerId, command: volumeImportCommand(volume) },
			log,
		);
	}
	for (const hostPath of staged.bindMounts) {
		if (!(await directoryExists(sourceServerId, hostPath))) {
			log(`Skipping bind mount ${hostPath}: not found on ${sourceName}`);
			continue;
		}
		log(`Copying bind mount ${hostPath}`);
		await copyStream(
			hostPath,
			{ serverId: sourceServerId, command: directoryExportCommand(hostPath) },
			{ serverId: targetServerId, command: directoryImportCommand(hostPath) },
			log,
		);
	}

	const originalNetworkIds =
		"networkIds" in source ? source.networkIds : undefined;
	const networks = await resolveNetworkIds(originalNetworkIds, targetServerId);
	if (networks.dropped.length > 0) {
		log(
			`Detaching networks not available on ${targetName}: ${networks.dropped.join(", ")}`,
		);
	}
	staged.switched = true;
	await updateServer(serviceType, serviceId, {
		serverId: targetServerId,
		networkIds: originalNetworkIds === undefined ? undefined : networks.kept,
	});
	const moved = await findService(serviceType, serviceId);

	const fileMounts = moved.mounts.filter((mount) => mount.type === "file");
	if (fileMounts.length > 0) {
		log(`Recreating ${fileMounts.length} file mount(s) on ${targetName}`);
		for (const mount of fileMounts) {
			await createFileMount(mount.mountId);
		}
	}
	if (isApplication(source) && isApplication(moved)) {
		log(`Recreating Traefik configuration on ${targetName}`);
		await moveTraefikConfig(source, moved, log);
	}

	await deployOnTarget(serviceType, serviceId, targetName, log);
};

const HEALTH_POLL_MS = 5_000;
const HEALTH_STABLE_MS = 15_000;

type HealthSnapshot =
	| { state: "healthy"; ids: string }
	| { state: "waiting" | "failed"; reason: string };

const swarmTasksSnapshot = (
	stdout: string,
	expected: number,
): HealthSnapshot => {
	const tasks = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [id = "", state = "", error = ""] = line.split("|");
			return { id, state, error };
		});
	const running = tasks.filter((task) => task.state.startsWith("Running"));
	if (running.length >= expected) {
		return {
			state: "healthy",
			ids: running
				.map((task) => task.id)
				.sort()
				.join(","),
		};
	}
	const failed = tasks.find((task) => /^(Failed|Rejected)/.test(task.state));
	if (failed) {
		return {
			state: "failed",
			reason: failed.error || failed.state,
		};
	}
	return {
		state: "waiting",
		reason: `${running.length}/${expected} task(s) running${tasks[0] ? ` (${tasks[0].state})` : ""}`,
	};
};

const composeContainersSnapshot = (stdout: string): HealthSnapshot => {
	const containers = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [id = "", name = "", state = "", status = ""] = line.split("|");
			return { id, name, state, status };
		});
	if (containers.length === 0) {
		return { state: "waiting", reason: "no containers yet" };
	}
	// One-shot containers (migrations, init jobs) legitimately exit with 0.
	const broken = containers.find(
		(c) =>
			c.state === "restarting" ||
			c.status.includes("(unhealthy)") ||
			(c.state === "exited" && !c.status.startsWith("Exited (0)")),
	);
	if (broken) {
		return {
			state: "waiting",
			reason: `${broken.name} is ${broken.status || broken.state}`,
		};
	}
	const starting = containers.find(
		(c) => c.state !== "running" && c.state !== "exited",
	);
	if (
		starting ||
		containers.some((c) => c.status.includes("health: starting"))
	) {
		return { state: "waiting", reason: "containers are starting" };
	}
	return {
		state: "healthy",
		ids: containers
			.filter((c) => c.state === "running")
			.map((c) => c.id)
			.sort()
			.join(","),
	};
};

const healthSnapshot = async (
	staged: StagedTransfer,
): Promise<HealthSnapshot> => {
	const { source, targetServerId } = staged;
	const name = q(source.appName);
	if (isCompose(source)) {
		if (source.composeType === "stack") {
			const { stdout } = await runOn(
				targetServerId,
				`docker stack ps ${name} --filter desired-state=running --format '{{.ID}}|{{.CurrentState}}|{{.Error}}' 2>/dev/null || true`,
			);
			return swarmTasksSnapshot(stdout, 1);
		}
		const { stdout } = await runOn(
			targetServerId,
			`docker ps -a --filter label=com.docker.compose.project=${name} --format '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}'`,
		);
		return composeContainersSnapshot(stdout);
	}
	const expected = isApplication(source) ? source.replicas : 1;
	if (expected === 0) return { state: "healthy", ids: "" };
	const { stdout } = await runOn(
		targetServerId,
		`docker service ps ${name} --filter desired-state=running --format '{{.ID}}|{{.CurrentState}}|{{.Error}}' 2>/dev/null || true`,
	);
	return swarmTasksSnapshot(stdout, expected);
};

/**
 * A deploy returns once Swarm has scheduled the task, so this waits until the
 * same containers have stayed up for a while, which catches crash loops.
 */
export const waitUntilHealthy = async (
	staged: StagedTransfer,
	log: Logger,
	timeoutMs = 5 * 60_000,
) => {
	const deadline = Date.now() + timeoutMs;
	let stableSince: number | null = null;
	let stableIds: string | null = null;
	let lastReason = "";

	while (Date.now() < deadline) {
		const snapshot = await healthSnapshot(staged);
		if (snapshot.state === "failed") {
			throw new Error(
				`${staged.source.appName} failed to start on ${staged.targetName}: ${snapshot.reason}`,
			);
		}
		if (snapshot.state === "healthy") {
			if (stableIds !== snapshot.ids) {
				stableIds = snapshot.ids;
				stableSince = Date.now();
			} else if (stableSince && Date.now() - stableSince >= HEALTH_STABLE_MS) {
				log(`${staged.source.appName} is running on ${staged.targetName}`);
				return;
			}
		} else {
			stableIds = null;
			stableSince = null;
			if (snapshot.reason !== lastReason) {
				lastReason = snapshot.reason;
				log(`Waiting for ${staged.source.appName}: ${snapshot.reason}`);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
	}
	throw new Error(
		`${staged.source.appName} did not become healthy on ${staged.targetName} within ${Math.round(timeoutMs / 60_000)} minutes${lastReason ? ` (${lastReason})` : ""}`,
	);
};

const removeFromTarget = async (staged: StagedTransfer) => {
	const moved = await findService(staged.serviceType, staged.serviceId);
	const serverId = staged.targetServerId;
	if (isApplication(moved)) {
		await removeSourceTraefikConfig(moved);
		await removeService(moved.appName, serverId);
		await removeDirectoryCode(moved.appName, serverId);
		await removeMonitoringDirectory(moved.appName, serverId);
	} else if (isCompose(moved)) {
		await removeCompose(moved, false);
	} else {
		await removeService(moved.appName, serverId);
		await removeDirectoryCode(moved.appName, serverId);
	}
};

/** Puts the service back on the source server as it was before stageTransfer. */
export const rollbackTransfer = async (staged: StagedTransfer, log: Logger) => {
	const { serviceType, serviceId, source, sourceName, targetName } = staged;
	log(`Rolling ${source.appName} back to ${sourceName}`);
	if (staged.switched) {
		try {
			await removeFromTarget(staged);
		} catch (error) {
			log(`  Could not remove it from ${targetName}: ${errorMessage(error)}`);
		}
		await updateServer(serviceType, serviceId, {
			serverId: staged.sourceServerId,
			networkIds: "networkIds" in source ? source.networkIds : undefined,
		});
		staged.switched = false;
	}
	if (staged.volumes.length > 0) {
		log(`  Data copied to ${targetName} was left in place`);
	}
	if (staged.sourceStopped) {
		if (isCompose(source) && source.composeType === "stack") {
			log(`  Redeploying the stack on ${sourceName}`);
			await deployCompose({
				composeId: source.composeId,
				titleLog: "Restore after failed transfer",
				descriptionLog: `Transfer to ${targetName} was rolled back`,
			});
		} else {
			await startOnSource(source, log);
		}
		staged.sourceStopped = false;
	}
	await updateStatus(serviceType, serviceId, staged.status);
};

/** Removes the old copy from the source server once the target is serving. */
export const commitTransfer = async (
	staged: StagedTransfer,
	removeSourceData: boolean,
	log: Logger,
) => {
	const { source, targetServerId, sourceName } = staged;
	if (isApplication(source) || isCompose(source)) {
		await moveDeploymentLogs(source, targetServerId, log);
	}
	log(`Cleaning up ${source.appName} on ${sourceName}`);
	await cleanupSource(source, staged.volumes, removeSourceData, log);
	await updateStatus(staged.serviceType, staged.serviceId, "done");
};

/** Compares source and target CPUs and, if they differ, what that breaks. */
export const checkTransferArchitecture = async (
	input: Omit<TransferServiceInput, "removeSourceData">,
) => {
	const staged = await prepareTransfer(input);
	const [source, target] = await Promise.all([
		detectServerArchitecture(staged.sourceServerId),
		detectServerArchitecture(staged.targetServerId),
	]);
	const mismatch = !!source && !!target && source !== target;
	const check =
		mismatch && target
			? (
					await checkServicesArchitecture(
						staged.sourceServerId,
						[
							{
								id: staged.serviceId,
								type: staged.serviceType,
								appName: staged.source.appName,
								stateful: staged.stateful,
							},
						],
						target,
					)
				).get(staged.serviceId)
			: undefined;
	return {
		source,
		target,
		mismatch,
		sourceName: staged.sourceName,
		targetName: staged.targetName,
		check,
	};
};

export const transferService = async (
	input: TransferServiceInput,
	log: Logger,
) => {
	const architecture = await checkTransferArchitecture(input).catch(() => null);
	if (architecture?.mismatch) {
		log(
			`Warning: ${architecture.sourceName} is ${architecture.source} but ${architecture.targetName} is ${architecture.target}`,
		);
		if (architecture.check && architecture.check.status !== "ok") {
			log(`Warning: ${architecture.check.message}`);
		}
		if (architecture.check?.dataWarning) {
			log(`Warning: ${architecture.check.dataWarning}`);
		}
	}
	const staged = await prepareTransfer(input);
	try {
		await stageTransfer(staged, log);
		await waitUntilHealthy(staged, log);
	} catch (error) {
		log(`Transfer failed: ${errorMessage(error)}`);
		try {
			await rollbackTransfer(staged, log);
		} catch (rollbackError) {
			await updateStatus(staged.serviceType, staged.serviceId, "error");
			log(`Rollback failed: ${errorMessage(rollbackError)}`);
		}
		throw error;
	}
	await commitTransfer(staged, input.removeSourceData, log);

	return {
		serviceType: staged.serviceType,
		serviceId: staged.serviceId,
		appName: staged.source.appName,
		targetServerId: staged.targetServerId,
		targetName: staged.targetName,
	};
};
