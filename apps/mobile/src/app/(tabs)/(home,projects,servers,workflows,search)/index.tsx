import { router, Stack } from "expo-router";

import { DeploymentRow, ServerRow, ServiceRow } from "@/components/rows";
import { Columns, Screen } from "@/components/screen";
import {
	EmptyState,
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
	Secondary,
} from "@/components/ui";
import {
	useProjects,
	useRecentDeployments,
	useServers,
	useVersion,
} from "@/lib/hooks";
import { flattenEnvironment } from "@/lib/services";
import { useSession } from "@/lib/session";

export default function Overview() {
	const { connection } = useSession();
	const version = useVersion();
	const projects = useProjects();
	const deployments = useRecentDeployments();
	const servers = useServers();

	const services = (projects.data ?? []).flatMap((p) =>
		p.environments.flatMap((e) =>
			flattenEnvironment(e).map((s) => ({
				...s,
				context: `${p.name} · ${e.name}`,
			})),
		),
	);
	const running = services.filter((s) => s.status === "done").length;
	const failing = services.filter((s) => s.status === "error");
	const building = (deployments.data ?? []).filter(
		(d) => d.status === "running",
	);
	const recent = (deployments.data ?? [])
		.filter((d) => d.status !== "running")
		.slice(0, 8);
	const online = (servers.data ?? []).filter(
		(s) => s.serverStatus === "active",
	).length;
	const host =
		connection && connection.mode !== "demo"
			? connection.baseUrl.replace(/^https?:\/\//, "")
			: "Demo";

	const summary = projects.data
		? `${running} of ${services.length} services running${servers.data?.length ? ` · ${online} of ${servers.data.length} servers online` : ""}`
		: " ";

	return (
		<>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button
					icon="person.crop.circle"
					accessibilityLabel="Settings"
					onPress={() => router.push("/settings")}
				/>
			</Stack.Toolbar>
			<Screen>
				<Secondary style={{ marginTop: -18, paddingHorizontal: 4 }}>
					{summary}
				</Secondary>

				{projects.isPending || deployments.isPending ? (
					<Loading />
				) : projects.error ? (
					<ErrorState error={projects.error} onRetry={projects.refetch} />
				) : (
					<Columns
						ratio={[3, 2]}
						left={
							<>
								{building.length > 0 && (
									<ListSection title="In Progress" inset={ICON_INSET}>
										{building.map((d) => (
											<DeploymentRow
												key={d.deploymentId}
												deployment={d}
												showService
											/>
										))}
									</ListSection>
								)}
								{failing.length > 0 && (
									<ListSection title="Needs Attention" inset={ICON_INSET}>
										{failing.map((s) => (
											<ServiceRow key={s.id} {...s} subtitle={s.context} />
										))}
									</ListSection>
								)}
								<ListSection title="Recent Deployments" inset={ICON_INSET}>
									{recent.length === 0
										? null
										: recent.map((d) => (
												<DeploymentRow
													key={d.deploymentId}
													deployment={d}
													showService
												/>
											))}
								</ListSection>
								{recent.length === 0 && (
									<EmptyState
										symbol="paperplane"
										title="No Deployments Yet"
										message="Deployments from any project show up here."
									/>
								)}
							</>
						}
						right={
							!!servers.data?.length && (
								<ListSection
									title="Servers"
									inset={ICON_INSET}
									footer={`${host}${version.data ? ` · Dokploy ${version.data}` : ""}`}
								>
									{servers.data.map((s) => (
										<ServerRow key={s.serverId} server={s} />
									))}
								</ListSection>
							)
						}
					/>
				)}
			</Screen>
		</>
	);
}
