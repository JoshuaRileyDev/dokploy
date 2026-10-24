import {
	applyMemoryPolicyToCompose,
	autoReservedMemory,
	parseMemoryBytes,
	resolveMemoryLimit,
} from "@dokploy/server/services/memory-policy";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { describe, expect, it } from "vitest";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const policy = { defaultMemoryLimit: 512 * MB, reservedMemory: null };

describe("resolveMemoryLimit", () => {
	it("keeps a service's own limit", () => {
		expect(resolveMemoryLimit(String(GB), null, policy)).toBe(String(GB));
	});

	it("falls back to the server default", () => {
		expect(resolveMemoryLimit(null, null, policy)).toBe(String(512 * MB));
	});

	it("returns null when neither is set", () => {
		expect(
			resolveMemoryLimit(null, null, { ...policy, defaultMemoryLimit: null }),
		).toBeNull();
	});

	it("raises the default to the reservation so Docker accepts it", () => {
		expect(resolveMemoryLimit(null, String(GB), policy)).toBe(String(GB));
	});
});

describe("parseMemoryBytes", () => {
	it.each([
		["512m", 512 * MB],
		["512M", 512 * MB],
		["1.5g", 1.5 * GB],
		["1gb", GB],
		["2048", 2048],
		[1024, 1024],
	])("parses %s", (input, expected) => {
		expect(parseMemoryBytes(input)).toBe(expected);
	});

	it("rejects values it doesn't understand", () => {
		expect(parseMemoryBytes("${MEM_LIMIT}")).toBeNull();
		expect(parseMemoryBytes("lots")).toBeNull();
	});
});

describe("applyMemoryPolicyToCompose", () => {
	const spec: ComposeSpecification = {
		services: {
			web: { image: "nginx" },
			worker: { image: "worker", mem_limit: "2g" },
			db: {
				image: "postgres",
				deploy: { resources: { limits: { memory: "1G" } } },
			},
			cache: { image: "redis", mem_reservation: "768m" },
			templated: { image: "app", mem_reservation: "${RESERVATION}" },
			labelled: { image: "app", deploy: { labels: ["a=b"] } },
		},
	};

	const result = applyMemoryPolicyToCompose(spec, policy);

	it("limits services without a limit", () => {
		expect(result.services?.web?.deploy?.resources?.limits?.memory).toBe(
			"512M",
		);
	});

	it("leaves explicit limits alone", () => {
		expect(result.services?.worker?.deploy).toBeUndefined();
		expect(result.services?.db?.deploy?.resources?.limits?.memory).toBe("1G");
	});

	it("raises the limit to the reservation", () => {
		expect(result.services?.cache?.deploy?.resources?.limits?.memory).toBe(
			"768M",
		);
	});

	it("skips services whose reservation can't be parsed", () => {
		expect(result.services?.templated?.deploy).toBeUndefined();
	});

	it("keeps existing deploy settings", () => {
		expect(result.services?.labelled?.deploy?.labels).toEqual(["a=b"]);
		expect(result.services?.labelled?.deploy?.resources?.limits?.memory).toBe(
			"512M",
		);
	});

	it("doesn't mutate the input", () => {
		expect(spec.services?.web?.deploy).toBeUndefined();
	});

	it("does nothing without a default", () => {
		expect(
			applyMemoryPolicyToCompose(spec, { ...policy, defaultMemoryLimit: null }),
		).toBe(spec);
	});
});

describe("autoReservedMemory", () => {
	it("keeps at least 512 MB on small servers", () => {
		expect(autoReservedMemory(2 * GB)).toBe(512 * MB);
	});

	it("keeps 10% on mid-sized servers", () => {
		expect(autoReservedMemory(16 * GB)).toBe(Math.round(1.6 * GB));
	});

	it("caps at 2 GB", () => {
		expect(autoReservedMemory(64 * GB)).toBe(2 * GB);
	});
});
