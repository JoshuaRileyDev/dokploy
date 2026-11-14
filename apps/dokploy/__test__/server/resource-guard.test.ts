import {
	APP_OOM_SCORE_ADJ,
	applyResourceGuardToCompose,
	computeResourceGuardPolicy,
	estimateCapacity,
	guardResources,
	parseComposeMemory,
	parseDockerStatsMemory,
	parseMemoryUsageOutput,
} from "@dokploy/server/utils/docker/resource-guard";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { describe, expect, it } from "vitest";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const policyFor = (
	memoryGb: number,
	cores: number,
	settings = { reservedMemoryMb: null as number | null, appMemoryPercent: 50 },
	isDokployHost = true,
) =>
	computeResourceGuardPolicy(
		{ memoryBytes: memoryGb * GIB, nanoCpus: cores * 1e9 },
		settings,
		isDokployHost,
	);

describe("computeResourceGuardPolicy", () => {
	it("keeps at least 1 GB for Dokploy on its own host", () => {
		const policy = policyFor(4, 2);
		expect(policy.platformReserveBytes).toBe(1024 * MIB);
		expect(policy.allocatableMemoryBytes).toBe(3 * GIB);
		expect(policy.defaultMemoryLimitBytes).toBe(1.5 * GIB);
		expect(policy.maxNanoCpus).toBe(1.5e9);
	});

	it("keeps 10% on large hosts and 512 MB minimum on remote servers", () => {
		expect(policyFor(32, 8).platformReserveBytes).toBe(
			Math.round(32 * GIB * 0.1),
		);
		expect(policyFor(2, 1, undefined, false).platformReserveBytes).toBe(
			512 * MIB,
		);
	});

	it("uses an explicit reserve and percentage", () => {
		const policy = policyFor(8, 4, {
			reservedMemoryMb: 2048,
			appMemoryPercent: 25,
		});
		expect(policy.reserveIsAuto).toBe(false);
		expect(policy.allocatableMemoryBytes).toBe(6 * GIB);
		expect(policy.defaultMemoryLimitBytes).toBe(1.5 * GIB);
	});

	it("doesn't cap CPU on a single core", () => {
		expect(policyFor(2, 1).maxNanoCpus).toBeNull();
	});

	it("never leaves a service less than 128 MB", () => {
		const policy = policyFor(1, 1);
		expect(policy.allocatableMemoryBytes).toBe(128 * MIB);
		expect(policy.defaultMemoryLimitBytes).toBe(128 * MIB);
	});
});

describe("guardResources", () => {
	const policy = policyFor(4, 2);

	it("applies the default when no limit is set", () => {
		const result = guardResources({ Limits: {}, Reservations: {} }, policy);
		expect(result.Limits?.MemoryBytes).toBe(1.5 * GIB);
		expect(result.Limits?.NanoCPUs).toBe(1.5e9);
	});

	it("keeps limits within what the server can spare", () => {
		const result = guardResources(
			{ Limits: { MemoryBytes: 2 * GIB, NanoCPUs: 1e9 }, Reservations: {} },
			policy,
		);
		expect(result.Limits?.MemoryBytes).toBe(2 * GIB);
		expect(result.Limits?.NanoCPUs).toBe(1e9);
	});

	it("lowers limits and reservations above the maximum", () => {
		const result = guardResources(
			{
				Limits: { MemoryBytes: 16 * GIB, NanoCPUs: 8e9 },
				Reservations: { MemoryBytes: 8 * GIB, NanoCPUs: 4e9 },
			},
			policy,
		);
		expect(result.Limits?.MemoryBytes).toBe(3 * GIB);
		expect(result.Limits?.NanoCPUs).toBe(1.5e9);
		expect(result.Reservations?.MemoryBytes).toBe(3 * GIB);
		expect(result.Reservations?.NanoCPUs).toBe(1.5e9);
	});

	it("passes resources through when capacity is unknown", () => {
		const resources = { Limits: {}, Reservations: {} };
		expect(guardResources(resources, null)).toBe(resources);
	});
});

describe("parseComposeMemory", () => {
	it.each([
		["512m", 512 * MIB],
		["1.5g", 1.5 * GIB],
		["2GB", 2 * GIB],
		["1024", 1024],
		[1024, 1024],
	])("parses %s", (value, bytes) => {
		expect(parseComposeMemory(value)).toBe(bytes);
	});

	it("can't read interpolated values", () => {
		expect(parseComposeMemory("${MEMORY}")).toBeNull();
	});
});

describe("applyResourceGuardToCompose", () => {
	const policy = policyFor(4, 2);

	it("caps every service and raises its OOM score", () => {
		const spec: ComposeSpecification = {
			services: {
				web: { image: "nginx" },
				worker: {
					image: "worker",
					deploy: { resources: { limits: { memory: "256M" } } },
				},
			},
		};
		const result = applyResourceGuardToCompose(spec, policy, "docker-compose");
		expect(result.services?.web?.deploy?.resources?.limits).toEqual({
			memory: "1536M",
			cpus: "1.50",
		});
		expect(result.services?.worker?.deploy?.resources?.limits).toEqual({
			memory: "256M",
			cpus: "1.50",
		});
		expect(result.services?.web?.oom_score_adj).toBe(APP_OOM_SCORE_ADJ);
		expect(spec.services?.web?.deploy).toBeUndefined();
	});

	it("respects mem_limit for docker compose but lowers it when too high", () => {
		const result = applyResourceGuardToCompose(
			{
				services: {
					small: { image: "a", mem_limit: "512m" },
					huge: { image: "b", mem_limit: "16g" },
				},
			},
			policy,
			"docker-compose",
		);
		expect(result.services?.small?.mem_limit).toBe("512m");
		expect(result.services?.small?.deploy?.resources?.limits?.memory).toBe(
			undefined,
		);
		expect(result.services?.huge?.mem_limit).toBeUndefined();
		expect(result.services?.huge?.deploy?.resources?.limits?.memory).toBe(
			"3072M",
		);
	});

	it("ignores mem_limit for stacks", () => {
		const result = applyResourceGuardToCompose(
			{ services: { web: { image: "a", mem_limit: "512m" } } },
			policy,
			"stack",
		);
		expect(result.services?.web?.deploy?.resources?.limits?.memory).toBe(
			"1536M",
		);
	});

	it("leaves values it can't read and an existing OOM score alone", () => {
		const result = applyResourceGuardToCompose(
			{
				services: {
					web: {
						image: "a",
						oom_score_adj: -100,
						deploy: { resources: { limits: { memory: "${MEM}" } } },
					},
				},
			},
			policy,
			"docker-compose",
		);
		expect(result.services?.web?.deploy?.resources?.limits?.memory).toBe(
			"${MEM}",
		);
		expect(result.services?.web?.oom_score_adj).toBe(-100);
	});
});

describe("parseDockerStatsMemory", () => {
	it.each([
		["135.7MiB / 7.57GiB", Math.round(135.7 * MIB)],
		["1.2GiB / 7.57GiB", Math.round(1.2 * GIB)],
		["512kB / 1GB", 512_000],
		["0B / 0B", 0],
	])("parses %s", (value, bytes) => {
		expect(parseDockerStatsMemory(value)).toBe(bytes);
	});
});

describe("parseMemoryUsageOutput", () => {
	it("groups containers by compose project or swarm service", () => {
		const { samples, hostAvailableBytes } = parseMemoryUsageOutput(
			[
				"==containers",
				"aaa|shop-web-1|shop||",
				"bbb|shop-db-1|shop||",
				"ccc|api.1.xyz||api",
				"ddd|dokploy-traefik||dokploy-traefik",
				"==stats",
				"aaa|100MiB / 8GiB",
				"bbb|50MiB / 8GiB",
				"ccc|200MiB / 8GiB",
				"ddd|70MiB / 8GiB",
				"==peaks",
				`aaa|${300 * MIB}`,
				`bbb|${60 * MIB}`,
				"==available",
				`${3 * GIB}`,
			].join("\n"),
		);
		expect(hostAvailableBytes).toBe(3 * GIB);
		expect(samples).toEqual([
			{
				name: "shop",
				containers: 2,
				currentBytes: 150 * MIB,
				peakBytes: 360 * MIB,
			},
			{ name: "api", containers: 1, currentBytes: 200 * MIB, peakBytes: null },
			{
				name: "dokploy-traefik",
				containers: 1,
				currentBytes: 70 * MIB,
				peakBytes: null,
			},
		]);
	});
});

describe("estimateCapacity", () => {
	const policy = policyFor(8, 4, {
		reservedMemoryMb: 1024,
		appMemoryPercent: 25,
	});
	const service = (name: string, current: number, peak: number | null) => ({
		name,
		containers: 1,
		currentBytes: current * MIB,
		peakBytes: peak === null ? null : peak * MIB,
	});

	it("gives a range between everything peaking and current usage", () => {
		const estimate = estimateCapacity(
			policy,
			[
				service("a", 100, 200),
				service("b", 100, 200),
				service("c", 1000, 3000),
				service("dokploy-traefik", 100, 150),
			],
			null,
		);
		expect(estimate.services.map((s) => s.name)).toEqual(["c", "a", "b"]);
		expect(estimate.typicalServiceBytes).toBe(200 * MIB);
		expect(estimate.usedNowBytes).toBe(1200 * MIB);
		expect(estimate.usedAtPeakBytes).toBe(3400 * MIB);
		// 7168 MB for services: (7168 - 3400) / 200 and (7168 - 1200) / 200
		expect(estimate.moreServicesLow).toBe(18);
		expect(estimate.moreServicesHigh).toBe(29);
		expect(estimate.overcommittedAtPeak).toBe(false);
	});

	it("is limited by what the host actually has free", () => {
		const estimate = estimateCapacity(
			policy,
			[service("a", 100, 200), service("dokploy-traefik", 100, null)],
			// 1 GB reserve with 100 MB of it used leaves 2000 - 924 = 1076 MB
			2000 * MIB,
		);
		expect(estimate.moreServicesHigh).toBe(5);
	});

	it("flags when the peaks together exceed the server", () => {
		const estimate = estimateCapacity(
			policy,
			[service("a", 1000, 4000), service("b", 1000, 4000)],
			null,
		);
		expect(estimate.overcommittedAtPeak).toBe(true);
		expect(estimate.moreServicesLow).toBe(0);
	});
});
