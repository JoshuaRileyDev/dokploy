import { FileCode2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { ClearFiltersButton, FilterSelect, SearchInput } from "./list-toolbar";
import { RunWorkflowDialog } from "./run-workflow-dialog";
import { TablePagination } from "./table-pagination";
import { describeTrigger, eventLabel, SUPPORTED_EVENTS } from "./utils";
import { WorkflowJobsSheet } from "./workflow-jobs-sheet";

const PAGE_SIZES = [10, 25, 50];
const VISIBLE_TRIGGERS = 3;

const STATES = [
	{ value: "enabled", label: "Enabled" },
	{ value: "disabled", label: "Disabled" },
	{ value: "errors", label: "Has errors" },
] as const;
type State = (typeof STATES)[number]["value"];

const SOURCE_DIRECTORIES = {
	dokploy: ".dokploy/workflows",
	github: ".github/workflows",
} as const;

interface Props {
	workflowRepositoryId: string;
}

export const WorkflowDefinitionsTable = ({ workflowRepositoryId }: Props) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: repository } = api.workflow.oneRepository.useQuery({
		workflowRepositoryId,
	});
	const setEnabled = api.workflow.setDefinitionEnabled.useMutation();
	const [search, setSearch] = useState("");
	const [state, setState] = useState<State>();
	const [event, setEvent] = useState<string>();
	const [source, setSource] = useState<string>();
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(PAGE_SIZES[1]!);
	const canEdit = !!permissions?.workflow.create;
	const canRun = !!permissions?.workflow.run;

	// Workflows from a source that's turned off never run, so they'd only be noise here.
	const { visible, hiddenSources } = useMemo(() => {
		if (!repository) return { visible: [], hiddenSources: [] };
		const sourceOn = {
			dokploy: repository.runDokployWorkflows,
			github: repository.runGithubWorkflows,
		};
		return {
			visible: repository.definitions.filter(
				(definition) => sourceOn[definition.source],
			),
			hiddenSources: (["dokploy", "github"] as const).flatMap((key) => {
				const count = repository.definitions.filter(
					(definition) => definition.source === key,
				).length;
				return !sourceOn[key] && count > 0 ? [{ source: key, count }] : [];
			}),
		};
	}, [repository]);

	const events = useMemo(
		() =>
			[
				...new Set(
					visible.flatMap((definition) =>
						definition.triggers.map((trigger) => trigger.event),
					),
				),
			].sort(),
		[visible],
	);
	const showSource = new Set(visible.map((d) => d.source)).size > 1;

	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		return visible.filter((definition) => {
			if (source && definition.source !== source) return false;
			if (state === "enabled" && !definition.enabled) return false;
			if (state === "disabled" && definition.enabled) return false;
			if (state === "errors" && !definition.parseError) return false;
			if (event && !definition.triggers.some((t) => t.event === event)) {
				return false;
			}
			if (!query) return true;
			return [
				definition.name,
				definition.path,
				...definition.jobs.flatMap((job) => [job.id, job.name]),
			].some((value) => value.toLowerCase().includes(query));
		});
	}, [visible, search, state, event, source]);

	if (!repository) return null;

	const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
	const currentPage = Math.min(page, pageCount - 1);
	const rows = filtered.slice(
		currentPage * pageSize,
		(currentPage + 1) * pageSize,
	);
	const hasFilters = !!search.trim() || !!state || !!event || !!source;

	const clearFilters = () => {
		setSearch("");
		setState(undefined);
		setEvent(undefined);
		setSource(undefined);
		setPage(0);
	};

	const withPageReset =
		<T,>(setter: (value: T) => void) =>
		(value: T) => {
			setter(value);
			setPage(0);
		};

	const hiddenNote = hiddenSources.length > 0 && (
		<p className="text-xs text-muted-foreground">
			{hiddenSources
				.map(
					({ source: key, count }) =>
						`${count} ${count === 1 ? "workflow" : "workflows"} in ${SOURCE_DIRECTORIES[key]} ${count === 1 ? "is" : "are"} hidden`,
				)
				.join(" and ")}{" "}
			because running them is turned off in this repository's settings.
		</p>
	);

	if (visible.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
				<FileCode2 className="size-8 text-muted-foreground" />
				<span className="text-sm text-muted-foreground">
					{repository.definitions.length === 0
						? "No workflow files found in .dokploy/workflows or .github/workflows."
						: "No workflows to show."}
				</span>
				{hiddenNote}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<SearchInput
					value={search}
					onChange={withPageReset(setSearch)}
					placeholder="Search workflows by name, file or job"
				/>
				<FilterSelect
					value={state}
					onChange={withPageReset((value) => setState(value as State))}
					allLabel="Any state"
					options={[...STATES]}
				/>
				{events.length > 1 && (
					<FilterSelect
						value={event}
						onChange={withPageReset(setEvent)}
						allLabel="Any trigger"
						options={events.map((value) => ({
							value,
							label: eventLabel(value),
						}))}
					/>
				)}
				{showSource && (
					<FilterSelect
						value={source}
						onChange={withPageReset(setSource)}
						allLabel="All folders"
						className="w-48"
						options={Object.entries(SOURCE_DIRECTORIES).map(
							([value, label]) => ({ value, label }),
						)}
					/>
				)}
				{hasFilters && <ClearFiltersButton onClick={clearFilters} />}
			</div>
			{hiddenNote}

			{filtered.length === 0 ? (
				<p className="py-10 text-center text-sm text-muted-foreground">
					No workflows match these filters.
				</p>
			) : (
				<div className="rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Workflow</TableHead>
								<TableHead>Triggers</TableHead>
								<TableHead>Jobs</TableHead>
								<TableHead className="w-24 text-center">Enabled</TableHead>
								<TableHead className="w-24" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((definition) => {
								const runnable =
									canRun && definition.enabled && !definition.parseError;
								const enabledJobs = definition.jobs.filter(
									(job) => !definition.disabledJobs.includes(job.id),
								).length;
								const extraTriggers =
									definition.triggers.length - VISIBLE_TRIGGERS;
								return (
									<TableRow
										key={definition.workflowDefinitionId}
										className={cn(
											!definition.enabled && "text-muted-foreground",
										)}
									>
										<TableCell className="align-top">
											<div className="flex min-w-0 flex-col gap-1">
												<span className="flex items-center gap-2 font-medium">
													{definition.name}
													{showSource && (
														<Badge variant="outline" className="font-normal">
															.{definition.source}
														</Badge>
													)}
												</span>
												<span className="font-mono text-xs text-muted-foreground">
													{definition.path}
												</span>
												{definition.parseError && (
													<span className="text-xs text-destructive">
														{definition.parseError}
													</span>
												)}
											</div>
										</TableCell>
										<TableCell className="align-top">
											<div className="flex max-w-sm flex-wrap gap-1">
												{definition.triggers
													.slice(0, VISIBLE_TRIGGERS)
													.map((trigger) => (
														<Badge
															key={trigger.event}
															variant={
																SUPPORTED_EVENTS.has(trigger.event)
																	? "secondary"
																	: "outline"
															}
															title={
																SUPPORTED_EVENTS.has(trigger.event)
																	? describeTrigger(trigger)
																	: "Dokploy doesn't trigger on this event"
															}
															className="max-w-full truncate"
														>
															{describeTrigger(trigger)}
														</Badge>
													))}
												{extraTriggers > 0 && (
													<Badge
														variant="outline"
														className="font-normal"
														title={definition.triggers
															.slice(VISIBLE_TRIGGERS)
															.map(describeTrigger)
															.join("\n")}
													>
														+{extraTriggers}
													</Badge>
												)}
											</div>
										</TableCell>
										<TableCell className="align-top">
											{definition.jobs.length > 0 ? (
												<WorkflowJobsSheet
													workflowRepositoryId={workflowRepositoryId}
													defaultBranch={repository.defaultBranch}
													definition={definition}
													canEdit={canEdit}
													runnable={runnable}
												/>
											) : (
												<span className="text-sm text-muted-foreground">—</span>
											)}
										</TableCell>
										<TableCell className="align-top text-center">
											<Switch
												disabled={!canEdit}
												checked={definition.enabled}
												aria-label={`${definition.enabled ? "Disable" : "Enable"} ${definition.name}`}
												onCheckedChange={(enabled) =>
													setEnabled
														.mutateAsync({
															workflowDefinitionId:
																definition.workflowDefinitionId,
															enabled,
														})
														.catch((error) => toast.error(error.message))
														.finally(() =>
															utils.workflow.oneRepository.invalidate({
																workflowRepositoryId,
															}),
														)
												}
											/>
										</TableCell>
										<TableCell className="align-top text-right">
											{runnable && enabledJobs > 0 && (
												<RunWorkflowDialog
													workflowRepositoryId={workflowRepositoryId}
													defaultBranch={repository.defaultBranch}
													definition={definition}
												/>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			)}

			{filtered.length > PAGE_SIZES[0]! && (
				<TablePagination
					total={filtered.length}
					page={currentPage}
					pageSize={pageSize}
					pageSizes={PAGE_SIZES}
					noun={["workflow", "workflows"]}
					onPageChange={setPage}
					onPageSizeChange={withPageReset(setPageSize)}
				/>
			)}
		</div>
	);
};
