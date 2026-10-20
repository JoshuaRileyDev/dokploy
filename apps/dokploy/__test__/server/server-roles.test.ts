import {
	describeRoleRemovalBlockers,
	legacyServerType,
	resolveServerRoles,
} from "@dokploy/server/db/schema";
import { describe, expect, it } from "vitest";

describe("resolveServerRoles", () => {
	it("prefers serverRoles and removes duplicates", () => {
		expect(
			resolveServerRoles({
				serverRoles: ["build", "workflow", "build"],
				serverType: "deploy",
			}),
		).toEqual(["build", "workflow"]);
	});

	it("maps the deprecated serverType to a single role", () => {
		expect(resolveServerRoles({ serverType: "build" })).toEqual(["build"]);
	});

	it("returns undefined when neither is provided so updates leave roles unchanged", () => {
		expect(resolveServerRoles({})).toBeUndefined();
	});
});

describe("legacyServerType", () => {
	it.each([
		[["deploy"], "deploy"],
		[["deploy", "workflow"], "deploy"],
		[["build"], "build"],
		[["build", "workflow"], "build"],
		[["workflow"], "build"],
	] as const)("maps %j to %s", (roles, expected) => {
		expect(legacyServerType([...roles])).toBe(expected);
	});
});

describe("describeRoleRemovalBlockers", () => {
	const idle = { deploy: false, build: 0, workflow: 0 };

	it("allows removing roles nothing depends on", () => {
		expect(
			describeRoleRemovalBlockers(["deploy", "build", "workflow"], idle),
		).toEqual([]);
	});

	it("blocks removing deploy while services run on the server", () => {
		expect(
			describeRoleRemovalBlockers(["deploy"], { ...idle, deploy: true }),
		).toEqual(["Can't remove the deploy role: it still hosts services."]);
	});

	it("blocks removing build while applications use it as their build server", () => {
		expect(
			describeRoleRemovalBlockers(["build"], { ...idle, build: 2 }),
		).toEqual([
			"Can't remove the build role: 2 applications use it as their build server.",
		]);
	});

	it("blocks removing workflow while repositories are pinned to it", () => {
		expect(
			describeRoleRemovalBlockers(["workflow"], { ...idle, workflow: 1 }),
		).toEqual([
			"Can't remove the workflow role: 1 workflow repository is pinned to it.",
		]);
	});

	it("only reports the roles being removed", () => {
		expect(
			describeRoleRemovalBlockers(["workflow"], {
				deploy: true,
				build: 3,
				workflow: 0,
			}),
		).toEqual([]);
	});

	it("reports every blocked role at once", () => {
		expect(
			describeRoleRemovalBlockers(["deploy", "workflow"], {
				deploy: true,
				build: 0,
				workflow: 2,
			}),
		).toHaveLength(2);
	});
});
