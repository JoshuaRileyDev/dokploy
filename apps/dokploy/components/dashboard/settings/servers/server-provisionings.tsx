import { formatDistanceToNow } from "date-fns";
import { Check, Loader2, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";

export type Provisioning =
	RouterOutputs["cloudProvider"]["provisionings"][number];

const steps = [
	{ status: "creating_server", label: "Create server" },
	{ status: "waiting_for_ssh", label: "Connect over SSH" },
	{ status: "installing", label: "Install Docker" },
	{ status: "completed", label: "Ready" },
] as const;

const stepIndex = (status: Provisioning["status"]) => {
	if (status === "pending") return 0;
	const index = steps.findIndex((step) => step.status === status);
	return index === -1 ? 0 : index;
};

export const isRunning = (status: Provisioning["status"]) =>
	status !== "completed" && status !== "failed";

/**
 * A failed job whose provider server was never registered in Dokploy and
 * wasn't cleaned up (cleanup failed, or Dokploy restarted mid-run). It's
 * still billing, and this row is the only place it can be removed from.
 */
export const hasOrphanedServer = (provisioning: Provisioning) =>
	provisioning.status === "failed" &&
	!provisioning.serverId &&
	!!provisioning.providerServerId &&
	!provisioning.providerServerDeletedAt;

const ProvisioningRow = ({ provisioning }: { provisioning: Provisioning }) => {
	const utils = api.useUtils();
	const { mutate: dismiss, isPending: isDismissing } =
		api.cloudProvider.dismissProvisioning.useMutation({
			onSuccess: () => utils.cloudProvider.provisionings.invalidate(),
		});
	const { mutateAsync: destroyServer, isPending: isDestroying } =
		api.cloudProvider.destroyServer.useMutation({
			onSuccess: () => utils.cloudProvider.provisionings.invalidate(),
		});
	const orphaned = hasOrphanedServer(provisioning);

	const failed = provisioning.status === "failed";
	const completed = provisioning.status === "completed";
	const running = isRunning(provisioning.status);
	// A failed job remembers how far it got through the last message it set.
	const current = failed
		? stepIndex(
				provisioning.serverId
					? "installing"
					: provisioning.ipAddress
						? "waiting_for_ssh"
						: "creating_server",
			)
		: stepIndex(provisioning.status);

	return (
		<li className="flex flex-col gap-3 rounded-lg border bg-background p-4">
			<div className="flex items-start gap-3">
				<CloudProviderIcon
					providerType={provisioning.providerType}
					className="mt-0.5 size-7 shrink-0"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="truncate text-sm font-medium">
							{provisioning.config.name}
						</span>
						<span className="text-xs uppercase text-muted-foreground">
							{provisioning.config.serverType} · {provisioning.config.location}
						</span>
						{provisioning.ipAddress && (
							<span className="font-mono text-xs text-muted-foreground">
								{provisioning.ipAddress}
							</span>
						)}
					</div>
					<span
						className={cn(
							"line-clamp-2 text-xs",
							failed ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{failed
							? provisioning.error
							: completed
								? `Ready ${formatDistanceToNow(new Date(provisioning.completedAt ?? provisioning.createdAt), { addSuffix: true })}`
								: provisioning.message}
					</span>
				</div>
				{orphaned ? (
					<DialogAction
						title={`Delete ${provisioning.config.name} on ${provisioning.providerLabel}?`}
						description="This server was never added to Dokploy but still exists on the provider, so it's being billed. Deleting it erases its disk."
						type="destructive"
						onClick={async () => {
							await destroyServer({
								serverProvisioningId: provisioning.serverProvisioningId,
							})
								.then(() =>
									toast.success(
										`Deleted ${provisioning.config.name} on ${provisioning.providerLabel}`,
									),
								)
								.catch((error) =>
									toast.error("Could not delete the server", {
										description: `${error.message} Delete it from the ${provisioning.providerLabel} console to stop billing.`,
									}),
								);
						}}
					>
						<Button
							variant="outline"
							size="sm"
							className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
							isLoading={isDestroying}
						>
							<Trash2 className="size-3.5" />
							Delete on {provisioning.providerLabel}
						</Button>
					</DialogAction>
				) : (
					!running && (
						<Button
							variant="ghost"
							size="icon"
							className="size-8 shrink-0 text-muted-foreground"
							isLoading={isDismissing}
							onClick={() =>
								dismiss({
									serverProvisioningId: provisioning.serverProvisioningId,
								})
							}
						>
							<X className="size-4" />
							<span className="sr-only">Dismiss</span>
						</Button>
					)
				)}
			</div>

			<ol className="grid grid-cols-4 gap-2">
				{steps.map((step, index) => {
					const done = completed || index < current;
					const active = index === current && running;
					const errored = index === current && failed;
					return (
						<li key={step.status} className="flex flex-col gap-1.5">
							<span
								className={cn(
									"h-1 rounded-full bg-muted transition-colors duration-300",
									done && "bg-primary",
									active && "animate-pulse bg-primary/60",
									errored && "bg-destructive",
								)}
							/>
							<span
								className={cn(
									"flex items-center gap-1 text-[11px] text-muted-foreground",
									(done || active) && "text-foreground",
									errored && "text-destructive",
								)}
							>
								{done && <Check className="size-3" />}
								{active && <Loader2 className="size-3 animate-spin" />}
								{errored && <X className="size-3" />}
								<span className="truncate">{step.label}</span>
							</span>
						</li>
					);
				})}
			</ol>
		</li>
	);
};

/**
 * Polls while any job is running and announces finished ones. Mount it once
 * per page, otherwise each instance shows its own toast.
 */
export const useServerProvisionings = () => {
	const utils = api.useUtils();
	const { data } = api.cloudProvider.provisionings.useQuery(undefined, {
		refetchInterval: (query) =>
			query.state.data?.some((p) => isRunning(p.status)) ? 2000 : false,
	});

	const previous = useRef<Map<string, Provisioning["status"]>>(new Map());
	useEffect(() => {
		if (!data) return;
		for (const provisioning of data) {
			const before = previous.current.get(provisioning.serverProvisioningId);
			if (before && isRunning(before) && !isRunning(provisioning.status)) {
				utils.server.all.invalidate();
				if (provisioning.status === "completed") {
					toast.success(`${provisioning.config.name} is ready`);
				} else {
					toast.error(`Creating ${provisioning.config.name} failed`);
				}
			}
			// The server joins the list as soon as setup starts.
			if (before !== "installing" && provisioning.status === "installing") {
				utils.server.all.invalidate();
			}
			previous.current.set(
				provisioning.serverProvisioningId,
				provisioning.status,
			);
		}
	}, [data, utils]);

	return {
		provisionings: data ?? [],
		runningCount: data?.filter((p) => isRunning(p.status)).length ?? 0,
	};
};

export const ServerProvisioningList = ({
	provisionings,
}: {
	provisionings: Provisioning[];
}) => (
	<ul className="flex flex-col gap-2">
		{provisionings.map((provisioning) => (
			<ProvisioningRow
				key={provisioning.serverProvisioningId}
				provisioning={provisioning}
			/>
		))}
	</ul>
);
