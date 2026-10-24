import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatMemory } from "@/components/dashboard/shared/memory-limits";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	createConverter,
	NumberInputWithSteps,
} from "@/components/ui/number-input";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

const MB = 1024 * 1024;
const MEMORY_STEP_MB = 256;

const memoryConverter = createConverter(MB, (mb) =>
	mb <= 0 ? "" : formatMemory(mb * MB),
);

const toBytes = (value: string) => {
	const bytes = Number.parseInt(value);
	return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
};

interface Props {
	/** Remote server to configure; omitted for the local Dokploy host. */
	serverId?: string;
	label?: string;
	ipAddress?: string;
}

export const MemoryPolicySettings = ({ serverId, label, ipAddress }: Props) => {
	const policyQuery = api.memoryPolicy.get.useQuery({ serverId });
	const budgetQuery = api.memoryPolicy.budget.useQuery(
		{ serverId },
		{ retry: false, refetchOnWindowFocus: false },
	);
	const update = api.memoryPolicy.update.useMutation();

	const [defaultLimit, setDefaultLimit] = useState("");
	const [reserved, setReserved] = useState("");
	const [showContainers, setShowContainers] = useState(false);

	useEffect(() => {
		if (!policyQuery.data) return;
		setDefaultLimit(policyQuery.data.defaultMemoryLimit?.toString() ?? "");
		setReserved(policyQuery.data.reservedMemory?.toString() ?? "");
	}, [policyQuery.data]);

	const savedDefault = policyQuery.data?.defaultMemoryLimit ?? null;
	const savedReserved = policyQuery.data?.reservedMemory ?? null;
	const hasChanges =
		toBytes(defaultLimit) !== savedDefault ||
		toBytes(reserved) !== savedReserved;

	const handleSave = async () => {
		try {
			await update.mutateAsync({
				serverId,
				defaultMemoryLimit: toBytes(defaultLimit),
				reservedMemory: toBytes(reserved),
			});
			await Promise.all([policyQuery.refetch(), budgetQuery.refetch()]);
			toast.success("Memory limits updated");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Error updating memory limits",
			);
		}
	};

	const budget = budgetQuery.data;
	const overcommitted =
		!!budget && budget.committedMemory > budget.availableMemory;
	const committedShare = budget?.totalMemory
		? Math.min(100, (budget.committedMemory / budget.totalMemory) * 100)
		: 0;
	const reservedShare = budget?.totalMemory
		? Math.min(100, (budget.reservedMemory / budget.totalMemory) * 100)
		: 0;

	return (
		<div className="flex flex-col gap-4 rounded-lg border p-3">
			<div className="flex items-center gap-2">
				<p className="text-sm font-medium">{label ?? "Dokploy Server"}</p>
				<span className="text-xs text-muted-foreground rounded border px-1.5 py-0.5">
					{serverId ? (ipAddress ?? "remote server") : "local host"}
				</span>
			</div>

			{budgetQuery.isError ? (
				<AlertBlock type="warning">{budgetQuery.error.message}</AlertBlock>
			) : budget ? (
				<div className="flex flex-col gap-2">
					<div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
						<div
							className={cn(
								"h-full",
								overcommitted ? "bg-red-500" : "bg-primary",
							)}
							style={{ width: `${committedShare}%` }}
						/>
						<div className="flex-1" />
						<div
							className="h-full bg-muted-foreground/40"
							style={{ width: `${reservedShare}%` }}
						/>
					</div>
					<div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
						<span>
							{formatMemory(budget.committedMemory)} of{" "}
							{formatMemory(budget.availableMemory)} allocated to limits
						</span>
						<span>
							{formatMemory(budget.reservedMemory)} reserved for the system
							{budget.reservedIsAuto ? " (auto)" : ""} ·{" "}
							{formatMemory(budget.totalMemory)} total
						</span>
					</div>
					{overcommitted && (
						<AlertBlock type="error">
							Memory limits add up to more than this server can provide. If
							several services reach their limits at the same time, the server
							runs out of memory and the kernel kills processes, possibly
							Dokploy or Traefik. Lower some limits or add memory.
						</AlertBlock>
					)}
					{budget.unlimitedContainers > 0 && (
						<AlertBlock type="warning">
							{budget.unlimitedContainers} running{" "}
							{budget.unlimitedContainers === 1
								? "container has"
								: "containers have"}{" "}
							no memory limit and can use all of this server's memory.
							{savedDefault
								? " Redeploy them to apply the default limit."
								: " Set a default limit below, then redeploy them."}
						</AlertBlock>
					)}
					<button
						type="button"
						className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						onClick={() => setShowContainers((open) => !open)}
					>
						{showContainers ? (
							<ChevronDown className="size-3" />
						) : (
							<ChevronRight className="size-3" />
						)}
						{budget.entries.length} running services
					</button>
					{showContainers && (
						<div className="flex flex-col divide-y rounded-md border text-sm">
							{budget.entries.map((entry) => (
								<div
									key={entry.key}
									className="flex items-center justify-between gap-4 px-3 py-2"
								>
									<div className="flex min-w-0 flex-col">
										<span className="truncate">{entry.label}</span>
										{entry.detail && (
											<span className="truncate text-xs text-muted-foreground">
												{entry.detail}
												{entry.containers > 1
													? ` · ${entry.containers} containers`
													: ""}
											</span>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-2">
										{!entry.managed && <Badge variant="outline">system</Badge>}
										{entry.unlimitedContainers > 0 ? (
											<Badge variant="red">
												{entry.unlimitedContainers === entry.containers
													? "No limit"
													: `${entry.unlimitedContainers} without limit`}
											</Badge>
										) : null}
										{entry.memoryLimit > 0 && (
											<span className="text-xs tabular-nums text-muted-foreground">
												{formatMemory(entry.memoryLimit)}
											</span>
										)}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">Reading memory usage…</p>
			)}

			<div className="grid gap-4 md:grid-cols-2">
				<div className="flex flex-col gap-2">
					<Label>Default memory limit</Label>
					<NumberInputWithSteps
						value={defaultLimit}
						onChange={setDefaultLimit}
						placeholder="No default limit"
						step={MEMORY_STEP_MB}
						converter={memoryConverter}
					/>
					<p className="text-xs text-muted-foreground">
						Applied on deploy to applications, databases and compose services
						that don't set their own limit. A service that goes over it is
						restarted, and nothing else on the server is affected.
					</p>
				</div>
				<div className="flex flex-col gap-2">
					<Label>Reserved for the system</Label>
					<NumberInputWithSteps
						value={reserved}
						onChange={setReserved}
						placeholder={
							budget?.reservedIsAuto
								? `Auto (${formatMemory(budget.reservedMemory)})`
								: "Auto"
						}
						step={MEMORY_STEP_MB}
						converter={memoryConverter}
					/>
					<p className="text-xs text-muted-foreground">
						Memory kept free for the OS, Docker, Traefik and Dokploy. Only used
						to warn when limits add up to more than the rest. Leave empty to
						keep 10% (between 512 MB and 2 GB).
					</p>
				</div>
			</div>
			<div className="flex justify-end">
				<Button
					type="button"
					size="sm"
					onClick={handleSave}
					isLoading={update.isPending}
					disabled={!hasChanges}
				>
					Save
				</Button>
			</div>
		</div>
	);
};
