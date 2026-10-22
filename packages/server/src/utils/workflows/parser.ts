import { parse, parseDocument } from "yaml";

export type WorkflowDispatchInput = {
	description?: string;
	required?: boolean;
	default?: string | number | boolean;
	type?: "string" | "boolean" | "choice" | "number" | "environment";
	options?: string[];
};

export type WorkflowTrigger = {
	event: string;
	types?: string[];
	branches?: string[];
	branchesIgnore?: string[];
	tags?: string[];
	tagsIgnore?: string[];
	paths?: string[];
	pathsIgnore?: string[];
	cron?: string[];
	inputs?: Record<string, WorkflowDispatchInput>;
};

export type WorkflowJobSummary = {
	id: string;
	name: string;
	needs: string[];
	runsOn: string[];
	uses?: string;
	hasMatrix: boolean;
};

export type ParsedWorkflow = {
	name: string;
	triggers: WorkflowTrigger[];
	jobs: WorkflowJobSummary[];
	concurrency?: { group: string; cancelInProgress: boolean };
};

export class WorkflowParseError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toStringList = (value: unknown, field: string): string[] | undefined => {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.map((v) => String(v));
	throw new WorkflowParseError(`"${field}" must be a string or a list`);
};

const FILTER_KEYS: Record<string, keyof WorkflowTrigger> = {
	types: "types",
	branches: "branches",
	"branches-ignore": "branchesIgnore",
	tags: "tags",
	"tags-ignore": "tagsIgnore",
	paths: "paths",
	"paths-ignore": "pathsIgnore",
};

const parseTrigger = (event: string, config: unknown): WorkflowTrigger => {
	const trigger: WorkflowTrigger = { event };
	if (config === null || config === undefined) return trigger;

	if (event === "schedule") {
		if (!Array.isArray(config)) {
			throw new WorkflowParseError('"on.schedule" must be a list of crons');
		}
		trigger.cron = config.map((entry) => {
			if (!isRecord(entry) || typeof entry.cron !== "string") {
				throw new WorkflowParseError(
					'Each "on.schedule" entry needs a "cron" string',
				);
			}
			return entry.cron;
		});
		return trigger;
	}

	if (!isRecord(config)) {
		throw new WorkflowParseError(`"on.${event}" must be a mapping`);
	}

	for (const [key, field] of Object.entries(FILTER_KEYS)) {
		const list = toStringList(config[key], `on.${event}.${key}`);
		if (list) (trigger[field] as string[]) = list;
	}

	if (trigger.branches && trigger.branchesIgnore) {
		throw new WorkflowParseError(
			`"on.${event}" can't use both "branches" and "branches-ignore"`,
		);
	}
	if (trigger.tags && trigger.tagsIgnore) {
		throw new WorkflowParseError(
			`"on.${event}" can't use both "tags" and "tags-ignore"`,
		);
	}
	if (trigger.paths && trigger.pathsIgnore) {
		throw new WorkflowParseError(
			`"on.${event}" can't use both "paths" and "paths-ignore"`,
		);
	}

	if (
		(event === "workflow_dispatch" || event === "workflow_call") &&
		isRecord(config.inputs)
	) {
		trigger.inputs = {};
		for (const [name, input] of Object.entries(config.inputs)) {
			if (!isRecord(input)) {
				throw new WorkflowParseError(`Input "${name}" must be a mapping`);
			}
			trigger.inputs[name] = {
				description:
					typeof input.description === "string" ? input.description : undefined,
				required: input.required === true,
				default: input.default as WorkflowDispatchInput["default"],
				type: (input.type as WorkflowDispatchInput["type"]) ?? "string",
				options: toStringList(input.options, `inputs.${name}.options`),
			};
		}
	}

	return trigger;
};

const parseTriggers = (on: unknown): WorkflowTrigger[] => {
	if (typeof on === "string") return [{ event: on }];
	if (Array.isArray(on)) return on.map((event) => ({ event: String(event) }));
	if (isRecord(on)) {
		return Object.entries(on).map(([event, config]) =>
			parseTrigger(event, config),
		);
	}
	throw new WorkflowParseError('Missing or invalid "on"');
};

const parseRunsOn = (value: unknown): string[] => {
	if (value === undefined) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.map((v) => String(v));
	if (isRecord(value)) {
		return toStringList(value.labels, "runs-on.labels") ?? [];
	}
	throw new WorkflowParseError('"runs-on" must be a string, list or mapping');
};

const MATRIX_REFERENCE = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/;

/** Resolves `runs-on: ${{ matrix.os }}` to the matrix's values, so runs can be routed by label. */
const expandMatrixRunsOn = (labels: string[], strategy: unknown) => {
	const matrix =
		isRecord(strategy) && isRecord(strategy.matrix) ? strategy.matrix : null;
	if (!matrix) return labels;
	return [
		...new Set(
			labels.flatMap((label) => {
				const key = label.match(MATRIX_REFERENCE)?.[1];
				if (!key) return [label];
				const values = Array.isArray(matrix[key]) ? matrix[key] : [];
				const included = Array.isArray(matrix.include)
					? matrix.include.flatMap((entry) =>
							isRecord(entry) && entry[key] !== undefined ? [entry[key]] : [],
						)
					: [];
				const expanded = [...values, ...included].filter(
					(value): value is string => typeof value === "string",
				);
				return expanded.length > 0 ? expanded : [label];
			}),
		),
	];
};

/** Every runs-on label across a workflow's jobs. */
/** A job plus every job it transitively needs, which is what `act -j` runs. */
export const jobWithNeeds = (workflow: ParsedWorkflow, jobId: string) => {
	const byId = new Map(workflow.jobs.map((job) => [job.id, job]));
	const ids = new Set<string>();
	const visit = (id: string) => {
		if (ids.has(id) || !byId.has(id)) return;
		ids.add(id);
		for (const need of byId.get(id)!.needs) visit(need);
	};
	visit(jobId);
	return ids;
};

export const workflowRunsOn = (
	workflow: ParsedWorkflow,
	{
		targetJob,
		skippedJobs = [],
	}: { targetJob?: string | null; skippedJobs?: string[] } = {},
) => {
	const included = targetJob ? jobWithNeeds(workflow, targetJob) : null;
	return [
		...new Set(
			workflow.jobs
				.filter((job) =>
					included ? included.has(job.id) : !skippedJobs.includes(job.id),
				)
				.flatMap((job) => job.runsOn),
		),
	];
};

/**
 * Rewrites a workflow so the given jobs get `if: false`. act has no flag to skip a job, and
 * this keeps GitHub's semantics: jobs that need a skipped job are skipped too.
 */
export const disableWorkflowJobs = (content: string, jobIds: string[]) => {
	const document = parseDocument(content);
	for (const jobId of jobIds) {
		if (document.hasIn(["jobs", jobId])) {
			document.setIn(["jobs", jobId, "if"], false);
		}
	}
	return document.toString();
};

const parseJobs = (jobs: unknown): WorkflowJobSummary[] => {
	if (!isRecord(jobs) || Object.keys(jobs).length === 0) {
		throw new WorkflowParseError('Missing or empty "jobs"');
	}

	const summaries = Object.entries(jobs).map(([id, job]) => {
		if (!isRecord(job)) {
			throw new WorkflowParseError(`Job "${id}" must be a mapping`);
		}
		const uses = typeof job.uses === "string" ? job.uses : undefined;
		if (!uses && job["runs-on"] === undefined) {
			throw new WorkflowParseError(`Job "${id}" is missing "runs-on"`);
		}
		if (!uses && !Array.isArray(job.steps)) {
			throw new WorkflowParseError(`Job "${id}" is missing "steps"`);
		}
		return {
			id,
			name: typeof job.name === "string" ? job.name : id,
			needs: toStringList(job.needs, `jobs.${id}.needs`) ?? [],
			runsOn: expandMatrixRunsOn(parseRunsOn(job["runs-on"]), job.strategy),
			uses,
			hasMatrix: isRecord(job.strategy) && job.strategy.matrix !== undefined,
		};
	});

	const ids = new Set(summaries.map((job) => job.id));
	for (const job of summaries) {
		for (const need of job.needs) {
			if (!ids.has(need)) {
				throw new WorkflowParseError(
					`Job "${job.id}" needs unknown job "${need}"`,
				);
			}
		}
	}
	assertNoCycles(summaries);

	return summaries;
};

const assertNoCycles = (jobs: WorkflowJobSummary[]) => {
	const byId = new Map(jobs.map((job) => [job.id, job]));
	const state = new Map<string, "visiting" | "done">();

	const visit = (id: string, path: string[]) => {
		if (state.get(id) === "done") return;
		if (state.get(id) === "visiting") {
			throw new WorkflowParseError(
				`Jobs have a dependency cycle: ${[...path, id].join(" -> ")}`,
			);
		}
		state.set(id, "visiting");
		for (const need of byId.get(id)?.needs ?? []) {
			visit(need, [...path, id]);
		}
		state.set(id, "done");
	};

	for (const job of jobs) visit(job.id, []);
};

const parseConcurrency = (value: unknown): ParsedWorkflow["concurrency"] => {
	if (typeof value === "string") {
		return { group: value, cancelInProgress: false };
	}
	if (isRecord(value) && typeof value.group === "string") {
		return {
			group: value.group,
			cancelInProgress: value["cancel-in-progress"] === true,
		};
	}
	return undefined;
};

/** Parses the parts of a GitHub Actions workflow Dokploy needs server-side; act handles the rest at run time. */
export const parseWorkflow = (
	content: string,
	fallbackName: string,
): ParsedWorkflow => {
	let doc: unknown;
	try {
		doc = parse(content);
	} catch (error) {
		throw new WorkflowParseError(
			`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(doc)) {
		throw new WorkflowParseError("Workflow must be a YAML mapping");
	}

	return {
		name: typeof doc.name === "string" ? doc.name : fallbackName,
		triggers: parseTriggers(doc.on),
		jobs: parseJobs(doc.jobs),
		concurrency: parseConcurrency(doc.concurrency),
	};
};
