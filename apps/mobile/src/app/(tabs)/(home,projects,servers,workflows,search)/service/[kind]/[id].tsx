import { Stack, useIsPreview, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Alert, TextInput, View } from "react-native";

import { LogView } from "@/components/log-view";
import { ActionButtons, SegmentedControl } from "@/components/native";
import { DeploymentRow, openDeployment } from "@/components/rows";
import { Columns, Screen } from "@/components/screen";
import {
	EmptyState,
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
	Row,
	Secondary,
	StatusText,
	TextButton,
} from "@/components/ui";
import { duration, timeAgo } from "@/lib/format";
import {
	useDeployments,
	usePost,
	useRuntimeLogs,
	useService,
	useServiceAction,
} from "@/lib/hooks";
import { useLiveLog } from "@/lib/live-log";
import {
	ACTION_META,
	KINDS,
	type ServiceAction,
	serviceStatus,
} from "@/lib/services";
import type { Deployment, ServiceDetail, ServiceKind } from "@/lib/types";
import { serviceTone, status, useLayout, useTheme } from "@/theme";

type Tab = "overview" | "deployments" | "logs" | "env";

export default function ServiceScreen() {
	const { kind, id } = useLocalSearchParams<{
		kind: ServiceKind;
		id: string;
	}>();
	const meta = KINDS[kind];
	const service = useService(kind, id);
	const svcStatus = service.data ? serviceStatus(service.data) : "idle";
	const deployments = useDeployments(kind, id, svcStatus === "running");
	const action = useServiceAction(kind, service.data, id);
	const { regular } = useLayout();
	const [tab, setTab] = useState<Tab>("overview");
	// Peek previews from a long press must not set navigation options.
	const isPreview = useIsPreview();

	if (service.isPending)
		return (
			<Screen>
				<Loading />
			</Screen>
		);
	if (service.error)
		return (
			<Screen>
				<ErrorState error={service.error} onRetry={service.refetch} />
			</Screen>
		);

	const detail = service.data;
	const list = deployments.data ?? detail.deployments ?? [];
	const building = svcStatus === "running" && meta.hasDeployments;

	function run(a: ServiceAction) {
		const m = ACTION_META[a];
		const go = () =>
			action.mutate(a, {
				onError: (e) =>
					Alert.alert(`Couldn't ${m.label.toLowerCase()}`, e.message),
			});
		if (m.confirm || m.destructive) {
			Alert.alert(`${m.label} ${detail.name}?`, m.confirm, [
				{ text: "Cancel", style: "cancel" },
				{
					text: m.label,
					style: m.destructive ? "destructive" : "default",
					onPress: go,
				},
			]);
		} else go();
	}

	const menuActions = meta.actions.filter(
		(a) =>
			a !== "deploy" &&
			a !== "start" &&
			a !== "stop" &&
			(a !== "cancelDeployment" || building),
	);
	const tabs: { value: Tab; label: string }[] = [
		...(regular ? [] : [{ value: "overview" as const, label: "Overview" }]),
		...(meta.hasDeployments
			? [{ value: "deployments" as const, label: "Deploys" }]
			: []),
		...(meta.hasRuntimeLogs ? [{ value: "logs" as const, label: "Logs" }] : []),
		{ value: "env", label: "Environment" },
	];
	const current = tabs.some((t) => t.value === tab) ? tab : tabs[0]!.value;

	const actions = (
		<ActionButtons
			actions={[
				{
					label: building ? "Deploying" : "Deploy",
					symbol: "paperplane.fill",
					kind: "prominent",
					disabled: building,
					loading: action.isPending && action.variables === "deploy",
					onPress: () => run("deploy"),
				},
				svcStatus === "idle"
					? {
							label: "Start",
							symbol: "play.fill",
							loading: action.isPending && action.variables === "start",
							onPress: () => run("start"),
						}
					: {
							label: "Stop",
							symbol: "stop.fill",
							loading: action.isPending && action.variables === "stop",
							onPress: () => run("stop"),
						},
			]}
		/>
	);

	const overview = (
		<Overview
			kind={kind}
			detail={detail}
			deployments={list}
			building={building}
			onShowDeploys={() => setTab("deployments")}
		/>
	);
	const body = (
		<>
			{current === "deployments" && <Deployments list={list} />}
			{current === "logs" && <RuntimeLogs kind={kind} id={id} />}
			{current === "env" && <EnvEditor kind={kind} id={id} detail={detail} />}
		</>
	);

	return (
		<>
			{!isPreview && <Stack.Screen options={{ title: detail.name }} />}
			{!isPreview && (
				<Stack.Toolbar placement="right">
					<Stack.Toolbar.Menu icon="ellipsis">
						{menuActions.map((a) => (
							<Stack.Toolbar.MenuAction
								key={a}
								icon={ACTION_META[a].symbol}
								destructive={ACTION_META[a].destructive}
								onPress={() => run(a)}
							>
								{ACTION_META[a].label}
							</Stack.Toolbar.MenuAction>
						))}
					</Stack.Toolbar.Menu>
				</Stack.Toolbar>
			)}
			<Screen>
				<Secondary style={{ marginTop: -18, paddingHorizontal: 4 }}>
					{meta.label} · {detail.environment.project.name} /{" "}
					{detail.environment.name}
				</Secondary>
				{regular ? (
					<Columns
						ratio={[2, 3]}
						left={
							<>
								{actions}
								{overview}
							</>
						}
						right={
							<>
								<SegmentedControl
									value={current}
									onChange={setTab}
									options={tabs}
								/>
								{body}
							</>
						}
					/>
				) : (
					<>
						{actions}
						<SegmentedControl
							value={current}
							onChange={setTab}
							options={tabs}
						/>
						{current === "overview" ? overview : body}
					</>
				)}
			</Screen>
		</>
	);
}

function Overview({
	kind,
	detail,
	deployments,
	building,
	onShowDeploys,
}: {
	kind: ServiceKind;
	detail: ServiceDetail;
	deployments: Deployment[];
	building: boolean;
	onShowDeploys: () => void;
}) {
	const { colors } = useTheme();
	const meta = KINDS[kind];
	const latest = deployments[0];
	const tone = serviceTone(serviceStatus(detail));
	const live = building && latest?.status === "running" ? latest : null;
	const { lines } = useLiveLog(
		live
			? {
					deploymentId: live.deploymentId,
					logPath: live.logPath,
					serverId: live.serverId,
					running: true,
				}
			: null,
	);
	const source = detail.repository
		? `${detail.owner}/${detail.repository}`
		: detail.dockerImage;

	return (
		<>
			{live && (
				<ListSection
					title="Building"
					action={
						<TextButton label="Full Log" onPress={() => openDeployment(live)} />
					}
				>
					<View style={{ padding: 6 }}>
						<LogView lines={lines} height={220} live />
					</View>
					<Row
						title={live.title}
						subtitle={`Started ${duration(live.startedAt ?? live.createdAt, null)} ago`}
						leading={
							<SymbolView
								name="hammer.fill"
								size={20}
								tintColor={status.warn}
							/>
						}
					/>
				</ListSection>
			)}

			<ListSection>
				<Row
					title="Status"
					trailing={<StatusText color={tone.color} label={tone.label} />}
				/>
				{latest && (
					<Row
						title="Last Deployment"
						value={timeAgo(latest.createdAt)}
						onPress={meta.hasDeployments ? onShowDeploys : undefined}
					/>
				)}
				<Row title="Server" value={detail.server?.name ?? "Dokploy host"} />
			</ListSection>

			{!!detail.domains?.length && (
				<ListSection title="Domains">
					{detail.domains.map((d) => (
						<Row
							key={d.domainId}
							title={d.host}
							subtitle={`${d.https ? "HTTPS" : "HTTP"}${d.port ? ` · port ${d.port}` : ""}`}
							chevron={false}
							trailing={
								<SymbolView
									name="arrow.up.right"
									size={14}
									tintColor={colors.tertiary}
									weight="semibold"
								/>
							}
							onPress={() =>
								WebBrowser.openBrowserAsync(
									`${d.https ? "https" : "http"}://${d.host}${d.path ?? ""}`,
								)
							}
						/>
					))}
				</ListSection>
			)}

			<ListSection title={meta.isDatabase ? "Database" : "Source"}>
				{source ? (
					<Row
						title={detail.repository ? "Repository" : "Image"}
						value={source}
					/>
				) : null}
				{detail.branch ? <Row title="Branch" value={detail.branch} /> : null}
				{detail.buildType ? (
					<Row title="Build Type" value={detail.buildType} />
				) : null}
				{detail.composeType ? (
					<Row title="Compose Type" value={detail.composeType} />
				) : null}
				{meta.isDatabase && detail.databaseName ? (
					<Row title="Database" value={detail.databaseName} />
				) : null}
				{meta.isDatabase && detail.databaseUser ? (
					<Row title="User" value={detail.databaseUser} />
				) : null}
				<Row title="App Name" value={detail.appName} />
			</ListSection>
		</>
	);
}

function Deployments({ list }: { list: Deployment[] }) {
	if (list.length === 0)
		return (
			<EmptyState
				symbol="paperplane"
				title="No Deployments"
				message="Deploy this service to see its history."
			/>
		);
	return (
		<ListSection inset={ICON_INSET}>
			{list.map((d) => (
				<DeploymentRow key={d.deploymentId} deployment={d} />
			))}
		</ListSection>
	);
}

function RuntimeLogs({ kind, id }: { kind: ServiceKind; id: string }) {
	const logs = useRuntimeLogs(kind, id, true);
	if (logs.isPending) return <Loading />;
	if (logs.error)
		return <ErrorState error={logs.error} onRetry={logs.refetch} />;
	return <LogView text={logs.data} height={520} live />;
}

function parseEnv(env: string) {
	return env
		.split("\n")
		.filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
		.map((l) => ({
			key: l.slice(0, l.indexOf("=")),
			value: l.slice(l.indexOf("=") + 1),
		}));
}

function EnvEditor({
	kind,
	id,
	detail,
}: {
	kind: ServiceKind;
	id: string;
	detail: ServiceDetail;
}) {
	const { colors } = useTheme();
	const [editing, setEditing] = useState(false);
	const [revealed, setRevealed] = useState(false);
	const [value, setValue] = useState(detail.env ?? "");
	const save = usePost<Record<string, unknown>>(`${kind}.saveEnvironment`);
	const vars = parseEnv(detail.env ?? "");

	useEffect(() => {
		if (!editing) setValue(detail.env ?? "");
	}, [detail.env, editing]);

	function onSave() {
		const input: Record<string, unknown> = {
			[KINDS[kind].idKey]: id,
			env: value,
		};
		if (kind === "application") {
			const extra = detail as ServiceDetail & {
				buildArgs?: string | null;
				buildSecrets?: string | null;
				createEnvFile?: boolean;
			};
			Object.assign(input, {
				buildArgs: extra.buildArgs ?? "",
				buildSecrets: extra.buildSecrets ?? "",
				createEnvFile: extra.createEnvFile ?? true,
			});
		}
		save.mutate(input, {
			onSuccess: () => setEditing(false),
			onError: (e) => Alert.alert("Couldn't save", e.message),
		});
	}

	if (editing) {
		return (
			<ListSection
				title="Edit Variables"
				action={<TextButton label="Cancel" onPress={() => setEditing(false)} />}
				footer="One KEY=value per line. Changes apply on the next deploy."
			>
				<TextInput
					multiline
					autoFocus
					value={value}
					onChangeText={setValue}
					autoCapitalize="none"
					autoCorrect={false}
					spellCheck={false}
					style={{
						color: colors.text,
						fontFamily: "Menlo",
						fontSize: 13,
						lineHeight: 20,
						minHeight: 200,
						padding: 16,
						paddingTop: 14,
						textAlignVertical: "top",
					}}
				/>
				<View style={{ padding: 12 }}>
					<ActionButtons
						actions={[
							{
								label: "Save",
								symbol: "checkmark",
								kind: "prominent",
								loading: save.isPending,
								disabled: value === (detail.env ?? ""),
								onPress: onSave,
							},
						]}
					/>
				</View>
			</ListSection>
		);
	}

	return (
		<ListSection
			title={`${vars.length} ${vars.length === 1 ? "Variable" : "Variables"}`}
			action={<TextButton label="Edit" onPress={() => setEditing(true)} />}
			footer={vars.length ? undefined : "No environment variables."}
		>
			{vars.map((v) => (
				<Row
					key={v.key}
					title={v.key}
					mono
					value={revealed ? v.value : "••••••••"}
				/>
			))}
			{vars.length > 0 && (
				<Row
					title={revealed ? "Hide Values" : "Show Values"}
					chevron={false}
					onPress={() => setRevealed((r) => !r)}
					leading={
						<SymbolView
							name={revealed ? "eye.slash" : "eye"}
							size={18}
							tintColor={colors.accent}
						/>
					}
				/>
			)}
		</ListSection>
	);
}
