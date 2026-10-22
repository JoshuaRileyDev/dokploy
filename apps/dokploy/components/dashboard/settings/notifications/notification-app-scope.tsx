import {
	ArrowLeft,
	ChevronRight,
	CircuitBoard,
	Folder,
	FolderKanban,
	GlobeIcon,
	Home,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { getFolderPath } from "@/components/dashboard/projects/project-folders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

export type AppTarget = { type: "application" | "compose"; id: string };

export interface AppScopeValue {
	appScope: "all" | "selected";
	targets: AppTarget[];
}

interface Service extends AppTarget {
	name: string;
	projectId: string;
	environmentId: string;
	environmentName: string;
}

const targetKey = (target: AppTarget) => `${target.type}:${target.id}`;

const useServiceCatalog = (enabled: boolean) => {
	const { data: projects, isPending: projectsPending } =
		api.project.all.useQuery(undefined, { enabled });
	const { data: folderData, isPending: foldersPending } =
		api.projectFolder.all.useQuery(undefined, { enabled });

	return useMemo(() => {
		const services = new Map<string, Service>();
		for (const project of projects ?? []) {
			for (const environment of project.environments) {
				for (const app of environment.applications) {
					const service: Service = {
						type: "application",
						id: app.applicationId,
						name: app.name,
						projectId: project.projectId,
						environmentId: environment.environmentId,
						environmentName: environment.name,
					};
					services.set(targetKey(service), service);
				}
				for (const compose of environment.compose) {
					const service: Service = {
						type: "compose",
						id: compose.composeId,
						name: compose.name,
						projectId: project.projectId,
						environmentId: environment.environmentId,
						environmentName: environment.name,
					};
					services.set(targetKey(service), service);
				}
			}
		}
		return {
			projects: projects ?? [],
			folders: folderData?.folders ?? [],
			projectFolder: new Map(
				(folderData?.items ?? []).map((item) => [
					item.projectId,
					item.folderId,
				]),
			),
			services,
			isPending: projectsPending || foldersPending,
		};
	}, [projects, folderData, projectsPending, foldersPending]);
};

const ServiceIcon = ({ type }: { type: AppTarget["type"] }) =>
	type === "application" ? (
		<GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
	) : (
		<CircuitBoard className="size-4 shrink-0 text-muted-foreground" />
	);

interface ScopeProps {
	value: AppScopeValue;
	onChange: (value: AppScopeValue) => void;
	onBrowse: () => void;
	error?: string;
}

export const NotificationAppScope = ({
	value,
	onChange,
	onBrowse,
	error,
}: ScopeProps) => {
	const catalog = useServiceCatalog(value.targets.length > 0);
	const projectNames = new Map(
		catalog.projects.map((p) => [p.projectId, p.name]),
	);
	const shown = value.targets.slice(0, 6);

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3 shadow-xs">
			<div className="space-y-0.5">
				<Label>Applications</Label>
				<p className="text-sm text-muted-foreground">
					Choose which applications trigger App Deploy and App Build Error.
				</p>
			</div>
			<RadioGroup
				value={value.appScope}
				onValueChange={(appScope) => {
					const next = {
						...value,
						appScope: appScope as AppScopeValue["appScope"],
					};
					onChange(next);
					if (appScope === "selected" && value.targets.length === 0) {
						onBrowse();
					}
				}}
				className="grid grid-cols-1 sm:grid-cols-2 gap-3"
			>
				{(
					[
						["all", "All applications", "Every app and compose service."],
						["selected", "Specific applications", "Only the ones you pick."],
					] as const
				).map(([scope, title, description]) => (
					<Label
						key={scope}
						htmlFor={`app-scope-${scope}`}
						className="flex cursor-pointer items-start gap-3 rounded-md border-2 border-muted p-3 font-normal hover:bg-accent has-data-[state=checked]:border-primary"
					>
						<RadioGroupItem
							value={scope}
							id={`app-scope-${scope}`}
							className="mt-0.5"
						/>
						<span className="flex flex-col gap-1">
							<span className="font-medium">{title}</span>
							<span className="text-xs text-muted-foreground">
								{description}
							</span>
						</span>
					</Label>
				))}
			</RadioGroup>

			{value.appScope === "selected" && (
				<div className="flex flex-col gap-2">
					{value.targets.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{shown.map((target) => {
								const service = catalog.services.get(targetKey(target));
								return (
									<Badge
										key={targetKey(target)}
										variant="secondary"
										className="h-auto gap-1.5 py-1 pr-1"
									>
										<ServiceIcon type={target.type} />
										<span>
											{service
												? `${projectNames.get(service.projectId)} / ${service.name}`
												: "Loading..."}
										</span>
										<button
											type="button"
											aria-label="Remove"
											className="rounded-sm p-0.5 hover:bg-background"
											onClick={() =>
												onChange({
													...value,
													targets: value.targets.filter(
														(t) => targetKey(t) !== targetKey(target),
													),
												})
											}
										>
											<XIcon className="size-3" />
										</button>
									</Badge>
								);
							})}
							{value.targets.length > shown.length && (
								<Badge variant="outline" className="h-auto py-1">
									+{value.targets.length - shown.length} more
								</Badge>
							)}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							No applications selected yet.
						</p>
					)}
					<div>
						<Button type="button" variant="outline" onClick={onBrowse}>
							<FolderKanban className="size-4" />
							{value.targets.length > 0
								? "Edit selection"
								: "Choose applications"}
						</Button>
					</div>
					{error && (
						<p className="text-sm font-medium text-destructive">{error}</p>
					)}
				</div>
			)}
		</div>
	);
};

type Location =
	| { kind: "folder"; folderId: string | null }
	| { kind: "project"; projectId: string; folderId: string | null };

interface PickerProps {
	targets: AppTarget[];
	onChange: (targets: AppTarget[]) => void;
}

export const NotificationAppPicker = ({ targets, onChange }: PickerProps) => {
	const catalog = useServiceCatalog(true);
	const [location, setLocation] = useState<Location>({
		kind: "folder",
		folderId: null,
	});
	const [search, setSearch] = useState("");

	const selected = useMemo(() => new Set(targets.map(targetKey)), [targets]);

	const selectedPerProject = useMemo(() => {
		const counts = new Map<string, number>();
		for (const key of selected) {
			const service = catalog.services.get(key);
			if (!service) continue;
			counts.set(service.projectId, (counts.get(service.projectId) ?? 0) + 1);
		}
		return counts;
	}, [selected, catalog.services]);

	const selectedPerFolder = useMemo(() => {
		const counts = new Map<string, number>();
		for (const [projectId, count] of selectedPerProject) {
			const folderId = catalog.projectFolder.get(projectId) ?? null;
			for (const folder of getFolderPath(catalog.folders, folderId)) {
				counts.set(folder.folderId, (counts.get(folder.folderId) ?? 0) + count);
			}
		}
		return counts;
	}, [selectedPerProject, catalog.folders, catalog.projectFolder]);

	const setChecked = (services: AppTarget[], checked: boolean) => {
		const keys = new Set(services.map(targetKey));
		const rest = targets.filter((t) => !keys.has(targetKey(t)));
		onChange(
			checked
				? [...rest, ...services.map(({ type, id }) => ({ type, id }))]
				: rest,
		);
	};

	const currentFolderId = location.folderId;
	const breadcrumb = getFolderPath(catalog.folders, currentFolderId);
	const currentProject =
		location.kind === "project"
			? catalog.projects.find((p) => p.projectId === location.projectId)
			: undefined;

	const query = search.trim().toLowerCase();
	const searchResults = useMemo(() => {
		if (!query) return [];
		const projectNames = new Map(
			catalog.projects.map((p) => [p.projectId, p.name]),
		);
		return [...catalog.services.values()]
			.map((service) => ({
				service,
				path: [
					...getFolderPath(
						catalog.folders,
						catalog.projectFolder.get(service.projectId) ?? null,
					).map((f) => f.name),
					projectNames.get(service.projectId),
					service.environmentName,
				].join(" / "),
			}))
			.filter(
				({ service, path }) =>
					service.name.toLowerCase().includes(query) ||
					path.toLowerCase().includes(query),
			);
	}, [query, catalog]);

	const renderServiceRow = (service: Service, subtitle?: string) => {
		const checked = selected.has(targetKey(service));
		return (
			<Label
				key={targetKey(service)}
				className={cn(
					"flex cursor-pointer items-center gap-3 px-3 py-2 font-normal hover:bg-accent",
					checked && "bg-accent/50",
				)}
			>
				<Checkbox
					checked={checked}
					onCheckedChange={(state) => setChecked([service], state === true)}
				/>
				<ServiceIcon type={service.type} />
				<span className="flex min-w-0 flex-col">
					<span className="truncate">{service.name}</span>
					{subtitle && (
						<span className="truncate text-xs text-muted-foreground">
							{subtitle}
						</span>
					)}
				</span>
				<span className="ml-auto text-xs text-muted-foreground">
					{service.type === "application" ? "Application" : "Compose"}
				</span>
			</Label>
		);
	};

	const renderFolderLevel = () => {
		const subfolders = catalog.folders.filter(
			(f) => (f.parentFolderId ?? null) === currentFolderId,
		);
		const projects = catalog.projects.filter(
			(p) =>
				(catalog.projectFolder.get(p.projectId) ?? null) === currentFolderId,
		);
		if (subfolders.length === 0 && projects.length === 0) {
			return (
				<p className="p-3 text-sm text-muted-foreground">
					This folder is empty.
				</p>
			);
		}
		return (
			<>
				{subfolders.map((folder) => (
					<NavRow
						key={folder.folderId}
						icon={<Folder className="size-4 text-muted-foreground" />}
						label={folder.name}
						count={selectedPerFolder.get(folder.folderId)}
						onClick={() =>
							setLocation({ kind: "folder", folderId: folder.folderId })
						}
					/>
				))}
				{projects.map((project) => (
					<NavRow
						key={project.projectId}
						icon={<FolderKanban className="size-4 text-muted-foreground" />}
						label={project.name}
						count={selectedPerProject.get(project.projectId)}
						onClick={() =>
							setLocation({
								kind: "project",
								projectId: project.projectId,
								folderId: currentFolderId,
							})
						}
					/>
				))}
			</>
		);
	};

	const renderProjectLevel = () => {
		if (!currentProject) return null;
		const environments = currentProject.environments
			.map((environment) => ({
				environment,
				services: [...catalog.services.values()].filter(
					(s) =>
						s.projectId === currentProject.projectId &&
						s.environmentId === environment.environmentId,
				),
			}))
			.filter(({ services }) => services.length > 0);
		if (environments.length === 0) {
			return (
				<p className="p-3 text-sm text-muted-foreground">
					This project has no applications.
				</p>
			);
		}
		return environments.map(({ environment, services }) => {
			const checkedCount = services.filter((s) =>
				selected.has(targetKey(s)),
			).length;
			const allChecked = checkedCount === services.length;
			return (
				<div
					key={environment.environmentId}
					className="border-b last:border-b-0"
				>
					<Label className="sticky top-0 z-10 flex cursor-pointer items-center gap-3 bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
						<Checkbox
							checked={
								allChecked ? true : checkedCount > 0 ? "indeterminate" : false
							}
							onCheckedChange={() => setChecked(services, !allChecked)}
						/>
						{environment.name}
						<span className="ml-auto font-normal">
							{checkedCount}/{services.length}
						</span>
					</Label>
					{services.map((service) => renderServiceRow(service))}
				</div>
			);
		});
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="relative">
				<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search all applications"
					className="pl-8"
				/>
			</div>

			{!query && (
				<nav className="flex min-h-8 flex-wrap items-center gap-1 text-sm">
					{location.kind === "project" && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="Back"
							onClick={() =>
								setLocation({ kind: "folder", folderId: location.folderId })
							}
						>
							<ArrowLeft className="size-4" />
						</Button>
					)}
					<CrumbButton
						onClick={() => setLocation({ kind: "folder", folderId: null })}
						active={location.kind === "folder" && currentFolderId === null}
					>
						<Home className="size-4" />
						Projects
					</CrumbButton>
					{breadcrumb.map((folder, i) => (
						<span key={folder.folderId} className="flex items-center gap-1">
							<ChevronRight className="size-4 text-muted-foreground" />
							<CrumbButton
								onClick={() =>
									setLocation({ kind: "folder", folderId: folder.folderId })
								}
								active={
									location.kind === "folder" && i === breadcrumb.length - 1
								}
							>
								<Folder className="size-4" />
								{folder.name}
							</CrumbButton>
						</span>
					))}
					{currentProject && (
						<span className="flex items-center gap-1">
							<ChevronRight className="size-4 text-muted-foreground" />
							<CrumbButton active>
								<FolderKanban className="size-4" />
								{currentProject.name}
							</CrumbButton>
						</span>
					)}
				</nav>
			)}

			<div className="h-80 overflow-y-auto rounded-md border">
				{catalog.isPending ? (
					<p className="p-3 text-sm text-muted-foreground">Loading...</p>
				) : query ? (
					searchResults.length === 0 ? (
						<p className="p-3 text-sm text-muted-foreground">
							No matching applications.
						</p>
					) : (
						searchResults.map(({ service, path }) =>
							renderServiceRow(service, path),
						)
					)
				) : location.kind === "folder" ? (
					renderFolderLevel()
				) : (
					renderProjectLevel()
				)}
			</div>

			<p className="text-sm text-muted-foreground">{targets.length} selected</p>
		</div>
	);
};

const NavRow = ({
	icon,
	label,
	count,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	count?: number;
	onClick: () => void;
}) => (
	<button
		type="button"
		onClick={onClick}
		className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-accent"
	>
		{icon}
		<span className="truncate">{label}</span>
		{!!count && (
			<Badge variant="blue" className="ml-auto">
				{count} selected
			</Badge>
		)}
		<ChevronRight
			className={cn("size-4 text-muted-foreground", !count && "ml-auto")}
		/>
	</button>
);

const CrumbButton = ({
	children,
	onClick,
	active,
}: {
	children: ReactNode;
	onClick?: () => void;
	active?: boolean;
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={!onClick}
		className={cn(
			"flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:hover:bg-transparent",
			active && "text-foreground font-medium",
		)}
	>
		{children}
	</button>
);
