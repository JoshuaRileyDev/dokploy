import { Link, router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { ActivityIndicator, Alert, View } from "react-native";

import { duration, timeAgo } from "@/lib/format";
import { useAction, useServerStorage } from "@/lib/hooks";
import { KINDS } from "@/lib/services";
import type {
	Deployment,
	Server,
	ServiceKind,
	ServiceStatus,
	WorkflowRun,
} from "@/lib/types";
import {
	deploymentTone,
	diskColor,
	runTone,
	serviceTone,
	status,
} from "@/theme";

import { Row, StatusText } from "./ui";

export function openDeployment(
	d: Pick<
		Deployment,
		"deploymentId" | "logPath" | "serverId" | "title" | "status"
	>,
) {
	router.push({
		pathname: "/deployment/[id]",
		params: {
			id: d.deploymentId,
			logPath: d.logPath,
			serverId: d.serverId ?? "",
			title: d.title,
			status: d.status ?? "",
		},
	});
}

/** A service row with a native long-press menu (peek preview plus quick actions). */
export function ServiceRow({
	kind,
	id,
	name,
	status,
	subtitle,
}: {
	kind: ServiceKind;
	id: string;
	name: string;
	status: ServiceStatus;
	subtitle?: string;
}) {
	const meta = KINDS[kind];
	const tone = serviceTone(status);
	const action = useAction();
	const input = { [meta.idKey]: id };
	const run = (verb: string, extra: Record<string, unknown> = {}) =>
		action.mutate(
			{ path: `${kind}.${verb}`, input: { ...input, ...extra } },
			{ onError: (e) => Alert.alert("Action failed", e.message) },
		);

	return (
		<Link
			href={{ pathname: "/service/[kind]/[id]", params: { kind, id } }}
			asChild
		>
			<Link.Trigger>
				<Row
					icon={{ symbol: meta.symbol, color: meta.hue }}
					title={name}
					subtitle={subtitle ?? meta.label}
					trailing={<StatusText color={tone.color} label={tone.label} />}
					accessibilityValue={tone.label}
				/>
			</Link.Trigger>
			<Link.Preview />
			<Link.Menu>
				<Link.MenuAction
					title="Deploy"
					icon="paperplane"
					disabled={status === "running"}
					onPress={() =>
						run(
							"deploy",
							meta.isDatabase ? {} : { title: "Deploy from mobile" },
						)
					}
				/>
				{meta.actions.includes("redeploy") && (
					<Link.MenuAction
						title="Redeploy"
						icon="arrow.triangle.2.circlepath"
						disabled={status === "running"}
						onPress={() => run("redeploy", { title: "Redeploy from mobile" })}
					/>
				)}
				{status === "idle" ? (
					<Link.MenuAction
						title="Start"
						icon="play"
						onPress={() => run("start")}
					/>
				) : (
					<Link.MenuAction
						title="Stop"
						icon="stop"
						destructive
						onPress={() =>
							Alert.alert(
								`Stop ${name}?`,
								"It stops serving traffic until you start it again.",
								[
									{ text: "Cancel", style: "cancel" },
									{
										text: "Stop",
										style: "destructive",
										onPress: () => run("stop"),
									},
								],
							)
						}
					/>
				)}
			</Link.Menu>
		</Link>
	);
}

function StatusGlyph({
	symbol,
	color,
	active,
}: {
	symbol: Parameters<typeof SymbolView>[0]["name"];
	color: Parameters<typeof SymbolView>[0]["tintColor"];
	active: boolean;
}) {
	return (
		<View style={{ width: 30, alignItems: "center" }}>
			{active ? (
				<ActivityIndicator size="small" />
			) : (
				<SymbolView
					accessible={false}
					name={symbol}
					size={22}
					tintColor={color}
				/>
			)}
		</View>
	);
}

export function DeploymentRow({
	deployment,
	showService,
}: {
	deployment: Deployment;
	showService?: boolean;
}) {
	const tone = deploymentTone(deployment.status);
	const owner = deployment.application ?? deployment.compose;
	const running = deployment.status === "running";
	const context =
		showService && owner
			? `${owner.name} · ${owner.environment.project.name}`
			: tone.label;

	return (
		<Row
			leading={
				<StatusGlyph symbol={tone.symbol} color={tone.color} active={running} />
			}
			title={deployment.title}
			accessibilityValue={tone.label}
			subtitle={`${context} · ${running ? duration(deployment.startedAt ?? deployment.createdAt, null) : timeAgo(deployment.createdAt)}`}
			onPress={() => openDeployment(deployment)}
		/>
	);
}

export function RunRow({
	run,
	showRepo,
}: {
	run: WorkflowRun;
	showRepo?: boolean;
}) {
	const tone = runTone(run.status);
	const active = run.status === "in_progress";
	const where =
		showRepo && run.repository
			? run.repository.repository
			: `${run.workflowName} #${run.runNumber}`;
	return (
		<Row
			leading={
				<StatusGlyph symbol={tone.symbol} color={tone.color} active={active} />
			}
			title={run.title}
			accessibilityValue={tone.label}
			subtitle={`${where} · ${run.branch ?? run.event} · ${active ? duration(run.startedAt, null) : timeAgo(run.createdAt)}`}
			onPress={() =>
				router.push({
					pathname: "/run/[runId]",
					params: { runId: run.workflowRunId },
				})
			}
		/>
	);
}

const ROLE_LABELS = {
	deploy: "Deploy",
	build: "Build",
	workflow: "Workflows",
} as const;

export function ServerRow({ server }: { server: Server }) {
	const active = server.serverStatus === "active";
	const storage = useServerStorage(server.serverId);
	const root = storage.data?.sample?.volumes[0];
	return (
		<Row
			icon={{ symbol: "server.rack", color: active ? "#636366" : "#3A3A3C" }}
			title={server.name}
			subtitle={`${server.ipAddress} · ${server.serverRoles.map((r) => ROLE_LABELS[r]).join(", ")}`}
			trailing={
				active ? (
					root ? (
						<StatusText
							color={diskColor(root.usedPercent)}
							label={`${root.usedPercent}% disk`}
						/>
					) : undefined
				) : (
					<StatusText color={status.idle} label="Offline" />
				)
			}
			onPress={() =>
				router.push({
					pathname: "/server/[serverId]",
					params: { serverId: server.serverId },
				})
			}
		/>
	);
}
