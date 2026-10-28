import type { inferRouterOutputs } from "@trpc/server";
import {
	AlertTriangle,
	ChevronRight,
	File,
	Folder,
	FolderOpen,
	HardDrive,
	Link2,
	Loader2,
	Lock,
	RefreshCw,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AppRouter } from "@/server/api/root";
import { api } from "@/utils/api";
import { formatBytes } from "./format-bytes";

type Listing = inferRouterOutputs<AppRouter>["serverFiles"]["list"];
type Entry = Listing["entries"][number];

const ROOT = "/";
const INDENT_PX = 16;

const listQueryOptions = {
	staleTime: 5 * 60_000,
	retry: false,
	refetchOnWindowFocus: false,
	// One folder can take a minute to measure; it must not hold up other requests.
	trpc: { context: { skipBatch: true } },
} as const;

const EntryIcon = ({ entry, open }: { entry: Entry; open: boolean }) => {
	const className = "size-4 shrink-0 text-muted-foreground";
	if (entry.mountPoint) return <HardDrive className={className} />;
	if (entry.type === "directory") {
		return open ? (
			<FolderOpen className={className} />
		) : (
			<Folder className={className} />
		);
	}
	if (entry.type === "symlink") return <Link2 className={className} />;
	return <File className={className} />;
};

const Indent = ({ depth }: { depth: number }) => (
	<span aria-hidden className="shrink-0" style={{ width: depth * INDENT_PX }} />
);

const StatusRow = ({
	depth,
	children,
	tone = "muted",
}: {
	depth: number;
	children: React.ReactNode;
	tone?: "muted" | "warning";
}) => (
	<div
		className={cn(
			"flex items-center gap-2 px-2 py-1.5 text-xs",
			tone === "warning"
				? "text-amber-600 dark:text-amber-400"
				: "text-muted-foreground",
		)}
	>
		<Indent depth={depth} />
		<span className="w-5 shrink-0" />
		{children}
	</div>
);

const EntryRow = ({
	entry,
	depth,
	parentBytes,
	expanded,
	dockerRoot,
	canViewDocker,
	serverId,
	onToggle,
	onDelete,
}: {
	entry: Entry;
	depth: number;
	parentBytes: number;
	expanded: boolean;
	dockerRoot: string;
	canViewDocker: boolean;
	serverId: string;
	onToggle: (path: string) => void;
	onDelete: (entry: Entry) => void;
}) => {
	const expandable = entry.type === "directory";
	const share = parentBytes > 0 ? (entry.sizeBytes / parentBytes) * 100 : 0;

	return (
		<div className="group/row flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
			<Indent depth={depth} />
			{expandable ? (
				<button
					type="button"
					className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label={`Show what's inside ${entry.name}`}
					aria-expanded={expanded}
					onClick={() => onToggle(entry.path)}
				>
					<ChevronRight
						className={cn(
							"size-3.5 transition-transform",
							expanded && "rotate-90",
						)}
					/>
				</button>
			) : (
				<span className="w-5 shrink-0" />
			)}
			<EntryIcon entry={entry} open={expanded} />
			<button
				type="button"
				disabled={!expandable}
				onClick={() => onToggle(entry.path)}
				className="min-w-0 flex-1 truncate text-left font-mono text-[13px] disabled:cursor-default enabled:hover:underline underline-offset-2 focus-visible:outline-none"
				title={entry.path}
			>
				{entry.name}
			</button>
			{entry.mountPoint && (
				<span
					className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground"
					title="A separate disk is mounted here; its size is that disk's used space"
				>
					mount
				</span>
			)}
			{entry.path === dockerRoot && canViewDocker && (
				<Link
					href={{
						pathname: "/dashboard/docker",
						query: { serverId, tab: "disk-usage" },
					}}
					className="shrink-0 text-xs font-medium hover:underline"
				>
					Docker usage
				</Link>
			)}
			<div className="hidden w-24 shrink-0 sm:block">
				<div className="h-1.5 overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-primary/70"
						style={{ width: `${Math.min(100, Math.max(share, 0.5))}%` }}
					/>
				</div>
			</div>
			<span className="w-16 shrink-0 text-right text-xs font-medium tabular-nums">
				{formatBytes(entry.sizeBytes)}
			</span>
			<span className="hidden w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:inline">
				{share >= 0.1 ? `${share.toFixed(share >= 10 ? 0 : 1)}%` : "<0.1%"}
			</span>
			{entry.protectedReason ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<span
							className="grid size-6 shrink-0 place-items-center text-muted-foreground/60"
							aria-label={`Can't delete: ${entry.protectedReason}`}
						>
							<Lock className="size-3" />
						</span>
					</TooltipTrigger>
					<TooltipContent className="max-w-64">
						{entry.protectedReason}
					</TooltipContent>
				</Tooltip>
			) : (
				<Button
					variant="ghost"
					size="icon"
					className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-destructive"
					aria-label={`Delete ${entry.path}`}
					onClick={() => onDelete(entry)}
				>
					<Trash2 className="size-3.5" />
				</Button>
			)}
		</div>
	);
};

interface TreeContext {
	serverId: string;
	canViewDocker: boolean;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	onDelete: (entry: Entry) => void;
}

const DirectoryChildren = ({
	path,
	depth,
	ctx,
}: {
	path: string;
	depth: number;
	ctx: TreeContext;
}) => {
	const { data, isPending, error, refetch, isFetching } =
		api.serverFiles.list.useQuery(
			{ serverId: ctx.serverId, path },
			listQueryOptions,
		);

	if (isPending) {
		return (
			<StatusRow depth={depth}>
				<Loader2 className="size-3.5 animate-spin" />
				Measuring folder sizes. Large folders can take up to a minute.
			</StatusRow>
		);
	}

	if (error) {
		return (
			<StatusRow depth={depth} tone="warning">
				<AlertTriangle className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate" title={error.message}>
					{error.message}
				</span>
				<Button
					variant="link"
					size="sm"
					className="h-auto p-0 text-xs"
					disabled={isFetching}
					onClick={() => refetch()}
				>
					Retry
				</Button>
			</StatusRow>
		);
	}

	if (!data.exists) {
		return <StatusRow depth={depth}>This folder no longer exists.</StatusRow>;
	}

	// Mounted disks aren't part of the folder's own total, so add them to keep shares under 100%.
	const parentBytes =
		data.totalBytes === null
			? data.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
			: data.entries.reduce(
					(sum, entry) => (entry.mountPoint ? sum + entry.sizeBytes : sum),
					data.totalBytes,
				);
	const hidden = data.truncated ? data.entryCount - data.entries.length : 0;

	return (
		<div>
			{data.partial && (
				<StatusRow depth={depth} tone="warning">
					<AlertTriangle className="size-3.5 shrink-0" />
					Measuring took too long, so some items may be missing.
				</StatusRow>
			)}
			{data.entries.length === 0 && !data.partial && (
				<StatusRow depth={depth}>Empty folder</StatusRow>
			)}
			{data.entries.map((entry) => {
				const open = ctx.expanded.has(entry.path);
				return (
					<div key={entry.path}>
						<EntryRow
							entry={entry}
							depth={depth}
							parentBytes={parentBytes}
							expanded={open}
							dockerRoot={data.dockerRoot}
							canViewDocker={ctx.canViewDocker}
							serverId={ctx.serverId}
							onToggle={ctx.onToggle}
							onDelete={ctx.onDelete}
						/>
						{open && (
							<DirectoryChildren
								path={entry.path}
								depth={depth + 1}
								ctx={ctx}
							/>
						)}
					</div>
				);
			})}
			{hidden > 0 && (
				<StatusRow depth={depth}>
					{hidden.toLocaleString()} smaller {hidden === 1 ? "item" : "items"}{" "}
					not shown
				</StatusRow>
			)}
		</div>
	);
};

const RootSummary = ({ serverId }: { serverId: string }) => {
	const { data } = api.serverFiles.list.useQuery(
		{ serverId, path: ROOT },
		listQueryOptions,
	);
	if (!data) return <Skeleton className="h-4 w-40" />;
	return (
		<span className="text-xs text-muted-foreground tabular-nums">
			{data.totalBytes !== null
				? `${formatBytes(data.totalBytes)} on the system disk`
				: "System disk"}
			{" · checked "}
			{new Date(data.checkedAt).toLocaleTimeString()}
		</span>
	);
};

const ExplorerBody = ({
	serverId,
	serverName,
	canViewDocker,
}: {
	serverId: string;
	serverName?: string;
	canViewDocker: boolean;
}) => {
	const utils = api.useUtils();
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]));
	const [pendingDelete, setPendingDelete] = useState<Entry | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const { mutateAsync: removePath, isPending: removing } =
		api.serverFiles.remove.useMutation();

	const toggle = (path: string) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(path)) {
				for (const open of current) {
					if (open === path || open.startsWith(`${path}/`)) next.delete(open);
				}
			} else {
				next.add(path);
			}
			return next;
		});

	const refresh = async () => {
		setRefreshing(true);
		try {
			await Promise.all(
				[...expanded].map(async (path) => {
					const result = await utils.client.serverFiles.list.query(
						{ serverId, path, force: true },
						{ context: { skipBatch: true } },
					);
					utils.serverFiles.list.setData({ serverId, path }, result);
				}),
			);
		} catch (error) {
			toast.error("Couldn't refresh sizes", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setRefreshing(false);
		}
	};

	const confirmDelete = async () => {
		if (!pendingDelete) return;
		const target = pendingDelete;
		try {
			await removePath({ serverId, path: target.path });
			toast.success(`Deleted ${target.name}`, {
				description: `Freed about ${formatBytes(target.sizeBytes)}`,
			});
			setExpanded((current) => {
				const next = new Set(current);
				for (const open of current) {
					if (open === target.path || open.startsWith(`${target.path}/`)) {
						next.delete(open);
					}
				}
				return next;
			});
			setPendingDelete(null);
			await Promise.all([
				utils.serverFiles.list.invalidate({ serverId }),
				utils.server.storage.invalidate({ serverId }),
			]);
		} catch (error) {
			toast.error(`Couldn't delete ${target.name}`, {
				description: error instanceof Error ? error.message : undefined,
			});
		}
	};

	const ctx: TreeContext = {
		serverId,
		canViewDocker,
		expanded,
		onToggle: toggle,
		onDelete: setPendingDelete,
	};

	return (
		<>
			<div className="flex items-center justify-between gap-2">
				<RootSummary serverId={serverId} />
				<Button
					variant="outline"
					size="sm"
					disabled={refreshing}
					onClick={refresh}
				>
					<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
					Refresh
				</Button>
			</div>
			<div className="-mx-2 min-h-48 flex-1 overflow-y-auto rounded-md border p-1">
				<DirectoryChildren path={ROOT} depth={0} ctx={ctx} />
			</div>

			<AlertDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open && !removing) setPendingDelete(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
						<AlertDialogDescription asChild>
							<div className="space-y-2">
								<p>
									This permanently deletes{" "}
									{pendingDelete?.type === "directory"
										? "this folder and everything in it"
										: "this file"}{" "}
									from {serverName ?? "the server"}. It can't be undone.
								</p>
								<p className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
									{pendingDelete?.path}
									{pendingDelete &&
										` · ${formatBytes(pendingDelete.sizeBytes)}`}
								</p>
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={removing}
							onClick={(event) => {
								event.preventDefault();
								confirmDelete();
							}}
						>
							{removing && <Loader2 className="size-3.5 animate-spin" />}
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
};

export const ServerFilesExplorer = ({
	serverId,
	serverName,
	canViewDocker = false,
	children,
	open,
	onOpenChange,
}: {
	serverId: string;
	serverName?: string;
	canViewDocker?: boolean;
	children?: React.ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) => {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const isOpen = open ?? uncontrolledOpen;
	const setOpen = onOpenChange ?? setUncontrolledOpen;

	return (
		<Dialog open={isOpen} onOpenChange={setOpen}>
			{children && <DialogTrigger asChild>{children}</DialogTrigger>}
			<DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Disk explorer</DialogTitle>
					<DialogDescription>
						What's using space on {serverName ?? "this server"}, largest first.
						Docker's own data is locked here; free it with Docker cleanup
						instead.
					</DialogDescription>
				</DialogHeader>
				{isOpen && (
					<ExplorerBody
						serverId={serverId}
						serverName={serverName}
						canViewDocker={canViewDocker}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
};
