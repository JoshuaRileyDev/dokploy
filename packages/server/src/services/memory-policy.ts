import { quote } from "shell-quote";
import type { MemoryPolicy } from "../db/schema/shared";
import type { ComposeSpecification } from "../utils/docker/types";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { findServerById } from "./server";
import { getWebServerSettings } from "./web-server-settings";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const EMPTY_MEMORY_POLICY: MemoryPolicy = {
	defaultMemoryLimit: null,
	reservedMemory: null,
};

export const getMemoryPolicy = async (
	serverId: string | null | undefined,
): Promise<MemoryPolicy> => {
	const stored = serverId
		? (await findServerById(serverId)).forkMemoryPolicy
		: (await getWebServerSettings())?.forkMemoryPolicy;
	return { ...EMPTY_MEMORY_POLICY, ...stored };
};

/**
 * Headroom kept for the OS, Docker, Traefik and Dokploy itself when the admin
 * hasn't set one: 10% of RAM, but never less than 512 MB or more than 2 GB.
 */
export const autoReservedMemory = (totalMemory: number) =>
	Math.min(2 * GB, Math.max(512 * MB, Math.round(totalMemory * 0.1)));

/**
 * Picks the limit for a Swarm service: its own limit if set, else the server
 * default. Raised to the reservation when needed, since Docker rejects a
 * reservation above the limit.
 */
export const resolveMemoryLimit = (
	memoryLimit: string | null,
	memoryReservation: string | null,
	policy: MemoryPolicy,
): string | null => {
	if (memoryLimit) return memoryLimit;
	if (!policy.defaultMemoryLimit) return null;
	const reservation = Number.parseInt(memoryReservation ?? "") || 0;
	return String(Math.max(policy.defaultMemoryLimit, reservation));
};

export const resolveServiceMemoryLimit = async (service: {
	serverId: string | null;
	memoryLimit: string | null;
	memoryReservation: string | null;
}) =>
	resolveMemoryLimit(
		service.memoryLimit,
		service.memoryReservation,
		await getMemoryPolicy(service.serverId),
	);

const UNIT_BYTES: Record<string, number> = {
	"": 1,
	b: 1,
	k: 1024,
	kb: 1024,
	m: MB,
	mb: MB,
	g: GB,
	gb: GB,
	t: 1024 * GB,
	tb: 1024 * GB,
};

/** Parses compose byte values ("512m", "1.5g", 1073741824); null if unparseable. */
export const parseMemoryBytes = (
	value: string | number | null | undefined,
): number | null => {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
	if (!match?.[1]) return null;
	const multiplier = UNIT_BYTES[(match[2] ?? "").toLowerCase()];
	if (multiplier === undefined) return null;
	return Math.round(Number.parseFloat(match[1]) * multiplier);
};

/**
 * Gives every compose service without a memory limit the server default.
 * Services that set `mem_limit` or `deploy.resources.limits.memory` are left
 * alone, as are ones whose values we can't parse, so a user's explicit choice
 * always wins.
 */
export const applyMemoryPolicyToCompose = (
	spec: ComposeSpecification,
	policy: MemoryPolicy,
): ComposeSpecification => {
	const defaultLimit = policy.defaultMemoryLimit;
	if (!defaultLimit) return spec;
	const result = structuredClone(spec);
	for (const service of Object.values(result.services ?? {})) {
		if (!service) continue;
		if (
			service.mem_limit !== undefined ||
			service.deploy?.resources?.limits?.memory !== undefined
		) {
			continue;
		}
		const rawReservation =
			service.mem_reservation ??
			service.deploy?.resources?.reservations?.memory;
		const reservation = parseMemoryBytes(rawReservation);
		if (rawReservation !== undefined && reservation === null) continue;
		const limit = Math.max(defaultLimit, reservation ?? 0);

		// `deploy.resources` works for both `docker compose` and `docker stack`,
		// whereas `mem_limit` is ignored by stacks.
		service.deploy ??= {};
		service.deploy.resources ??= {};
		service.deploy.resources.limits ??= {};
		service.deploy.resources.limits.memory = `${Math.ceil(limit / MB)}M`;
	}
	return result;
};

const runOnServer = (serverId: string | null | undefined, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

const FIELD_SEPARATOR = "|";

const inspectFields = [
	"{{.Name}}",
	"{{.HostConfig.Memory}}",
	"{{.State.Status}}",
	"{{.State.OOMKilled}}",
	"{{.State.FinishedAt}}",
	"{{.State.ExitCode}}",
	'{{index .Config.Labels "com.docker.swarm.service.name"}}',
	'{{index .Config.Labels "com.docker.compose.project"}}',
	'{{index .Config.Labels "com.docker.compose.service"}}',
	'{{index .Config.Labels "com.docker.stack.namespace"}}',
	'{{index .Config.Labels "dokploy.organization.id"}}',
	'{{index .Config.Labels "dokploy.project"}}',
	'{{index .Config.Labels "dokploy.application"}}',
	'{{index .Config.Labels "dokploy.service"}}',
].join(FIELD_SEPARATOR);

interface InspectedContainer {
	name: string;
	memoryLimit: number;
	status: string;
	oomKilled: boolean;
	finishedAt: string | null;
	exitCode: number;
	swarmService: string;
	composeProject: string;
	composeService: string;
	stackNamespace: string;
	organizationId: string;
	projectName: string;
	applicationName: string;
	serviceName: string;
}

const parseInspectLine = (line: string): InspectedContainer | null => {
	const parts = line.split(FIELD_SEPARATOR);
	if (parts.length < 14) return null;
	const [
		name = "",
		memory = "0",
		status = "",
		oomKilled = "false",
		finishedAt = "",
		exitCode = "0",
		swarmService = "",
		composeProject = "",
		composeService = "",
		stackNamespace = "",
		organizationId = "",
		projectName = "",
		applicationName = "",
		serviceName = "",
	] = parts;
	return {
		name: name.replace(/^\//, ""),
		memoryLimit: Number.parseInt(memory) || 0,
		status,
		oomKilled: oomKilled === "true",
		finishedAt:
			finishedAt && !finishedAt.startsWith("0001-") ? finishedAt : null,
		exitCode: Number.parseInt(exitCode) || 0,
		swarmService,
		composeProject,
		composeService,
		stackNamespace,
		organizationId,
		projectName,
		applicationName,
		serviceName,
	};
};

const inspectContainers = async (
	serverId: string | null | undefined,
	psArgs: string,
) => {
	const command = `docker ps -q ${psArgs} | xargs -r docker inspect --format ${quote([inspectFields])}`;
	const { stdout } = await runOnServer(serverId, command);
	return stdout
		.split("\n")
		.filter(Boolean)
		.map(parseInspectLine)
		.filter((container): container is InspectedContainer => !!container);
};

export interface MemoryBudgetEntry {
	key: string;
	label: string;
	detail: string | null;
	containers: number;
	unlimitedContainers: number;
	memoryLimit: number;
	managed: boolean;
}

export interface MemoryBudget {
	totalMemory: number;
	reservedMemory: number;
	reservedIsAuto: boolean;
	availableMemory: number;
	committedMemory: number;
	unlimitedContainers: number;
	policy: MemoryPolicy;
	entries: MemoryBudgetEntry[];
}

/**
 * Sums the memory limits of running containers on a server against its RAM.
 * Containers from other organizations on a shared host count towards the
 * total but are grouped anonymously so their names don't leak.
 */
export const getMemoryBudget = async (
	serverId: string | null | undefined,
	organizationId: string,
): Promise<MemoryBudget> => {
	const [{ stdout: memTotal }, containers, policy] = await Promise.all([
		runOnServer(serverId, "docker info --format '{{.MemTotal}}'"),
		inspectContainers(serverId, ""),
		getMemoryPolicy(serverId),
	]);
	const totalMemory = Number.parseInt(memTotal.trim()) || 0;
	const reservedIsAuto = policy.reservedMemory === null;
	const reservedMemory = reservedIsAuto
		? autoReservedMemory(totalMemory)
		: (policy.reservedMemory ?? 0);

	const entries = new Map<string, MemoryBudgetEntry>();
	for (const container of containers) {
		const foreign =
			!!container.organizationId && container.organizationId !== organizationId;
		const owner = foreign
			? "foreign"
			: container.stackNamespace ||
				container.swarmService ||
				container.composeProject ||
				container.name;
		const entry = entries.get(owner) ?? {
			key: owner,
			label: foreign
				? "Other organizations"
				: container.applicationName || owner,
			detail: foreign
				? null
				: container.projectName
					? `${container.projectName} · ${owner}`
					: owner,
			containers: 0,
			unlimitedContainers: 0,
			memoryLimit: 0,
			managed: foreign || !!container.applicationName,
		};
		entry.containers += 1;
		if (container.memoryLimit > 0) {
			entry.memoryLimit += container.memoryLimit;
		} else {
			entry.unlimitedContainers += 1;
		}
		entries.set(owner, entry);
	}

	const sorted = [...entries.values()].sort(
		(a, b) =>
			b.unlimitedContainers - a.unlimitedContainers ||
			b.memoryLimit - a.memoryLimit,
	);

	return {
		totalMemory,
		reservedMemory,
		reservedIsAuto,
		availableMemory: Math.max(0, totalMemory - reservedMemory),
		committedMemory: sorted.reduce((sum, e) => sum + e.memoryLimit, 0),
		unlimitedContainers: sorted.reduce(
			(sum, e) => sum + e.unlimitedContainers,
			0,
		),
		policy,
		entries: sorted,
	};
};

export type OomServiceType = "application" | "stack" | "docker-compose";

export interface OomKill {
	container: string;
	service: string | null;
	finishedAt: string | null;
	memoryLimit: number;
}

/**
 * Lists stopped containers of a service that the kernel killed for exceeding
 * their memory limit. Swarm keeps a few exited task containers per service
 * (task-history-limit), so recent OOM restarts stay visible.
 */
export const getOomKills = async (
	appName: string,
	type: OomServiceType,
	serverId: string | null | undefined,
): Promise<OomKill[]> => {
	const label =
		type === "docker-compose"
			? `com.docker.compose.project=${appName}`
			: type === "stack"
				? `com.docker.stack.namespace=${appName}`
				: `com.docker.swarm.service.name=${appName}`;
	const containers = await inspectContainers(
		serverId,
		`-a --filter status=exited --filter ${quote([`label=${label}`])}`,
	);
	return containers
		.filter((container) => container.oomKilled)
		.map((container) => ({
			container: container.name,
			service: container.composeService || container.serviceName || null,
			finishedAt: container.finishedAt,
			memoryLimit: container.memoryLimit,
		}))
		.sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
};
