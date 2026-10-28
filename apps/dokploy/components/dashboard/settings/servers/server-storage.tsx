import type { inferRouterOutputs } from "@trpc/server";
import { formatDistanceToNowStrict } from "date-fns";
import {
	AlertTriangle,
	ChevronRight,
	ExternalLink,
	FolderSearch,
	HardDrive,
	RefreshCw,
	WifiOff,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { AppRouter } from "@/server/api/root";
import { api } from "@/utils/api";
import { formatBytes } from "./format-bytes";
import { ServerFilesExplorer } from "./server-files-explorer";
import { useHoverPopover } from "./use-hover-popover";

type StorageResult = inferRouterOutputs<AppRouter>["server"]["storage"];
type StorageVolume = NonNullable<StorageResult["sample"]>["volumes"][number];
type HistoryPoint = StorageResult["history"][number];
type AttachedVolume = NonNullable<
	StorageResult["sample"]
>["attachedVolumes"][number];
type CloudVolume =
	inferRouterOutputs<AppRouter>["server"]["cloudVolumes"]["volumes"][number];
type UsageFields = Pick<
	StorageVolume,
	| "mount"
	| "filesystem"
	| "totalBytes"
	| "usedBytes"
	| "availableBytes"
	| "usedPercent"
	| "inodesTotal"
	| "inodesUsed"
	| "inodesUsedPercent"
>;

const HETZNER_VOLUME_DOCS =
	"https://docs.hetzner.com/cloud/volumes/getting-started/using-volumes/";

const POLL_INTERVAL_MS = 15_000;
const WARNING_PERCENT = 80;
const CRITICAL_PERCENT = 90;

type Level = "ok" | "warning" | "critical";

const levelOf = (percent: number | null): Level => {
	if (percent === null) return "ok";
	if (percent >= CRITICAL_PERCENT) return "critical";
	if (percent >= WARNING_PERCENT) return "warning";
	return "ok";
};

const worstLevel = (volume: UsageFields): Level => {
	const levels = [
		levelOf(volume.usedPercent),
		levelOf(volume.inodesUsedPercent),
	];
	if (levels.includes("critical")) return "critical";
	if (levels.includes("warning")) return "warning";
	return "ok";
};

const FILL_CLASS: Record<Level, string> = {
	ok: "bg-primary",
	warning: "bg-amber-500",
	critical: "bg-red-500",
};

const formatCount = (value: number) =>
	new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);

const volumeLabel = (volume: StorageVolume) => {
	if (volume.holdsDocker && volume.holdsRoot) return "System & Docker";
	if (volume.holdsDocker) return "Docker data";
	return "System";
};

const useNow = (intervalMs: number) => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
};

const Meter = ({
	percent,
	level,
	label,
	className,
}: {
	percent: number;
	level: Level;
	label: string;
	className?: string;
}) => (
	<div
		className={cn(
			"relative h-2 w-full overflow-hidden rounded-full bg-muted",
			className,
		)}
	>
		{/* A styled native <meter> renders inconsistently across browsers, so it is only for assistive tech. */}
		<meter
			className="sr-only"
			aria-label={label}
			min={0}
			max={100}
			low={WARNING_PERCENT}
			high={CRITICAL_PERCENT}
			optimum={0}
			value={percent}
		/>
		<div
			aria-hidden
			className={cn(
				"h-full rounded-full transition-[width,background-color] duration-700 ease-out",
				FILL_CLASS[level],
			)}
			style={{ width: `${Math.min(100, Math.max(percent, 1))}%` }}
		/>
	</div>
);

const worseOf = (a: Level, b: Level): Level =>
	a === "critical" || b === "critical"
		? "critical"
		: a === "warning" || b === "warning"
			? "warning"
			: "ok";

const LevelNotice = ({ level, text }: { level: Level; text?: string }) => {
	if (level === "ok") return null;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 text-xs font-medium",
				level === "critical"
					? "text-red-600 dark:text-red-400"
					: "text-amber-600 dark:text-amber-400",
			)}
		>
			<AlertTriangle className="size-3" />
			{text ?? (level === "critical" ? "Almost full" : "Running low")}
		</span>
	);
};

const LiveStatus = ({ data }: { data: StorageResult }) => {
	if (data.status === "ok") {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
				<span className="relative flex size-2">
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:hidden" />
					<span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
				</span>
				Live
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
			<WifiOff className="size-3" />
			{data.status === "stale" ? "Last known" : "Unreachable"}
		</span>
	);
};

const TrendChart = ({ history }: { history: HistoryPoint[] }) => {
	const [hovered, setHovered] = useState<number | null>(null);
	const width = 280;
	const height = 56;

	const geometry = useMemo(() => {
		if (history.length < 2) return null;
		const first = history[0]!;
		const last = history[history.length - 1]!;
		const values = history.map((point) => point.usedBytes);
		const min = Math.min(...values);
		const max = Math.max(...values);
		// A floor on the span keeps a few MB of log churn from looking like a cliff.
		const span = Math.max(max - min, last.totalBytes * 0.01, 1);
		const mid = (max + min) / 2;
		const lo = mid - span / 2;
		const duration = Math.max(last.t - first.t, 1);
		const points = history.map((point) => ({
			x: ((point.t - first.t) / duration) * width,
			y: height - 4 - ((point.usedBytes - lo) / span) * (height - 8),
		}));
		const line = points.map((p) => `${p.x},${p.y}`).join(" ");
		return {
			points,
			line,
			area: `0,${height} ${line} ${width},${height}`,
			delta: last.usedBytes - first.usedBytes,
			duration,
		};
	}, [history]);

	if (!geometry) {
		return (
			<p className="text-xs text-muted-foreground">
				Collecting readings — the trend appears after the next refresh.
			</p>
		);
	}

	const active = hovered !== null ? history[hovered] : null;
	const activePoint = hovered !== null ? geometry.points[hovered] : null;
	const deltaLabel =
		Math.abs(geometry.delta) < 1024 ** 2
			? "No change"
			: `${geometry.delta > 0 ? "+" : "−"}${formatBytes(Math.abs(geometry.delta))}`;

	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between text-xs">
				<span className="text-muted-foreground">
					{active
						? formatDistanceToNowStrict(active.t, { addSuffix: true })
						: `Used space, last ${formatDistanceToNowStrict(Date.now() - geometry.duration)}`}
				</span>
				<span className="font-medium tabular-nums">
					{active ? formatBytes(active.usedBytes) : deltaLabel}
				</span>
			</div>
			<div className="relative">
				<svg
					viewBox={`0 0 ${width} ${height}`}
					preserveAspectRatio="none"
					className="h-14 w-full overflow-visible text-primary"
					role="img"
					aria-label={`Used space trend: ${deltaLabel}`}
					onMouseLeave={() => setHovered(null)}
					onMouseMove={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						const x = ((event.clientX - rect.left) / rect.width) * width;
						let nearest = 0;
						for (let i = 1; i < geometry.points.length; i++) {
							if (
								Math.abs(geometry.points[i]!.x - x) <
								Math.abs(geometry.points[nearest]!.x - x)
							) {
								nearest = i;
							}
						}
						setHovered(nearest);
					}}
				>
					<polygon
						points={geometry.area}
						className="fill-current opacity-[0.07]"
					/>
					<polyline
						points={geometry.line}
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
					/>
					{activePoint && (
						<line
							x1={activePoint.x}
							x2={activePoint.x}
							y1={0}
							y2={height}
							className="stroke-muted-foreground"
							strokeDasharray="2 2"
							vectorEffect="non-scaling-stroke"
						/>
					)}
				</svg>
			</div>
		</div>
	);
};

const VolumeDetails = ({
	volume,
	label,
	detail,
}: {
	volume: UsageFields;
	label: string;
	detail?: string;
}) => {
	const level = worstLevel(volume);
	const inodeLevel = levelOf(volume.inodesUsedPercent);
	return (
		<div className="space-y-2">
			<div className="flex items-baseline justify-between gap-2">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium" title={label}>
						{label}
					</p>
					<p
						className="truncate font-mono text-xs text-muted-foreground"
						title={`${volume.filesystem} on ${volume.mount}`}
					>
						{volume.mount} · {detail ?? volume.filesystem}
					</p>
				</div>
				<span className="text-sm font-semibold tabular-nums">
					{Math.round(volume.usedPercent)}%
				</span>
			</div>
			<Meter
				percent={volume.usedPercent}
				level={levelOf(volume.usedPercent)}
				label={`${label} usage`}
			/>
			<dl className="grid grid-cols-3 gap-2 text-xs">
				<div>
					<dt className="text-muted-foreground">Used</dt>
					<dd className="font-medium tabular-nums">
						{formatBytes(volume.usedBytes)}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Free</dt>
					<dd className="font-medium tabular-nums">
						{formatBytes(volume.availableBytes)}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Size</dt>
					<dd className="font-medium tabular-nums">
						{formatBytes(volume.totalBytes)}
					</dd>
				</div>
			</dl>
			{volume.inodesTotal !== null && volume.inodesUsed !== null && (
				<div className="flex items-center justify-between text-xs">
					<span className="text-muted-foreground">
						Inodes {formatCount(volume.inodesUsed)} of{" "}
						{formatCount(volume.inodesTotal)}
					</span>
					<span
						className={cn(
							"tabular-nums",
							inodeLevel === "ok" ? "text-muted-foreground" : "font-medium",
						)}
					>
						{inodeLevel !== "ok" && (
							<AlertTriangle className="mr-1 inline size-3 text-amber-500" />
						)}
						{Math.round(volume.inodesUsedPercent ?? 0)}%
					</span>
				</div>
			)}
			{level !== "ok" && <LevelNotice level={level} />}
		</div>
	);
};

const volumeName = (volumeId: string, cloud: CloudVolume | undefined) =>
	cloud?.name ?? `Volume ${volumeId}`;

const NotMounted = ({ title, detail }: { title: string; detail: string }) => (
	<div className="space-y-1">
		<p className="truncate text-sm font-medium" title={title}>
			{title}
		</p>
		<div className="flex gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
			<AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
			<div className="min-w-0 space-y-0.5">
				<p className="font-medium">Not mounted</p>
				<p className="break-words text-muted-foreground">{detail}</p>
				<a
					href={HETZNER_VOLUME_DOCS}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
				>
					How to mount a volume
					<ExternalLink className="size-3" />
				</a>
			</div>
		</div>
	</div>
);

const AttachedVolumes = ({
	serverId,
	attached,
}: {
	serverId: string;
	attached: AttachedVolume[];
}) => {
	const { data: cloud } = api.server.cloudVolumes.useQuery(
		{ serverId },
		{
			staleTime: 60_000,
			retry: false,
			trpc: { context: { skipBatch: true } },
		},
	);
	const cloudById = new Map(
		(cloud?.volumes ?? []).map((volume) => [volume.id, volume]),
	);
	const seenIds = new Set(attached.map((volume) => volume.volumeId));
	const listed = attached.filter((volume) => !volume.alsoListed);
	// Hetzner can report an attachment before the kernel sees the disk, e.g. straight after attaching.
	const notOnServer = (cloud?.volumes ?? []).filter(
		(volume) => !seenIds.has(volume.id),
	);

	if (listed.length === 0 && notOnServer.length === 0) return null;

	return (
		<div className="space-y-3 border-t pt-3">
			<div className="flex items-center justify-between gap-2">
				<span className="flex items-center gap-1.5 text-sm font-semibold">
					<HardDrive className="size-3.5 text-muted-foreground" />
					Attached volumes
				</span>
				<span className="text-xs text-muted-foreground tabular-nums">
					{formatBytes(
						[...listed, ...notOnServer].reduce(
							(sum, volume) =>
								sum +
								("sizeGb" in volume
									? volume.sizeGb * 1024 ** 3
									: (volume.usage?.totalBytes ?? volume.sizeBytes)),
							0,
						),
					)}
				</span>
			</div>
			{listed.map((volume) => {
				const name = `${volumeName(volume.volumeId, cloudById.get(volume.volumeId))}${volume.partition ? ` · partition ${volume.partition}` : ""}`;
				return volume.usage ? (
					<VolumeDetails
						key={`${volume.volumeId}-${volume.partition}`}
						volume={volume.usage}
						label={name}
					/>
				) : (
					<NotMounted
						key={`${volume.volumeId}-${volume.partition}`}
						title={name}
						detail={`${formatBytes(volume.sizeBytes)} attached as ${volume.device} but not mounted, so the space can't be used yet.`}
					/>
				);
			})}
			{notOnServer.map((volume) => (
				<NotMounted
					key={volume.id}
					title={volume.name}
					detail={`Hetzner shows ${volume.sizeGb} GB attached, but the server can't see the disk yet.${volume.linuxDevice ? ` Expected at ${volume.linuxDevice}.` : ""}`}
				/>
			))}
		</div>
	);
};

const StorageDetails = ({
	serverId,
	data,
	onRefresh,
	refreshing,
	canViewDocker,
	onBrowseFiles,
}: {
	serverId: string;
	data: StorageResult;
	onRefresh: () => void;
	refreshing: boolean;
	canViewDocker: boolean;
	onBrowseFiles?: () => void;
}) => {
	const now = useNow(1000);
	const checkedAt = data.sample?.checkedAt;

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<HardDrive className="size-4 text-muted-foreground" />
					<span className="text-sm font-semibold">Storage</span>
					<LiveStatus data={data} />
				</div>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					aria-label="Refresh storage"
					disabled={refreshing}
					onClick={onRefresh}
				>
					<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
				</Button>
			</div>

			{data.error && (
				<div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
					<div className="min-w-0 space-y-0.5">
						<p className="font-medium">
							{data.sample
								? "Couldn't reach the server, showing the last reading"
								: "Couldn't read storage"}
						</p>
						<p className="break-words text-muted-foreground">{data.error}</p>
					</div>
				</div>
			)}

			{data.sample?.volumes.map((volume) => (
				<VolumeDetails
					key={volume.mount}
					volume={volume}
					label={
						volume.attachedVolumeId
							? `${volumeLabel(volume)} · Volume ${volume.attachedVolumeId}`
							: volumeLabel(volume)
					}
				/>
			))}

			{data.sample && data.sample.volumes.length > 0 && (
				<div className="border-t pt-3">
					<TrendChart history={data.history} />
				</div>
			)}

			{data.sample && (
				<AttachedVolumes
					serverId={serverId}
					attached={data.sample.attachedVolumes ?? []}
				/>
			)}

			<div className="flex items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
				<span className="tabular-nums">
					{checkedAt
						? `Checked ${Math.max(0, Math.round((now - checkedAt) / 1000))}s ago`
						: "Not checked yet"}
				</span>
				<span className="flex items-center gap-3">
					{onBrowseFiles && (
						<button
							type="button"
							onClick={onBrowseFiles}
							className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
						>
							<FolderSearch className="size-3" />
							Browse files
						</button>
					)}
					{canViewDocker && (
						<Link
							href={{
								pathname: "/dashboard/docker",
								query: { serverId, tab: "disk-usage" },
							}}
							className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
						>
							Docker usage
							<ChevronRight className="size-3" />
						</Link>
					)}
				</span>
			</div>
		</div>
	);
};

const StatusDot = ({ status }: { status: StorageResult["status"] }) => (
	<span
		className={cn(
			"inline-block size-1.5 shrink-0 rounded-full",
			status === "ok"
				? "bg-emerald-500"
				: status === "stale"
					? "bg-amber-500"
					: "bg-muted-foreground",
		)}
		title={status === "ok" ? "Live" : "Showing the last known reading"}
	/>
);

export const ServerStorage = ({
	serverId,
	serverName,
	canViewDocker,
	canBrowseFiles = false,
	variant = "tile",
}: {
	serverId: string;
	serverName?: string;
	canViewDocker: boolean;
	canBrowseFiles?: boolean;
	variant?: "tile" | "row";
}) => {
	const utils = api.useUtils();
	const [refreshing, setRefreshing] = useState(false);
	const [explorerOpen, setExplorerOpen] = useState(false);
	const hover = useHoverPopover();
	const { data, isPending, refetch } = api.server.storage.useQuery(
		{ serverId },
		{
			refetchInterval: POLL_INTERVAL_MS,
			staleTime: POLL_INTERVAL_MS - 5_000,
			retry: 1,
			// One slow or unreachable server must not hold up every other card's reading.
			trpc: { context: { skipBatch: true } },
		},
	);

	const refresh = async () => {
		setRefreshing(true);
		try {
			const result = await utils.client.server.storage.query(
				{ serverId, force: true },
				{ context: { skipBatch: true } },
			);
			utils.server.storage.setData({ serverId }, result);
		} catch {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const isRow = variant === "row";

	if (isPending) {
		return (
			<div
				className={cn(isRow ? "flex items-center gap-2" : "space-y-1.5")}
				aria-busy="true"
			>
				<Skeleton className={cn("h-3", isRow ? "w-16 sm:w-28" : "w-2/3")} />
				<Skeleton
					className={cn("h-1.5 rounded-full", isRow ? "w-12" : "w-full")}
				/>
			</div>
		);
	}

	const primary = data?.sample?.volumes[0];

	if (!data || !primary) {
		return (
			<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
				<HardDrive className="size-3.5 shrink-0" />
				<span
					className={cn("truncate", isRow && "hidden sm:inline")}
					title={data?.error ?? undefined}
				>
					{isRow ? "Unavailable" : "Storage unavailable"}
				</span>
				<Button
					variant="ghost"
					size="icon"
					className="size-6 shrink-0"
					aria-label="Retry reading storage"
					title={data?.error ?? "Retry"}
					disabled={refreshing}
					onClick={refresh}
				>
					<RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
				</Button>
			</div>
		);
	}

	const attachedVolumes = data.sample?.attachedVolumes ?? [];
	const others = [
		...(data.sample?.volumes.slice(1) ?? []),
		...attachedVolumes.flatMap((volume) =>
			volume.usage && !volume.alsoListed ? [volume.usage] : [],
		),
	];
	const primaryLevel = worstLevel(primary);
	const fullestOther = others.reduce<(typeof others)[number] | undefined>(
		(fullest, volume) =>
			!fullest || volume.usedPercent > fullest.usedPercent ? volume : fullest,
		undefined,
	);
	const otherLevel = others.reduce<Level>(
		(worst, volume) => worseOf(worst, worstLevel(volume)),
		"ok",
	);
	const level = worseOf(primaryLevel, otherLevel);
	// The tile's numbers describe the main disk, so name the other volume when it's the one filling up.
	const levelText =
		primaryLevel === level || !fullestOther
			? undefined
			: `Volume at ${Math.round(fullestOther.usedPercent)}%`;
	const unmounted = attachedVolumes.some((volume) => !volume.usage);
	const percentLabel = `${Math.round(primary.usedPercent)}%`;

	return (
		<>
			<Popover open={hover.open} onOpenChange={hover.setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						{...hover.triggerProps}
						className={cn(
							"group rounded-md text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							isRow
								? "-mx-1.5 flex min-w-0 items-center gap-2 px-1.5 py-1 hover:bg-muted/60"
								: "-mx-1.5 block w-[calc(100%+0.75rem)] space-y-1.5 px-1.5 py-1 hover:bg-muted/60",
							data.status !== "ok" && "opacity-70",
						)}
						aria-label={`Storage ${percentLabel} used, ${formatBytes(primary.availableBytes)} free. Show details`}
					>
						{isRow ? (
							<>
								<StatusDot status={data.status} />
								<Meter
									percent={primary.usedPercent}
									level={levelOf(primary.usedPercent)}
									label={`${volumeLabel(primary)} usage`}
									className="hidden h-1.5 w-14 shrink-0 sm:block"
								/>
								<span className="w-8 shrink-0 text-right font-medium tabular-nums">
									{percentLabel}
								</span>
								<span className="hidden truncate text-muted-foreground tabular-nums sm:inline">
									{formatBytes(primary.availableBytes)} free
								</span>
								{level !== "ok" && (
									<AlertTriangle
										className={cn(
											"size-3.5 shrink-0",
											level === "critical" ? "text-red-500" : "text-amber-500",
										)}
										aria-label={
											levelText ??
											(level === "critical" ? "Almost full" : "Running low")
										}
									/>
								)}
							</>
						) : (
							<>
								<span className="flex items-center justify-between gap-2">
									<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
										<StatusDot status={data.status} />
										{level === "ok" ? (
											"Storage"
										) : (
											<LevelNotice level={level} text={levelText} />
										)}
										{attachedVolumes.length > 0 &&
											(level === "ok" || unmounted) && (
												<span
													className={cn(
														"inline-flex items-center gap-0.5 tabular-nums",
														unmounted && "text-amber-600 dark:text-amber-400",
													)}
													title={
														unmounted
															? "An attached volume isn't mounted"
															: `${attachedVolumes.length} attached ${attachedVolumes.length === 1 ? "volume" : "volumes"}`
													}
												>
													<HardDrive className="size-3" />
													{attachedVolumes.length}
												</span>
											)}
									</span>
									<span className="truncate tabular-nums text-muted-foreground">
										<span className="font-medium text-foreground">
											{formatBytes(primary.availableBytes)}
										</span>{" "}
										free · {percentLabel}
									</span>
								</span>
								<Meter
									percent={primary.usedPercent}
									level={levelOf(primary.usedPercent)}
									label={`${volumeLabel(primary)} usage`}
									className="h-1.5"
								/>
							</>
						)}
					</button>
				</PopoverTrigger>
				<PopoverContent
					{...hover.contentProps}
					className="w-80 max-h-(--radix-popover-content-available-height) overflow-y-auto"
					side={isRow ? "left" : "right"}
					align="center"
					collisionPadding={16}
				>
					<StorageDetails
						serverId={serverId}
						data={data}
						onRefresh={refresh}
						refreshing={refreshing}
						canViewDocker={canViewDocker}
						onBrowseFiles={
							canBrowseFiles
								? () => {
										hover.setOpen(false);
										setExplorerOpen(true);
									}
								: undefined
						}
					/>
				</PopoverContent>
			</Popover>
			{canBrowseFiles && (
				// Lives outside the popover, which unmounts its content as soon as it closes.
				<ServerFilesExplorer
					serverId={serverId}
					serverName={serverName}
					canViewDocker={canViewDocker}
					open={explorerOpen}
					onOpenChange={setExplorerOpen}
				/>
			)}
		</>
	);
};
