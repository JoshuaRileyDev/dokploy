import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
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
	const canEdit = !!permissions?.workflow.create;
	const canRun = !!permissions?.workflow.run;

	const refresh = () =>
		utils.workflow.oneRepository.invalidate({ workflowRepositoryId });

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
							return (
								<TableRow key={definition.workflowDefinitionId}>
									<TableCell className="align-top">
										<div className="flex flex-col gap-1">
											<span className="font-medium">{definition.name}</span>
											<span className="font-mono text-xs text-muted-foreground">
												{definition.path}
											</span>
											{definition.jobs.length > 0 && (
												<span className="text-xs text-muted-foreground">
													Jobs:{" "}
													{definition.jobs.map((job) => job.name).join(", ")}
												</span>
											)}
											{sourceOff && (
												<span className="text-xs text-muted-foreground">
													Not running: .{definition.source} workflows are turned
													off for this repository
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
										{canRun &&
											!sourceOff &&
											definition.enabled &&
											!definition.parseError &&
											definition.triggers.some(
												(trigger) => trigger.event === "workflow_dispatch",
											) && (
												<RunWorkflowDialog
													workflowRepositoryId={workflowRepositoryId}
													defaultBranch={repository.defaultBranch}
													definition={definition}
												/>
											)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</div>
	);
};
