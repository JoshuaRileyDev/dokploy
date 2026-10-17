import { parse } from "yaml";

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
			runsOn: parseRunsOn(job["runs-on"]),
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
