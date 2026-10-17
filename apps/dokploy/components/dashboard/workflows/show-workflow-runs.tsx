import { CircleDashed } from "lucide-react";

export const ShowWorkflowRuns = () => (
	<div className="flex min-h-[25vh] flex-col items-center justify-center gap-2 text-center">
		<CircleDashed className="size-8 text-muted-foreground" />
		<span className="text-base text-muted-foreground">No runs yet.</span>
	</div>
);
