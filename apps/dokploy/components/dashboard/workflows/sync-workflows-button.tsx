import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

export const SyncWorkflowsButton = ({
	workflowRepositoryId,
}: {
	workflowRepositoryId: string;
}) => {
	const utils = api.useUtils();
	const sync = api.workflow.syncRepository.useMutation();
	return (
		<Button
			variant="outline"
			isLoading={sync.isPending}
			onClick={() =>
				sync
					.mutateAsync({ workflowRepositoryId })
					.then(() => toast.success("Workflows synced"))
					.catch((error) => toast.error(error.message))
					.finally(() =>
						utils.workflow.oneRepository.invalidate({ workflowRepositoryId }),
					)
			}
		>
			<RefreshCw className="size-4" />
			Sync
		</Button>
	);
};
