import { createHash } from "node:crypto";
import { quote } from "shell-quote";
import { execAsyncRemote } from "../process/execAsync";
import { formatGuardMemory, type ResourceGuardPolicy } from "./resource-guard";
import type { ComposeSpecification } from "./types";

const MIB = 1024 ** 2;
const NANO_CPUS_PER_CORE = 1e9;

// Without its own budget, one compose stack may use this much of the server between all its services, so a busy
// one always leaves the rest for its neighbours. Per-service caps alone don't do that: three services at 25% each,
// or one at "all but half a core" each, add up to most of the server.
export const DEFAULT_COMPOSE_SHARE_PERCENT = 50;

export type ComposeBudget = {
	/** Null leaves CPU unlimited, as on a single-core server. */
	nanoCpus: number | null;
	memoryBytes: number;
};

export type ComposeBudgetOverrides = {
	cpus: number | null;
	memoryMb: number | null;
};

/** What a compose stack may use in total: its own budget if it has one, else a share of the server. */
export const computeComposeBudget = (
	policy: ResourceGuardPolicy,
	overrides: ComposeBudgetOverrides,
): ComposeBudget => {
	const shareCpus = policy.maxNanoCpus
		? Math.max(
				NANO_CPUS_PER_CORE,
				Math.floor((policy.hostNanoCpus * DEFAULT_COMPOSE_SHARE_PERCENT) / 100),
			)
		: null;
	const shareMemory = Math.max(
		Math.floor(
			(policy.allocatableMemoryBytes * DEFAULT_COMPOSE_SHARE_PERCENT) / 100,
		),
		policy.defaultMemoryLimitBytes,
	);
	return {
		nanoCpus:
			overrides.cpus && overrides.cpus > 0
				? Math.min(
						Math.round(overrides.cpus * NANO_CPUS_PER_CORE),
						policy.hostNanoCpus,
					)
				: shareCpus,
		memoryBytes:
			overrides.memoryMb && overrides.memoryMb > 0
				? Math.min(overrides.memoryMb * MIB, policy.allocatableMemoryBytes)
				: shareMemory,
	};
};

/**
 * The systemd slice a compose stack's containers share. A hyphen in a slice name means nesting (`a-b.slice` lives
 * inside `a.slice`), so everything but letters, digits and underscores becomes an underscore, and a short hash of the
 * real name keeps `shop-api` and `shop_api` apart.
 */
export const composeSliceName = (appName: string) =>
	`dokploy_${appName.replace(/[^a-zA-Z0-9_]/g, "_")}_${createHash("sha256").update(appName).digest("hex").slice(0, 8)}.slice`;

export const formatComposeBudget = (budget: ComposeBudget) =>
	`${budget.nanoCpus ? `${(budget.nanoCpus / NANO_CPUS_PER_CORE).toFixed(2)} CPUs` : "unlimited CPU"}, ${formatGuardMemory(budget.memoryBytes)}`;

/**
 * Creates or updates the slice on the server; daemon-reload applies a change to a running slice, a CPU limit removed
 * included. Prints OK when the stack can use it, or SKIP and why: Docker has to
 * manage cgroups through systemd (cgroup v2), and writing the unit needs root.
 */
export const composeBudgetScript = (slice: string, budget: ComposeBudget) => {
	const properties = [
		...(budget.nanoCpus
			? [
					`CPUQuota=${Math.round((budget.nanoCpus / NANO_CPUS_PER_CORE) * 100)}%`,
				]
			: []),
		`MemoryMax=${Math.floor(budget.memoryBytes / MIB)}M`,
	];
	const unit = `[Unit]\nDescription=Dokploy budget for ${slice}\n\n[Slice]\n${properties.join("\n")}\n`;
	return `
driver="$(docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}' 2>/dev/null || true)"
if [ "$driver" != "systemd 2" ]; then echo "SKIP: Docker's cgroup driver is '\${driver:-unknown}', and a shared budget needs systemd on cgroup v2"; exit 0; fi
if [ "$(id -u)" != "0" ] || ! command -v systemctl >/dev/null 2>&1; then echo "SKIP: setting a budget needs root and systemctl"; exit 0; fi
set -e
printf '%s' ${quote([unit])} > /etc/systemd/system/${slice}
systemctl daemon-reload
systemctl start ${slice}
echo OK
`;
};

export const removeComposeBudgetScript = (appName: string) => {
	const slice = composeSliceName(appName);
	return `if [ -f /etc/systemd/system/${slice} ]; then systemctl stop ${slice} 2>/dev/null; rm -f /etc/systemd/system/${slice}; systemctl daemon-reload; fi`;
};

/** Puts every service in the stack's slice, unless the file already chose a parent cgroup for it. */
export const applyComposeSlice = (
	spec: ComposeSpecification,
	slice: string,
): ComposeSpecification => {
	const result = structuredClone(spec);
	for (const service of Object.values(result.services ?? {})) {
		if (service && !service.cgroup_parent) service.cgroup_parent = slice;
	}
	return result;
};

export type ComposeBudgetResult = {
	/** Set when the stack's services should join it. */
	slice: string | null;
	log: string;
};

/**
 * Gives a compose stack one CPU and memory budget for all its services, on top of the guard's per-service caps.
 * Only `docker compose` on a remote server: Swarm ignores `cgroup_parent`, and on its own host Dokploy runs in a
 * container without the host's systemd. Never fails the deploy; when it can't apply, the log says why.
 */
export const prepareComposeBudget = async (options: {
	appName: string;
	composeType: "docker-compose" | "stack";
	serverId: string | null | undefined;
	policy: ResourceGuardPolicy | null;
	overrides: ComposeBudgetOverrides;
}): Promise<ComposeBudgetResult> => {
	const { appName, composeType, serverId, policy, overrides } = options;
	if (!policy)
		return { slice: null, log: "unavailable (server capacity unreadable)" };
	if (composeType !== "docker-compose")
		return {
			slice: null,
			log: "not applied (Swarm stacks keep per-service caps)",
		};
	if (!serverId)
		return { slice: null, log: "not applied (only on remote servers)" };
	const budget = computeComposeBudget(policy, overrides);
	const slice = composeSliceName(appName);
	try {
		const { stdout } = await execAsyncRemote(
			serverId,
			composeBudgetScript(slice, budget),
		);
		const result = stdout.trim().split("\n").pop() ?? "";
		if (result === "OK")
			return {
				slice,
				log: `${formatComposeBudget(budget)} for the whole stack (${slice})`,
			};
		return {
			slice: null,
			log: `not applied (${result.replace(/^SKIP: /, "") || "no answer from the server"})`,
		};
	} catch (error) {
		console.warn(
			`Compose budget: could not set ${slice} on ${serverId}`,
			error,
		);
		return {
			slice: null,
			log: `not applied (${error instanceof Error ? error.message.split("\n")[0] : "error"})`,
		};
	}
};
