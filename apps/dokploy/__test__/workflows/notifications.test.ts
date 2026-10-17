import { checkRunSummary } from "@dokploy/server/utils/workflows/check-runs";
import {
	buildWorkflowCustomPayload,
	ruleMatches,
	type WorkflowRunSummary,
} from "@dokploy/server/utils/workflows/notifications";
import { describe, expect, it } from "vitest";

describe("ruleMatches", () => {
	const rule = { branches: [], onFailure: true, onSuccess: false };

	it("matches the run's outcome", () => {
		expect(ruleMatches(rule, { status: "failure", branch: "main" })).toBe(true);
		expect(ruleMatches(rule, { status: "success", branch: "main" })).toBe(
			false,
		);
		expect(
			ruleMatches(
				{ ...rule, onSuccess: true },
				{ status: "success", branch: "main" },
			),
		).toBe(true);
	});

	it("applies branch patterns", () => {
		const scoped = { ...rule, branches: ["main", "release/**"] };
		expect(ruleMatches(scoped, { status: "failure", branch: "main" })).toBe(
			true,
		);
		expect(
			ruleMatches(scoped, { status: "failure", branch: "release/1.2" }),
		).toBe(true);
		expect(
			ruleMatches(scoped, { status: "failure", branch: "feature/x" }),
		).toBe(false);
		expect(ruleMatches(scoped, { status: "failure", branch: null })).toBe(
			false,
		);
	});
});

describe("buildWorkflowCustomPayload", () => {
	it("describes the run for webhook consumers", () => {
		const run: WorkflowRunSummary = {
			status: "failure",
			repository: "acme/widgets",
			workflow: "CI",
			runNumber: 12,
			attempt: 2,
			event: "push",
			branch: "main",
			sha: "abc1234def",
			commitTitle: "Fix the thing",
			actor: "octocat",
			errorMessage: null,
			durationSeconds: 42,
			runUrl: "https://dokploy.example.com/dashboard/workflows/runs/r1",
			date: new Date("2026-10-17T10:00:00Z"),
		};
		expect(buildWorkflowCustomPayload(run)).toMatchObject({
			title: "Workflow failed",
			message: "CI #12 failed on acme/widgets",
			type: "workflow",
			status: "error",
			repository: "acme/widgets",
			workflow: "CI",
			runNumber: 12,
			attempt: 2,
			branch: "main",
			sha: "abc1234def",
			actor: "octocat",
			durationSeconds: 42,
			runUrl: "https://dokploy.example.com/dashboard/workflows/runs/r1",
			timestamp: "2026-10-17T10:00:00.000Z",
		});
		expect(
			buildWorkflowCustomPayload({ ...run, status: "success" }).status,
		).toBe("success");
	});
});

describe("checkRunSummary", () => {
	it("lists jobs with their outcome and leads with any error", () => {
		expect(
			checkRunSummary({
				errorMessage: "act exited with code 1",
				jobs: [
					{ name: "build", status: "success" },
					{ name: "test (18)", status: "failure" },
					{ name: "deploy", status: "skipped" },
				],
			}),
		).toBe("act exited with code 1\n\n- ✅ build\n- ❌ test (18)\n- ⏭️ deploy");
		expect(checkRunSummary({ errorMessage: null, jobs: [] })).toBe(
			"No jobs ran.",
		);
	});
});
