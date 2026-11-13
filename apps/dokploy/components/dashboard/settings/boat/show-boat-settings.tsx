import { Loader2, RefreshCw, RotateCcw, Sailboat, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, type RouterOutputs } from "@/utils/api";

export const BOAT_MACHINE_TYPES = [
	{ value: "small", label: "Small · 2 vCPU, 4 GB" },
	{ value: "default", label: "Default · 4 vCPU, 8 GB" },
	{ value: "large", label: "Large · 8 vCPU, 16 GB" },
	{ value: "xlarge", label: "XLarge · 16 vCPU, 32 GB ($100+ plans)" },
] as const;

export type BoatMachineType = (typeof BOAT_MACHINE_TYPES)[number]["value"];

type Boat = NonNullable<RouterOutputs["boat"]["get"]>;

export const useBoat = () =>
	api.boat.get.useQuery(undefined, {
		refetchInterval: (query) =>
			query.state.data?.workflowSnapshotBuilding ||
			query.state.data?.workflowSnapshotStatus === "building"
				? 5_000
				: false,
	});

export const MachineTypeSelect = ({
	id,
	value,
	disabled,
	onChange,
}: {
	id: string;
	value: BoatMachineType;
	disabled?: boolean;
	onChange: (value: BoatMachineType) => void;
}) => (
	<Select
		value={value}
		disabled={disabled}
		onValueChange={(next) => onChange(next as BoatMachineType)}
	>
		<SelectTrigger id={id}>
			<SelectValue />
		</SelectTrigger>
		<SelectContent>
			{BOAT_MACHINE_TYPES.map((type) => (
				<SelectItem key={type.value} value={type.value}>
					{type.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
);

export const Section = ({
	title,
	description,
	children,
}: {
	title: string;
	description: React.ReactNode;
	children: React.ReactNode;
}) => (
	<div className="flex flex-col gap-4 rounded-lg border p-4">
		<div className="space-y-1">
			<h3 className="font-medium">{title}</h3>
			<p className="text-sm text-muted-foreground">{description}</p>
		</div>
		{children}
	</div>
);

const BoatConnection = ({ boat }: { boat: Boat | null }) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const save = api.boat.saveConnection.useMutation();
	const remove = api.boat.removeConnection.useMutation();
	const [apiKey, setApiKey] = useState("");
	const canEdit = !!permissions?.organization.update;

	return (
		<Section
			title="Connection"
			description={
				<>
					Dokploy uses your{" "}
					<a
						href="https://boat.dev"
						target="_blank"
						rel="noreferrer"
						className="underline"
					>
						Boat
					</a>{" "}
					account to start cloud machines on demand. Create an API key with{" "}
					<code>boat api-key create</code> or in the Boat dashboard.
				</>
			}
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="boat-api-key">API key</Label>
					<Input
						id="boat-api-key"
						type="password"
						autoComplete="off"
						placeholder={
							boat
								? `Connected (${boat.apiKeyHint}). Enter a new key to replace it`
								: "boat_..."
						}
						value={apiKey}
						disabled={!canEdit}
						onChange={(event) => setApiKey(event.target.value)}
					/>
				</div>
				{canEdit && (
					<div className="flex gap-2">
						<Button
							isLoading={save.isPending}
							disabled={!apiKey.trim()}
							onClick={() =>
								save
									.mutateAsync({ apiKey: apiKey.trim() })
									.then(() => {
										setApiKey("");
										toast.success("Boat connected");
									})
									.catch((error) => toast.error(error.message))
									.finally(() => utils.boat.get.invalidate())
							}
						>
							{boat ? "Replace key" : "Connect"}
						</Button>
						{boat && (
							<DialogAction
								title="Disconnect Boat"
								description="Workflow runs go back to your workflow servers, services on the build pool build on their deploy servers, and Dokploy deletes its snapshots and build machines from your Boat account."
								type="destructive"
								onClick={() =>
									remove
										.mutateAsync()
										.then(() => toast.success("Boat disconnected"))
										.catch((error) => toast.error(error.message))
										.finally(() => utils.boat.get.invalidate())
								}
							>
								<Button variant="ghost" className="text-destructive">
									<Trash2 className="size-4" />
									Disconnect
								</Button>
							</DialogAction>
						)}
					</div>
				)}
			</div>
			{boat?.snapshotAllowance && (
				<p className="text-xs text-muted-foreground">
					Using {boat.snapshotAllowance.used} of{" "}
					{boat.snapshotAllowance.included} saved snapshot slots on your Boat
					plan.
				</p>
			)}
		</Section>
	);
};

const SnapshotStatus = ({ boat }: { boat: Boat }) => {
	const status = boat.workflowSnapshotStatus;
	if (boat.workflowSnapshotBuilding || status === "building") {
		return (
			<Badge variant="secondary" className="gap-1">
				<Loader2 className="size-3 animate-spin" />
				{status === "ready" ? "Refreshing" : "Building"}
			</Badge>
		);
	}
	if (status === "ready") return <Badge>Ready</Badge>;
	if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
	return <Badge variant="outline">Not built</Badge>;
};

const BoatWorkflowSettings = ({ boat }: { boat: Boat }) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const save = api.boat.saveWorkflowSettings.useMutation();
	const rebuild = api.boat.rebuildWorkflowSnapshot.useMutation();
	const canEdit = !!permissions?.workflow.create;

	const [enabled, setEnabled] = useState(boat.workflowsEnabled);
	const [machineType, setMachineType] = useState<BoatMachineType>(
		boat.workflowMachineType,
	);
	const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(
		boat.workflowMaxConcurrentRuns,
	);
	useEffect(() => {
		setEnabled(boat.workflowsEnabled);
		setMachineType(boat.workflowMachineType);
		setMaxConcurrentRuns(boat.workflowMaxConcurrentRuns);
	}, [
		boat.workflowsEnabled,
		boat.workflowMachineType,
		boat.workflowMaxConcurrentRuns,
	]);

	return (
		<Section
			title="Workflows"
			description="Each workflow run gets a fresh machine, created from a saved snapshot that already has act and the runner images, and deleted when the run finishes. Boat takes every run except jobs that match a runner's labels and repositories that pin a workflow server."
		>
			<div className="grid gap-4 md:grid-cols-2">
				<div className="flex items-center justify-between gap-4 md:col-span-2">
					<Label htmlFor="boat-workflows-enabled">
						Send workflow runs to Boat
					</Label>
					<Switch
						id="boat-workflows-enabled"
						checked={enabled}
						disabled={!canEdit}
						onCheckedChange={setEnabled}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="boat-workflow-machine">Machine size</Label>
					<MachineTypeSelect
						id="boat-workflow-machine"
						value={machineType}
						disabled={!canEdit}
						onChange={setMachineType}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="boat-workflow-concurrency">Runs at once</Label>
					<Input
						id="boat-workflow-concurrency"
						type="number"
						min={1}
						max={100}
						value={maxConcurrentRuns}
						disabled={!canEdit}
						onChange={(event) =>
							setMaxConcurrentRuns(
								Math.min(100, Math.max(1, Number(event.target.value) || 1)),
							)
						}
					/>
				</div>
				{canEdit && (
					<div className="flex justify-end md:col-span-2">
						<Button
							isLoading={save.isPending}
							onClick={() =>
								save
									.mutateAsync({ enabled, machineType, maxConcurrentRuns })
									.then(() => toast.success("Workflow settings saved"))
									.catch((error) => toast.error(error.message))
									.finally(() => utils.boat.get.invalidate())
							}
						>
							Save
						</Button>
					</div>
				)}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium">act snapshot</span>
						<SnapshotStatus boat={boat} />
					</div>
					<p className="text-sm text-muted-foreground">
						{boat.workflowSnapshotName ? (
							<>
								<code>{boat.workflowSnapshotName}</code>
								{boat.workflowSnapshotBuiltAt && (
									<>
										{" · "}
										<DateTooltip date={boat.workflowSnapshotBuiltAt}>
											Built
										</DateTooltip>
									</>
								)}
								{!boat.workflowSnapshotCurrent &&
									" · Out of date, rebuilds before the next run"}
							</>
						) : (
							"Built automatically before the first run. This takes a few minutes."
						)}
					</p>
					<p className="text-xs text-muted-foreground">
						Uses one saved snapshot slot and is refreshed weekly.
					</p>
				</div>
				{canEdit && (
					<Button
						variant="outline"
						disabled={
							boat.workflowSnapshotBuilding ||
							boat.workflowSnapshotStatus === "building"
						}
						isLoading={rebuild.isPending}
						onClick={() =>
							rebuild
								.mutateAsync()
								.then(() => toast.success("Rebuilding the snapshot"))
								.catch((error) => toast.error(error.message))
								.finally(() => utils.boat.get.invalidate())
						}
					>
						<RefreshCw className="size-4" />
						Rebuild
					</Button>
				)}
			</div>
			{boat.workflowSnapshotError && (
				<AlertBlock type="error">
					<span className="whitespace-pre-wrap break-words font-mono text-xs">
						{boat.workflowSnapshotError}
					</span>
				</AlertBlock>
			)}
		</Section>
	);
};

const MACHINE_STATE_LABELS: Record<string, string> = {
	archived: "Stopped",
	archiving: "Stopping",
	ready: "Running",
	idle: "Running",
	running: "Running",
	provisioning: "Starting",
	provisioned: "Starting",
	cloning: "Starting",
};

const BoatBuildSettings = ({ boat }: { boat: Boat }) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canRead = !!permissions?.server.read;
	const canEdit = !!permissions?.server.create;
	const { data: machines } = api.boat.buildMachines.useQuery(undefined, {
		enabled: canRead,
		refetchInterval: 10_000,
	});
	const save = api.boat.saveBuildSettings.useMutation();
	const retry = api.boat.retryBuildMachine.useMutation();

	const [enabled, setEnabled] = useState(boat.buildsEnabled);
	const [poolSize, setPoolSize] = useState(boat.buildPoolSize);
	const [machineType, setMachineType] = useState<BoatMachineType>(
		boat.buildMachineType,
	);
	const [idleStopMinutes, setIdleStopMinutes] = useState(
		boat.buildIdleStopMinutes,
	);
	useEffect(() => {
		setEnabled(boat.buildsEnabled);
		setPoolSize(boat.buildPoolSize);
		setMachineType(boat.buildMachineType);
		setIdleStopMinutes(boat.buildIdleStopMinutes);
	}, [
		boat.buildsEnabled,
		boat.buildPoolSize,
		boat.buildMachineType,
		boat.buildIdleStopMinutes,
	]);

	if (!canRead) return null;

	return (
		<Section
			title="Builds"
			description="A pool of Boat machines that build images for applications and compose services set to the Boat build pool. Each machine builds one service at a time and keeps its Docker cache between builds. Machines are started for a build and stopped once they've been idle, so you only pay while they build."
		>
			<div className="grid gap-4 md:grid-cols-2">
				<div className="flex items-center justify-between gap-4 md:col-span-2">
					<Label htmlFor="boat-builds-enabled">Use the Boat build pool</Label>
					<Switch
						id="boat-builds-enabled"
						checked={enabled}
						disabled={!canEdit}
						onCheckedChange={setEnabled}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="boat-build-pool-size">
						Machines (builds at once)
					</Label>
					<Input
						id="boat-build-pool-size"
						type="number"
						min={1}
						max={20}
						value={poolSize}
						disabled={!canEdit}
						onChange={(event) =>
							setPoolSize(
								Math.min(20, Math.max(1, Number(event.target.value) || 1)),
							)
						}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="boat-build-machine">Machine size</Label>
					<MachineTypeSelect
						id="boat-build-machine"
						value={machineType}
						disabled={!canEdit}
						onChange={setMachineType}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="boat-build-idle">Stop after idle (minutes)</Label>
					<Input
						id="boat-build-idle"
						type="number"
						min={1}
						max={240}
						value={idleStopMinutes}
						disabled={!canEdit}
						onChange={(event) =>
							setIdleStopMinutes(
								Math.min(240, Math.max(1, Number(event.target.value) || 1)),
							)
						}
					/>
				</div>
				{canEdit && (
					<div className="flex items-end justify-end">
						<Button
							isLoading={save.isPending}
							onClick={() =>
								save
									.mutateAsync({
										enabled,
										poolSize,
										machineType,
										idleStopMinutes,
									})
									.then(() =>
										toast.success(
											enabled
												? "Build pool saved. New machines are set up in the background"
												: "Build pool saved",
										),
									)
									.catch((error) => toast.error(error.message))
									.finally(() => {
										utils.boat.get.invalidate();
										utils.boat.buildMachines.invalidate();
									})
							}
						>
							Save
						</Button>
					</div>
				)}
			</div>
			<p className="text-xs text-muted-foreground">
				Then choose <strong>Boat build pool</strong> under a service's Advanced
				→ Build Server, together with a registry the deploy server can pull
				from.
			</p>

			{!!machines?.length && (
				<div className="flex flex-col divide-y rounded-md border">
					{machines.map((machine) => (
						<div
							key={machine.serverId}
							className="flex flex-wrap items-center justify-between gap-3 p-3"
						>
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium">{machine.name}</span>
									{machine.settingUp || machine.status === "provisioning" ? (
										<Badge variant="secondary" className="gap-1">
											<Loader2 className="size-3 animate-spin" />
											Setting up
										</Badge>
									) : machine.status === "failed" ? (
										<Badge variant="destructive">Failed</Badge>
									) : machine.building ? (
										<Badge>Building</Badge>
									) : (
										<Badge variant="outline">
											{MACHINE_STATE_LABELS[machine.state] ?? machine.state}
										</Badge>
									)}
								</div>
								{machine.error ? (
									<p className="text-xs text-destructive">{machine.error}</p>
								) : machine.lastUsedAt ? (
									<p className="text-xs text-muted-foreground">
										<DateTooltip date={machine.lastUsedAt}>
											Last build
										</DateTooltip>
									</p>
								) : null}
							</div>
							{canEdit && machine.status === "failed" && !machine.settingUp && (
								<Button
									variant="outline"
									size="sm"
									isLoading={retry.isPending}
									onClick={() =>
										retry
											.mutateAsync({ serverId: machine.serverId })
											.then(() => toast.success(`Setting up ${machine.name}`))
											.catch((error) => toast.error(error.message))
											.finally(() => utils.boat.buildMachines.invalidate())
									}
								>
									<RotateCcw className="size-4" />
									Retry setup
								</Button>
							)}
						</div>
					))}
				</div>
			)}
		</Section>
	);
};

/** The Boat connection plus the settings for everything Dokploy runs on it. */
export const BoatSections = () => {
	const { data: boat, isPending } = useBoat();
	if (isPending) {
		return (
			<div className="flex min-h-[20vh] items-center justify-center">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<BoatConnection boat={boat ?? null} />
			{boat && <BoatWorkflowSettings boat={boat} />}
			{boat && <BoatBuildSettings boat={boat} />}
		</div>
	);
};

export const ShowBoatSettings = () => (
	<div className="mx-auto w-full max-w-5xl">
		<Card className="h-full rounded-xl bg-sidebar p-2.5">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader>
					<CardTitle className="flex flex-row gap-2 text-xl">
						<Sailboat className="size-6 self-center text-muted-foreground" />
						Boat
					</CardTitle>
					<CardDescription>
						Run workflows and builds on on-demand cloud machines from boat.dev.
					</CardDescription>
				</CardHeader>
				<CardContent className="border-t pt-4">
					<BoatSections />
				</CardContent>
			</div>
		</Card>
	</div>
);
