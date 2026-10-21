import { resolveConcurrency } from "@dokploy/server/services/workflow-run";
import {
	evaluateExpression,
	evaluateTemplate,
} from "@dokploy/server/utils/workflows/expressions";
import { parseWorkflow } from "@dokploy/server/utils/workflows/parser";
import { describe, expect, it } from "vitest";

const context = {
	github: {
		workflow: "CI",
		ref: "refs/heads/main",
		head_ref: "",
		event_name: "push",
		event: { pull_request: { number: 7 } },
	},
	inputs: { env: "staging" },
};

describe("evaluateExpression", () => {
	it.each([
		["github.workflow", "CI"],
		["github.event.pull_request.number", 7],
		["github['ref']", "refs/heads/main"],
		["github.missing.deeper", null],
		["github.head_ref || github.ref", "refs/heads/main"],
		["github.workflow && github.ref", "refs/heads/main"],
		["github.event_name == 'PUSH'", true],
		["github.event_name != 'push'", false],
		["!github.head_ref", true],
		["'it''s'", "it's"],
		["(inputs.env == 'staging') && 'yes'", "yes"],
		["3", 3],
	])("%s", (expression, expected) => {
		expect(evaluateExpression(expression, context)).toEqual(expected);
	});
});

describe("evaluateTemplate", () => {
	it("substitutes each expression", () => {
		expect(
			evaluateTemplate(
				"${{ github.workflow }}-${{ github.head_ref || github.ref }}",
				context,
			),
		).toBe("CI-refs/heads/main");
	});

	it("returns null for unsupported functions", () => {
		expect(
			evaluateTemplate("${{ format('{0}', github.ref) }}", context),
		).toBeNull();
	});
});

describe("resolveConcurrency", () => {
	const workflow = (concurrency: string) =>
		parseWorkflow(
			`on: push\n${concurrency}\njobs:\n  a:\n    runs-on: x\n    steps: [{run: echo}]`,
			"wf",
		);
	const run = {
		event: "pull_request",
		ref: "refs/pull/7/merge",
		sha: "abc",
		actor: "octocat",
		payload: { pull_request: { number: 7, head: { ref: "feature" } } },
		inputs: null,
		workflowName: "CI",
		repositoryFullName: "acme/widgets",
	};

	it("evaluates the group and cancel-in-progress", () => {
		expect(
			resolveConcurrency(
				workflow(
					"concurrency:\n  group: ${{ github.workflow }}-${{ github.head_ref || github.ref }}\n  cancel-in-progress: true",
				),
				run,
			),
		).toEqual({
			concurrencyGroup: "CI-feature",
			concurrencyCancelInProgress: true,
		});
	});

	it("keeps the raw group when it can't be evaluated", () => {
		expect(
			resolveConcurrency(
				workflow("concurrency: deploy-${{ hashFiles('x') }}"),
				run,
			),
		).toEqual({
			concurrencyGroup: "deploy-${{ hashFiles('x') }}",
			concurrencyCancelInProgress: false,
		});
	});

	it("returns no group without a concurrency block", () => {
		expect(resolveConcurrency(workflow(""), run)).toEqual({
			concurrencyGroup: null,
			concurrencyCancelInProgress: false,
		});
	});
});
