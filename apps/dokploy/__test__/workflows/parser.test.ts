import { readFileSync } from "node:fs";
import path from "node:path";
import {
	parseWorkflow,
	WorkflowParseError,
	workflowRunsOn,
} from "@dokploy/server/utils/workflows/parser";
import { describe, expect, it } from "vitest";

const fixture = (name: string) =>
	readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("parseWorkflow", () => {
	it("parses the act fixture workflow", () => {
		const workflow = parseWorkflow(fixture("act-run.workflow.yml"), "ci");

		expect(workflow.name).toBe("CI");
		expect(workflow.triggers).toEqual([{ event: "push", branches: ["main"] }]);
		expect(workflow.jobs).toEqual([
			{
				id: "build",
				name: "build",
				needs: [],
				runsOn: ["ubuntu-latest"],
				uses: undefined,
				hasMatrix: false,
			},
			{
				id: "test",
				name: "test",
				needs: ["build"],
				runsOn: ["ubuntu-latest"],
				uses: undefined,
				hasMatrix: true,
			},
			{
				id: "fail",
				name: "fail",
				needs: ["build"],
				runsOn: ["ubuntu-latest"],
				uses: undefined,
				hasMatrix: false,
			},
		]);
	});

	it.each([
		["on: push", [{ event: "push" }]],
		[
			"on: [push, pull_request]",
			[{ event: "push" }, { event: "pull_request" }],
		],
	])("normalizes the short forms of on (%s)", (on, expected) => {
		const workflow = parseWorkflow(
			`${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: echo}]`,
			"wf",
		);
		expect(workflow.triggers).toEqual(expected);
		expect(workflow.name).toBe("wf");
	});

	it("normalizes filters, release types, schedules and dispatch inputs", () => {
		const workflow = parseWorkflow(
			`
name: Release
on:
  push:
    branches: [main, "releases/**"]
    tags-ignore: ["v*-rc*"]
    paths: ["src/**"]
  pull_request:
    types: [opened, closed]
    branches-ignore: [wip]
  release:
    types: published
  schedule:
    - cron: "0 3 * * *"
    - cron: "30 12 * * 1"
  workflow_dispatch:
    inputs:
      environment:
        description: Target
        type: choice
        options: [staging, production]
        required: true
      dry_run:
        type: boolean
        default: true
jobs:
  ship:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo ship
`,
			"release",
		);

		expect(workflow.triggers).toEqual([
			{
				event: "push",
				branches: ["main", "releases/**"],
				tagsIgnore: ["v*-rc*"],
				paths: ["src/**"],
			},
			{
				event: "pull_request",
				types: ["opened", "closed"],
				branchesIgnore: ["wip"],
			},
			{ event: "release", types: ["published"] },
			{ event: "schedule", cron: ["0 3 * * *", "30 12 * * 1"] },
			{
				event: "workflow_dispatch",
				inputs: {
					environment: {
						description: "Target",
						required: true,
						default: undefined,
						type: "choice",
						options: ["staging", "production"],
					},
					dry_run: {
						description: undefined,
						required: false,
						default: true,
						type: "boolean",
						options: undefined,
					},
				},
			},
		]);
		expect(workflow.jobs[0]?.runsOn).toEqual(["self-hosted", "linux"]);
	});

	it("reads concurrency settings", () => {
		const workflow = parseWorkflow(
			`
on: push
concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{run: echo}]
`,
			"wf",
		);
		expect(workflow.concurrency).toEqual({
			group: "deploy-${{ github.ref }}",
			cancelInProgress: true,
		});
	});

	it("accepts reusable workflow jobs without runs-on or steps", () => {
		const workflow = parseWorkflow(
			`
on: push
jobs:
  call:
    uses: acme/shared/.github/workflows/build.yml@main
`,
			"wf",
		);
		expect(workflow.jobs[0]?.uses).toBe(
			"acme/shared/.github/workflows/build.yml@main",
		);
	});

	it.each([
		["not: yaml: [", /Invalid YAML/],
		["- just\n- a list", /must be a YAML mapping/],
		["jobs:\n  a:\n    runs-on: x\n    steps: []", /Missing or invalid "on"/],
		["on: push", /Missing or empty "jobs"/],
		["on: push\njobs:\n  a:\n    steps: []", /missing "runs-on"/],
		["on: push\njobs:\n  a:\n    runs-on: x", /missing "steps"/],
		[
			"on: push\njobs:\n  a:\n    runs-on: x\n    needs: ghost\n    steps: []",
			/needs unknown job "ghost"/,
		],
		[
			"on: push\njobs:\n  a:\n    runs-on: x\n    needs: b\n    steps: []\n  b:\n    runs-on: x\n    needs: a\n    steps: []",
			/dependency cycle: a -> b -> a/,
		],
		[
			"on:\n  push:\n    branches: [main]\n    branches-ignore: [dev]\njobs:\n  a:\n    runs-on: x\n    steps: []",
			/can't use both "branches" and "branches-ignore"/,
		],
	])("rejects invalid workflows (%#)", (content, message) => {
		expect(() => parseWorkflow(content, "wf")).toThrow(WorkflowParseError);
		expect(() => parseWorkflow(content, "wf")).toThrow(message);
	});
});

describe("runs-on matrix expansion", () => {
	it("resolves matrix references, including include entries", () => {
		const workflow = parseWorkflow(
			`
on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        include:
          - os: macos-15
    steps: [{run: echo}]
  lint:
    runs-on: ubuntu-latest
    steps: [{run: echo}]
`,
			"wf",
		);
		expect(workflow.jobs[0]?.runsOn).toEqual([
			"ubuntu-latest",
			"macos-latest",
			"macos-15",
		]);
		expect(workflowRunsOn(workflow)).toEqual([
			"ubuntu-latest",
			"macos-latest",
			"macos-15",
		]);
	});

	it("keeps references it can't resolve", () => {
		const workflow = parseWorkflow(
			"on: push\njobs:\n  a:\n    runs-on: ${{ inputs.os }}\n    steps: [{run: echo}]",
			"wf",
		);
		expect(workflow.jobs[0]?.runsOn).toEqual(["${{ inputs.os }}"]);
	});
});
