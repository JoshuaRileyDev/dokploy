import { workflowEnvNameProblem } from "@dokploy/server/services/workflow-env-import";
import { describe, expect, it } from "vitest";

describe("workflowEnvNameProblem", () => {
	it.each([
		["DATABASE_URL", null],
		["_private", null],
		["npm_token2", null],
		["my-key", "Not a valid secret name"],
		["2FAST", "Not a valid secret name"],
		["GITHUB_TOKEN", "Names can't start with GITHUB_"],
		["github_custom", "Names can't start with GITHUB_"],
	])("%s", (name, expected) => {
		expect(workflowEnvNameProblem(name)).toBe(expected);
	});
});
