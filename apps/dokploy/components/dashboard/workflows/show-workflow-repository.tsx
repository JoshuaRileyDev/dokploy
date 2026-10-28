import {
	ArrowLeft,
	ExternalLink,
	FileCode2,
	History,
	Loader2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { DateTooltip } from "@/components/shared/date-tooltip";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";
import { ShowWorkflowRuns } from "./show-workflow-runs";
import { SyncWorkflowsButton } from "./sync-workflows-button";
import { githubRepositoryUrl } from "./utils";
import { WorkflowDefinitionsTable } from "./workflow-definitions-table";
import { WorkflowRepositorySettings } from "./workflow-repository-settings";

const TABS = ["runs", "workflows"] as const;
type Tab = (typeof TABS)[number];

interface Props {
	workflowRepositoryId: string;
}

export const ShowWorkflowRepository = ({ workflowRepositoryId }: Props) => {
	const router = useRouter();
	const tab: Tab = TABS.includes(router.query.tab as Tab)
		? (router.query.tab as Tab)
		: "runs";
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: repository, isPending } = api.workflow.oneRepository.useQuery({
		workflowRepositoryId,
	});
	const canEdit = !!permissions?.workflow.create;

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
							<div className="flex gap-2">
								<SyncWorkflowsButton
									workflowRepositoryId={workflowRepositoryId}
								/>
								<WorkflowRepositorySettings repository={repository} />
							</div>
						)}
					</CardHeader>
					{repository.syncError && (
						<CardContent className="pt-0">
							<AlertBlock type="error">
								Last sync failed: {repository.syncError}
							</AlertBlock>
						</CardContent>
					)}
				</div>
			</Card>
			<Card className="rounded-xl bg-sidebar p-2.5">
				<div className="rounded-xl bg-background p-4 shadow-md">
					<Tabs
						value={tab}
						onValueChange={(value) =>
							router.replace(
								{ query: { ...router.query, tab: value } },
								undefined,
								{ shallow: true },
							)
						}
					>
						<TabsList>
							<TabsTrigger value="runs">
								<History />
								Runs
							</TabsTrigger>
							<TabsTrigger value="workflows">
								<FileCode2 />
								Workflows
							</TabsTrigger>
						</TabsList>
						<TabsContent value="workflows" className="flex flex-col gap-3 pt-3">
							<p className="text-sm text-muted-foreground">
								Read from the {repository.defaultBranch} branch. Runs always use
								the workflow files at the commit that triggered them.
							</p>
							<WorkflowDefinitionsTable
								workflowRepositoryId={workflowRepositoryId}
							/>
						</TabsContent>
						<TabsContent value="runs" className="pt-3">
							<ShowWorkflowRuns workflowRepositoryId={workflowRepositoryId} />
						</TabsContent>
					</Tabs>
				</div>
			</Card>
		</div>
	);
};
