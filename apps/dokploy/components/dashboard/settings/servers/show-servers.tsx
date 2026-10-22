import {
	Activity,
	BarChartHorizontalBigIcon,
	ChevronLeft,
	ChevronRight,
	Folder,
	KeyIcon,
	LayoutGrid,
	List,
	Loader2,
	MoreHorizontal,
	Pencil,
	Search,
	ServerIcon,
	Settings,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSortPreference } from "@/hooks/use-sort-preference";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import { TerminalModal } from "../web-server/terminal-modal";
import { ShowServerActions } from "./actions/show-server-actions";
import { DeleteServerModal } from "./delete-server-modal";
import { HandleServers } from "./handle-servers";
import { ProvisionServer } from "./provision-server";
import {
	type ServerCost,
	ServerCostBadge,
	ServerCostSummary,
	type ServerProvider,
	ServerProviderIcon,
	useServerCosts,
} from "./server-costs";
import {
	ALL_FOLDERS,
	FolderNameDialog,
	MoveToFolderMenu,
	type ServerFolder,
	ServerFolderBar,
	UNFILED,
	useMoveServersToFolder,
	useServerFolders,
} from "./server-folders";
import { ServerStorage } from "./server-storage";
import { SetupServer } from "./setup-server";
import { ShowMonitoringModal } from "./show-monitoring-modal";
import { WelcomeSubscription } from "./welcome-stripe/welcome-subscription";

type Server = RouterOutputs["server"]["all"][number];
type Permissions = RouterOutputs["user"]["getPermissions"];

const VIEWS = ["grid", "list"] as const;
const PAGE_SIZES = ["12", "24", "48", "96"] as const;
const ROLE_FILTERS = ["all", "deploy", "build", "workflow"] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number];

const matchesSearch = (
	server: Server,
	terms: string[],
	folderName: string | undefined,
) => {
	if (terms.length === 0) return true;
	const haystack = [
		server.name,
		server.description,
		server.ipAddress,
		`${server.username}@${server.ipAddress}:${server.port}`,
		folderName,
		...server.serverRoles,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return terms.every((term) => haystack.includes(term));
};

interface ServerItemProps {
	server: Server;
	isCloud: boolean;
	permissions: Permissions | undefined;
	folders: ServerFolder[];
	folder: ServerFolder | undefined;
	showFolder: boolean;
	cost: ServerCost | undefined;
	provider: ServerProvider | undefined;
	onNewFolder: (serverId: string) => void;
}

const IconAction = ({
	label,
	children,
}: {
	label: string;
	children: React.ReactElement;
}) => (
	<Tooltip>
		<TooltipTrigger asChild>{children}</TooltipTrigger>
		<TooltipContent>{label}</TooltipContent>
	</Tooltip>
);

const ServerActions = ({
	server,
	isCloud,
	permissions,
	folders,
	folder,
	onNewFolder,
}: Omit<ServerItemProps, "showFolder" | "cost" | "provider">) => {
	const isDeployServer = server.serverRoles.includes("deploy");
	const canManage = !!permissions?.server.create;

	return (
		<div className="flex shrink-0 items-center">
			<SetupServer serverId={server.serverId}>
				<Button
					variant="ghost"
					size="icon"
					className="hidden size-7 sm:inline-flex"
					aria-label="Setup server"
					title="Setup server"
				>
					<Settings className="size-4" />
				</Button>
			</SetupServer>
			{server.sshKeyId && permissions?.server.terminal && (
				<TerminalModal serverId={server.serverId} asButton>
					<Button
						variant="ghost"
						size="icon"
						className="hidden size-7 sm:inline-flex"
						aria-label="Open terminal"
						title="Terminal"
					>
						<Terminal className="size-4" />
					</Button>
				</TerminalModal>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label={`More actions for ${server.name}`}
					>
						<MoreHorizontal className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-48">
					<SetupServer serverId={server.serverId}>
						<DropdownMenuItem
							className="sm:hidden"
							onSelect={(event) => event.preventDefault()}
						>
							<Settings className="size-4" />
							Setup server
						</DropdownMenuItem>
					</SetupServer>
					{server.sshKeyId && permissions?.server.terminal && (
						<TerminalModal serverId={server.serverId} asButton>
							<DropdownMenuItem
								className="sm:hidden"
								onSelect={(event) => event.preventDefault()}
							>
								<Terminal className="size-4" />
								Terminal
							</DropdownMenuItem>
						</TerminalModal>
					)}
					<HandleServers serverId={server.serverId}>
						<DropdownMenuItem onSelect={(event) => event.preventDefault()}>
							<Pencil className="size-4" />
							Edit server
						</DropdownMenuItem>
					</HandleServers>
					{server.sshKeyId && isDeployServer && (
						<ShowServerActions serverId={server.serverId}>
							<DropdownMenuItem onSelect={(event) => event.preventDefault()}>
								<Activity className="size-4" />
								Web server actions
							</DropdownMenuItem>
						</ShowServerActions>
					)}
					{isCloud && server.sshKeyId && isDeployServer && (
						<ShowMonitoringModal
							url={`http://${server.ipAddress}:${server.metricsConfig?.server?.port}/metrics`}
							token={server.metricsConfig?.server?.token}
						>
							<DropdownMenuItem onSelect={(event) => event.preventDefault()}>
								<BarChartHorizontalBigIcon className="size-4" />
								Monitoring
							</DropdownMenuItem>
						</ShowMonitoringModal>
					)}
					{canManage && (
						<MoveToFolderMenu
							serverIds={[server.serverId]}
							folders={folders}
							currentFolderId={folder?.folderId ?? null}
							onNewFolder={() => onNewFolder(server.serverId)}
						/>
					)}
					{permissions?.server.delete && (
						<>
							<DropdownMenuSeparator />
							<DeleteServerModal
								serverId={server.serverId}
								serverName={server.name}
							>
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onSelect={(event) => event.preventDefault()}
								>
									<Trash2 className="size-4" />
									Delete server
								</DropdownMenuItem>
							</DeleteServerModal>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
};

const StatusBadge = ({ server }: { server: Server }) =>
	server.serverStatus === "active" ? null : (
		<IconAction label="This server is deactivated due to lack of payment. Pay your invoice to reactivate it.">
			<Badge variant="destructive" className="cursor-help">
				{server.serverStatus}
			</Badge>
		</IconAction>
	);

const RoleBadges = ({ roles }: { roles: Server["serverRoles"] }) => (
	<>
		{roles.map((role) => (
			<Badge
				key={role}
				variant={role === "deploy" ? "default" : "secondary"}
				className="h-5 px-1.5 text-[11px]"
			>
				{role}
			</Badge>
		))}
	</>
);

const ServerStorageSlot = ({
	server,
	permissions,
	variant,
}: {
	server: Server;
	permissions: Permissions | undefined;
	variant: "tile" | "row";
}) => {
	if (server.serverStatus !== "active") return null;
	if (!server.sshKeyId) {
		return (
			<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<KeyIcon className="size-3.5" />
				No SSH key
			</span>
		);
	}
	return (
		<ServerStorage
			serverId={server.serverId}
			canViewDocker={!!permissions?.docker.read}
			variant={variant}
		/>
	);
};

const ServerTile = (props: ServerItemProps) => {
	const { server, folder, showFolder, permissions, cost, provider } = props;
	const isActive = server.serverStatus === "active";
	return (
		<div className="flex flex-col gap-2.5 rounded-lg border bg-background p-3 transition-shadow hover:shadow-sm">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<ServerProviderIcon
							provider={provider}
							className="size-4 shrink-0"
						/>
						<span className="truncate font-medium" title={server.name}>
							{server.name}
						</span>
					</div>
					<p
						className="mt-0.5 truncate pl-6 font-mono text-xs text-muted-foreground"
						title={`${server.username}@${server.ipAddress}:${server.port}`}
					>
						{server.username}@{server.ipAddress}:{server.port}
					</p>
				</div>
				{isActive && <ServerActions {...props} />}
			</div>
			<div className="flex flex-wrap items-center gap-1 pl-6">
				<StatusBadge server={server} />
				<RoleBadges roles={server.serverRoles} />
				<ServerCostBadge cost={cost} />
				{showFolder && folder && (
					<span className="ml-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
						<Folder className="size-3 shrink-0" />
						<span className="truncate">{folder.name}</span>
					</span>
				)}
			</div>
			<div className="mt-auto pl-6">
				<ServerStorageSlot
					server={server}
					permissions={permissions}
					variant="tile"
				/>
			</div>
		</div>
	);
};

const ServerRow = (props: ServerItemProps) => {
	const { server, folder, showFolder, permissions, cost, provider } = props;
	return (
		<TableRow>
			<TableCell className="max-w-32 py-2 sm:max-w-56">
				<div className="flex min-w-0 items-center gap-2">
					<ServerProviderIcon provider={provider} className="size-4 shrink-0" />
					<div className="min-w-0">
						<p className="truncate font-medium" title={server.name}>
							{server.name}
						</p>
						{showFolder && folder && (
							<p className="flex items-center gap-1 text-xs text-muted-foreground">
								<Folder className="size-3 shrink-0" />
								<span className="truncate">{folder.name}</span>
							</p>
						)}
					</div>
				</div>
			</TableCell>
			<TableCell className="hidden py-2 font-mono text-xs text-muted-foreground md:table-cell">
				{server.username}@{server.ipAddress}:{server.port}
			</TableCell>
			<TableCell className="hidden py-2 lg:table-cell">
				<div className="flex flex-wrap gap-1">
					<StatusBadge server={server} />
					<RoleBadges roles={server.serverRoles} />
					<ServerCostBadge cost={cost} />
				</div>
			</TableCell>
			<TableCell className="py-2 sm:w-56">
				<ServerStorageSlot
					server={server}
					permissions={permissions}
					variant="row"
				/>
			</TableCell>
			<TableCell className="w-px py-2 text-right">
				{server.serverStatus === "active" && <ServerActions {...props} />}
			</TableCell>
		</TableRow>
	);
};

const Pagination = ({
	page,
	pageCount,
	total,
	pageSize,
	onPage,
	onPageSize,
}: {
	page: number;
	pageCount: number;
	total: number;
	pageSize: number;
	onPage: (page: number) => void;
	onPageSize: (size: (typeof PAGE_SIZES)[number]) => void;
}) => {
	const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
	const to = Math.min(total, page * pageSize);
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
			<span className="tabular-nums">
				{from}–{to} of {total}
			</span>
			<div className="flex items-center gap-2">
				<span className="hidden sm:inline">Per page</span>
				<Select
					value={String(pageSize)}
					onValueChange={(value) =>
						onPageSize(value as (typeof PAGE_SIZES)[number])
					}
				>
					<SelectTrigger className="h-8 w-18" aria-label="Servers per page">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{PAGE_SIZES.map((size) => (
							<SelectItem key={size} value={size}>
								{size}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					variant="outline"
					size="icon"
					className="size-8"
					aria-label="Previous page"
					disabled={page <= 1}
					onClick={() => onPage(page - 1)}
				>
					<ChevronLeft className="size-4" />
				</Button>
				<span className="min-w-16 text-center tabular-nums">
					{page} / {pageCount}
				</span>
				<Button
					variant="outline"
					size="icon"
					className="size-8"
					aria-label="Next page"
					disabled={page >= pageCount}
					onClick={() => onPage(page + 1)}
				>
					<ChevronRight className="size-4" />
				</Button>
			</div>
		</div>
	);
};

export const ShowServers = () => {
	const router = useRouter();
	const query = router.query;
	const { data, isPending } = api.server.all.useQuery();
	const { data: sshKeys } = api.sshKey.all.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { folders, folderByServer } = useServerFolders();
	const moveServers = useMoveServersToFolder();
	const { byServerId: costByServer, providerByServerId } = useServerCosts();

	const [view, setView] = useSortPreference("servers-view", "grid", VIEWS);
	const [pageSizePref, setPageSize] = useSortPreference(
		"servers-page-size",
		"12",
		PAGE_SIZES,
	);
	const pageSize = Number(pageSizePref);
	const [search, setSearch] = useState("");
	const [role, setRole] = useState<RoleFilter>("all");
	const [page, setPage] = useState(1);
	const [newFolderFor, setNewFolderFor] = useState<string | null>(null);

	const queryFolder =
		typeof query.folder === "string" ? query.folder : ALL_FOLDERS;
	const selectedFolder =
		queryFolder === ALL_FOLDERS ||
		queryFolder === UNFILED ||
		folders.some((f) => f.folderId === queryFolder)
			? queryFolder
			: ALL_FOLDERS;

	const setFolder = (value: string) => {
		const { folder: _current, ...rest } = router.query;
		router.replace(
			{
				pathname: router.pathname,
				query: value === ALL_FOLDERS ? rest : { ...rest, folder: value },
			},
			undefined,
			{ shallow: true },
		);
	};

	const folderById = useMemo(
		() => new Map(folders.map((f) => [f.folderId, f])),
		[folders],
	);

	const servers = data ?? [];
	const terms = search.toLowerCase().split(/\s+/).filter(Boolean);

	// Folder counts reflect search and role filters so the chips always describe what clicking them shows.
	const searched = servers.filter((server) => {
		const folderId = folderByServer.get(server.serverId);
		return (
			(role === "all" || server.serverRoles.includes(role)) &&
			matchesSearch(
				server,
				terms,
				folderId ? folderById.get(folderId)?.name : undefined,
			)
		);
	});

	const counts = {
		all: searched.length,
		unfiled: searched.filter((s) => !folderByServer.has(s.serverId)).length,
		byFolder: searched.reduce((map, server) => {
			const folderId = folderByServer.get(server.serverId);
			if (folderId) map.set(folderId, (map.get(folderId) ?? 0) + 1);
			return map;
		}, new Map<string, number>()),
	};

	const filtered = searched.filter((server) => {
		const folderId = folderByServer.get(server.serverId);
		if (selectedFolder === ALL_FOLDERS) return true;
		if (selectedFolder === UNFILED) return !folderId;
		return folderId === selectedFolder;
	});

	const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
	const currentPage = Math.min(page, pageCount);
	const visible = filtered.slice(
		(currentPage - 1) * pageSize,
		currentPage * pageSize,
	);

	useEffect(() => {
		setPage(1);
	}, [search, role, selectedFolder, pageSize]);

	const hasFilters = terms.length > 0 || role !== "all";
	const clearFilters = () => {
		setSearch("");
		setRole("all");
	};

	const canCreate = !!permissions?.server.create;

	const itemProps = (server: Server): ServerItemProps => {
		const folderId = folderByServer.get(server.serverId);
		return {
			server,
			isCloud: !!isCloud,
			permissions,
			folders,
			folder: folderId ? folderById.get(folderId) : undefined,
			showFolder: selectedFolder === ALL_FOLDERS,
			cost: costByServer.get(server.serverId),
			provider: providerByServerId.get(server.serverId),
			onNewFolder: setNewFolderFor,
		};
	};

	return (
		<div className="w-full">
			{query?.success && isCloud && <WelcomeSubscription />}
			<Card className="h-full p-2.5 rounded-xl max-w-6xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
						<div className="space-y-1.5">
							<CardTitle className="text-xl flex flex-row gap-2">
								<ServerIcon className="size-6 text-muted-foreground self-center" />
								Servers
							</CardTitle>
							<CardDescription>
								Add servers to deploy your applications remotely.
							</CardDescription>
							{isCloud && (
								<span
									className="bg-linear-to-r cursor-pointer from-blue-600 via-green-500 to-indigo-400 inline-block text-transparent bg-clip-text text-sm"
									onClick={() => {
										router.push("/dashboard/settings/servers?success=true");
									}}
								>
									Reset Onboarding
								</span>
							)}
						</div>
						{canCreate && servers.length > 0 && (
							<div className="flex flex-row flex-wrap gap-2">
								<ProvisionServer />
								<HandleServers />
							</div>
						)}
					</CardHeader>
					<CardContent className="space-y-4 py-6 border-t">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : sshKeys?.length === 0 && servers.length === 0 ? (
							<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
								<KeyIcon className="size-8" />
								<span className="text-base text-muted-foreground">
									No SSH Keys found. Add a SSH Key to start adding servers.{" "}
									<Link
										href="/dashboard/settings/ssh-keys"
										className="text-primary"
									>
										Add SSH Key
									</Link>
								</span>
								{canCreate && <ProvisionServer />}
							</div>
						) : servers.length === 0 ? (
							<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
								<ServerIcon className="size-8 self-center text-muted-foreground" />
								<span className="text-base text-muted-foreground">
									Start adding servers to deploy your applications remotely.
								</span>
								{canCreate && (
									<div className="flex flex-row gap-2">
										<ProvisionServer />
										<HandleServers />
									</div>
								)}
							</div>
						) : (
							<TooltipProvider>
								<div className="flex flex-wrap items-center gap-2">
									<InputGroup className="h-9 min-w-48 flex-1">
										<InputGroupAddon>
											<Search />
										</InputGroupAddon>
										<InputGroupInput
											value={search}
											onChange={(event) => setSearch(event.target.value)}
											placeholder="Search by name, IP, user or role"
											aria-label="Search servers"
										/>
										{search && (
											<InputGroupAddon align="inline-end">
												<InputGroupButton
													size="icon-xs"
													aria-label="Clear search"
													onClick={() => setSearch("")}
												>
													<X />
												</InputGroupButton>
											</InputGroupAddon>
										)}
									</InputGroup>
									<Select
										value={role}
										onValueChange={(value) => setRole(value as RoleFilter)}
									>
										<SelectTrigger
											className="h-9 w-36"
											aria-label="Filter by role"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">All roles</SelectItem>
											<SelectItem value="deploy">Deploy</SelectItem>
											<SelectItem value="build">Build</SelectItem>
											<SelectItem value="workflow">Workflow</SelectItem>
										</SelectContent>
									</Select>
									<fieldset
										className="flex h-9 items-center rounded-md border p-0.5"
										aria-label="View"
									>
										{VIEWS.map((option) => {
											const Icon = option === "grid" ? LayoutGrid : List;
											return (
												<IconAction
													key={option}
													label={option === "grid" ? "Tiles" : "List"}
												>
													<Button
														variant="ghost"
														size="icon"
														className={cn(
															"size-7",
															view === option && "bg-muted text-foreground",
														)}
														aria-pressed={view === option}
														aria-label={
															option === "grid" ? "Tile view" : "List view"
														}
														onClick={() => setView(option)}
													>
														<Icon className="size-4" />
													</Button>
												</IconAction>
											);
										})}
									</fieldset>
								</div>

								<ServerCostSummary />

								<ServerFolderBar
									folders={folders}
									counts={counts}
									selected={selectedFolder}
									onSelect={setFolder}
									canManage={canCreate}
								/>

								{filtered.length === 0 ? (
									<div className="flex min-h-[20vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
										{hasFilters ? (
											<>
												<Search className="size-6" />
												<p>No servers match your filters.</p>
												<Button
													variant="outline"
													size="sm"
													onClick={clearFilters}
												>
													Clear filters
												</Button>
											</>
										) : (
											<>
												<Folder className="size-6" />
												<p>
													This folder is empty. Use{" "}
													<span className="font-medium text-foreground">
														Move to folder
													</span>{" "}
													in a server's menu to add servers.
												</p>
											</>
										)}
									</div>
								) : view === "grid" ? (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
										{visible.map((server) => (
											<ServerTile
												key={server.serverId}
												{...itemProps(server)}
											/>
										))}
									</div>
								) : (
									<div className="rounded-lg border">
										<Table>
											<TableHeader>
												<TableRow>
													<TableHead>Name</TableHead>
													<TableHead className="hidden md:table-cell">
														Address
													</TableHead>
													<TableHead className="hidden lg:table-cell">
														Roles
													</TableHead>
													<TableHead>Storage</TableHead>
													<TableHead>
														<span className="sr-only">Actions</span>
													</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{visible.map((server) => (
													<ServerRow
														key={server.serverId}
														{...itemProps(server)}
													/>
												))}
											</TableBody>
										</Table>
									</div>
								)}

								{filtered.length > Number(PAGE_SIZES[0]) && (
									<Pagination
										page={currentPage}
										pageCount={pageCount}
										total={filtered.length}
										pageSize={pageSize}
										onPage={setPage}
										onPageSize={setPageSize}
									/>
								)}
							</TooltipProvider>
						)}
					</CardContent>
				</div>
			</Card>
			<FolderNameDialog
				open={newFolderFor !== null}
				onOpenChange={(open) => !open && setNewFolderFor(null)}
				onSaved={(folder) => {
					if (newFolderFor) {
						moveServers.mutate({
							serverIds: [newFolderFor],
							folderId: folder.folderId,
						});
					}
				}}
			/>
		</div>
	);
};
