import { ExternalLink, Loader2, Workflow } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { ShowWorkflowRuns } from "./show-workflow-runs";
import { SyncWorkflowsButton } from "./sync-workflows-button";
import { WorkflowDefinitionsTable } from "./workflow-definitions-table";
import { WorkflowEnvEditor } from "./workflow-env-editor";
import { WorkflowRepositorySettings } from "./workflow-repository-settings";

const ImportedRepository = ({
	workflowRepositoryId,
}: {
	workflowRepositoryId: string;
}) => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: repository } = api.workflow.oneRepository.useQuery({
		workflowRepositoryId,
	});
	const canEdit = !!permissions?.workflow.create;

	if (!repository) {
		return (
			<div className="flex min-h-[30vh] items-center justify-center">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<Card className="bg-background">
				<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
					<div className="space-y-1.5">
						<CardTitle className="text-xl">Workflows</CardTitle>
						<CardDescription>
							From the {repository.defaultBranch} branch of{" "}
							<Link
								href={`/dashboard/workflows/repositories/${workflowRepositoryId}`}
								className="inline-flex items-center gap-1 hover:text-foreground"
							>
								{repository.owner}/{repository.repository}
								<ExternalLink className="size-3" />
							</Link>
							. Runs use the workflow files at the commit that triggered them.
						</CardDescription>
					</div>
					{canEdit && (
						<div className="flex gap-2">
							<SyncWorkflowsButton
								workflowRepositoryId={workflowRepositoryId}
							/>
							<WorkflowRepositorySettings repository={repository} />
						</div>
					)}
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					{repository.syncError && (
						<AlertBlock type="error">
							Last sync failed: {repository.syncError}
						</AlertBlock>
					)}
					<WorkflowDefinitionsTable
						workflowRepositoryId={workflowRepositoryId}
					/>
				</CardContent>
			</Card>
			{canEdit && (
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="text-xl">Secrets & Variables</CardTitle>
					</CardHeader>
					<CardContent>
						<WorkflowEnvEditor workflowRepositoryId={workflowRepositoryId} />
					</CardContent>
				</Card>
			)}
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">Runs</CardTitle>
				</CardHeader>
				<CardContent>
					<ShowWorkflowRuns workflowRepositoryId={workflowRepositoryId} />
				</CardContent>
			</Card>
		</div>
	);
};

interface Props {
	serviceType: "application" | "compose";
	serviceId: string;
}

export const ShowServiceWorkflows = ({ serviceType, serviceId }: Props) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: link, isPending } = api.workflow.repositoryForService.useQuery({
		serviceType,
		serviceId,
	});
	const importRepository =
		api.workflow.importRepositoryForService.useMutation();

	if (isPending) {
		return (
			<div className="flex min-h-[30vh] items-center justify-center">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (link?.eligible && link.workflowRepositoryId) {
		return (
			<ImportedRepository workflowRepositoryId={link.workflowRepositoryId} />
		);
	}

	return (
		<Card className="bg-background">
			<CardContent className="flex min-h-[30vh] flex-col items-center justify-center gap-3 text-center">
				<Workflow className="size-8 text-muted-foreground" />
				{link?.eligible ? (
					<>
						<span className="text-base text-muted-foreground">
							{link.owner}/{link.repository} isn't set up for workflows yet.
						</span>
						<span className="max-w-lg text-sm text-muted-foreground">
							Dokploy imports it automatically before the next deployment if it
							has workflow files in .dokploy/workflows or .github/workflows.
						</span>
						{permissions?.workflow.create && (
							<Button
								isLoading={importRepository.isPending}
								onClick={() =>
									importRepository
										.mutateAsync({ serviceType, serviceId })
										.then(() => {
											toast.success("Repository imported");
											return utils.workflow.repositoryForService.invalidate({
												serviceType,
												serviceId,
											});
										})
										.catch((error) => toast.error(error.message))
								}
							>
								Import now
							</Button>
						)}
					</>
				) : (
					<span className="max-w-lg text-base text-muted-foreground">
						Workflows are available for services deployed from a GitHub
						provider.
					</span>
				)}
			</CardContent>
		</Card>
	);
};
