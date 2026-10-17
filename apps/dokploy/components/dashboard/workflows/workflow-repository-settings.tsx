import { Settings } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";
import { WorkflowEnvEditor } from "./workflow-env-editor";

const ANY_SERVER = "any";

interface Props {
	repository: {
		workflowRepositoryId: string;
		owner: string;
		repository: string;
		runDokployWorkflows: boolean;
		runGithubWorkflows: boolean;
		defaultServerId: string | null;
	};
}

export const WorkflowRepositorySettings = ({ repository }: Props) => {
	const utils = api.useUtils();
	const { workflowRepositoryId } = repository;
	const { data: workflowServers } = api.server.workflowServers.useQuery();
	const update = api.workflow.updateRepository.useMutation();

	const save = (values: {
		runGithubWorkflows?: boolean;
		runDokployWorkflows?: boolean;
		defaultServerId?: string | null;
	}) =>
		update
			.mutateAsync({ workflowRepositoryId, ...values })
			.then(() => toast.success("Settings saved"))
			.catch((error) => toast.error(error.message))
			.finally(() =>
				utils.workflow.oneRepository.invalidate({ workflowRepositoryId }),
			);

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Settings className="size-4" />
					Settings
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{repository.owner}/{repository.repository} settings
					</DialogTitle>
					<DialogDescription>
						Choose which workflows run, where they run, and the secrets they
						receive.
					</DialogDescription>
				</DialogHeader>
				<Tabs defaultValue="general">
					<TabsList>
						<TabsTrigger value="general">General</TabsTrigger>
						<TabsTrigger value="secrets">Secrets & Variables</TabsTrigger>
					</TabsList>
					<TabsContent value="general" className="flex flex-col gap-3 pt-2">
						<div className="flex items-start justify-between gap-4 rounded-lg border p-4">
							<div className="space-y-1">
								<Label htmlFor="run-dokploy">Run .dokploy/workflows</Label>
								<p className="text-sm text-muted-foreground">
									Workflows written for Dokploy.
								</p>
							</div>
							<Switch
								id="run-dokploy"
								checked={repository.runDokployWorkflows}
								onCheckedChange={(checked) =>
									save({ runDokployWorkflows: checked })
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
								checked={repository.runGithubWorkflows}
								onCheckedChange={(checked) =>
									save({ runGithubWorkflows: checked })
								}
							/>
						</div>
						<div className="flex items-center justify-between gap-4 rounded-lg border p-4">
							<div className="space-y-1">
								<Label htmlFor="workflow-server">Workflow server</Label>
								<p className="text-sm text-muted-foreground">
									Where this repository's runs execute.
								</p>
							</div>
							<Select
								value={repository.defaultServerId ?? ANY_SERVER}
								onValueChange={(value) =>
									save({ defaultServerId: value === ANY_SERVER ? null : value })
								}
							>
								<SelectTrigger id="workflow-server" className="w-56">
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
					</TabsContent>
					<TabsContent value="secrets" className="pt-2">
						<WorkflowEnvEditor workflowRepositoryId={workflowRepositoryId} />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
};
