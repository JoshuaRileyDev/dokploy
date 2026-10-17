import type { WorkflowRunStatus } from "@dokploy/server/db/schema";
import {
	Ban,
	CircleCheck,
	CircleDashed,
	CircleSlash,
	CircleX,
	Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS: Record<
	WorkflowRunStatus,
	{ label: string; icon: typeof CircleCheck; className: string }
> = {
	queued: {
		label: "Queued",
		icon: CircleDashed,
		className: "text-muted-foreground",
	},
	in_progress: {
		label: "In progress",
		icon: Loader2,
		className: "animate-spin text-amber-500",
	},
	success: { label: "Success", icon: CircleCheck, className: "text-green-600" },
	failure: { label: "Failed", icon: CircleX, className: "text-red-600" },
	cancelled: {
		label: "Cancelled",
		icon: Ban,
		className: "text-muted-foreground",
	},
	skipped: {
		label: "Skipped",
		icon: CircleSlash,
		className: "text-muted-foreground",
	},
};

export const statusLabel = (status: WorkflowRunStatus) => STATUS[status].label;

export const StatusIcon = ({
	status,
	className,
}: {
	status: WorkflowRunStatus;
	className?: string;
}) => {
	const { icon: Icon, className: statusClassName, label } = STATUS[status];
	return (
		<Icon
			aria-label={label}
			className={cn("size-4 shrink-0", statusClassName, className)}
		/>
	);
};

export const isFinished = (status: WorkflowRunStatus) =>
	status !== "queued" && status !== "in_progress";

export const formatDuration = (
	start?: string | null,
	end?: string | null,
): string => {
	if (!start) return "—";
	const ms =
		(end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
	return formatMs(ms);
};

export const formatMs = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
