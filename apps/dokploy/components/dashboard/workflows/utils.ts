import type { WorkflowTrigger } from "@dokploy/server/utils/workflows/parser";

const EVENT_LABELS: Record<string, string> = {
	push: "Push",
	pull_request: "Pull request",
	release: "Release",
	create: "Branch or tag created",
	schedule: "Schedule",
	workflow_dispatch: "Manual",
};

export const describeTrigger = (trigger: WorkflowTrigger) => {
	const label = EVENT_LABELS[trigger.event] ?? trigger.event;
	const details = [
		...(trigger.branches ?? []),
		...(trigger.tags ?? []).map((tag) => `tag ${tag}`),
		...(trigger.types ?? []),
		...(trigger.cron ?? []),
	];
	return details.length > 0 ? `${label}: ${details.join(", ")}` : label;
};

export const SUPPORTED_EVENTS = new Set(Object.keys(EVENT_LABELS));

export const eventLabel = (event: string, action?: string | null) => {
	const label = EVENT_LABELS[event] ?? event;
	return action ? `${label} (${action})` : label;
};

export const githubRepositoryUrl = (
	githubUrl: string | null | undefined,
	owner: string,
	repository: string,
) => `${githubUrl ?? "https://github.com"}/${owner}/${repository}`;
