import copy from "copy-to-clipboard";
import {
	Check,
	Copy,
	KeyRound,
	Loader2,
	Pencil,
	PlusIcon,
	Server,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export const RUNNER_PACKAGE = "@joshuarileydev/dokploy-runner";

const CopyableCommand = ({ command }: { command: string }) => {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-start gap-2 rounded-md border bg-muted/50 p-2">
			<code className="flex-1 break-all font-mono text-xs">{command}</code>
			<Button
				variant="ghost"
				size="icon"
				className="size-6 shrink-0"
				onClick={() => {
					copy(command);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				}}
			>
				{copied ? (
					<Check className="size-3.5" />
				) : (
					<Copy className="size-3.5" />
				)}
			</Button>
		</div>
	);
};

const RegistrationInstructions = ({ token }: { token: string }) => {
	const url = typeof window === "undefined" ? "" : window.location.origin;
	return (
		<div className="flex flex-col gap-3">
			<AlertBlock type="warning">
				Copy this now: the registration token is only shown once and expires in
				an hour. Generate a new one from the runner list if you lose it.
			</AlertBlock>
			<div className="space-y-1.5">
				<p className="text-sm font-medium">1. Install the runner (needs act)</p>
				<CopyableCommand command={`npm install -g ${RUNNER_PACKAGE}`} />
				<CopyableCommand command="brew install act" />
			</div>
			<div className="space-y-1.5">
				<p className="text-sm font-medium">2. Register this machine</p>
				<CopyableCommand
					command={`dokploy-runner register --url ${url} --token ${token}`}
				/>
			</div>
			<div className="space-y-1.5">
				<p className="text-sm font-medium">3. Start it</p>
				<CopyableCommand command="dokploy-runner start" />
				<p className="text-xs text-muted-foreground">
					On macOS, <code>dokploy-runner install-service</code> keeps it running
					in the background and after reboots.
				</p>
			</div>
		</div>
	);
};

type RunnerFormValues = {
	name: string;
	labels: string;
	allowedRepositoryIds: string[];
};

const RunnerForm = ({
	values,
	onChange,
}: {
	values: RunnerFormValues;
	onChange: (values: RunnerFormValues) => void;
}) => {
	const { data: repositories } = api.workflow.allRepositories.useQuery();
	return (
		<div className="grid gap-4">
			<div className="space-y-2">
				<Label htmlFor="runner-name">Name</Label>
				<Input
					id="runner-name"
					placeholder="Office Mac mini"
					value={values.name}
					onChange={(e) => onChange({ ...values, name: e.target.value })}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="runner-labels">Labels</Label>
				<Input
					id="runner-labels"
					placeholder="macos-latest, macos-15"
					value={values.labels}
					onChange={(e) => onChange({ ...values, labels: e.target.value })}
				/>
				<p className="text-sm text-muted-foreground">
					Comma-separated. Runs whose jobs use one of these in{" "}
					<code>runs-on</code> go to this runner instead of a workflow server.
					macOS labels run directly on the machine.
				</p>
			</div>
			<div className="space-y-2">
				<Label>Repositories</Label>
				<p className="text-sm text-muted-foreground">
					Leave all unchecked to allow every repository.
				</p>
				<div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border p-2">
					{repositories?.length ? (
						repositories.map((repository) => {
							const id = repository.workflowRepositoryId;
							return (
								<label
									key={id}
									htmlFor={`runner-repo-${id}`}
									className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted"
								>
									<Checkbox
										id={`runner-repo-${id}`}
										checked={values.allowedRepositoryIds.includes(id)}
										onCheckedChange={(checked) =>
											onChange({
												...values,
												allowedRepositoryIds: checked
													? [...values.allowedRepositoryIds, id]
													: values.allowedRepositoryIds.filter((r) => r !== id),
											})
										}
									/>
									{repository.owner}/{repository.repository}
								</label>
							);
						})
					) : (
						<span className="text-sm text-muted-foreground">
							No repositories imported yet.
						</span>
					)}
				</div>
			</div>
		</div>
	);
};

const parseLabels = (labels: string) =>
	labels
		.split(",")
		.map((label) => label.trim())
		.filter(Boolean);

const AddRunner = () => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [token, setToken] = useState<string | null>(null);
	const [values, setValues] = useState<RunnerFormValues>({
		name: "",
		labels: "macos-latest",
		allowedRepositoryIds: [],
	});
	const create = api.workflow.createRunner.useMutation();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setToken(null);
					setValues({
						name: "",
						labels: "macos-latest",
						allowedRepositoryIds: [],
					});
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline">
					<PlusIcon className="size-4" />
					Add Runner
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{token ? "Connect your runner" : "Add runner"}
					</DialogTitle>
					<DialogDescription>
						A runner is a machine you own, such as a Mac for iOS builds, that
						polls Dokploy for runs. Dokploy never connects to it, so it works
						behind NAT.
					</DialogDescription>
				</DialogHeader>
				{token ? (
					<RegistrationInstructions token={token} />
				) : (
					<RunnerForm values={values} onChange={setValues} />
				)}
				<DialogFooter>
					{token ? (
						<Button onClick={() => setOpen(false)}>Done</Button>
					) : (
						<Button
							disabled={!values.name || parseLabels(values.labels).length === 0}
							isLoading={create.isPending}
							onClick={() =>
								create
									.mutateAsync({
										name: values.name,
										labels: parseLabels(values.labels),
										allowedRepositoryIds: values.allowedRepositoryIds,
									})
									.then((created) => {
										setToken(created.registrationToken);
										return utils.workflow.runners.invalidate();
									})
									.catch((error) => toast.error(error.message))
							}
						>
							Create
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const EditRunner = ({
	runner,
}: {
	runner: {
		workflowRunnerId: string;
		name: string;
		labels: string[];
		allowedRepositoryIds: string[];
	};
}) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<RunnerFormValues>({
		name: runner.name,
		labels: runner.labels.join(", "),
		allowedRepositoryIds: runner.allowedRepositoryIds,
	});
	const update = api.workflow.updateRunner.useMutation();
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					setValues({
						name: runner.name,
						labels: runner.labels.join(", "),
						allowedRepositoryIds: runner.allowedRepositoryIds,
					});
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="ghost" size="icon" title="Edit runner">
					<Pencil className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Edit {runner.name}</DialogTitle>
				</DialogHeader>
				<RunnerForm values={values} onChange={setValues} />
				<DialogFooter>
					<Button
						disabled={!values.name || parseLabels(values.labels).length === 0}
						isLoading={update.isPending}
						onClick={() =>
							update
								.mutateAsync({
									workflowRunnerId: runner.workflowRunnerId,
									name: values.name,
									labels: parseLabels(values.labels),
									allowedRepositoryIds: values.allowedRepositoryIds,
								})
								.then(() => {
									toast.success("Runner updated");
									setOpen(false);
									return utils.workflow.runners.invalidate();
								})
								.catch((error) => toast.error(error.message))
						}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const RegenerateToken = ({
	workflowRunnerId,
}: {
	workflowRunnerId: string;
}) => {
	const [token, setToken] = useState<string | null>(null);
	const regenerate = api.workflow.regenerateRunnerToken.useMutation();
	return (
		<Dialog open={!!token} onOpenChange={(next) => !next && setToken(null)}>
			<Button
				variant="ghost"
				size="icon"
				title="New registration token"
				isLoading={regenerate.isPending}
				onClick={() =>
					regenerate
						.mutateAsync({ workflowRunnerId })
						.then((result) => setToken(result.registrationToken))
						.catch((error) => toast.error(error.message))
				}
			>
				<KeyRound className="size-4" />
			</Button>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>New registration token</DialogTitle>
					<DialogDescription>
						Registering with this token replaces the runner's current
						credential, so the old machine stops working.
					</DialogDescription>
				</DialogHeader>
				{token && <RegistrationInstructions token={token} />}
			</DialogContent>
		</Dialog>
	);
};

export const ShowWorkflowRunners = () => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: runners, isPending } = api.workflow.runners.useQuery(
		undefined,
		{ refetchInterval: 10_000 },
	);
	const remove = api.workflow.removeRunner.useMutation();
	const canEdit = !!permissions?.workflow.create;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">
					Machines you host yourself, such as a Mac for iOS and macOS builds.
					They poll Dokploy for runs that match their labels.
				</p>
				{canEdit && <AddRunner />}
			</div>
			{isPending ? (
				<div className="flex min-h-[20vh] items-center justify-center">
					<Loader2 className="size-5 animate-spin text-muted-foreground" />
				</div>
			) : !runners?.length ? (
				<div className="flex min-h-[20vh] flex-col items-center justify-center gap-2 text-center">
					<Server className="size-8 text-muted-foreground" />
					<span className="text-base text-muted-foreground">
						No runners yet.
					</span>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Runner</TableHead>
							<TableHead>Labels</TableHead>
							<TableHead>Machine</TableHead>
							<TableHead>Activity</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{runners.map((runner) => (
							<TableRow key={runner.workflowRunnerId}>
								<TableCell>
									<div className="flex items-center gap-2">
										<span
											className={cn(
												"size-2 rounded-full",
												runner.online
													? "bg-green-500"
													: "bg-muted-foreground/40",
											)}
										/>
										<span className="font-medium">{runner.name}</span>
									</div>
									<span className="text-xs text-muted-foreground">
										{!runner.registered
											? "Waiting for registration"
											: runner.online
												? "Online"
												: "Offline"}
									</span>
								</TableCell>
								<TableCell>
									<div className="flex flex-wrap gap-1">
										{runner.labels.map((label) => (
											<Badge key={label} variant="secondary">
												{label}
											</Badge>
										))}
									</div>
								</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{runner.os
										? `${runner.os} ${runner.arch ?? ""} · v${runner.version ?? "?"}`
										: "—"}
								</TableCell>
								<TableCell className="text-sm">
									{runner.currentRun ? (
										<Link
											href={`/dashboard/workflows/runs/${runner.currentRun.workflowRunId}`}
											className="hover:underline"
										>
											Running {runner.currentRun.workflowName} #
											{runner.currentRun.runNumber}
										</Link>
									) : runner.lastSeenAt ? (
										<DateTooltip date={runner.lastSeenAt}>Seen</DateTooltip>
									) : (
										<span className="text-muted-foreground">Never seen</span>
									)}
								</TableCell>
								<TableCell>
									{canEdit && (
										<div className="flex justify-end gap-1">
											<EditRunner runner={runner} />
											<RegenerateToken
												workflowRunnerId={runner.workflowRunnerId}
											/>
											{permissions?.workflow.delete && (
												<DialogAction
													title={`Remove ${runner.name}`}
													description="The machine can no longer take runs. Queued runs that only it could take will wait for another matching runner."
													type="destructive"
													onClick={() =>
														remove
															.mutateAsync({
																workflowRunnerId: runner.workflowRunnerId,
															})
															.then(() => utils.workflow.runners.invalidate())
															.catch((error) => toast.error(error.message))
													}
												>
													<Button
														variant="ghost"
														size="icon"
														className="text-destructive hover:text-destructive"
													>
														<Trash2 className="size-4" />
													</Button>
												</DialogAction>
											)}
										</div>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
};
