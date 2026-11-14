import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";
import { CapacityEstimate } from "./capacity-estimate";
import { formatBytes } from "./format-bytes";

interface Props {
	serverId?: string;
}

const MIB = 1024 ** 2;

const Stat = ({ label, value }: { label: string; value: string }) => (
	<div className="flex flex-col gap-0.5">
		<span className="text-xs text-muted-foreground">{label}</span>
		<span className="text-sm font-medium">{value}</span>
	</div>
);

export const ResourceGuardCard = ({ serverId }: Props) => {
	const utils = api.useUtils();
	const { data, isLoading } = api.docker.getResourceGuard.useQuery(
		{ serverId },
		{ refetchOnWindowFocus: false, retry: false },
	);
	const { mutateAsync, isPending } =
		api.docker.updateResourceGuard.useMutation();

	const [reserveMb, setReserveMb] = useState("");
	const [percent, setPercent] = useState("");

	useEffect(() => {
		if (!data) return;
		setReserveMb(
			data.settings.reservedMemoryMb === null
				? ""
				: String(data.settings.reservedMemoryMb),
		);
		setPercent(String(data.settings.appMemoryPercent));
	}, [data]);

	if (isLoading) {
		return (
			<Card className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				Loading resource guard…
			</Card>
		);
	}
	if (!data) return null;

	const { policy } = data;
	const autoReserve =
		policy?.reserveIsAuto && policy
			? `Auto (${Math.round(policy.platformReserveBytes / MIB)} MB)`
			: "Auto";

	const save = async () => {
		const reserve = reserveMb.trim() === "" ? null : Number(reserveMb);
		const pct = Number(percent);
		if (reserve !== null && (!Number.isInteger(reserve) || reserve < 0)) {
			toast.error("Platform reserve must be a whole number of MB");
			return;
		}
		if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
			toast.error("Per-service default must be between 1 and 100%");
			return;
		}
		try {
			await mutateAsync({
				serverId,
				reservedMemoryMb: reserve,
				appMemoryPercent: pct,
			});
			await utils.docker.getResourceGuard.invalidate({ serverId });
			toast.success(
				"Resource guard updated. Redeploy services to apply the new limits.",
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Couldn't update the guard",
			);
		}
	};

	return (
		<Card className="p-4 flex flex-col gap-4">
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-2 text-sm font-medium">
					<ShieldCheck className="size-4 text-muted-foreground" />
					Resource guard
				</div>
				<p className="text-xs text-muted-foreground">
					Every application, database and compose service on this server gets a
					memory and CPU cap when it deploys, so one service can't starve the
					others. Services without their own limit get the default below; limits
					above what the server can spare are lowered. If memory still runs out,
					the kernel kills your services before Dokploy, Traefik or the platform
					database.
				</p>
			</div>

			{policy ? (
				<>
					<div className="grid grid-cols-2 md:grid-cols-5 gap-4">
						<Stat
							label="Server memory"
							value={formatBytes(policy.hostMemoryBytes)}
						/>
						<Stat
							label="Kept for Dokploy"
							value={formatBytes(policy.platformReserveBytes)}
						/>
						<Stat
							label="Max per service"
							value={formatBytes(policy.allocatableMemoryBytes)}
						/>
						<Stat
							label="Default per service"
							value={formatBytes(policy.defaultMemoryLimitBytes)}
						/>
						<Stat
							label="CPU cap per service"
							value={
								policy.maxNanoCpus
									? `${(policy.maxNanoCpus / 1e9).toFixed(1)} of ${(policy.hostNanoCpus / 1e9).toFixed(0)} cores`
									: "None (single core)"
							}
						/>
					</div>
					<CapacityEstimate
						serverId={serverId}
						allocatableBytes={policy.allocatableMemoryBytes}
					/>
				</>
			) : (
				<div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded-lg p-3">
					Couldn't read this server's memory and CPU, so deploys currently go
					out with only the limits set on each service.
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-4 items-end">
				<div className="flex flex-col gap-2">
					<Label htmlFor="guard-reserve">Memory kept for Dokploy (MB)</Label>
					<Input
						id="guard-reserve"
						inputMode="numeric"
						placeholder={autoReserve}
						value={reserveMb}
						onChange={(e) => setReserveMb(e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-2">
					<Label htmlFor="guard-percent">
						Default per service (% of the max)
					</Label>
					<Input
						id="guard-percent"
						inputMode="numeric"
						value={percent}
						onChange={(e) => setPercent(e.target.value)}
					/>
				</div>
				<Button onClick={save} isLoading={isPending}>
					Save
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				Leave the reserve empty to size it automatically (10% of memory, at
				least {serverId ? "512 MB" : "1 GB"}). Changes apply to each service on
				its next deploy.
			</p>
		</Card>
	);
};
