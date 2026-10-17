import { readFileSync } from "node:fs";
import path from "node:path";
import {
	type ActLogEvent,
	ActLogProcessor,
	jobDisplayName,
	LineBuffer,
} from "@dokploy/server/utils/workflows/act-log";
import { describe, expect, it } from "vitest";

// Captured from `act push --json` (v0.2.89) running act-run.workflow.yml.
const fixture = readFileSync(
	path.join(__dirname, "fixtures", "act-run.jsonl"),
	"utf8",
);

const processAll = () => {
	const processor = new ActLogProcessor();
	return fixture.split("\n").flatMap((line) => processor.process(line));
};

const byType = <T extends ActLogEvent["type"]>(
	events: ActLogEvent[],
	type: T,
) =>
	events.filter((e): e is Extract<ActLogEvent, { type: T }> => e.type === type);

describe("ActLogProcessor", () => {
	const events = processAll();

	it("starts one job per matrix instance", () => {
		expect(byType(events, "job_started")).toEqual([
			{ type: "job_started", key: "CI/build", jobId: "build", matrix: {} },
			{ type: "job_started", key: "CI/fail", jobId: "fail", matrix: {} },
			{
				type: "job_started",
				key: "CI/test-2",
				jobId: "test",
				matrix: { node: 20 },
			},
			{
				type: "job_started",
				key: "CI/test-1",
				jobId: "test",
				matrix: { node: 18 },
			},
		]);
	});

	it("reports each job's result", () => {
		expect(
			Object.fromEntries(
				byType(events, "job_finished").map((e) => [e.key, e.result]),
			),
		).toEqual({
			"CI/build": "success",
			"CI/fail": "failure",
			"CI/test-1": "success",
			"CI/test-2": "success",
		});
	});

	it("tracks steps in order with results and durations", () => {
		const buildSteps = events.filter(
			(
				e,
			): e is Extract<
				ActLogEvent,
				{ type: "step_started" | "step_finished" }
			> =>
				e.key === "CI/build" &&
				(e.type === "step_started" || e.type === "step_finished"),
		);
		expect(
			buildSteps.map((e) =>
				e.type === "step_started" ? `start ${e.name}` : `${e.result} ${e.name}`,
			),
		).toEqual([
			"start Set up job",
			"success Set up job",
			"start actions/checkout@v4",
			"success actions/checkout@v4",
			'start echo "version=1.2.3" >> "$GITHUB_OUTPUT"',
			'success echo "version=1.2.3" >> "$GITHUB_OUTPUT"',
			"start Say hi",
			"success Say hi",
			"start Complete job",
			"success Complete job",
		]);
		const checkout = byType(events, "step_finished").find(
			(e) => e.name === "actions/checkout@v4",
		);
		expect(checkout?.durationMs).toBe(17);
	});

	it("marks the failing step", () => {
		const boom = byType(events, "step_finished").find(
			(e) => e.key === "CI/fail" && e.name === "Boom",
		);
		expect(boom?.result).toBe("failure");
	});

	it("routes command output to the right job log", () => {
		const logs = byType(events, "log");
		expect(logs).toContainEqual({
			type: "log",
			key: "CI/build",
			line: "hello from build",
		});
		expect(logs).toContainEqual({
			type: "log",
			key: "CI/test-1",
			line: "testing node 18 version 1.2.3",
		});
		expect(logs).toContainEqual({
			type: "log",
			key: "CI/fail",
			line: "exitcode '3': failure",
		});
	});

	it("builds step keys without the evaluated step name", () => {
		const processor = new ActLogProcessor();
		const [, started] = processor.process(
			JSON.stringify({
				job: "CI/build",
				jobID: "build",
				stage: "Main",
				step: "echo token=s3cr3t-value",
				stepID: ["1"],
				msg: "⭐ Run Main echo token=s3cr3t-value",
			}),
		);
		expect(started).toMatchObject({ type: "step_started", stepKey: "Main:1" });
	});

	it("keeps non-JSON lines as run-level log lines", () => {
		const processor = new ActLogProcessor();
		expect(processor.process("Cloning into 'repo'...")).toEqual([
			{ type: "log", key: null, line: "Cloning into 'repo'..." },
		]);
		expect(processor.process("   ")).toEqual([]);
	});
});

describe("jobDisplayName", () => {
	it("appends matrix values", () => {
		expect(jobDisplayName("test", { node: 18, os: "linux" })).toBe(
			"test (18, linux)",
		);
		expect(jobDisplayName("build", {})).toBe("build");
	});
});

describe("LineBuffer", () => {
	it("joins lines split across chunks", () => {
		const buffer = new LineBuffer();
		expect(buffer.push('{"a":')).toEqual([]);
		expect(buffer.push('1}\r\n{"b"')).toEqual(['{"a":1}']);
		expect(buffer.push(":2}\n")).toEqual(['{"b":2}']);
		expect(buffer.push("tail")).toEqual([]);
		expect(buffer.flush()).toEqual(["tail"]);
	});
});
