import type { WorkflowRunStatus } from "@dokploy/server/db/schema";
import { CircleDashed, GitBranch, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";
import { formatDuration, StatusIcon, statusLabel } from "./status";
import { eventLabel } from "./utils";

const STATUS_FILTERS: (WorkflowRunStatus | "all")[] = [
	"all",
	"queued",
	"in_progress",
	"success",
	"failure",
	"cancelled",
	"skipped",
];

interface Props {
	workflowRepositoryId?: string;
}

export const ShowWorkflowRuns = ({ workflowRepositoryId }: Props) => {
	const [status, setStatus] = useState<WorkflowRunStatus | "all">("all");
	const { data: runs, isPending } = api.workflow.runs.useQuery(
		{
			workflowRepositoryId,
			status: status === "all" ? undefined : status,
			limit: 50,
		},
		{ refetchInterval: 5000 },
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex justify-end">
				<Select
					value={status}
					onValueChange={(value) => setStatus(value as typeof status)}
				>
					<SelectTrigger className="w-44">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{STATUS_FILTERS.map((value) => (
							<SelectItem key={value} value={value}>
								{value === "all" ? "All statuses" : statusLabel(value)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{isPending ? (
				<div className="flex min-h-[25vh] items-center justify-center gap-2 text-sm text-muted-foreground">
					<span>Loading...</span>
					<Loader2 className="size-4 animate-spin" />
				</div>
			) : !runs?.length ? (
				<div className="flex min-h-[25vh] flex-col items-center justify-center gap-2 text-center">
					<CircleDashed className="size-8 text-muted-foreground" />
					<span className="text-base text-muted-foreground">No runs yet.</span>
					<span className="max-w-md text-sm text-muted-foreground">
						Runs start when a matching push, pull request, release or tag
						arrives from GitHub, or when you run a workflow manually.
					</span>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Run</TableHead>
							{!workflowRepositoryId && <TableHead>Repository</TableHead>}
							<TableHead>Trigger</TableHead>
							<TableHead>Duration</TableHead>
							<TableHead>Started</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{runs.map((run) => (
							<TableRow key={run.workflowRunId}>
								<TableCell>
									<Link
										href={`/dashboard/workflows/runs/${run.workflowRunId}`}
										className="group flex items-start gap-2"
									>
										<StatusIcon status={run.status} className="mt-0.5" />
										<span className="flex min-w-0 flex-col">
											<span className="font-medium group-hover:underline">
												{run.workflowName} #{run.runNumber}
												{run.attempt > 1 && (
													<span className="text-muted-foreground">
														{" "}
														(attempt {run.attempt})
													</span>
												)}
											</span>
											<span className="max-w-md truncate text-sm text-muted-foreground">
												{run.title}
											</span>
										</span>
									</Link>
								</TableCell>
								{!workflowRepositoryId && (
									<TableCell>
										<Link
											href={`/dashboard/workflows/repositories/${run.workflowRepositoryId}`}
											className="text-sm hover:underline"
										>
											{run.owner}/{run.repository}
										</Link>
									</TableCell>
								)}
								<TableCell>
									<div className="flex flex-col gap-1 text-sm">
										<span>{eventLabel(run.event, run.eventAction)}</span>
										<span className="flex items-center gap-1.5 text-muted-foreground">
											{run.branch && (
												<Badge variant="outline" className="gap-1 font-normal">
													<GitBranch className="size-3" />
													{run.branch}
												</Badge>
											)}
											<span className="font-mono text-xs">
												{run.sha.slice(0, 7)}
											</span>
										</span>
									</div>
								</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{formatDuration(run.startedAt, run.finishedAt)}
								</TableCell>
								<TableCell>
									<DateTooltip date={run.createdAt} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
};
