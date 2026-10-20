import { describe, expect, it } from "vitest";
import { merge3 } from "../../scripts/generate-fork-migration";

const table = (columns: Record<string, unknown>) => ({ columns });

describe("merge3", () => {
	it("keeps upstream additions and fork additions side by side", () => {
		const base = { tables: { server: table({ id: "text" }) } };
		const upstream = {
			tables: {
				server: table({ id: "text", region: "text" }),
				invoice: table({ id: "text" }),
			},
		};
		const fork = {
			tables: {
				server: table({ id: "text", serverRoles: "serverRole[]" }),
				workflow_run: table({ id: "text" }),
			},
		};

		expect(merge3(base, upstream, fork)).toEqual({
			tables: {
				server: table({
					id: "text",
					region: "text",
					serverRoles: "serverRole[]",
				}),
				invoice: table({ id: "text" }),
				workflow_run: table({ id: "text" }),
			},
		});
	});

	it("follows upstream when it changes a value the fork left alone", () => {
		const base = { enums: { serverType: ["deploy", "build"] } };
		const upstream = { enums: { serverType: ["deploy", "build", "edge"] } };
		const fork = { enums: { serverType: ["deploy", "build"] } };

		expect(merge3(base, upstream, fork)).toEqual(upstream);
	});

	it("unions arrays when both sides add values", () => {
		const base = { values: ["a"] };
		const upstream = { values: ["a", "b"] };
		const fork = { values: ["a", "c"] };

		expect(merge3(base, upstream, fork)).toEqual({ values: ["a", "b", "c"] });
	});

	it("drops columns upstream removed", () => {
		const base = { columns: { legacy: "text", id: "text" } };
		const upstream = { columns: { id: "text" } };
		const fork = { columns: { legacy: "text", id: "text", extra: "text" } };

		expect(merge3(base, upstream, fork)).toEqual({
			columns: { id: "text", extra: "text" },
		});
	});
});
