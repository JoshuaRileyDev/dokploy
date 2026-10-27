import type {
	WorkflowJobSummary,
	WorkflowTrigger,
} from "@dokploy/server/utils/workflows/parser";
import { ListTree } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { RunWorkflowDialog } from "./run-workflow-dialog";

interface Props {
	workflowRepositoryId: string;
	defaultBranch: string;
	definition: {
		workflowDefinitionId: string;
		name: string;
		path: string;
		enabled: boolean;
		triggers: WorkflowTrigger[];
		jobs: WorkflowJobSummary[];
		disabledJobs: string[];
	};
	canEdit: boolean;
	runnable: boolean;
}

export const WorkflowJobsSheet = ({
	workflowRepositoryId,
	defaultBranch,
	definition,
	canEdit,
	runnable,
}: Props) => {
	const utils = api.useUtils();
	const setJobEnabled = api.workflow.setJobEnabled.useMutation();
	const total = definition.jobs.length;
	const enabled = definition.jobs.filter(
		(job) => !definition.disabledJobs.includes(job.id),
	).length;

	return (
		<Sheet>
			<SheetTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 px-2 font-normal text-muted-foreground"
				>
					<ListTree className="size-3.5" />
					{enabled === total
						? `${total} ${total === 1 ? "job" : "jobs"}`
						: `${enabled} of ${total} jobs`}
				</Button>
			</SheetTrigger>
			<SheetContent className="w-full overflow-y-auto sm:max-w-xl">
				<SheetHeader>
					<SheetTitle>{definition.name}</SheetTitle>
					<SheetDescription className="font-mono text-xs">
						{definition.path}
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-2 px-4 pb-4">
					<p className="text-sm text-muted-foreground">
						Disabled jobs are skipped on every run, along with the jobs that
						need them.
					</p>
					{definition.jobs.map((job) => {
						const jobEnabled = !definition.disabledJobs.includes(job.id);
						return (
							<div
								key={job.id}
								className={cn(
									"flex items-start justify-between gap-3 rounded-lg border p-3",
									(!jobEnabled || !definition.enabled) &&
										"text-muted-foreground",
								)}
							>
								<div className="flex min-w-0 flex-col gap-1">
									<span className="flex items-center gap-2 font-medium">
										{job.name}
										{job.hasMatrix && (
											<Badge variant="outline" className="font-normal">
												matrix
											</Badge>
										)}
									</span>
									{job.name !== job.id && (
										<span className="font-mono text-xs text-muted-foreground">
											{job.id}
										</span>
									)}
									<span className="text-xs text-muted-foreground">
										<span className="font-mono">
											{job.uses ?? job.runsOn.join(", ")}
										</span>
										{job.needs.length > 0 && (
											<> · needs {job.needs.join(", ")}</>
										)}
									</span>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									{runnable && (
										<RunWorkflowDialog
											workflowRepositoryId={workflowRepositoryId}
											defaultBranch={defaultBranch}
											definition={definition}
											job={job}
										/>
									)}
									<Switch
										disabled={!canEdit}
										checked={jobEnabled}
										aria-label={`${jobEnabled ? "Disable" : "Enable"} ${job.name}`}
										onCheckedChange={(value) =>
											setJobEnabled
												.mutateAsync({
													workflowDefinitionId: definition.workflowDefinitionId,
													jobId: job.id,
													enabled: value,
												})
												.catch((error) => toast.error(error.message))
												.finally(() =>
													utils.workflow.oneRepository.invalidate({
														workflowRepositoryId,
													}),
												)
										}
									/>
								</div>
							</div>
						);
					})}
				</div>
			</SheetContent>
		</Sheet>
	);
};
