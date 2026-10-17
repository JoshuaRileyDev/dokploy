import { db } from "@dokploy/server/db";
import {
	type WorkflowJobStatus,
	type WorkflowRunStatus,
	workflowRuns,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { getDokployUrl } from "../../services/admin";
import { authGithub } from "../providers/github";

const CONCLUSIONS: Partial<Record<WorkflowRunStatus, string>> = {
	success: "success",
	failure: "failure",
	cancelled: "cancelled",
	skipped: "skipped",
};

const JOB_ICONS: Record<WorkflowJobStatus, string> = {
	queued: "⏳",
	in_progress: "🔄",
	success: "✅",
	failure: "❌",
	cancelled: "🚫",
	skipped: "⏭️",
};

export const checkRunSummary = (run: {
	errorMessage: string | null;
	jobs: { name: string; status: WorkflowJobStatus }[];
}) =>
	[
		...(run.errorMessage ? [run.errorMessage, ""] : []),
		...run.jobs.map((job) => `- ${JOB_ICONS[job.status]} ${job.name}`),
	].join("\n") || "No jobs ran.";

const warnedRepositories = new Set<string>();
const chains = new Map<string, Promise<void>>();

const syncNow = async (workflowRunId: string) => {
	const run = await db.query.workflowRuns.findFirst({
		where: eq(workflowRuns.workflowRunId, workflowRunId),
		with: {
			repository: { with: { github: true } },
			jobs: { orderBy: (jobs, { asc }) => [asc(jobs.position)] },
		},
	});
	const github = run?.repository.github;
	if (!run || !github) return;

	const { owner, repository } = run.repository;
	const octokit = authGithub(github);
	const conclusion = CONCLUSIONS[run.status];
	const body = {
		owner,
		repo: repository,
		name: `Dokploy / ${run.workflowName}`,
		head_sha: run.sha,
		external_id: run.workflowRunId,
		details_url: `${await getDokployUrl()}/dashboard/workflows/runs/${run.workflowRunId}`,
		...(conclusion
			? {
					status: "completed" as const,
					conclusion: conclusion as "success",
					completed_at: run.finishedAt ?? new Date().toISOString(),
					output: {
						title: `${run.workflowName} #${run.runNumber}: ${conclusion}`,
						summary: checkRunSummary(run),
					},
				}
			: {
					status:
						run.status === "in_progress"
							? ("in_progress" as const)
							: ("queued" as const),
					...(run.startedAt ? { started_at: run.startedAt } : {}),
				}),
	};

	try {
		if (run.checkRunId) {
			await octokit.rest.checks.update({
				...body,
				check_run_id: Number(run.checkRunId),
			});
		} else {
			const { data } = await octokit.rest.checks.create(body);
			await db
				.update(workflowRuns)
				.set({ checkRunId: String(data.id) })
				.where(eq(workflowRuns.workflowRunId, workflowRunId));
		}
	} catch (error) {
		const status = (error as { status?: number }).status;
		const key = `${owner}/${repository}`;
		if (status === 403 && !warnedRepositories.has(key)) {
			warnedRepositories.add(key);
			console.warn(
				`Can't report workflow status to GitHub for ${key}: the GitHub App needs the "Checks: read and write" permission.`,
			);
		} else if (status !== 403) {
			console.error(`Failed to update the GitHub check run for ${key}`, error);
		}
	}
};

/** Mirrors the run's current state to a GitHub check run. Calls for the same run are serialized so updates can't overtake the create. */
export const syncWorkflowCheckRun = (workflowRunId: string) => {
	const next = (chains.get(workflowRunId) ?? Promise.resolve())
		.then(() => syncNow(workflowRunId))
		.catch((error) => console.error("Check run sync failed", error));
	chains.set(workflowRunId, next);
	next.finally(() => {
		if (chains.get(workflowRunId) === next) chains.delete(workflowRunId);
	});
	return next;
};
