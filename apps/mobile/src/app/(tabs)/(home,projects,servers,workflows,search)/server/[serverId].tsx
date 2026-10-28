import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActionSheetIOS, Alert, Platform, View } from "react-native";

import { ActionButtons } from "@/components/native";
import { Columns, Screen } from "@/components/screen";
import {
	ErrorState,
	ListSection,
	Loading,
	Meter,
	Row,
	Secondary,
	StatusText,
} from "@/components/ui";
import { bytes, timeAgo } from "@/lib/format";
import {
	useAction,
	useContainers,
	useServer,
	useServerCommands,
	useServerStorage,
} from "@/lib/hooks";
import type { Container } from "@/lib/types";
import { diskColor, status, useTheme } from "@/theme";

const CLEANUPS = [
	{
		path: "settings.cleanUnusedImages",
		label: "Remove Unused Images",
		detail: "docker image prune -a",
	},
	{
		path: "settings.cleanUnusedVolumes",
		label: "Remove Unused Volumes",
		detail: "docker volume prune",
	},
	{
		path: "settings.cleanStoppedContainers",
		label: "Remove Stopped Containers",
		detail: "docker container prune",
	},
	{
		path: "settings.cleanDockerBuilder",
		label: "Clear Build Cache",
		detail: "docker builder prune -a",
	},
];

const ROLE_LABELS = {
	deploy: "Deploy",
	build: "Build",
	workflow: "Workflows",
} as const;

export default function ServerDetail() {
	const { serverId } = useLocalSearchParams<{ serverId: string }>();
	const { colors } = useTheme();
	const server = useServer(serverId);
	const storage = useServerStorage(serverId);
	const containers = useContainers(serverId);
	const commands = useServerCommands(serverId);
	const action = useAction();

	if (server.isPending)
		return (
			<Screen>
				<Loading />
			</Screen>
		);
	if (server.error)
		return (
			<Screen>
				<ErrorState error={server.error} onRetry={server.refetch} />
			</Screen>
		);
	const s = server.data;
	const active = s.serverStatus === "active";

	const confirm = (
		path: string,
		label: string,
		message: string,
		done: string,
	) =>
		Alert.alert(`${label}?`, message, [
			{ text: "Cancel", style: "cancel" },
			{
				text: label.split(" ")[0]!,
				style: "destructive",
				onPress: () =>
					action.mutate(
						{ path, input: { serverId } },
						{
							onSuccess: () => Alert.alert(done),
							onError: (e) => Alert.alert("Something went wrong", e.message),
						},
					),
			},
		]);

	const openContainer = (c: Container) => {
		const restart = () =>
			action.mutate(
				{
					path: "docker.restartContainer",
					input: { containerId: c.containerId, serverId },
				},
				{ onError: (e) => Alert.alert("Couldn't restart", e.message) },
			);
		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					title: c.name,
					message: `${c.image} · ${c.status}`,
					options: ["Restart Container", "Cancel"],
					cancelButtonIndex: 1,
				},
				(i) => i === 0 && restart(),
			);
		} else
			Alert.alert(c.name, c.status, [
				{ text: "Restart", onPress: restart },
				{ text: "Cancel", style: "cancel" },
			]);
	};

	return (
		<>
			<Stack.Screen options={{ title: s.name }} />
			<Screen>
				{s.description ? (
					<Secondary style={{ marginTop: -18, paddingHorizontal: 4 }}>
						{s.description}
					</Secondary>
				) : null}
				<ActionButtons
					actions={[
						{
							label: "Terminal",
							symbol: "terminal.fill",
							kind: "prominent",
							disabled: !active,
							onPress: () =>
								router.push({
									pathname: "/command/[serverId]",
									params: { serverId, name: s.name },
								}),
						},
						{
							label: "Reload Traefik",
							symbol: "arrow.clockwise",
							disabled: !active,
							onPress: () =>
								confirm(
									"settings.reloadTraefik",
									"Reload Traefik",
									`Restarts the proxy on ${s.name}. Requests may fail for a few seconds.`,
									"Traefik reloaded",
								),
						},
					]}
				/>
				<Columns
					left={
						<>
							<ListSection>
								<Row
									title="Status"
									trailing={
										<StatusText
											color={active ? status.ok : status.idle}
											label={active ? "Online" : "Offline"}
										/>
									}
								/>
								<Row title="Address" value={`${s.ipAddress}:${s.port}`} />
								<Row title="User" value={s.username} />
								<Row
									title="Roles"
									value={s.serverRoles.map((r) => ROLE_LABELS[r]).join(", ")}
								/>
								<Row
									title="Automatic Cleanup"
									value={s.enableDockerCleanup ? "On" : "Off"}
								/>
							</ListSection>

							{active && (
								<ListSection
									title="Storage"
									footer={
										storage.data?.sample
											? `Docker data in ${storage.data.sample.dockerRoot}`
											: undefined
									}
								>
									{storage.isPending ? (
										<Loading />
									) : (
										(storage.data?.sample?.volumes ?? []).map((v) => (
											<View
												key={v.mount}
												style={{
													paddingHorizontal: 16,
													paddingVertical: 14,
													gap: 10,
												}}
											>
												<View
													style={{
														flexDirection: "row",
														justifyContent: "space-between",
														alignItems: "baseline",
													}}
												>
													<Secondary
														style={{ color: colors.text, fontSize: 17 }}
													>
														{v.mount}
													</Secondary>
													<Secondary>
														{bytes(v.usedBytes)} of {bytes(v.totalBytes)}
													</Secondary>
												</View>
												<Meter
													percent={v.usedPercent}
													color={diskColor(v.usedPercent)}
												/>
											</View>
										))
									)}
								</ListSection>
							)}

							{active && (
								<ListSection
									title="Docker Cleanup"
									footer="Frees disk space on this server. Running containers and their data are not affected."
								>
									{CLEANUPS.map((c) => (
										<Row
											key={c.path}
											title={c.label}
											subtitle={c.detail}
											chevron={false}
											onPress={() =>
												confirm(
													c.path,
													c.label,
													`Runs ${c.detail} on ${s.name}. This can't be undone.`,
													"Cleanup finished",
												)
											}
										/>
									))}
									<Row
										title="Clean Everything"
										destructive
										chevron={false}
										onPress={() =>
											confirm(
												"settings.cleanAll",
												"Clean Everything",
												`Runs every cleanup above on ${s.name}. This can't be undone.`,
												"Cleanup finished",
											)
										}
									/>
								</ListSection>
							)}
						</>
					}
					right={
						active && (
							<>
								<ListSection title="Containers" inset={44}>
									{containers.isPending ? (
										<Loading />
									) : containers.error ? (
										<ErrorState
											error={containers.error}
											onRetry={containers.refetch}
										/>
									) : (
										containers.data.map((c) => (
											<Row
												key={c.containerId}
												leading={
													<View style={{ width: 14, alignItems: "center" }}>
														<View
															style={{
																width: 8,
																height: 8,
																borderRadius: 4,
																backgroundColor:
																	c.state === "running"
																		? status.ok
																		: status.error,
															}}
														/>
													</View>
												}
												title={c.name.replace(/\.\d+\.[a-z0-9]+$/, "")}
												subtitle={`${c.image} · ${c.status}`}
												chevron={false}
												onPress={() => openContainer(c)}
											/>
										))
									)}
								</ListSection>
								{!!commands.data?.length && (
									<ListSection title="Recent Commands">
										{commands.data.slice(0, 5).map((c) => (
											<Row
												key={c.serverCommandId}
												title={c.command}
												mono
												value={timeAgo(c.createdAt)}
												onPress={() =>
													router.push({
														pathname: "/command/[serverId]",
														params: {
															serverId,
															name: s.name,
															commandId: c.serverCommandId,
														},
													})
												}
											/>
										))}
									</ListSection>
								)}
							</>
						)
					}
				/>
			</Screen>
		</>
	);
}
