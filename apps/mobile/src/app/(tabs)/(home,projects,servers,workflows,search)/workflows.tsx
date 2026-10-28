import { router } from "expo-router";

import { RunRow } from "@/components/rows";
import { Columns, Screen } from "@/components/screen";
import {
	EmptyState,
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
	Row,
	StatusText,
} from "@/components/ui";
import { useWorkflowRepos, useWorkflowRuns } from "@/lib/hooks";
import { runTone } from "@/theme";

export default function Workflows() {
	const repos = useWorkflowRepos();
	const runs = useWorkflowRuns();

	if (repos.isPending)
		return (
			<Screen>
				<Loading />
			</Screen>
		);
	if (repos.error)
		return (
			<Screen>
				<ErrorState error={repos.error} onRetry={repos.refetch} />
			</Screen>
		);
	if (repos.data.length === 0) {
		return (
			<Screen>
				<EmptyState
					symbol="arrow.triangle.branch"
					title="No Repositories"
					message="Import a repository from the Workflows page in Dokploy to run CI on your own servers."
				/>
			</Screen>
		);
	}

	const allRuns = runs.data ?? [];
	return (
		<Screen>
			<Columns
				ratio={[2, 3]}
				left={
					<ListSection title="Repositories" inset={ICON_INSET}>
						{repos.data.map((r) => {
							const last = allRuns.find(
								(run) => run.workflowRepositoryId === r.workflowRepositoryId,
							);
							const tone = last ? runTone(last.status) : null;
							const count = r.definitions?.length ?? 0;
							return (
								<Row
									key={r.workflowRepositoryId}
									icon={{
										symbol: "chevron.left.forwardslash.chevron.right",
										color: "#30B0C7",
									}}
									title={r.repository}
									subtitle={`${count} ${count === 1 ? "workflow" : "workflows"}`}
									trailing={
										tone ? (
											<StatusText color={tone.color} label={tone.label} />
										) : undefined
									}
									onPress={() =>
										router.push({
											pathname: "/repo/[repoId]",
											params: { repoId: r.workflowRepositoryId },
										})
									}
								/>
							);
						})}
					</ListSection>
				}
				right={
					<ListSection title="Recent Runs" inset={ICON_INSET}>
						{runs.isPending ? (
							<Loading />
						) : (
							allRuns
								.slice(0, 15)
								.map((r) => <RunRow key={r.workflowRunId} run={r} showRepo />)
						)}
					</ListSection>
				}
			/>
		</Screen>
	);
}
