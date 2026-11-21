import { describe, expect, it } from "vitest";
import {
	buildSetupTimeline,
	type SetupRun,
} from "@/components/dashboard/workflows/workflow-setup-timeline";

const at = (seconds: number) =>
	new Date(Date.UTC(2026, 10, 21, 12, 0, 0) + seconds * 1000).toISOString();

const boatRun = (overrides: Partial<SetupRun> = {}): SetupRun => ({
	status: "success",
	createdAt: at(0),
	startedAt: at(0.5),
	requiresRunner: false,
	runsOnBoat: true,
	setupTimings: [
		{ step: "inputs_ready", at: at(1.5) },
		{ step: "sandbox_ready", at: at(4) },
		{ step: "connected", at: at(4.5) },
		{ step: "repository_ready", at: at(6) },
		{ step: "machine_prepared", at: at(8) },
		{ step: "act_started", at: at(8.1) },
	],
	jobs: [
		{
			status: "success",
			startedAt: at(8.3),
			steps: [
				{
					key: "a",
					name: "Set up job",
					status: "success",
					startedAt: at(8.3),
					durationMs: 200,
				},
				{ key: "b", name: "Main build", status: "success", startedAt: at(8.6) },
			],
		},
	],
	...overrides,
});

const durations = (run: SetupRun) =>
	Object.fromEntries(
		buildSetupTimeline(run).phases.map((phase) => [
			phase.key,
			((phase.end ?? Number.NaN) - phase.start) / 1000,
		]),
	);

describe("buildSetupTimeline", () => {
	it("measures setup until the first job's own step, phase by phase", () => {
		const timeline = buildSetupTimeline(boatRun());
		expect((timeline.ready! - timeline.start) / 1000).toBeCloseTo(8.6);
		expect(durations(boatRun())).toEqual({
			queue: 0.5,
			sandbox: 3.5,
			ssh: 0.5,
			inputs: 1,
			repository: 1.5,
			prepare: 3.5,
			act: expect.closeTo(0.2),
			job: expect.closeTo(0.3),
		});
	});

	it("shows only what applies to a run that's still setting up", () => {
		const timeline = buildSetupTimeline(
			boatRun({
				status: "in_progress",
				setupTimings: [{ step: "inputs_ready", at: at(1.5) }],
				jobs: [],
			}),
		);
		expect(
			timeline.phases.map((phase) => [phase.key, phase.end === null]),
		).toEqual([
			["queue", false],
			["sandbox", true],
			["inputs", false],
		]);
		expect(timeline.ready).toBeNull();
	});

	it("falls back to one machine phase for runs recorded before setup timings", () => {
		expect(Object.keys(durations(boatRun({ setupTimings: [] })))).toEqual([
			"queue",
			"machine",
			"job",
		]);
	});

	it("doesn't count a failed job setup as ready", () => {
		const run = boatRun({ status: "failure" });
		run.jobs[0]!.steps = [
			{
				key: "a",
				name: "Set up job",
				status: "failure",
				startedAt: at(8.3),
				durationMs: 200,
			},
		];
		expect(buildSetupTimeline(run).ready).toBeNull();
	});
});
