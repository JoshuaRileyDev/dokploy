import {
	AlertTriangle,
	GitBranch,
	Loader2,
	RefreshCw,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

export const ShowWorkflowRepositories = () => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: repositories, isPending } =
		api.workflow.allRepositories.useQuery();
	const sync = api.workflow.syncRepository.useMutation();
	const remove = api.workflow.removeRepository.useMutation();

	if (isPending) {
		return (
			<div className="flex min-h-[25vh] items-center justify-center gap-2 text-sm text-muted-foreground">
				<span>Loading...</span>
				<Loader2 className="size-4 animate-spin" />
			</div>
		);
	}

	if (!repositories?.length) {
		return (
			<div className="flex min-h-[25vh] flex-col items-center justify-center gap-2 text-center">
				<GitBranch className="size-8 text-muted-foreground" />
				<span className="text-base text-muted-foreground">
					No repositories imported yet.
				</span>
				<span className="max-w-md text-sm text-muted-foreground">
					Import a repository to run the workflows in its .dokploy/workflows
					folder, and optionally .github/workflows.
				</span>
			</div>
		);
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Repository</TableHead>
					<TableHead>Workflows</TableHead>
					<TableHead>Server</TableHead>
					<TableHead>Last synced</TableHead>
					<TableHead className="text-right">Actions</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{repositories.map((repository) => {
					const dokployCount = repository.definitions.filter(
						(d) => d.source === "dokploy",
					).length;
					const githubCount = repository.definitions.filter(
						(d) => d.source === "github",
					).length;
					const errorCount = repository.definitions.filter(
						(d) => d.parseError,
					).length;
					return (
						<TableRow key={repository.workflowRepositoryId}>
							<TableCell>
								<Link
									href={`/dashboard/workflows/repositories/${repository.workflowRepositoryId}`}
									className="flex items-center gap-2 font-medium hover:underline"
								>
									<GithubIcon className="size-4" />
									{repository.owner}/{repository.repository}
								</Link>
							</TableCell>
							<TableCell>
								<div className="flex flex-wrap items-center gap-1.5">
									<Badge variant="secondary">.dokploy: {dokployCount}</Badge>
									<Badge
										variant="outline"
										className={
											repository.runGithubWorkflows
												? ""
												: "text-muted-foreground"
										}
									>
										.github: {githubCount}
										{!repository.runGithubWorkflows && githubCount > 0
											? " (off)"
											: ""}
									</Badge>
									{errorCount > 0 && (
										<Badge variant="destructive" className="gap-1">
											<AlertTriangle className="size-3" />
											{errorCount} invalid
										</Badge>
									)}
								</div>
							</TableCell>
							<TableCell className="text-muted-foreground">
								{repository.defaultServer?.name ?? "Any workflow server"}
							</TableCell>
							<TableCell>
								{repository.syncError ? (
									<span className="text-sm text-destructive">Sync failed</span>
								) : repository.lastSyncedAt ? (
									<DateTooltip date={repository.lastSyncedAt} />
								) : (
									<span className="text-muted-foreground">Never</span>
								)}
							</TableCell>
							<TableCell>
								<div className="flex justify-end gap-1">
									{permissions?.workflow.create && (
										<Button
											variant="ghost"
											size="icon"
											title="Sync workflows"
											isLoading={
												sync.isPending &&
												sync.variables?.workflowRepositoryId ===
													repository.workflowRepositoryId
											}
											onClick={() =>
												sync
													.mutateAsync({
														workflowRepositoryId:
															repository.workflowRepositoryId,
													})
													.then(() => toast.success("Workflows synced"))
													.catch((error) => toast.error(error.message))
													.finally(() =>
														utils.workflow.allRepositories.invalidate(),
													)
											}
										>
											<RefreshCw className="size-4" />
										</Button>
									)}
									{permissions?.workflow.delete && (
										<DialogAction
											title="Remove repository"
											description={`Remove ${repository.owner}/${repository.repository} and all of its run history from Dokploy? The GitHub repository is not affected.`}
											type="destructive"
											onClick={() =>
												remove
													.mutateAsync({
														workflowRepositoryId:
															repository.workflowRepositoryId,
													})
													.then(() => {
														toast.success("Repository removed");
														return utils.workflow.allRepositories.invalidate();
													})
													.catch((error) => toast.error(error.message))
											}
										>
											<Button
												variant="ghost"
												size="icon"
												title="Remove repository"
												className="text-destructive hover:text-destructive"
											>
												<Trash2 className="size-4" />
											</Button>
										</DialogAction>
									)}
								</div>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
};
