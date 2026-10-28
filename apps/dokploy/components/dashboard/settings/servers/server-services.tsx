import { formatDistanceToNowStrict } from "date-fns";
import {
	AppWindow,
	Boxes,
	ChevronLeft,
	ChevronRight,
	Folder,
	Globe,
	Layers,
	Rocket,
	ScrollText,
	Search,
	X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DB_ENGINE_ICONS } from "@/components/icons/data-tools-icons";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
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
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { useHoverPopover } from "./use-hover-popover";

export type ServerService = RouterOutputs["server"]["servicesOverview"][number];
type ServiceType = ServerService["type"];
type ServiceStatus = ServerService["status"];

// Past this many services the hover card shows a summary and defers the full list to a dialog.
const FULL_LIST_MAX = 8;
const SUMMARY_ATTENTION_ROWS = 3;
const SUMMARY_PROJECT_ROWS = 5;
const DIALOG_PAGE_SIZE = 10;

const TYPE_LABEL: Record<ServiceType, string> = {
	application: "Application",
	compose: "Compose",
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
	libsql: "libSQL",
};

const STATUS_ORDER: Record<ServiceStatus, number> = {
	error: 0,
	stopped: 1,
	deploying: 2,
	running: 3,
};

const needsAttention = (service: ServerService) =>
	service.status === "error" || service.status === "stopped";

const byStatusThenName = (a: ServerService, b: ServerService) =>
	STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
	a.name.localeCompare(b.name);

const isDatabase = (type: ServiceType) =>
	type !== "application" && type !== "compose";

export const ServiceTypeIcon = ({
	type,
	className,
}: {
	type: ServiceType;
	className?: string;
}) => {
	if (type === "application") return <AppWindow className={className} />;
	if (type === "compose") return <Layers className={className} />;
	const Icon = DB_ENGINE_ICONS[type];
	return <Icon className={className} />;
};

const StatusLabel = ({ status }: { status: ServiceStatus }) => (
	<span
		className={cn(
			"inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap",
			status === "error" && "text-red-600 dark:text-red-400",
			status === "stopped" && "text-muted-foreground",
			status === "deploying" && "text-blue-600 dark:text-blue-400",
		)}
	>
		<span
			className={cn(
				"size-1.5 rounded-full",
				status === "running" && "bg-emerald-500",
				status === "error" && "bg-red-500",
				status === "stopped" && "bg-muted-foreground",
				status === "deploying" && "animate-pulse bg-blue-500",
			)}
		/>
		{status === "running"
			? "Running"
			: status === "error"
				? "Error"
				: status === "deploying"
					? "Deploying"
					: "Stopped"}
	</span>
);

const describe = (service: ServerService) => {
	const deployed = service.lastDeployedAt
		? formatDistanceToNowStrict(new Date(service.lastDeployedAt), {
				addSuffix: true,
			})
		: null;
	if (service.status === "error") {
		return deployed ? `Last deploy failed ${deployed}` : "Last deploy failed";
	}
	if (service.status === "stopped") return "Stopped";
	if (service.status === "deploying") return "Deploying now";
	return deployed ? `Deployed ${deployed}` : "Running";
};

const QuickAction = ({
	label,
	href,
	external,
	children,
}: {
	label: string;
	href: string;
	external?: boolean;
	children: React.ReactNode;
}) => (
	<Tooltip>
		<TooltipTrigger asChild>
			<Link
				href={href}
				aria-label={label}
				className="relative z-10 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				{...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
			>
				{children}
			</Link>
		</TooltipTrigger>
		<TooltipContent>{label}</TooltipContent>
	</Tooltip>
);

const QuickActions = ({
	service,
	className,
}: {
	service: ServerService;
	className?: string;
}) => (
	<span className={cn("flex shrink-0 items-center", className)}>
		{service.domain ? (
			<QuickAction
				label={`Open ${service.domain.replace(/^https?:\/\//, "")}`}
				href={service.domain}
				external
			>
				<Globe className="size-3.5" />
			</QuickAction>
		) : (
			<span className="size-7" aria-hidden />
		)}
		<QuickAction label="Logs" href={`${service.url}?tab=logs`}>
			<ScrollText className="size-3.5" />
		</QuickAction>
		{isDatabase(service.type) ? (
			<span className="size-7" aria-hidden />
		) : (
			<QuickAction label="Deployments" href={`${service.url}?tab=deployments`}>
				<Rocket className="size-3.5" />
			</QuickAction>
		)}
	</span>
);

/** A whole-row link with secondary actions layered above it, since links can't nest. */
const ServiceRow = ({
	service,
	meta,
}: {
	service: ServerService;
	meta?: string;
}) => (
	<div className="group/row relative -mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60 focus-within:bg-muted/60">
		<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
			<ServiceTypeIcon type={service.type} className="size-3.5" />
		</span>
		<span className="min-w-0 flex-1">
			<Link
				href={service.url}
				className="block truncate text-[13px] font-medium after:absolute after:inset-0 after:content-[''] group-hover/row:underline underline-offset-2 focus-visible:outline-none"
			>
				{service.name}
			</Link>
			<span className="block truncate text-xs text-muted-foreground">
				{meta ?? TYPE_LABEL[service.type]} · {describe(service)}
			</span>
		</span>
		<span className="group-hover/row:hidden group-focus-within/row:hidden">
			<StatusLabel status={service.status} />
		</span>
		<QuickActions
			service={service}
			className="hidden group-hover/row:flex group-focus-within/row:flex"
		/>
	</div>
);

const GroupLabel = ({
	children,
	count,
}: {
	children: React.ReactNode;
	count: number;
}) => (
	<div className="mt-3 mb-1 flex items-center justify-between text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
		<span className="truncate">{children}</span>
		<span className="tabular-nums">{count}</span>
	</div>
);

interface ProjectGroup {
	key: string;
	projectId: string;
	projectName: string;
	environmentName: string;
	services: ServerService[];
}

const groupByProject = (services: ServerService[]) => {
	const groups = new Map<string, ProjectGroup>();
	for (const service of services) {
		const key = `${service.projectId}:${service.environmentId}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				projectId: service.projectId,
				projectName: service.projectName,
				environmentName: service.environmentName,
				services: [],
			};
			groups.set(key, group);
		}
		group.services.push(service);
	}
	return [...groups.values()];
};

const countStatuses = (services: ServerService[]) => {
	const counts: Record<ServiceStatus, number> = {
		running: 0,
		deploying: 0,
		stopped: 0,
		error: 0,
	};
	for (const service of services) counts[service.status]++;
	return counts;
};

const StatusBar = ({
	counts,
	total,
}: {
	counts: Record<ServiceStatus, number>;
	total: number;
}) => (
	<div className="space-y-1.5">
		<div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
			{(
				[
					["running", "bg-emerald-500"],
					["deploying", "bg-blue-500"],
					["stopped", "bg-muted-foreground"],
					["error", "bg-red-500"],
				] as const
			).map(([status, color]) =>
				counts[status] > 0 ? (
					<div
						key={status}
						className={color}
						style={{ width: `${(counts[status] / total) * 100}%` }}
					/>
				) : null,
			)}
		</div>
		<div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
			<span>{counts.running} running</span>
			{counts.deploying > 0 && <span>{counts.deploying} deploying</span>}
			<span>{counts.stopped} stopped</span>
			<span
				className={cn(counts.error > 0 && "text-red-600 dark:text-red-400")}
			>
				{counts.error} error
			</span>
		</div>
	</div>
);

type DialogFilter = {
	status?: "attention";
	projectKey?: string;
};

const ServicesSummary = ({
	services,
	onViewAll,
}: {
	services: ServerService[];
	onViewAll: (filter?: DialogFilter) => void;
}) => {
	const counts = countStatuses(services);
	const attention = services.filter(needsAttention).sort(byStatusThenName);
	const groups = groupByProject(services).sort(
		(a, b) => b.services.length - a.services.length,
	);

	return (
		<>
			<StatusBar counts={counts} total={services.length} />
			{attention.length > 0 && (
				<div>
					<GroupLabel count={attention.length}>Needs attention</GroupLabel>
					{attention.slice(0, SUMMARY_ATTENTION_ROWS).map((service) => (
						<ServiceRow
							key={service.id}
							service={service}
							meta={service.projectName}
						/>
					))}
					{attention.length > SUMMARY_ATTENTION_ROWS && (
						<button
							type="button"
							className="-mx-2 w-[calc(100%+1rem)] rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
							onClick={() => onViewAll({ status: "attention" })}
						>
							+{attention.length - SUMMARY_ATTENTION_ROWS} more needing
							attention
						</button>
					)}
				</div>
			)}
			<div>
				<GroupLabel count={groups.length}>By project</GroupLabel>
				{groups.slice(0, SUMMARY_PROJECT_ROWS).map((group) => {
					const running = group.services.filter(
						(service) => service.status === "running",
					).length;
					const unhealthy = group.services.some(needsAttention);
					return (
						<button
							key={group.key}
							type="button"
							className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
							onClick={() => onViewAll({ projectKey: group.key })}
						>
							<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
								<Folder className="size-3.5" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] font-medium">
									{group.projectName}
								</span>
								<span className="block truncate text-xs text-muted-foreground">
									{group.environmentName}
								</span>
							</span>
							<span
								className={cn(
									"inline-flex items-center gap-1.5 text-xs tabular-nums",
									unhealthy
										? "text-amber-600 dark:text-amber-400"
										: "text-muted-foreground",
								)}
							>
								<span
									className={cn(
										"size-1.5 rounded-full",
										unhealthy ? "bg-amber-500" : "bg-emerald-500",
									)}
								/>
								{unhealthy
									? `${running}/${group.services.length}`
									: group.services.length}
							</span>
							<ChevronRight className="size-3.5 text-muted-foreground" />
						</button>
					);
				})}
				{groups.length > SUMMARY_PROJECT_ROWS && (
					<p className="pt-1 pl-8 text-xs text-muted-foreground">
						+{groups.length - SUMMARY_PROJECT_ROWS} more projects
					</p>
				)}
			</div>
			{/* Pinned so the way into the full list stays visible when the card has to scroll. */}
			<div className="sticky -bottom-4 -mx-4 mt-3 -mb-4 border-t bg-popover px-4 pt-3 pb-4">
				<Button
					variant="outline"
					size="sm"
					className="w-full"
					onClick={() => onViewAll()}
				>
					View all {services.length} services
					<ChevronRight className="size-3.5" />
				</Button>
			</div>
		</>
	);
};

const ServicesFullList = ({ services }: { services: ServerService[] }) => {
	const groups = groupByProject(services);
	return (
		<div>
			{groups.map((group) => (
				<div key={group.key}>
					<GroupLabel count={group.services.length}>
						{group.projectName} · {group.environmentName}
					</GroupLabel>
					{[...group.services].sort(byStatusThenName).map((service) => (
						<ServiceRow key={service.id} service={service} />
					))}
				</div>
			))}
		</div>
	);
};

const STATUS_TABS = [
	["all", "All"],
	["running", "Running"],
	["attention", "Needs attention"],
] as const;
const KIND_TABS = [
	["all", "All types"],
	["application", "Apps"],
	["compose", "Compose"],
	["database", "Databases"],
] as const;
type StatusTab = (typeof STATUS_TABS)[number][0];
type KindTab = (typeof KIND_TABS)[number][0];

const matchesKind = (service: ServerService, kind: KindTab) =>
	kind === "all" ||
	(kind === "database" ? isDatabase(service.type) : service.type === kind);

const matchesStatus = (service: ServerService, status: StatusTab) =>
	status === "all" ||
	(status === "attention"
		? needsAttention(service)
		: service.status === "running");

const Segmented = <T extends string>({
	options,
	value,
	onChange,
	counts,
	label,
}: {
	options: readonly (readonly [T, string])[];
	value: T;
	onChange: (value: T) => void;
	counts?: Record<T, number>;
	label: string;
}) => (
	<fieldset
		className="flex h-9 items-center gap-0.5 rounded-md border p-0.5"
		aria-label={label}
	>
		{options.map(([key, text]) => (
			<button
				key={key}
				type="button"
				aria-pressed={value === key}
				className={cn(
					"inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
					value === key && "bg-muted text-foreground",
				)}
				onClick={() => onChange(key)}
			>
				{text}
				{counts && (
					<span className="tabular-nums text-muted-foreground">
						{counts[key]}
					</span>
				)}
			</button>
		))}
	</fieldset>
);

const ServicesDialog = ({
	serverName,
	services,
	open,
	onOpenChange,
	initialFilter,
}: {
	serverName: string;
	services: ServerService[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialFilter: DialogFilter;
}) => {
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<StatusTab>(
		initialFilter.status ?? "all",
	);
	const [kind, setKind] = useState<KindTab>("all");
	const [projectKey, setProjectKey] = useState(initialFilter.projectKey);
	const [page, setPage] = useState(1);

	const groups = useMemo(() => groupByProject(services), [services]);
	const project = groups.find((group) => group.key === projectKey);
	const terms = search.toLowerCase().split(/\s+/).filter(Boolean);

	const base = services.filter((service) => {
		if (
			projectKey &&
			`${service.projectId}:${service.environmentId}` !== projectKey
		) {
			return false;
		}
		if (!matchesKind(service, kind)) return false;
		const haystack =
			`${service.name} ${service.appName} ${service.projectName} ${service.environmentName} ${service.domain ?? ""}`.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
	const statusCounts = {
		all: base.length,
		running: base.filter((service) => matchesStatus(service, "running")).length,
		attention: base.filter(needsAttention).length,
	};
	const rows = base
		.filter((service) => matchesStatus(service, status))
		.sort(byStatusThenName);
	const pageCount = Math.max(1, Math.ceil(rows.length / DIALOG_PAGE_SIZE));
	const currentPage = Math.min(page, pageCount);
	const visible = rows.slice(
		(currentPage - 1) * DIALOG_PAGE_SIZE,
		currentPage * DIALOG_PAGE_SIZE,
	);
	const counts = countStatuses(services);

	const resetPage =
		<T,>(set: (value: T) => void) =>
		(value: T) => {
			set(value);
			setPage(1);
		};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-4xl">
				<DialogHeader>
					<DialogTitle>Services on {serverName}</DialogTitle>
					<DialogDescription>
						{counts.running} of {services.length} running across {groups.length}{" "}
						{groups.length === 1 ? "project" : "projects"}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-wrap items-center gap-2">
					<InputGroup className="h-9 min-w-48 flex-1">
						<InputGroupAddon>
							<Search />
						</InputGroupAddon>
						<InputGroupInput
							value={search}
							onChange={(event) => resetPage(setSearch)(event.target.value)}
							placeholder="Search services, projects or domains"
							aria-label="Search services"
						/>
						{search && (
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									size="icon-xs"
									aria-label="Clear search"
									onClick={() => resetPage(setSearch)("")}
								>
									<X />
								</InputGroupButton>
							</InputGroupAddon>
						)}
					</InputGroup>
					<Segmented
						label="Filter by status"
						options={STATUS_TABS}
						value={status}
						onChange={resetPage(setStatus)}
						counts={statusCounts}
					/>
					<Segmented
						label="Filter by type"
						options={KIND_TABS}
						value={kind}
						onChange={resetPage(setKind)}
					/>
				</div>
				{project && (
					<div>
						<span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted pr-1 pl-2.5 text-xs">
							<Folder className="size-3" />
							{project.projectName} · {project.environmentName}
							<button
								type="button"
								className="grid size-4 place-items-center rounded-full hover:bg-background"
								aria-label="Clear project filter"
								onClick={() => resetPage(setProjectKey)(undefined)}
							>
								<X className="size-3" />
							</button>
						</span>
					</div>
				)}
				<div className="min-h-[29rem] overflow-x-auto rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden md:table-cell">Project</TableHead>
								<TableHead className="hidden sm:table-cell">Type</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="hidden lg:table-cell">
									Last change
								</TableHead>
								<TableHead>
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{visible.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={6}
										className="py-10 text-center text-sm text-muted-foreground"
									>
										No services match your filters.
									</TableCell>
								</TableRow>
							) : (
								visible.map((service) => (
									<TableRow key={service.id} className="group/row relative">
										<TableCell className="max-w-56 py-2">
											<div className="flex min-w-0 items-center gap-2">
												<ServiceTypeIcon
													type={service.type}
													className="size-4 shrink-0 text-muted-foreground"
												/>
												<div className="min-w-0">
													<Link
														href={service.url}
														className="block truncate font-medium after:absolute after:inset-0 after:content-[''] group-hover/row:underline underline-offset-2"
													>
														{service.name}
													</Link>
													{service.domain && (
														<p className="truncate font-mono text-xs text-muted-foreground">
															{service.domain.replace(/^https?:\/\//, "")}
														</p>
													)}
												</div>
											</div>
										</TableCell>
										<TableCell className="hidden py-2 text-muted-foreground md:table-cell">
											{service.projectName} · {service.environmentName}
										</TableCell>
										<TableCell className="hidden py-2 text-muted-foreground sm:table-cell">
											{TYPE_LABEL[service.type]}
										</TableCell>
										<TableCell className="py-2">
											<StatusLabel status={service.status} />
										</TableCell>
										<TableCell className="hidden py-2 text-muted-foreground lg:table-cell">
											{describe(service)}
										</TableCell>
										<TableCell className="w-px py-2">
											<QuickActions
												service={service}
												className="opacity-40 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100"
											/>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>
				<div className="flex items-center justify-between text-sm text-muted-foreground">
					<span className="tabular-nums">
						{rows.length === 0
							? "0 of 0"
							: `${(currentPage - 1) * DIALOG_PAGE_SIZE + 1}–${Math.min(rows.length, currentPage * DIALOG_PAGE_SIZE)} of ${rows.length}`}
					</span>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="icon"
							className="size-8"
							aria-label="Previous page"
							disabled={currentPage <= 1}
							onClick={() => setPage(currentPage - 1)}
						>
							<ChevronLeft className="size-4" />
						</Button>
						<span className="min-w-12 text-center tabular-nums">
							{currentPage} / {pageCount}
						</span>
						<Button
							variant="outline"
							size="icon"
							className="size-8"
							aria-label="Next page"
							disabled={currentPage >= pageCount}
							onClick={() => setPage(currentPage + 1)}
						>
							<ChevronRight className="size-4" />
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};

export const ServerServicesPill = ({
	serverName,
	serverRoles,
	services,
}: {
	serverName: string;
	serverRoles: string[];
	services: ServerService[];
}) => {
	const hover = useHoverPopover();
	const [dialog, setDialog] = useState<{ key: number; filter: DialogFilter }>();

	const counts = countStatuses(services);
	const total = services.length;
	const dot =
		counts.error > 0
			? "bg-red-500"
			: counts.stopped > 0
				? "bg-amber-500"
				: counts.deploying > 0
					? "bg-blue-500"
					: "bg-emerald-500";
	const label =
		counts.running === total
			? `${total} running`
			: `${counts.running}/${total} running`;

	const openDialog = (filter: DialogFilter = {}) => {
		hover.setOpen(false);
		// A fresh key resets the dialog's filters each time it's opened from a different entry point.
		setDialog({ key: Date.now(), filter });
	};

	return (
		<>
			<Popover open={hover.open} onOpenChange={hover.setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						{...hover.triggerProps}
						className={cn(
							badgeVariants({ variant: "outline" }),
							"h-5 cursor-pointer gap-1.5 px-1.5 text-[11px] hover:bg-muted/60 data-[state=open]:bg-muted/60",
						)}
						aria-label={
							total === 0
								? "No services on this server"
								: `${label}. Show services`
						}
					>
						{total === 0 ? (
							<>
								<span className="size-1.5 rounded-full bg-muted-foreground" />
								<span className="text-muted-foreground">No services</span>
							</>
						) : (
							<>
								<Boxes className="size-3" />
								<span className={cn("size-1.5 rounded-full", dot)} />
								<span className="tabular-nums">{label}</span>
							</>
						)}
					</button>
				</PopoverTrigger>
				<PopoverContent
					{...hover.contentProps}
					className="w-80 max-h-(--radix-popover-content-available-height) gap-0 overflow-y-auto"
					side="bottom"
					align="start"
					collisionPadding={16}
				>
					<div className="mb-3 flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<Boxes className="size-4 text-muted-foreground" />
							<span className="text-sm font-semibold">Services</span>
						</div>
						{total > 0 && (
							<span className="text-xs text-muted-foreground tabular-nums">
								{counts.running} of {total} running
							</span>
						)}
					</div>
					{total === 0 ? (
						<p className="text-xs text-muted-foreground">
							No applications, compose stacks or databases are deployed here.
							{!serverRoles.includes("deploy") &&
								` This server only runs ${serverRoles.join(" and ")} jobs.`}
						</p>
					) : total > FULL_LIST_MAX ? (
						<ServicesSummary services={services} onViewAll={openDialog} />
					) : (
						<ServicesFullList services={services} />
					)}
				</PopoverContent>
			</Popover>
			{dialog && (
				<ServicesDialog
					key={dialog.key}
					serverName={serverName}
					services={services}
					open
					onOpenChange={(open) => !open && setDialog(undefined)}
					initialFilter={dialog.filter}
				/>
			)}
		</>
	);
};
