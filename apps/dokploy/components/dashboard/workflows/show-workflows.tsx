import { Workflow } from "lucide-react";
import { useRouter } from "next/router";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";
import { ImportWorkflowRepository } from "./import-workflow-repository";
import { ShowWorkflowNotifications } from "./show-workflow-notifications";
import { ShowWorkflowRepositories } from "./show-workflow-repositories";
import { ShowWorkflowRuns } from "./show-workflow-runs";
import { WorkflowEnvEditor } from "./workflow-env-editor";

const TABS = ["runs", "repositories", "secrets", "notifications"] as const;
type Tab = (typeof TABS)[number];

export const ShowWorkflows = () => {
	const router = useRouter();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const tab: Tab = TABS.includes(router.query.tab as Tab)
		? (router.query.tab as Tab)
		: "runs";

	return (
		<Card className="h-full w-full rounded-xl bg-sidebar p-2.5">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
					<div className="space-y-1.5">
						<CardTitle className="flex flex-row gap-2 text-xl">
							<Workflow className="size-6 self-center text-muted-foreground" />
							Workflows
						</CardTitle>
						<CardDescription>
							Run GitHub Actions workflows from your repositories on your own
							workflow servers.
						</CardDescription>
					</div>
					{permissions?.workflow.create && <ImportWorkflowRepository />}
				</CardHeader>
				<CardContent className="border-t pt-4">
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
							<TabsTrigger value="runs">Recent Runs</TabsTrigger>
							<TabsTrigger value="repositories">Repositories</TabsTrigger>
							<TabsTrigger value="secrets">Secrets & Variables</TabsTrigger>
							<TabsTrigger value="notifications">Notifications</TabsTrigger>
						</TabsList>
						<TabsContent value="runs" className="pt-2">
							<ShowWorkflowRuns />
						</TabsContent>
						<TabsContent value="repositories" className="pt-2">
							<ShowWorkflowRepositories />
						</TabsContent>
						<TabsContent value="secrets" className="pt-2">
							<WorkflowEnvEditor workflowRepositoryId={null} />
						</TabsContent>
						<TabsContent value="notifications" className="pt-2">
							<ShowWorkflowNotifications />
						</TabsContent>
					</Tabs>
				</CardContent>
			</div>
		</Card>
	);
};
