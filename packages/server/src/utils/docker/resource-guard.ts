import { db } from "@dokploy/server/db";
import { server } from "@dokploy/server/db/schema";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "@dokploy/server/services/web-server-settings";
import type { ResourceRequirements } from "dockerode";
import { eq } from "drizzle-orm";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { getRemoteDocker } from "../servers/remote-docker";
import type { ComposeSpecification } from "./types";

declare module "dockerode" {
	interface ContainerSpec {
		// Engine API 1.46+ (Docker 27); older daemons ignore the field.
		OomScoreAdj?: number;
	}
}

const MIB = 1024 ** 2;
const NANO_CPUS_PER_CORE = 1e9;

// Raised for every user workload so the kernel OOM killer picks them before
// Dokploy, Traefik and the platform database (all left at 0). Databases sit
// below apps because losing a stateless app is cheaper than losing a DB.
export const APP_OOM_SCORE_ADJ = 500;
export const DATABASE_OOM_SCORE_ADJ = 300;

export const DEFAULT_APP_MEMORY_PERCENT = 25;
const MIN_DEFAULT_LIMIT_BYTES = 128 * MIB;
// Dokploy, Traefik and the platform Postgres/Redis live on the Dokploy host;
// a remote server only runs Traefik and the monitoring agents.
const MIN_RESERVE_DOKPLOY_HOST_BYTES = 1024 * MIB;
const MIN_RESERVE_REMOTE_BYTES = 512 * MIB;
const PLATFORM_CPU_RESERVE_NANO = 0.5 * NANO_CPUS_PER_CORE;

export type ResourceGuardSettings = {
	reservedMemoryMb: number | null;
	appMemoryPercent: number;
};

export type HostCapacity = {
	memoryBytes: number;
	nanoCpus: number;
};

export type ResourceGuardPolicy = {
	hostMemoryBytes: number;
	hostNanoCpus: number;
	platformReserveBytes: number;
	reserveIsAuto: boolean;
	allocatableMemoryBytes: number;
	appMemoryPercent: number;
	defaultMemoryLimitBytes: number;
	maxNanoCpus: number | null;
};

export const computeResourceGuardPolicy = (
	capacity: HostCapacity,
	settings: ResourceGuardSettings,
	isDokployHost: boolean,
): ResourceGuardPolicy => {
	const reserveIsAuto = settings.reservedMemoryMb === null;
	const autoReserve = Math.max(
		isDokployHost ? MIN_RESERVE_DOKPLOY_HOST_BYTES : MIN_RESERVE_REMOTE_BYTES,
		Math.round(capacity.memoryBytes * 0.1),
	);
	const platformReserveBytes = reserveIsAuto
		? autoReserve
		: (settings.reservedMemoryMb ?? 0) * MIB;
	const allocatableMemoryBytes = Math.max(
		capacity.memoryBytes - platformReserveBytes,
		Math.min(capacity.memoryBytes, MIN_DEFAULT_LIMIT_BYTES),
	);
	const percent = Math.min(100, Math.max(1, settings.appMemoryPercent));
	const defaultMemoryLimitBytes = Math.max(
		Math.floor((allocatableMemoryBytes * percent) / 100),
		Math.min(allocatableMemoryBytes, MIN_DEFAULT_LIMIT_BYTES),
	);
	// On a single core, holding back half of it would halve every app; CPU
	// contention only slows things down, so the cap isn't worth that there.
	const maxNanoCpus =
		capacity.nanoCpus >= 2 * NANO_CPUS_PER_CORE
			? capacity.nanoCpus - PLATFORM_CPU_RESERVE_NANO
			: null;

	return {
		hostMemoryBytes: capacity.memoryBytes,
		hostNanoCpus: capacity.nanoCpus,
		platformReserveBytes,
		reserveIsAuto,
		allocatableMemoryBytes,
		appMemoryPercent: percent,
		defaultMemoryLimitBytes,
		maxNanoCpus,
	};
};

const capOrDefault = (
	value: number | undefined,
	fallback: number,
	max: number,
): number => (value && value > 0 ? Math.min(value, max) : fallback);

export const guardResources = (
	resources: ResourceRequirements,
	policy: ResourceGuardPolicy | null,
): ResourceRequirements => {
	if (!policy) return resources;

	const memoryLimit = capOrDefault(
		resources.Limits?.MemoryBytes,
		policy.defaultMemoryLimitBytes,
		policy.allocatableMemoryBytes,
	);
	const cpuLimit = policy.maxNanoCpus
		? capOrDefault(
				resources.Limits?.NanoCPUs,
				policy.maxNanoCpus,
				policy.maxNanoCpus,
			)
		: resources.Limits?.NanoCPUs;

	// Swarm rejects a reservation above the limit, and the limit may have just been lowered.
	const memoryReservation = resources.Reservations?.MemoryBytes;
	const cpuReservation = resources.Reservations?.NanoCPUs;

	return {
		Limits: {
			MemoryBytes: memoryLimit,
			NanoCPUs: cpuLimit,
		},
		Reservations: {
			MemoryBytes:
				memoryReservation !== undefined
					? Math.min(memoryReservation, memoryLimit)
					: undefined,
			NanoCPUs:
				cpuReservation !== undefined && cpuLimit
					? Math.min(cpuReservation, cpuLimit)
					: cpuReservation,
		},
	};
};

const MEMORY_UNITS: Record<string, number> = {
	"": 1,
	b: 1,
	k: 1024,
	kb: 1024,
	m: MIB,
	mb: MIB,
	g: 1024 ** 3,
	gb: 1024 ** 3,
};

/** Bytes for a compose memory value ("512m", "1.5g", 1073741824), or null if it can't be read (e.g. `${VAR}`). */
export const parseComposeMemory = (
	value: number | string | undefined | null,
): number | null => {
	if (value === undefined || value === null) return null;
	if (typeof value === "number") return value > 0 ? value : null;
	const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?b?)\s*$/i.exec(value);
	if (!match?.[1]) return null;
	const multiplier = MEMORY_UNITS[(match[2] ?? "").toLowerCase()];
	if (multiplier === undefined) return null;
	const bytes = Math.floor(Number.parseFloat(match[1]) * multiplier);
	return bytes > 0 ? bytes : null;
};

const parseComposeCpus = (
	value: number | string | undefined | null,
): number | null => {
	if (value === undefined || value === null) return null;
	const cpus = typeof value === "number" ? value : Number(value);
	return Number.isFinite(cpus) && cpus > 0 ? cpus : null;
};

const toComposeMemory = (bytes: number) => `${Math.floor(bytes / MIB)}M`;

export const formatGuardMemory = (bytes: number) =>
	bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GB`
		: `${Math.round(bytes / MIB)} MB`;
const toComposeCpus = (nanoCpus: number) =>
	(nanoCpus / NANO_CPUS_PER_CORE).toFixed(2);

/**
 * Gives every compose service a memory/CPU cap and a raised OOM score.
 * Limits the file already sets are kept (and capped to what the server can
 * spare); values that can't be parsed, like `${VAR}`, are left untouched.
 */
export const applyResourceGuardToCompose = (
	spec: ComposeSpecification,
	policy: ResourceGuardPolicy | null,
	composeType: "docker-compose" | "stack",
): ComposeSpecification => {
	if (!policy) return spec;
	const result = structuredClone(spec);

	for (const service of Object.values(result.services ?? {})) {
		if (!service) continue;

		// `mem_limit`/`cpus` only apply to `docker compose`; stack deploy reads `deploy.resources`.
		const legacyMemory =
			composeType === "docker-compose" ? service.mem_limit : undefined;
		const legacyCpus =
			composeType === "docker-compose" ? service.cpus : undefined;
		const limits = service.deploy?.resources?.limits;
		const rawMemory = limits?.memory ?? legacyMemory;
		const rawCpus = limits?.cpus ?? legacyCpus;
		const memory = parseComposeMemory(rawMemory);
		const cpus = parseComposeCpus(rawCpus);

		const nextLimits = { ...(limits ?? {}) };
		let changed = false;

		if (rawMemory === undefined || rawMemory === null) {
			nextLimits.memory = toComposeMemory(policy.defaultMemoryLimitBytes);
			changed = true;
		} else if (memory !== null && memory > policy.allocatableMemoryBytes) {
			nextLimits.memory = toComposeMemory(policy.allocatableMemoryBytes);
			if (legacyMemory !== undefined) delete service.mem_limit;
			changed = true;
		}

		if (policy.maxNanoCpus) {
			const maxCpus = policy.maxNanoCpus / NANO_CPUS_PER_CORE;
			if (rawCpus === undefined || rawCpus === null) {
				nextLimits.cpus = toComposeCpus(policy.maxNanoCpus);
				changed = true;
			} else if (cpus !== null && cpus > maxCpus) {
				nextLimits.cpus = toComposeCpus(policy.maxNanoCpus);
				if (legacyCpus !== undefined) delete service.cpus;
				changed = true;
			}
		}

		if (changed) {
			service.deploy = {
				...(service.deploy ?? {}),
				resources: {
					...(service.deploy?.resources ?? {}),
					limits: nextLimits,
				},
			};
		}

		if (service.oom_score_adj === undefined) {
			service.oom_score_adj = APP_OOM_SCORE_ADJ;
		}
	}

	return result;
};

const readHostCapacity = async (
	serverId: string | null | undefined,
): Promise<HostCapacity> => {
	const docker = await getRemoteDocker(serverId);
	try {
		// Swarm can place a task on any ready node, so size against the smallest one.
		const nodes = await docker.listNodes();
		const ready = nodes
			.filter((node) => node.Status?.State === "ready")
			.map((node) => node.Description?.Resources)
			.filter(
				(r): r is { MemoryBytes: number; NanoCPUs: number } =>
					!!r?.MemoryBytes && !!r?.NanoCPUs,
			);
		if (ready.length > 0) {
			return {
				memoryBytes: Math.min(...ready.map((r) => r.MemoryBytes)),
				nanoCpus: Math.min(...ready.map((r) => r.NanoCPUs)),
			};
		}
	} catch {
		// Not a swarm manager; fall back to this engine's own totals.
	}
	const info = await docker.info();
	return {
		memoryBytes: Number(info.MemTotal) || 0,
		nanoCpus: (Number(info.NCPU) || 0) * NANO_CPUS_PER_CORE,
	};
};

export const getResourceGuardSettings = async (
	serverId: string | null | undefined,
): Promise<ResourceGuardSettings> => {
	if (serverId) {
		const row = await db.query.server.findFirst({
			where: eq(server.serverId, serverId),
			columns: {
				forkGuardReservedMemoryMb: true,
				forkGuardAppMemoryPercent: true,
			},
		});
		return {
			reservedMemoryMb: row?.forkGuardReservedMemoryMb ?? null,
			appMemoryPercent:
				row?.forkGuardAppMemoryPercent ?? DEFAULT_APP_MEMORY_PERCENT,
		};
	}
	const settings = await getWebServerSettings();
	return {
		reservedMemoryMb: settings?.forkGuardReservedMemoryMb ?? null,
		appMemoryPercent:
			settings?.forkGuardAppMemoryPercent ?? DEFAULT_APP_MEMORY_PERCENT,
	};
};

export const updateResourceGuardSettings = async (
	serverId: string | null | undefined,
	settings: ResourceGuardSettings,
) => {
	const values = {
		forkGuardReservedMemoryMb: settings.reservedMemoryMb,
		forkGuardAppMemoryPercent: settings.appMemoryPercent,
	};
	if (serverId) {
		await db.update(server).set(values).where(eq(server.serverId, serverId));
	} else {
		await updateWebServerSettings(values);
	}
};

/**
 * Null when the server's capacity can't be read: the deploy then goes ahead
 * with the service's own limits rather than failing on a monitoring hiccup.
 */
export const getResourceGuardPolicy = async (
	serverId: string | null | undefined,
): Promise<ResourceGuardPolicy | null> => {
	try {
		const capacity = await readHostCapacity(serverId);
		if (capacity.memoryBytes <= 0) return null;
		const settings = await getResourceGuardSettings(serverId);
		return computeResourceGuardPolicy(capacity, settings, !serverId);
	} catch (error) {
		console.warn(
			`Resource guard: could not read capacity for ${serverId ?? "the Dokploy server"}, deploying without it`,
			error,
		);
		return null;
	}
};

export type ServiceMemorySample = {
	name: string;
	containers: number;
	currentBytes: number;
	/** Highest usage since the containers started; null where the host's cgroups can't be read. */
	peakBytes: number | null;
};

export type CapacityEstimate = {
	services: ServiceMemorySample[];
	usedNowBytes: number;
	usedAtPeakBytes: number;
	peaksKnown: boolean;
	typicalServiceBytes: number;
	/** If every service hit its peak at the same time. */
	moreServicesLow: number;
	/** At current usage. */
	moreServicesHigh: number;
	overcommittedAtPeak: boolean;
};

// Dokploy's own containers are covered by the platform reserve, not counted as services.
const isPlatformService = (name: string) =>
	name === "dokploy" || name.startsWith("dokploy-");

const DOCKER_SIZE_UNITS: Record<string, number> = {
	b: 1,
	kb: 1000,
	kib: 1024,
	mb: 1000 ** 2,
	mib: MIB,
	gb: 1000 ** 3,
	gib: 1024 ** 3,
	tb: 1000 ** 4,
	tib: 1024 ** 4,
};

/** Bytes for the usage half of `docker stats` MemUsage ("135.7MiB / 7.57GiB"). */
export const parseDockerStatsMemory = (value: string): number => {
	const match = /^\s*([\d.]+)\s*([a-z]+)/i.exec(value);
	if (!match?.[1] || !match[2]) return 0;
	const unit = DOCKER_SIZE_UNITS[match[2].toLowerCase()];
	return unit ? Math.round(Number.parseFloat(match[1]) * unit) : 0;
};

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length === 0) return 0;
	return sorted.length % 2
		? (sorted[mid] ?? 0)
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

export const estimateCapacity = (
	policy: ResourceGuardPolicy,
	samples: ServiceMemorySample[],
	hostAvailableBytes: number | null,
): CapacityEstimate => {
	const services = samples
		.filter((s) => !isPlatformService(s.name))
		.sort(
			(a, b) =>
				(b.peakBytes ?? b.currentBytes) - (a.peakBytes ?? a.currentBytes),
		);
	const usedNowBytes = services.reduce((sum, s) => sum + s.currentBytes, 0);
	const usedAtPeakBytes = services.reduce(
		(sum, s) => sum + Math.max(s.peakBytes ?? 0, s.currentBytes),
		0,
	);
	// The median, not the mean: one heavy service shouldn't make every new one look heavy.
	const typicalServiceBytes = Math.max(
		median(services.map((s) => Math.max(s.peakBytes ?? 0, s.currentBytes))),
		64 * MIB,
	);

	const platformNowBytes = samples
		.filter((s) => isPlatformService(s.name))
		.reduce((sum, s) => sum + s.currentBytes, 0);
	// Memory used outside these containers (the OS, Docker itself) only shows in what the
	// host reports free, and part of that free memory is the platform reserve's unused share.
	const hostHeadroom =
		hostAvailableBytes === null
			? Number.POSITIVE_INFINITY
			: hostAvailableBytes -
				Math.max(0, policy.platformReserveBytes - platformNowBytes);
	const headroomNow = Math.min(
		policy.allocatableMemoryBytes - usedNowBytes,
		hostHeadroom,
	);
	const headroomAtPeak = Math.min(
		policy.allocatableMemoryBytes - usedAtPeakBytes,
		headroomNow,
	);
	const fit = (bytes: number) =>
		Math.max(0, Math.floor(bytes / typicalServiceBytes));

	return {
		services,
		usedNowBytes,
		usedAtPeakBytes,
		peaksKnown: services.some((s) => s.peakBytes !== null),
		typicalServiceBytes,
		moreServicesLow: fit(headroomAtPeak),
		moreServicesHigh: fit(headroomNow),
		overcommittedAtPeak: usedAtPeakBytes > policy.allocatableMemoryBytes,
	};
};

// Containers are grouped the way Dokploy deploys them: a compose project or a Swarm service.
// memory.peak needs cgroup v2 and access to the host's cgroups; it's missing from inside the
// Dokploy container on its own host, so peaks there fall back to current usage.
const MEMORY_USAGE_SCRIPT = `
echo "==containers"
docker ps --no-trunc --format '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.swarm.service.name"}}' 2>/dev/null
echo "==stats"
docker stats --no-stream --no-trunc --format '{{.ID}}|{{.MemUsage}}' 2>/dev/null
echo "==peaks"
for id in $(docker ps -q --no-trunc 2>/dev/null); do
  for f in /sys/fs/cgroup/system.slice/docker-$id.scope/memory.peak /sys/fs/cgroup/docker/$id/memory.peak; do
    if [ -r "$f" ]; then echo "$id|$(cat "$f")"; break; fi
  done
done
echo "==available"
awk '/^MemAvailable:/{print $2 * 1024}' /proc/meminfo 2>/dev/null
`;

export const parseMemoryUsageOutput = (
	stdout: string,
): { samples: ServiceMemorySample[]; hostAvailableBytes: number | null } => {
	const sections: Record<string, string[]> = {};
	let current = "";
	for (const line of stdout.split("\n")) {
		const header = /^==(\w+)$/.exec(line.trim());
		if (header?.[1]) {
			current = header[1];
			sections[current] = [];
		} else if (current && line.trim()) {
			sections[current]?.push(line.trim());
		}
	}

	const usage = new Map<string, number>();
	for (const line of sections.stats ?? []) {
		const [id, mem] = line.split("|");
		if (id && mem) usage.set(id, parseDockerStatsMemory(mem));
	}
	const peaks = new Map<string, number>();
	for (const line of sections.peaks ?? []) {
		const [id, peak] = line.split("|");
		const bytes = Number(peak);
		if (id && Number.isFinite(bytes)) peaks.set(id, bytes);
	}

	const groups = new Map<string, ServiceMemorySample>();
	for (const line of sections.containers ?? []) {
		const [id, name, composeProject, swarmService] = line.split("|");
		if (!id || !name) continue;
		const key = composeProject || swarmService || name;
		const group = groups.get(key) ?? {
			name: key,
			containers: 0,
			currentBytes: 0,
			peakBytes: null,
		};
		group.containers += 1;
		group.currentBytes += usage.get(id) ?? 0;
		const peak = peaks.get(id);
		if (peak !== undefined) group.peakBytes = (group.peakBytes ?? 0) + peak;
		groups.set(key, group);
	}

	const available = Number(sections.available?.[0]);
	return {
		samples: [...groups.values()],
		hostAvailableBytes:
			Number.isFinite(available) && available > 0 ? available : null,
	};
};

export const getCapacityEstimate = async (
	serverId: string | null | undefined,
	policy: ResourceGuardPolicy,
): Promise<CapacityEstimate> => {
	const { stdout } = serverId
		? await execAsyncRemote(serverId, MEMORY_USAGE_SCRIPT)
		: await execAsync(MEMORY_USAGE_SCRIPT);
	const { samples, hostAvailableBytes } = parseMemoryUsageOutput(stdout);
	return estimateCapacity(policy, samples, hostAvailableBytes);
};
