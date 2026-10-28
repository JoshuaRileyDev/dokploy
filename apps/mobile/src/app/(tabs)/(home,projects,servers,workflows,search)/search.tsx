import { router, Stack } from "expo-router";
import { useState } from "react";

import { ServiceRow } from "@/components/rows";
import { Screen } from "@/components/screen";
import { EmptyState, ICON_INSET, ListSection, Row } from "@/components/ui";
import { useProjects, useServers, useWorkflowRepos } from "@/lib/hooks";
import { flattenEnvironment } from "@/lib/services";

export default function Search() {
	const [query, setQuery] = useState("");
	const projects = useProjects();
	const servers = useServers();
	const repos = useWorkflowRepos();
	const q = query.trim().toLowerCase();
	const match = (...fields: (string | null | undefined)[]) =>
		fields.some((f) => f?.toLowerCase().includes(q));

	const services = (projects.data ?? []).flatMap((p) =>
		p.environments.flatMap((e) =>
			flattenEnvironment(e).map((s) => ({
				...s,
				subtitle: `${p.name} · ${e.name}`,
			})),
		),
	);
	const found = {
		services: q
			? services.filter((s) => match(s.name, s.subtitle, s.kind))
			: [],
		projects: q
			? (projects.data ?? []).filter((p) => match(p.name, p.description))
			: [],
		servers: q
			? (servers.data ?? []).filter((s) =>
					match(s.name, s.ipAddress, s.description),
				)
			: [],
		repos: q
			? (repos.data ?? []).filter((r) => match(r.repository, r.owner))
			: [],
	};
	const total =
		found.services.length +
		found.projects.length +
		found.servers.length +
		found.repos.length;

	return (
		<>
			<Stack.Screen
				options={{
					headerSearchBarOptions: {
						placeholder: "Services, projects and servers",
						onChangeText: (e) => setQuery(e.nativeEvent.text),
						hideWhenScrolling: false,
						autoCapitalize: "none",
					},
				}}
			/>
			<Screen refreshable={false} readable>
				{!q ? (
					<ListSection title="All Services" inset={ICON_INSET}>
						{services.map((s) => (
							<ServiceRow key={s.id} {...s} />
						))}
					</ListSection>
				) : total === 0 ? (
					<EmptyState
						symbol="magnifyingglass"
						title={`No Results for “${query.trim()}”`}
						message="Check the spelling or try a new search."
					/>
				) : (
					<>
						{found.services.length > 0 && (
							<ListSection title="Services" inset={ICON_INSET}>
								{found.services.map((s) => (
									<ServiceRow key={s.id} {...s} />
								))}
							</ListSection>
						)}
						{found.projects.length > 0 && (
							<ListSection title="Projects" inset={ICON_INSET}>
								{found.projects.map((p) => (
									<Row
										key={p.projectId}
										icon={{ symbol: "folder.fill", color: "#0A84FF" }}
										title={p.name}
										subtitle={p.description ?? undefined}
										onPress={() =>
											router.push({
												pathname: "/project/[projectId]",
												params: { projectId: p.projectId },
											})
										}
									/>
								))}
							</ListSection>
						)}
						{found.servers.length > 0 && (
							<ListSection title="Servers" inset={ICON_INSET}>
								{found.servers.map((s) => (
									<Row
										key={s.serverId}
										icon={{ symbol: "server.rack", color: "#636366" }}
										title={s.name}
										subtitle={s.ipAddress}
										onPress={() =>
											router.push({
												pathname: "/server/[serverId]",
												params: { serverId: s.serverId },
											})
										}
									/>
								))}
							</ListSection>
						)}
						{found.repos.length > 0 && (
							<ListSection title="Repositories" inset={ICON_INSET}>
								{found.repos.map((r) => (
									<Row
										key={r.workflowRepositoryId}
										icon={{
											symbol: "chevron.left.forwardslash.chevron.right",
											color: "#30B0C7",
										}}
										title={r.repository}
										subtitle={r.owner}
										onPress={() =>
											router.push({
												pathname: "/repo/[repoId]",
												params: { repoId: r.workflowRepositoryId },
											})
										}
									/>
								))}
							</ListSection>
						)}
					</>
				)}
			</Screen>
		</>
	);
}
