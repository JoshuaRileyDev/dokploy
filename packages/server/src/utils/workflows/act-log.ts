export type ActStepResult = "success" | "failure" | "skipped";
export type ActJobResult = "success" | "failure" | "cancelled" | "skipped";

export type ActLogEvent =
	| {
			type: "job_started";
			key: string;
			jobId: string;
			matrix: Record<string, unknown>;
	  }
	| { type: "step_started"; key: string; stepKey: string; name: string }
	| {
			type: "step_finished";
			key: string;
			stepKey: string;
			name: string;
			result: ActStepResult;
			durationMs?: number;
	  }
	| { type: "job_finished"; key: string; result: ActJobResult }
	| { type: "log"; key: string | null; line: string };

type ActJsonLine = {
	msg?: string;
	level?: string;
	job?: string;
	jobID?: string;
	matrix?: Record<string, unknown>;
	stage?: string;
	step?: string;
	stepID?: string[];
	stepid?: string[];
	raw_output?: boolean;
	stepResult?: ActStepResult;
	jobResult?: ActJobResult;
	executionTime?: number;
};

const STEP_START_PREFIX = "⭐ Run ";

const parseJson = (line: string): ActJsonLine | null => {
	if (!line.startsWith("{")) return null;
	try {
		return JSON.parse(line) as ActJsonLine;
	} catch {
		return null;
	}
};

const stepName = (entry: ActJsonLine) =>
	entry.stage && entry.stage !== "Main"
		? `${entry.stage} ${entry.step}`
		: (entry.step ?? "");

// Not built from the step name: act evaluates expressions in names, so they can contain secrets.
const stepKey = (entry: ActJsonLine) =>
	`${entry.stage ?? ""}:${(entry.stepID ?? entry.stepid ?? []).join("/")}`;

/** Turns `act --json` output into job, step and log events. Matrix jobs are keyed by act's per-instance job name. */
export class ActLogProcessor {
	private readonly startedJobs = new Set<string>();

	process(line: string): ActLogEvent[] {
		const entry = parseJson(line.trim());
		if (!entry) return line.trim() ? [{ type: "log", key: null, line }] : [];
		if (!entry.job || !entry.jobID) {
			return entry.msg
				? [{ type: "log", key: null, line: entry.msg.trimEnd() }]
				: [];
		}

		const key = entry.job.trim();
		const events: ActLogEvent[] = [];

		if (!this.startedJobs.has(key)) {
			this.startedJobs.add(key);
			events.push({
				type: "job_started",
				key,
				jobId: entry.jobID,
				matrix: entry.matrix ?? {},
			});
		}

		const msg = (entry.msg ?? "").replace(/\n$/, "");

		if (entry.step && msg.startsWith(STEP_START_PREFIX)) {
			events.push({
				type: "step_started",
				key,
				stepKey: stepKey(entry),
				name: stepName(entry),
			});
		}

		if (msg) {
			for (const text of entry.raw_output ? msg.split("\n") : [msg.trim()]) {
				events.push({ type: "log", key, line: text });
			}
		}

		if (entry.step && entry.stepResult) {
			events.push({
				type: "step_finished",
				key,
				stepKey: stepKey(entry),
				name: stepName(entry),
				result: entry.stepResult,
				durationMs:
					entry.executionTime !== undefined
						? Math.round(entry.executionTime / 1_000_000)
						: undefined,
			});
		}

		if (entry.jobResult) {
			events.push({ type: "job_finished", key, result: entry.jobResult });
		}

		return events;
	}
}

/** Builds the label shown for a job instance, e.g. "test (18)" for a matrix job. */
export const jobDisplayName = (
	jobName: string,
	matrix: Record<string, unknown>,
) => {
	const values = Object.values(matrix);
	return values.length > 0
		? `${jobName} (${values.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")})`
		: jobName;
};

/** Splits a stream of chunks into complete lines, keeping any trailing partial line for the next chunk. */
export class LineBuffer {
	private pending = "";

	push(chunk: string): string[] {
		const parts = (this.pending + chunk).split("\n");
		this.pending = parts.pop() ?? "";
		return parts.map((part) => part.replace(/\r$/, ""));
	}

	flush(): string[] {
		const rest = this.pending;
		this.pending = "";
		return rest ? [rest] : [];
	}
}
