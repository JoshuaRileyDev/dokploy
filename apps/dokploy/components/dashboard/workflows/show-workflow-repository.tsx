import { ArrowLeft, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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
import {
	describeTrigger,
	githubRepositoryUrl,
	SUPPORTED_EVENTS,
} from "./utils";

const ANY_SERVER = "any";

interface Props {
	workflowRepositoryId: string;
}

export const ShowWorkflowRepository = ({ workflowRepositoryId }: Props) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: repository, isPending } = api.workflow.oneRepository.useQuery({
		workflowRepositoryId,
	});
	const { data: workflowServers } = api.server.workflowServers.useQuery();
	const update = api.workflow.updateRepository.useMutation();
	const sync = api.workflow.syncRepository.useMutation();
	const setEnabled = api.workflow.setDefinitionEnabled.useMutation();
	const canEdit = !!permissions?.workflow.create;

	const refresh = () =>
		utils.workflow.oneRepository.invalidate({ workflowRepositoryId });

	const saveSettings = (values: {
		runGithubWorkflows?: boolean;
		runDokployWorkflows?: boolean;
		defaultServerId?: string | null;
	}) =>
		update
			.mutateAsync({ workflowRepositoryId, ...values })
			.then(() => toast.success("Settings saved"))
			.catch((error) => toast.error(error.message))
			.finally(refresh);

	if (isPending || !repository) {
		return (
			<div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-muted-foreground">
				<span>Loading...</span>
				<Loader2 className="size-4 animate-spin" />
			</div>
		);
	}

	const repoUrl = githubRepositoryUrl(
		repository.github?.githubUrl,
		repository.owner,
		repository.repository,
	);

	return (
		<div className="flex w-full flex-col gap-4">
			<Card className="rounded-xl bg-sidebar p-2.5">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
						<div className="space-y-1.5">
							<Link
								href="/dashboard/workflows?tab=repositories"
								className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
							>
								<ArrowLeft className="size-4" />
								Workflows
							</Link>
							<CardTitle className="flex items-center gap-2 text-xl">
								<GithubIcon className="size-5" />
								{repository.owner}/{repository.repository}
							</CardTitle>
							<CardDescription className="flex flex-wrap items-center gap-3">
								<span>Default branch: {repository.defaultBranch}</span>
								{repository.lastSyncedAt && (
									<DateTooltip date={repository.lastSyncedAt}>
										Synced
									</DateTooltip>
								)}
								<a
									href={repoUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center gap-1 hover:text-foreground"
								>
									View on GitHub <ExternalLink className="size-3" />
								</a>
							</CardDescription>
						</div>
						{canEdit && (
							<Button
								variant="outline"
								isLoading={sync.isPending}
								onClick={() =>
									sync
										.mutateAsync({ workflowRepositoryId })
										.then(() => toast.success("Workflows synced"))
										.catch((error) => toast.error(error.message))
										.finally(refresh)
								}
							>
								<RefreshCw className="size-4" />
								Sync
							</Button>
						)}
					</CardHeader>
					<CardContent className="grid gap-6 border-t pt-6 md:grid-cols-3">
						{repository.syncError && (
							<AlertBlock type="error" className="md:col-span-3">
								Last sync failed: {repository.syncError}
							</AlertBlock>
						)}
						<div className="flex items-start justify-between gap-4 rounded-lg border p-4">
							<div className="space-y-1">
								<Label htmlFor="run-dokploy">Run .dokploy/workflows</Label>
								<p className="text-sm text-muted-foreground">
									Workflows written for Dokploy.
								</p>
							</div>
							<Switch
								id="run-dokploy"
								disabled={!canEdit}
								checked={repository.runDokployWorkflows}
								onCheckedChange={(checked) =>
									saveSettings({ runDokployWorkflows: checked })
								}
							/>
						</div>
						<div className="flex items-start justify-between gap-4 rounded-lg border p-4">
							<div className="space-y-1">
								<Label htmlFor="run-github">Run .github/workflows</Label>
								<p className="text-sm text-muted-foreground">
									Leave this off if GitHub Actions still runs these, or every
									workflow will run twice.
								</p>
							</div>
							<Switch
								id="run-github"
								disabled={!canEdit}
								checked={repository.runGithubWorkflows}
								onCheckedChange={(checked) =>
									saveSettings({ runGithubWorkflows: checked })
								}
							/>
						</div>
						<div className="space-y-2 rounded-lg border p-4">
							<Label>Workflow server</Label>
							<Select
								disabled={!canEdit}
								value={repository.defaultServerId ?? ANY_SERVER}
								onValueChange={(value) =>
									saveSettings({
										defaultServerId: value === ANY_SERVER ? null : value,
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ANY_SERVER}>
										Any workflow server
									</SelectItem>
									{workflowServers?.map((server) => (
										<SelectItem key={server.serverId} value={server.serverId}>
											{server.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</CardContent>
				</div>
			</Card>

			<Card className="rounded-xl bg-sidebar p-2.5">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-lg">Workflows</CardTitle>
						<CardDescription>
							Read from the {repository.defaultBranch} branch. Runs always use
							the workflow files at the commit that triggered them.
						</CardDescription>
					</CardHeader>
					<CardContent className="border-t pt-2">
						{repository.definitions.length === 0 ? (
							<p className="py-10 text-center text-sm text-muted-foreground">
								No workflow files found in .dokploy/workflows or
								.github/workflows.
							</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Workflow</TableHead>
										<TableHead>Triggers</TableHead>
										<TableHead>Jobs</TableHead>
										<TableHead className="text-right">Enabled</TableHead>
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
														<span className="font-medium">
															{definition.name}
														</span>
														<span className="font-mono text-xs text-muted-foreground">
															{definition.path}
														</span>
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
												<TableCell className="align-top text-sm text-muted-foreground">
													{definition.jobs.map((job) => job.name).join(", ")}
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
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
