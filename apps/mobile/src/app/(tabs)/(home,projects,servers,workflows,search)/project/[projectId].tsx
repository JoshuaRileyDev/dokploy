import { router, Stack, useIsPreview, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { SegmentedControl } from "@/components/native";
import { ServiceRow } from "@/components/rows";
import { Columns, Screen } from "@/components/screen";
import {
	EmptyState,
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
	Secondary,
} from "@/components/ui";
import { useProjects } from "@/lib/hooks";
import { flattenEnvironment, KINDS } from "@/lib/services";
import type { ServiceSummary } from "@/lib/types";

export default function ProjectDetail() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const projects = useProjects();
	const project = projects.data?.find((p) => p.projectId === projectId);
	const [envId, setEnvId] = useState<string | null>(null);
	const isPreview = useIsPreview();

	if (projects.isPending)
		return (
			<Screen>
				<Loading />
			</Screen>
		);
	if (projects.error)
		return (
			<Screen>
				<ErrorState error={projects.error} onRetry={projects.refetch} />
			</Screen>
		);
	if (!project)
		return (
			<Screen>
				<EmptyState symbol="questionmark.folder" title="Project Not Found" />
			</Screen>
		);

	const env =
		project.environments.find((e) => e.environmentId === envId) ??
		project.environments.find((e) => e.isDefault) ??
		project.environments[0];
	const services = env ? flattenEnvironment(env) : [];
	const groups: { title: string; items: ServiceSummary[] }[] = [
		{
			title: "Applications",
			items: services.filter((s) => s.kind === "application"),
		},
		{ title: "Compose", items: services.filter((s) => s.kind === "compose") },
		{
			title: "Databases",
			items: services.filter((s) => KINDS[s.kind].isDatabase),
		},
	].filter((g) => g.items.length > 0);
	const section = (g: (typeof groups)[number]) => (
		<ListSection key={g.title} title={g.title} inset={ICON_INSET}>
			{g.items.map((s) => (
				<ServiceRow key={s.id} {...s} />
			))}
		</ListSection>
	);

	return (
		<>
			{!isPreview && <Stack.Screen options={{ title: project.name }} />}
			{!isPreview && (
				<Stack.Toolbar placement="right">
					<Stack.Toolbar.Button
						icon="gearshape"
						accessibilityLabel="Project Settings"
						onPress={() =>
							router.push({
								pathname: "/project-settings/[projectId]",
								params: { projectId },
							})
						}
					/>
				</Stack.Toolbar>
			)}
			<Screen>
				{project.description ? (
					<Secondary style={{ marginTop: -18, paddingHorizontal: 4 }}>
						{project.description}
					</Secondary>
				) : null}
				{project.environments.length > 1 && env && (
					<SegmentedControl
						value={env.environmentId}
						onChange={setEnvId}
						options={project.environments.map((e) => ({
							value: e.environmentId,
							label: e.name[0]!.toUpperCase() + e.name.slice(1),
						}))}
					/>
				)}
				{groups.length === 0 ? (
					<EmptyState
						symbol="shippingbox"
						title="No Services"
						message={`Nothing is deployed to ${env?.name ?? "this environment"} yet.`}
					/>
				) : (
					<Columns
						left={groups.slice(0, 1).map(section)}
						right={groups.slice(1).map(section)}
					/>
				)}
			</Screen>
		</>
	);
}
