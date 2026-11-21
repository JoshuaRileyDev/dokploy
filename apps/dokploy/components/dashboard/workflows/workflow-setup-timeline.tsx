import type {
	WorkflowJobStatus,
	WorkflowRunStatus,
	WorkflowSetupTiming,
	WorkflowStepState,
} from "@dokploy/server/db/schema";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatMs, isFinished } from "./status";

// act reports its own job preparation (starting the container or host workspace) as this step.
const ACT_SETUP_STEP = "Set up job";

export type SetupRun = {
	status: WorkflowRunStatus;
	createdAt: string;
	startedAt: string | null;
	requiresRunner: boolean;
	runsOnBoat: boolean;
	setupTimings: WorkflowSetupTiming[];
	jobs: {
		status: WorkflowJobStatus;
		startedAt: string | null;
		steps: WorkflowStepState[];
	}[];
};

type Phase = {
	key: string;
	label: string;
	start: number;
	end: number | null;
};

export type SetupTimeline = {
	start: number;
	/** When the first job's first own step began; null while the run is still setting up. */
	ready: number | null;
	phases: Phase[];
};

const time = (iso?: string | null) => (iso ? Date.parse(iso) : undefined);

const latest = (...values: (number | undefined)[]) => {
	const known = values.filter((value) => value !== undefined);
	return known.length > 0 ? Math.max(...known) : undefined;
};

const firstJobStart = (run: SetupRun) => {
	const started = run.jobs
		.filter((job) => job.startedAt)
		.sort((a, b) => time(a.startedAt)! - time(b.startedAt)!);
	const job = started[0];
	if (!job) return {};
	const ownStep = job.steps.find(
		(step) => step.name !== ACT_SETUP_STEP && step.startedAt,
	);
	const setupStep = job.steps.find((step) => step.name === ACT_SETUP_STEP);
	const setupEnd =
		setupStep?.startedAt && setupStep.durationMs !== undefined
			? time(setupStep.startedAt)! + setupStep.durationMs
			: undefined;
	return {
		job: time(job.startedAt),
		ready: time(ownStep?.startedAt) ?? setupEnd,
	};
};

/** Splits the time from trigger to the first job step into the phases recorded along the way. */
export const buildSetupTimeline = (run: SetupRun): SetupTimeline => {
	const marks = new Map<string, number>();
	for (const { step, at } of run.setupTimings) {
		if (!marks.has(step)) marks.set(step, Date.parse(at));
	}
	const triggered = Date.parse(run.createdAt);
	const picked = time(run.startedAt);
	const { job, ready } = firstJobStart(run);
	const mark = (step: string) => marks.get(step);

	// The run script starts once the machine is connected and the inputs are ready; runners have no connection step.
	const scriptStart = run.requiresRunner
		? mark("inputs_ready")
		: mark("connected") !== undefined && mark("inputs_ready") !== undefined
			? latest(mark("connected"), mark("inputs_ready"))
			: undefined;
	const actStart =
		mark("act_started") ??
		latest(mark("repository_ready"), mark("machine_prepared"));

	// `open` says whether the phase can still be in progress for this run, so it's shown counting up.
	const candidates: (Omit<Phase, "start" | "end"> & {
		start: number | undefined;
		end: number | undefined;
		open: boolean;
	})[] = [
		{
			key: "queue",
			label: run.requiresRunner
				? "Waiting for a runner"
				: "Waiting for a free machine",
			start: triggered,
			end: picked,
			open: true,
		},
		{
			key: "sandbox",
			label: "Starting the Boat sandbox",
			start: picked,
			end: mark("sandbox_ready"),
			open: run.runsOnBoat,
		},
		{
			key: "ssh",
			label: run.runsOnBoat ? "Starting the runner" : "Connecting over SSH",
			start: run.runsOnBoat ? mark("sandbox_ready") : picked,
			end: mark("connected"),
			open: !run.requiresRunner,
		},
		{
			key: "inputs",
			label: "Loading secrets",
			start: picked,
			end: mark("inputs_ready"),
			open: true,
		},
		{
			key: "repository",
			label: "Fetching the repository",
			start: scriptStart,
			end: mark("repository_ready"),
			open: true,
		},
		{
			key: "prepare",
			label: "Preparing Docker and actions",
			start: scriptStart,
			end: mark("machine_prepared"),
			open: run.runsOnBoat && mark("repository_ready") !== undefined,
		},
		{
			key: "act",
			label: "Starting act",
			start: actStart,
			end: job,
			open: true,
		},
		{
			key: "job",
			label: "Setting up the job",
			start: job,
			end: ready,
			open: true,
		},
	];
	// Runs from before setup timings were recorded only know when the machine was picked and the job started.
	if (marks.size === 0 && picked !== undefined && job !== undefined) {
		candidates.splice(1, candidates.length - 2, {
			key: "machine",
			label: "Preparing the machine",
			start: picked,
			end: job,
			open: false,
		});
	}

	const running = !isFinished(run.status) && ready === undefined;
	const phases: Phase[] = [];
	for (const { open, ...candidate } of candidates) {
		if (candidate.start === undefined) continue;
		if (candidate.end !== undefined) {
			phases.push({
				...candidate,
				start: candidate.start,
				end: Math.max(candidate.end, candidate.start),
			});
		} else if (running && open) {
			phases.push({ ...candidate, start: candidate.start, end: null });
		}
	}
	return { start: triggered, ready: ready ?? null, phases };
};

export const formatSetupMs = (ms: number) =>
	ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatMs(ms);

const useNow = (active: boolean) => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const interval = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(interval);
	}, [active]);
	return now;
};

/** Time from trigger until the first job step started, counting up while the run is still setting up. */
export const SetupDuration = ({ run }: { run: SetupRun }) => {
	const timeline = buildSetupTimeline(run);
	const live = timeline.ready === null && !isFinished(run.status);
	const now = useNow(live);
	if (timeline.ready === null && !live) return <>—</>;
	return <>{formatSetupMs((timeline.ready ?? now) - timeline.start)}</>;
};

export const WorkflowSetupTimeline = ({ run }: { run: SetupRun }) => {
	const timeline = buildSetupTimeline(run);
	const live = timeline.ready === null && !isFinished(run.status);
	const now = useNow(live);
	const end = Math.max(
		timeline.ready ?? now,
		...timeline.phases.map((phase) => phase.end ?? now),
		timeline.start + 1,
	);
	const span = end - timeline.start;
	const percent = (value: number) => ((value - timeline.start) / span) * 100;

	return (
		<div className="flex flex-col gap-4 rounded-md border p-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<div>
					<h3 className="font-medium">Set up</h3>
					<p className="text-sm text-muted-foreground">
						{timeline.ready !== null
							? "Time from the trigger until the first job's first step started."
							: live
								? "The run is still setting up."
								: "The run ended before a job started."}
					</p>
				</div>
				{(timeline.ready !== null || live) && (
					<span className="text-2xl font-semibold tabular-nums">
						{formatSetupMs((timeline.ready ?? now) - timeline.start)}
					</span>
				)}
			</div>
			{timeline.phases.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No setup timings were recorded for this run.
				</p>
			) : (
				<div className="flex flex-col gap-2">
					{timeline.phases.map((phase) => {
						const phaseEnd = phase.end ?? now;
						const duration = formatSetupMs(phaseEnd - phase.start);
						return (
							<div
								key={phase.key}
								className="grid grid-cols-[minmax(0,14rem)_1fr_3.5rem] items-center gap-3 text-sm"
							>
								<span className="truncate">{phase.label}</span>
								<div className="relative h-2 rounded-full bg-muted">
									<div
										title={`${phase.label}: ${duration}${phase.end === null ? " so far" : ""}`}
										className={cn(
											"absolute inset-y-0 min-w-[3px] rounded-[4px] bg-primary",
											phase.end === null && "animate-pulse",
										)}
										style={{
											left: `${percent(phase.start)}%`,
											width: `${percent(phaseEnd) - percent(phase.start)}%`,
										}}
									/>
								</div>
								<span className="text-right tabular-nums text-muted-foreground">
									{duration}
								</span>
							</div>
						);
					})}
					<div className="grid grid-cols-[minmax(0,14rem)_1fr_3.5rem] gap-3 text-xs text-muted-foreground">
						<span />
						<div className="flex justify-between tabular-nums">
							<span>Triggered</span>
							<span>{formatSetupMs(span)}</span>
						</div>
						<span />
					</div>
				</div>
			)}
			<p className="text-xs text-muted-foreground">
				Some phases overlap: the machine starts while secrets and the workflow
				file load, and Docker is prepared while the repository is fetched.
			</p>
		</div>
	);
};
