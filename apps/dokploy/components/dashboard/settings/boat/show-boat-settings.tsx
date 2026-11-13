import { Loader2, RefreshCw, Sailboat, Trash2 } from "lucide-react";
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
								description="Workflow runs go back to your workflow servers, and Dokploy deletes its snapshots from your Boat account."
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
						Run workflows on on-demand cloud machines from boat.dev.
					</CardDescription>
				</CardHeader>
				<CardContent className="border-t pt-4">
					<BoatSections />
				</CardContent>
			</div>
		</Card>
	</div>
);
