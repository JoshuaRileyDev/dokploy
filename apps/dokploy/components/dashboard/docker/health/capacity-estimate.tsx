import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { api } from "@/utils/api";
import { formatBytes } from "./format-bytes";

interface Props {
	serverId?: string;
	allocatableBytes: number;
}

const TOP_SERVICES = 5;

export const CapacityEstimate = ({ serverId, allocatableBytes }: Props) => {
	const { data, isFetching, refetch } = api.docker.getCapacityEstimate.useQuery(
		{ serverId },
		{ refetchOnWindowFocus: false, retry: false },
	);

	if (isFetching && !data) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				Measuring what each service uses…
			</div>
		);
	}
	if (!data) {
		return (
			<p className="text-xs text-muted-foreground">
				Couldn't measure service memory on this server, so there's no estimate
				of how many more services fit.
			</p>
		);
	}

	const range =
		data.moreServicesLow === data.moreServicesHigh
			? `${data.moreServicesHigh}`
			: `${data.moreServicesLow}–${data.moreServicesHigh}`;
	const pctOf = (bytes: number) =>
		Math.min(100, Math.round((bytes / (allocatableBytes || 1)) * 100));

	return (
		<div className="flex flex-col gap-3 border-t pt-4">
			<div className="flex items-start justify-between gap-2">
				<div className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">
						Room for more services
					</span>
					<span className="text-2xl font-semibold">About {range} more</span>
					<span className="text-xs text-muted-foreground">
						Sized like a typical service here (
						{formatBytes(data.typicalServiceBytes)} at its peak). The low end
						assumes every service peaks at once; the high end goes by what they
						use now.
					</span>
				</div>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => refetch()}
					disabled={isFetching}
					aria-label="Measure again"
				>
					<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
				</Button>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<div className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">
						In use now: {formatBytes(data.usedNowBytes)} of{" "}
						{formatBytes(allocatableBytes)}
					</span>
					<Progress value={pctOf(data.usedNowBytes)} className="h-2" />
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">
						{data.peaksKnown
							? `If everything peaked together: ${formatBytes(data.usedAtPeakBytes)}`
							: "Peak usage isn't readable on this server; using current usage"}
					</span>
					<Progress value={pctOf(data.usedAtPeakBytes)} className="h-2" />
				</div>
			</div>

			{data.overcommittedAtPeak && (
				<div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded-lg p-3">
					<AlertTriangle className="size-4 shrink-0" />
					Together, your services' peaks add up to more memory than this server
					has for them. If they peak at the same time, the largest will be
					restarted. Consider moving a heavy service to another server.
				</div>
			)}

			{data.services.length > 0 && (
				<div className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">
						Heaviest services ({data.services.length} running)
					</span>
					{data.services.slice(0, TOP_SERVICES).map((service) => (
						<div
							key={service.name}
							className="flex items-center justify-between gap-4 text-sm"
						>
							<span className="truncate">{service.name}</span>
							<span className="text-muted-foreground shrink-0 tabular-nums">
								{formatBytes(service.currentBytes)} now
								{service.peakBytes !== null
									? ` · ${formatBytes(service.peakBytes)} peak`
									: ""}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
};
