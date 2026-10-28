import { Stack, useLocalSearchParams } from "expo-router";
import { Alert } from "react-native";

import { RunRow } from "@/components/rows";
import { Columns, Screen } from "@/components/screen";
import {
	EmptyState,
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
	Row,
	Secondary,
	TextButton,
} from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { useAction, useWorkflowRepo, useWorkflowRuns } from "@/lib/hooks";

export default function RepoDetail() {
	const { repoId } = useLocalSearchParams<{ repoId: string }>();
	const repo = useWorkflowRepo(repoId);
	const runs = useWorkflowRuns(repoId);
	const action = useAction();

	if (repo.isPending)
		return (
			<Screen>
				<Loading />
			</Screen>
		);
	if (repo.error)
		return (
			<Screen>
				<ErrorState error={repo.error} onRetry={repo.refetch} />
			</Screen>
		);
	const r = repo.data;
	const sources = [
		r.runDokployWorkflows && ".dokploy",
		r.runGithubWorkflows && ".github",
	]
		.filter(Boolean)
		.join(" and ");

	const dispatch = (id: string, name: string) =>
		Alert.alert(`Run ${name}?`, `Starts ${name} on ${r.defaultBranch}.`, [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Run",
				onPress: () =>
					action.mutate(
						{
							path: "workflow.dispatch",
							input: { workflowDefinitionId: id, branch: r.defaultBranch },
						},
						{
							onError: (e) => Alert.alert("Couldn't start the run", e.message),
						},
					),
			},
		]);

	return (
		<>
			<Stack.Screen options={{ title: r.repository }} />
			<Screen>
				<Secondary style={{ marginTop: -18, paddingHorizontal: 4 }}>
					{r.owner} · synced {timeAgo(r.lastSyncedAt)}
				</Secondary>
				<Columns
					ratio={[2, 3]}
					left={
						<ListSection
							title="Workflows"
							inset={ICON_INSET}
							footer={sources ? `Runs workflows from ${sources}.` : undefined}
						>
							{(r.definitions ?? []).map((d) => (
								<Row
									key={d.workflowDefinitionId}
									icon={{
										symbol: "flowchart.fill",
										color: d.enabled ? "#5E5CE6" : "#8E8E93",
									}}
									title={d.name}
									subtitle={d.enabled ? d.path : `${d.path} · disabled`}
									trailing={
										d.enabled ? (
											<TextButton
												label="Run"
												onPress={() => dispatch(d.workflowDefinitionId, d.name)}
											/>
										) : undefined
									}
								/>
							))}
						</ListSection>
					}
					right={
						runs.isPending ? (
							<Loading />
						) : (runs.data ?? []).length === 0 ? (
							<EmptyState symbol="clock" title="No Runs Yet" />
						) : (
							<ListSection title="Runs" inset={ICON_INSET}>
								{(runs.data ?? []).map((run) => (
									<RunRow key={run.workflowRunId} run={run} />
								))}
							</ListSection>
						)
					}
				/>
			</Screen>
		</>
	);
}
