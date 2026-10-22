import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { RunWorkflowDialog } from "./run-workflow-dialog";
import { describeTrigger, SUPPORTED_EVENTS } from "./utils";

interface Props {
	workflowRepositoryId: string;
}

export const WorkflowDefinitionsTable = ({ workflowRepositoryId }: Props) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: repository } = api.workflow.oneRepository.useQuery({
		workflowRepositoryId,
	});
	const setEnabled = api.workflow.setDefinitionEnabled.useMutation();
	const setJobEnabled = api.workflow.setJobEnabled.useMutation();
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const canEdit = !!permissions?.workflow.create;
	const canRun = !!permissions?.workflow.run;

	const refresh = () =>
		utils.workflow.oneRepository.invalidate({ workflowRepositoryId });

	const toggleCollapsed = (workflowDefinitionId: string) =>
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(workflowDefinitionId)) next.delete(workflowDefinitionId);
			else next.add(workflowDefinitionId);
			return next;
		});

	if (!repository) return null;

	return (
		<div className="flex flex-col gap-3">
			{repository.definitions.length === 0 ? (
				<p className="py-10 text-center text-sm text-muted-foreground">
					No workflow files found in .dokploy/workflows or .github/workflows.
				</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-8" />
							<TableHead>Workflow</TableHead>
							<TableHead>Triggers</TableHead>
							<TableHead className="text-right">Enabled</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{repository.definitions.map((definition) => {
							const sourceOff =
								definition.source === "github"
									? !repository.runGithubWorkflows
									: !repository.runDokployWorkflows;
							const runnable =
								canRun &&
								!sourceOff &&
								definition.enabled &&
								!definition.parseError;
							const expanded =
								definition.jobs.length > 0 &&
								!collapsed.has(definition.workflowDefinitionId);
							const enabledJobs = definition.jobs.filter(
								(job) => !definition.disabledJobs.includes(job.id),
							).length;
							return (
								<Fragment key={definition.workflowDefinitionId}>
									<TableRow className={cn(expanded && "border-b-0")}>
										<TableCell className="align-top">
											{definition.jobs.length > 0 && (
												<Button
													variant="ghost"
													size="icon"
													className="size-6"
													title={expanded ? "Hide jobs" : "Show jobs"}
													onClick={() =>
														toggleCollapsed(definition.workflowDefinitionId)
													}
												>
													{expanded ? (
														<ChevronDown className="size-4" />
													) : (
														<ChevronRight className="size-4" />
													)}
												</Button>
											)}
										</TableCell>
										<TableCell className="align-top">
											<div className="flex flex-col gap-1">
												<span className="font-medium">{definition.name}</span>
												<span className="font-mono text-xs text-muted-foreground">
													{definition.path}
												</span>
												{definition.jobs.length > 0 && (
													<span className="text-xs text-muted-foreground">
														{enabledJobs === definition.jobs.length
															? `${definition.jobs.length} ${definition.jobs.length === 1 ? "job" : "jobs"}`
															: `${enabledJobs} of ${definition.jobs.length} jobs enabled`}
													</span>
												)}
												{sourceOff && (
													<span className="text-xs text-muted-foreground">
														Not running: .{definition.source} workflows are
														turned off for this repository
													</span>
												)}
												{definition.parseError && (
													<span className="text-xs text-destructive">
														{definition.parseError}
													</span>
												)}
											</div>
										</TableCell>
										<TableCell className="align-top">
											<div className="flex flex-wrap gap-1">
												{definition.triggers.map((trigger) => (
													<Badge
														key={trigger.event}
														variant={
															SUPPORTED_EVENTS.has(trigger.event)
																? "secondary"
																: "outline"
														}
														title={
															SUPPORTED_EVENTS.has(trigger.event)
																? undefined
																: "Dokploy doesn't trigger on this event"
														}
													>
														{describeTrigger(trigger)}
													</Badge>
												))}
											</div>
										</TableCell>
										<TableCell className="align-top text-right">
											<Switch
												disabled={!canEdit}
												checked={definition.enabled}
												onCheckedChange={(enabled) =>
													setEnabled
														.mutateAsync({
															workflowDefinitionId:
																definition.workflowDefinitionId,
															enabled,
														})
														.catch((error) => toast.error(error.message))
														.finally(refresh)
												}
											/>
										</TableCell>
										<TableCell className="align-top text-right">
											{runnable && enabledJobs > 0 && (
												<RunWorkflowDialog
													workflowRepositoryId={workflowRepositoryId}
													defaultBranch={repository.defaultBranch}
													definition={definition}
												/>
											)}
										</TableCell>
									</TableRow>
									{expanded && (
										<TableRow className="hover:bg-transparent">
											<TableCell />
											<TableCell colSpan={4} className="pt-0">
												<div className="rounded-md border">
													<Table>
														<TableHeader>
															<TableRow>
																<TableHead>Job</TableHead>
																<TableHead>Runs on</TableHead>
																<TableHead>Needs</TableHead>
																<TableHead className="text-right">
																	Enabled
																</TableHead>
																<TableHead className="w-12" />
															</TableRow>
														</TableHeader>
														<TableBody>
															{definition.jobs.map((job) => {
																const jobEnabled =
																	!definition.disabledJobs.includes(job.id);
																return (
																	<TableRow
																		key={job.id}
																		className={cn(
																			(!jobEnabled || !definition.enabled) &&
																				"text-muted-foreground",
																		)}
																	>
																		<TableCell>
																			<div className="flex flex-col gap-0.5">
																				<span className="flex items-center gap-2 font-medium">
																					{job.name}
																					{job.hasMatrix && (
																						<Badge
																							variant="outline"
																							className="font-normal"
																						>
																							matrix
																						</Badge>
																					)}
																				</span>
																				{job.name !== job.id && (
																					<span className="font-mono text-xs text-muted-foreground">
																						{job.id}
																					</span>
																				)}
																			</div>
																		</TableCell>
																		<TableCell className="font-mono text-xs">
																			{job.uses ?? job.runsOn.join(", ")}
																		</TableCell>
																		<TableCell className="text-xs">
																			{job.needs.length > 0
																				? job.needs.join(", ")
																				: "—"}
																		</TableCell>
																		<TableCell className="text-right">
																			<Switch
																				disabled={!canEdit}
																				checked={jobEnabled}
																				title={
																					jobEnabled
																						? "Jobs that need this one are skipped too when it's disabled"
																						: undefined
																				}
																				onCheckedChange={(enabled) =>
																					setJobEnabled
																						.mutateAsync({
																							workflowDefinitionId:
																								definition.workflowDefinitionId,
																							jobId: job.id,
																							enabled,
																						})
																						.catch((error) =>
																							toast.error(error.message),
																						)
																						.finally(refresh)
																				}
																			/>
																		</TableCell>
																		<TableCell className="text-right">
																			{runnable && (
																				<RunWorkflowDialog
																					workflowRepositoryId={
																						workflowRepositoryId
																					}
																					defaultBranch={
																						repository.defaultBranch
																					}
																					definition={definition}
																					job={job}
																				/>
																			)}
																		</TableCell>
																	</TableRow>
																);
															})}
														</TableBody>
													</Table>
												</div>
											</TableCell>
										</TableRow>
									)}
								</Fragment>
							);
						})}
					</TableBody>
				</Table>
			)}
		</div>
	);
};
