import {
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
