import {
	applyComposeSlice,
	composeBudgetScript,
	composeSliceName,
	computeComposeBudget,
	prepareComposeBudget,
	removeComposeBudgetScript,
} from "@dokploy/server/utils/docker/compose-budget";
import { computeResourceGuardPolicy } from "@dokploy/server/utils/docker/resource-guard";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execAsyncRemote = vi.hoisted(() => vi.fn());
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote,
	execAsync: vi.fn(),
}));

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const none = { cpus: null, memoryMb: null };

// A client server: 4 CPUs, 8 GB, remote, guard defaults.
const policyFor = (memoryGb: number, cores: number) =>
	computeResourceGuardPolicy(
		{ memoryBytes: memoryGb * GIB, nanoCpus: cores * 1e9 },
		{ reservedMemoryMb: null, appMemoryPercent: 25 },
		false,
	);

describe("computeComposeBudget", () => {
	it("gives a stack half the server when it has no budget of its own", () => {
		const policy = policyFor(8, 4);
		const budget = computeComposeBudget(policy, none);
		expect(budget.nanoCpus).toBe(2e9);
		expect(budget.memoryBytes).toBe(
			Math.floor(policy.allocatableMemoryBytes / 2),
		);
	});

	it("takes the stack's own budget, but never more than the server has", () => {
		const policy = policyFor(8, 4);
		expect(computeComposeBudget(policy, { cpus: 1.5, memoryMb: 1024 })).toEqual(
			{ nanoCpus: 1.5e9, memoryBytes: 1024 * MIB },
		);
		expect(
			computeComposeBudget(policy, { cpus: 64, memoryMb: 64 * 1024 }),
		).toEqual({
			nanoCpus: 4e9,
			memoryBytes: policy.allocatableMemoryBytes,
		});
	});

	it("leaves CPU alone on one core, and never goes below one CPU or one service's memory", () => {
		expect(computeComposeBudget(policyFor(1, 1), none).nanoCpus).toBeNull();
		const small = policyFor(2, 2);
		const budget = computeComposeBudget(small, none);
		expect(budget.nanoCpus).toBe(1e9);
		expect(budget.memoryBytes).toBeGreaterThanOrEqual(
			small.defaultMemoryLimitBytes,
		);
	});
});

describe("composeSliceName", () => {
	it("makes a top-level slice, since a hyphen would nest it", () => {
		expect(composeSliceName("tmcrm-acme-a1b2")).toMatch(
			/^dokploy_tmcrm_acme_a1b2_[0-9a-f]{8}\.slice$/,
		);
	});

	it("keeps names apart that differ only in punctuation", () => {
		expect(composeSliceName("shop-api")).not.toBe(composeSliceName("shop_api"));
		expect(composeSliceName("shop-api")).toBe(composeSliceName("shop-api"));
	});
});

describe("applyComposeSlice", () => {
	it("puts every service in the slice, except one that chose its own parent", () => {
		const spec: ComposeSpecification = {
			services: {
				app: { image: "app" },
				db: { image: "postgres", cgroup_parent: "custom.slice" },
			},
		};
		const result = applyComposeSlice(spec, "dokploy_x.slice");
		expect(result.services?.app?.cgroup_parent).toBe("dokploy_x.slice");
		expect(result.services?.db?.cgroup_parent).toBe("custom.slice");
		expect(spec.services?.app?.cgroup_parent).toBeUndefined();
	});
});

describe("composeBudgetScript", () => {
	it("writes the slice with CPU and memory, and stops before OK if any step fails", () => {
		const script = composeBudgetScript("dokploy_x.slice", {
			nanoCpus: 2e9,
			memoryBytes: 3 * GIB,
		});
		expect(script).toContain("[Slice]\nCPUQuota=200%\nMemoryMax=3072M");
		expect(script).toContain("> /etc/systemd/system/dokploy_x.slice");
		expect(script).not.toContain("set-property");
		expect(script).toContain("set -e\nprintf");
		expect(script).toContain('"$driver" != "systemd 2"');
	});

	it("sets no CPU quota when CPU is unlimited", () => {
		const script = composeBudgetScript("dokploy_x.slice", {
			nanoCpus: null,
			memoryBytes: GIB,
		});
		expect(script).not.toContain("CPUQuota");
	});
});

describe("removeComposeBudgetScript", () => {
	it("stops and deletes the stack's slice if there is one", () => {
		const script = removeComposeBudgetScript("tmcrm-acme");
		const slice = composeSliceName("tmcrm-acme");
		expect(script).toContain(`systemctl stop ${slice}`);
		expect(script).toContain(`rm -f /etc/systemd/system/${slice}`);
	});
});

describe("prepareComposeBudget", () => {
	const base = {
		appName: "tmcrm-acme",
		composeType: "docker-compose" as const,
		serverId: "srv",
		policy: policyFor(8, 4),
		overrides: none,
	};
	beforeEach(() => {
		execAsyncRemote.mockReset();
	});

	it("uses the slice when the server set it up", async () => {
		execAsyncRemote.mockResolvedValue({ stdout: "OK\n", stderr: "" });
		const result = await prepareComposeBudget(base);
		expect(result.slice).toBe(composeSliceName("tmcrm-acme"));
		expect(result.log).toContain("2.00 CPUs");
	});

	it("deploys without it, and says why, when the server can't", async () => {
		execAsyncRemote.mockResolvedValue({
			stdout:
				"SKIP: Docker's cgroup driver is 'cgroupfs 2', and a shared budget needs systemd on cgroup v2\n",
			stderr: "",
		});
		const skipped = await prepareComposeBudget(base);
		expect(skipped.slice).toBeNull();
		expect(skipped.log).toContain("cgroupfs");
	});

	it("deploys without it when the server can't be reached", async () => {
		execAsyncRemote.mockRejectedValue(new Error("ssh: connection refused"));
		const failed = await prepareComposeBudget(base);
		expect(failed.slice).toBeNull();
		expect(failed.log).toContain("connection refused");
	});

	it("doesn't touch the server for stacks, the Dokploy host, or an unreadable server", async () => {
		await prepareComposeBudget({ ...base, composeType: "stack" });
		await prepareComposeBudget({ ...base, serverId: null });
		await prepareComposeBudget({ ...base, policy: null });
		expect(execAsyncRemote).not.toHaveBeenCalled();
	});
});
