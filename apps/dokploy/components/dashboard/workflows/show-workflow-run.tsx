import { ArrowLeft, Ban, GitBranch, Loader2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import {
	formatDuration,
	formatMs,
	isFinished,
	StatusIcon,
	statusLabel,
} from "./status";
import { eventLabel, githubRepositoryUrl } from "./utils";
import { WorkflowLogViewer } from "./workflow-log-viewer";

const RUN_LOG = "run";

interface Props {
	workflowRunId: string;
}

export const ShowWorkflowRun = ({ workflowRunId }: Props) => {
	const router = useRouter();
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: run, isPending } = api.workflow.oneRun.useQuery(
		{ workflowRunId },
		{
			refetchInterval: (query) =>
				query.state.data && isFinished(query.state.data.status) ? false : 2000,
		},
	);
	const rerun = api.workflow.rerun.useMutation();
	const cancel = api.workflow.cancelRun.useMutation();
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		if (!run || selected) return;
		const initial =
			run.jobs.find((job) => job.status === "failure") ??
			run.jobs.find((job) => job.status === "in_progress") ??
			run.jobs[0];
		if (initial) setSelected(initial.workflowJobId);
		else if (isFinished(run.status)) setSelected(RUN_LOG);
	}, [run, selected]);

	if (isPending || !run) {
		return (
			<div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-muted-foreground">
				<span>Loading...</span>
				<Loader2 className="size-4 animate-spin" />
			</div>
		);
	}

	const repoUrl = githubRepositoryUrl(
		run.repository.githubUrl,
		run.repository.owner,
		run.repository.repository,
	);
	const selectedJob = run.jobs.find((job) => job.workflowJobId === selected);
	const canRun = !!permissions?.workflow.run;
	const finished = isFinished(run.status);

	return (
		<div className="flex w-full flex-col gap-4">
			<Card className="rounded-xl bg-sidebar p-2.5">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
						<div className="min-w-0 space-y-1.5">
							<Link
								href={`/dashboard/workflows/repositories/${run.workflowRepositoryId}`}
								className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
							>
								<ArrowLeft className="size-4" />
								{run.repository.owner}/{run.repository.repository}
							</Link>
							<CardTitle className="flex items-center gap-2 text-xl">
								<StatusIcon status={run.status} className="size-5" />
								{run.workflowName} #{run.runNumber}
								{run.attempt > 1 && (
									<span className="text-base font-normal text-muted-foreground">
										attempt {run.attempt}
									</span>
								)}
							</CardTitle>
							<p className="truncate text-sm">{run.title}</p>
							<CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
								<span>{statusLabel(run.status)}</span>
								<span>{eventLabel(run.event, run.eventAction)}</span>
								{run.branch && (
									<Badge variant="outline" className="gap-1 font-normal">
										<GitBranch className="size-3" />
										{run.branch}
									</Badge>
								)}
								<a
									href={`${repoUrl}/commit/${run.sha}`}
									target="_blank"
									rel="noopener noreferrer"
									className="font-mono text-xs hover:text-foreground"
								>
									{run.sha.slice(0, 7)}
								</a>
								{run.actor && <span>by {run.actor}</span>}
								{run.server && <span>on {run.server.name}</span>}
								<DateTooltip date={run.createdAt}>Triggered</DateTooltip>
								<span>
									Duration {formatDuration(run.startedAt, run.finishedAt)}
								</span>
							</CardDescription>
						</div>
						{canRun && (
							<div className="flex gap-2">
								{!finished && (
									<DialogAction
										title="Cancel run"
										description="Stop this run? Running jobs are terminated."
										type="destructive"
										onClick={() =>
											cancel
												.mutateAsync({ workflowRunId })
												.then(() => {
													toast.success("Cancelling run");
													return utils.workflow.oneRun.invalidate({
														workflowRunId,
													});
												})
												.catch((error) => toast.error(error.message))
										}
									>
										<Button variant="outline" isLoading={cancel.isPending}>
											<Ban className="size-4" />
											Cancel
										</Button>
									</DialogAction>
								)}
								{finished && (
									<Button
										variant="outline"
										isLoading={rerun.isPending}
										onClick={() =>
											rerun
												.mutateAsync({ workflowRunId })
												.then((next) =>
													router.push(
														`/dashboard/workflows/runs/${next.workflowRunId}`,
													),
												)
												.catch((error) => toast.error(error.message))
										}
									>
										<RotateCcw className="size-4" />
										Re-run
									</Button>
								)}
							</div>
						)}
					</CardHeader>
					{run.errorMessage && (
						<CardContent className="pt-0">
							<AlertBlock type={run.status === "skipped" ? "warning" : "error"}>
								<span className="whitespace-pre-wrap">{run.errorMessage}</span>
							</AlertBlock>
						</CardContent>
					)}
				</div>
			</Card>

			<Card className="rounded-xl bg-sidebar p-2.5">
				<div className="grid gap-4 rounded-xl bg-background p-4 shadow-md lg:grid-cols-[280px_1fr]">
					<nav className="flex flex-col gap-1">
						<span className="px-2 pb-1 text-xs font-medium uppercase text-muted-foreground">
							Jobs
						</span>
						{run.jobs.length === 0 && !finished && (
							<span className="px-2 py-1 text-sm text-muted-foreground">
								{run.status === "queued"
									? "Waiting for the workflow server..."
									: "Starting..."}
							</span>
						)}
						{run.jobs.map((job) => (
							<button
								key={job.workflowJobId}
								type="button"
								onClick={() => setSelected(job.workflowJobId)}
								className={cn(
									"flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
									selected === job.workflowJobId && "bg-muted",
								)}
							>
								<StatusIcon status={job.status} />
								<span className="flex-1 truncate">{job.name}</span>
								<span className="text-xs text-muted-foreground">
									{job.startedAt
										? formatDuration(job.startedAt, job.finishedAt)
										: ""}
								</span>
							</button>
						))}
						{run.logPath && (
							<button
								type="button"
								onClick={() => setSelected(RUN_LOG)}
								className={cn(
									"mt-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted",
									selected === RUN_LOG && "bg-muted text-foreground",
								)}
							>
								Run log
							</button>
						)}
					</nav>

					<div className="flex min-w-0 flex-col gap-3">
						{selectedJob ? (
							<>
								<div className="flex items-center gap-2">
									<StatusIcon status={selectedJob.status} />
									<h3 className="font-medium">{selectedJob.name}</h3>
								</div>
								{selectedJob.steps.length > 0 && (
									<ol className="flex flex-col gap-1 rounded-md border p-2">
										{selectedJob.steps.map((step) => (
											<li
												key={step.key}
												className="flex items-center gap-2 px-1 text-sm"
											>
												<StatusIcon status={step.status} />
												<span className="flex-1 truncate">{step.name}</span>
												{step.durationMs !== undefined && (
													<span className="text-xs text-muted-foreground">
														{formatMs(step.durationMs)}
													</span>
												)}
											</li>
										))}
									</ol>
								)}
								{selectedJob.startedAt ? (
									<WorkflowLogViewer logPath={selectedJob.logPath} />
								) : (
									<p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
										This job didn't run
										{selectedJob.status === "skipped"
											? ": a job it needs failed, or its if condition was false."
											: "."}
									</p>
								)}
							</>
						) : selected === RUN_LOG && run.logPath ? (
							<WorkflowLogViewer logPath={run.logPath} />
						) : (
							<p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
								{finished
									? "No jobs ran."
									: "Jobs appear here once they start."}
							</p>
						)}
					</div>
				</div>
			</Card>
		</div>
	);
};
