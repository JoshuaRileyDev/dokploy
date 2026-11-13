import { executeWorkflowRun } from "./executor";

/** Where a run executes: a workflow server takes one run at a time, Boat takes up to its configured limit. */
export type QueueTarget = { key: string; capacity: number };

type QueuedRun = {
	workflowRunId: string;
	target: QueueTarget;
	concurrencyKey: string | null;
};

type QueueState = {
	waiting: QueuedRun[];
	active: Map<string, QueuedRun & { controller: AbortController }>;
};

// Dev can evaluate this module more than once, so the queue lives on globalThis like the deployment queue.
const globalForQueue = globalThis as unknown as {
	__dokployWorkflowQueue?: QueueState;
};
globalForQueue.__dokployWorkflowQueue ??= { waiting: [], active: new Map() };
const state = globalForQueue.__dokployWorkflowQueue;

const isBlocked = (queued: QueuedRun) => {
	const active = [...state.active.values()];
	return (
		active.filter((run) => run.target.key === queued.target.key).length >=
			queued.target.capacity ||
		active.some(
			(run) =>
				queued.concurrencyKey !== null &&
				run.concurrencyKey === queued.concurrencyKey,
		)
	);
};

const pump = () => {
	for (const queued of [...state.waiting]) {
		if (isBlocked(queued)) continue;
		state.waiting = state.waiting.filter(
			(run) => run.workflowRunId !== queued.workflowRunId,
		);
		const controller = new AbortController();
		state.active.set(queued.workflowRunId, { ...queued, controller });
		executeWorkflowRun(queued.workflowRunId, controller.signal)
			.catch((error) =>
				console.error(`Workflow run ${queued.workflowRunId} crashed`, error),
			)
			.finally(() => {
				state.active.delete(queued.workflowRunId);
				pump();
			});
	}
};

export const enqueueWorkflowRun = (
	workflowRunId: string,
	target: QueueTarget,
	concurrencyKey: string | null = null,
) => {
	if (
		state.active.has(workflowRunId) ||
		state.waiting.some((run) => run.workflowRunId === workflowRunId)
	) {
		return;
	}
	state.waiting.push({ workflowRunId, target, concurrencyKey });
	pump();
};

/** Returns true if the run was executing (the executor records the cancellation), false if it was only waiting. */
export const cancelQueuedOrActiveRun = (workflowRunId: string) => {
	const active = state.active.get(workflowRunId);
	if (active) {
		active.controller.abort();
		return true;
	}
	state.waiting = state.waiting.filter(
		(run) => run.workflowRunId !== workflowRunId,
	);
	return false;
};

export const activeWorkflowRunCounts = () => {
	const counts = new Map<string, number>();
	for (const run of [...state.active.values(), ...state.waiting]) {
		counts.set(run.target.key, (counts.get(run.target.key) ?? 0) + 1);
	}
	return counts;
};
