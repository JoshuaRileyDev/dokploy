import type { WorkflowRunStatus } from "@dokploy/server/db/schema";
import {
	Archive,
	ArchiveRestore,
	CircleDashed,
	GitBranch,
	Loader2,
	MoreHorizontal,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateTooltip } from "@/components/shared/date-tooltip";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";
import { useDebounce } from "@/utils/hooks/use-debounce";
import { ClearFiltersButton, FilterSelect, SearchInput } from "./list-toolbar";
import { formatDuration, isFinished, StatusIcon, statusLabel } from "./status";
import { TablePagination } from "./table-pagination";
import { eventLabel } from "./utils";

const STATUSES: WorkflowRunStatus[] = [
	"queued",
	"in_progress",
	"success",
	"failure",
	"cancelled",
	"skipped",
];

const PAGE_SIZES = [20, 50, 100];

type Filters = {
	status?: WorkflowRunStatus;
	workflowPath?: string;
	event?: string;
	branch?: string;
};

interface Props {
	workflowRepositoryId?: string;
}

export const ShowWorkflowRuns = ({ workflowRepositoryId }: Props) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebounce(search.trim(), 300);
	const [filters, setFilters] = useState<Filters>({});
	const [archived, setArchived] = useState(false);
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(PAGE_SIZES[0]!);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);

	const { data: options } = api.workflow.runFilterOptions.useQuery({
		workflowRepositoryId,
	});
	const { data, isPending, isPlaceholderData } =
		api.workflow.searchRuns.useQuery(
			{
				workflowRepositoryId,
				search: debouncedSearch || undefined,
				...filters,
				archived,
				limit: pageSize,
				offset: page * pageSize,
			},
			{ refetchInterval: 5000, placeholderData: (previous) => previous },
		);
	const setRunsArchived = api.workflow.setRunsArchived.useMutation();
	const removeRuns = api.workflow.removeRuns.useMutation();

	const canArchive = !!permissions?.workflow.run;
	const canDelete = !!permissions?.workflow.delete;
	const canSelect = canArchive || canDelete;
	const runs = data?.runs ?? [];
	const total = data?.total ?? 0;
	const selectable = runs.filter((run) => isFinished(run.status));
	const hasFilters =
		!!debouncedSearch || Object.values(filters).some((value) => value);

	useEffect(() => {
		setPage(0);
	}, [debouncedSearch]);

	// Deleting or archiving the last rows on the final page would otherwise leave an empty page.
	useEffect(() => {
		if (page > 0 && data && page * pageSize >= data.total) {
			setPage(Math.max(0, Math.ceil(data.total / pageSize) - 1));
		}
	}, [data, page, pageSize]);

	const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
		setFilters((current) => ({ ...current, [key]: value }));
		setPage(0);
	};

	const clearFilters = () => {
		setSearch("");
		setFilters({});
		setPage(0);
	};

	const refresh = () =>
		Promise.all([
			utils.workflow.searchRuns.invalidate(),
			utils.workflow.runs.invalidate(),
			utils.workflow.runFilterOptions.invalidate(),
		]);

	const archive = (workflowRunIds: string[], value: boolean) =>
		setRunsArchived
			.mutateAsync({ workflowRunIds, archived: value })
			.then(({ updated }) => {
				toast.success(
					`${value ? "Archived" : "Restored"} ${updated} ${updated === 1 ? "run" : "runs"}`,
				);
				setSelected(new Set());
			})
			.catch((error) => toast.error(error.message))
			.finally(refresh);

	const remove = (workflowRunIds: string[]) =>
		removeRuns
			.mutateAsync({ workflowRunIds })
			.then(({ removed }) => {
				toast.success(`Deleted ${removed} ${removed === 1 ? "run" : "runs"}`);
				setSelected(new Set());
				setConfirmDelete(null);
			})
			.catch((error) => toast.error(error.message))
			.finally(refresh);

	const toggle = (workflowRunId: string, checked: boolean) =>
		setSelected((current) => {
			const next = new Set(current);
			if (checked) next.add(workflowRunId);
			else next.delete(workflowRunId);
			return next;
		});

	// Only rows still on screen count, so paging or filtering drops the rest of the selection.
	const selectedIds = selectable
		.filter((run) => selected.has(run.workflowRunId))
		.map((run) => run.workflowRunId);
	const allSelected =
		selectable.length > 0 && selectedIds.length === selectable.length;
	const someSelected = !allSelected && selectedIds.length > 0;
	const deleteCount = confirmDelete?.length ?? 0;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<SearchInput
					value={search}
					onChange={setSearch}
					placeholder={
						workflowRepositoryId
							? "Search by workflow, title, branch, commit or #number"
							: "Search by repository, workflow, title, branch or commit"
					}
				/>
				<Tabs
					value={archived ? "archived" : "active"}
					onValueChange={(value) => {
						setArchived(value === "archived");
						setPage(0);
					}}
				>
					<TabsList>
						<TabsTrigger value="active">Active</TabsTrigger>
						<TabsTrigger value="archived">
							<Archive />
							Archived
						</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<FilterSelect
					value={filters.status}
					onChange={(value) =>
						updateFilter("status", value as WorkflowRunStatus | undefined)
					}
					allLabel="All statuses"
					options={STATUSES.map((status) => ({
						value: status,
						label: statusLabel(status),
					}))}
				/>
				{!!options?.workflows.length && (
					<FilterSelect
						value={filters.workflowPath}
						onChange={(value) => updateFilter("workflowPath", value)}
						allLabel="All workflows"
						className="w-48"
						options={options.workflows.map((workflow) => ({
							value: workflow.workflowPath,
							label: workflow.workflowName,
						}))}
					/>
				)}
				{!!options?.branches.length && (
					<FilterSelect
						value={filters.branch}
						onChange={(value) => updateFilter("branch", value)}
						allLabel="All branches"
						options={options.branches.map((branch) => ({
							value: branch,
							label: branch,
						}))}
					/>
				)}
				{!!options?.events.length && (
					<FilterSelect
						value={filters.event}
						onChange={(value) => updateFilter("event", value)}
						allLabel="All events"
						options={options.events.map((event) => ({
							value: event,
							label: eventLabel(event),
						}))}
					/>
				)}
				{hasFilters && <ClearFiltersButton onClick={clearFilters} />}
			</div>

			{selectedIds.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
					<span className="font-medium">
						{selectedIds.length} {selectedIds.length === 1 ? "run" : "runs"}{" "}
						selected
					</span>
					<div className="ml-auto flex gap-2">
						{canArchive && (
							<Button
								variant="outline"
								size="sm"
								isLoading={setRunsArchived.isPending}
								onClick={() => archive(selectedIds, !archived)}
							>
								{archived ? (
									<ArchiveRestore className="size-4" />
								) : (
									<Archive className="size-4" />
								)}
								{archived ? "Restore" : "Archive"}
							</Button>
						)}
						{canDelete && (
							<Button
								variant="destructive"
								size="sm"
								onClick={() => setConfirmDelete(selectedIds)}
							>
								<Trash2 className="size-4" />
								Delete
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setSelected(new Set())}
						>
							Clear
						</Button>
					</div>
				</div>
			)}

			{isPending ? (
				<div className="flex min-h-[25vh] items-center justify-center gap-2 text-sm text-muted-foreground">
					<span>Loading...</span>
					<Loader2 className="size-4 animate-spin" />
				</div>
			) : runs.length === 0 ? (
				<div className="flex min-h-[25vh] flex-col items-center justify-center gap-2 text-center">
					<CircleDashed className="size-8 text-muted-foreground" />
					{hasFilters ? (
						<span className="text-base text-muted-foreground">
							No runs match these filters.
						</span>
					) : archived ? (
						<span className="text-base text-muted-foreground">
							No archived runs.
						</span>
					) : (
						<>
							<span className="text-base text-muted-foreground">
								No runs yet.
							</span>
							<span className="max-w-md text-sm text-muted-foreground">
								Runs start when a matching push, pull request, release or tag
								arrives from GitHub, or when you run a workflow manually.
							</span>
						</>
					)}
				</div>
			) : (
				<div className="rounded-md border">
					<Table className={isPlaceholderData ? "opacity-60" : undefined}>
						<TableHeader>
							<TableRow>
								{canSelect && (
									<TableHead className="w-10">
										<Checkbox
											aria-label="Select all finished runs on this page"
											disabled={selectable.length === 0}
											checked={
												allSelected
													? true
													: someSelected
														? "indeterminate"
														: false
											}
											onCheckedChange={(checked) =>
												setSelected(
													checked
														? new Set(
																selectable.map((run) => run.workflowRunId),
															)
														: new Set(),
												)
											}
										/>
									</TableHead>
								)}
								<TableHead>Run</TableHead>
								{!workflowRepositoryId && <TableHead>Repository</TableHead>}
								<TableHead>Trigger</TableHead>
								<TableHead>Duration</TableHead>
								<TableHead>Started</TableHead>
								{canSelect && <TableHead className="w-10" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{runs.map((run) => {
								const finished = isFinished(run.status);
								return (
									<TableRow
										key={run.workflowRunId}
										data-state={
											selected.has(run.workflowRunId) ? "selected" : undefined
										}
									>
										{canSelect && (
											<TableCell>
												<Checkbox
													aria-label={`Select ${run.workflowName} #${run.runNumber}`}
													disabled={!finished}
													title={
														finished
															? undefined
															: "Runs can be archived or deleted once they finish"
													}
													checked={selected.has(run.workflowRunId)}
													onCheckedChange={(checked) =>
														toggle(run.workflowRunId, checked === true)
													}
												/>
											</TableCell>
										)}
										<TableCell>
											<Link
												href={`/dashboard/workflows/runs/${run.workflowRunId}`}
												className="group flex items-start gap-2"
											>
												<StatusIcon status={run.status} className="mt-0.5" />
												<span className="flex min-w-0 flex-col">
													<span className="font-medium group-hover:underline">
														{run.workflowName} #{run.runNumber}
														{run.attempt > 1 && (
															<span className="text-muted-foreground">
																{" "}
																(attempt {run.attempt})
															</span>
														)}
													</span>
													<span className="max-w-md truncate text-sm text-muted-foreground">
														{run.title}
													</span>
												</span>
											</Link>
										</TableCell>
										{!workflowRepositoryId && (
											<TableCell>
												<Link
													href={`/dashboard/workflows/repositories/${run.workflowRepositoryId}`}
													className="text-sm hover:underline"
												>
													{run.owner}/{run.repository}
												</Link>
											</TableCell>
										)}
										<TableCell>
											<div className="flex flex-col gap-1 text-sm">
												<span>{eventLabel(run.event, run.eventAction)}</span>
												<span className="flex items-center gap-1.5 text-muted-foreground">
													{run.branch && (
														<Badge
															variant="outline"
															className="gap-1 font-normal"
														>
															<GitBranch className="size-3" />
															{run.branch}
														</Badge>
													)}
													<span className="font-mono text-xs">
														{run.sha.slice(0, 7)}
													</span>
												</span>
											</div>
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{formatDuration(run.startedAt, run.finishedAt)}
										</TableCell>
										<TableCell>
											<DateTooltip date={run.createdAt} />
										</TableCell>
										{canSelect && (
											<TableCell className="text-right">
												{finished && (
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<Button
																variant="ghost"
																size="icon"
																className="size-8"
																title="Run actions"
															>
																<MoreHorizontal className="size-4" />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															{canArchive && (
																<DropdownMenuItem
																	onSelect={() =>
																		archive(
																			[run.workflowRunId],
																			!run.archivedAt,
																		)
																	}
																>
																	{run.archivedAt ? (
																		<ArchiveRestore />
																	) : (
																		<Archive />
																	)}
																	{run.archivedAt ? "Restore" : "Archive"}
																</DropdownMenuItem>
															)}
															{canArchive && canDelete && (
																<DropdownMenuSeparator />
															)}
															{canDelete && (
																<DropdownMenuItem
																	variant="destructive"
																	onSelect={() =>
																		setConfirmDelete([run.workflowRunId])
																	}
																>
																	<Trash2 />
																	Delete
																</DropdownMenuItem>
															)}
														</DropdownMenuContent>
													</DropdownMenu>
												)}
											</TableCell>
										)}
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			)}

			{!isPending && total > 0 && (
				<TablePagination
					total={total}
					page={page}
					pageSize={pageSize}
					pageSizes={PAGE_SIZES}
					noun={["run", "runs"]}
					onPageChange={setPage}
					onPageSizeChange={(size) => {
						setPageSize(size);
						setPage(0);
					}}
				/>
			)}

			<AlertDialog
				open={confirmDelete !== null}
				onOpenChange={(open) => !open && setConfirmDelete(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{deleteCount === 1
								? "Delete this run?"
								: `Delete ${deleteCount} runs?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteCount === 1
								? "The run, its jobs and its logs are removed permanently. Archive it instead to hide it but keep the history."
								: "The runs, their jobs and their logs are removed permanently. Archive them instead to hide them but keep the history."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={removeRuns.isPending}
							onClick={(event) => {
								event.preventDefault();
								if (confirmDelete) remove(confirmDelete);
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
};
