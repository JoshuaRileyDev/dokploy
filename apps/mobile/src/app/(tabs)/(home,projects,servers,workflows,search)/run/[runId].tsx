import { Stack, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";

import { LogView } from "@/components/log-view";
import { ActionButtons } from "@/components/native";
import { Columns, Screen } from "@/components/screen";
import {
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
	Row,
	Secondary,
	StatusText,
} from "@/components/ui";
import { duration, timeAgo } from "@/lib/format";
import { useAction, useWorkflowLogs, useWorkflowRun } from "@/lib/hooks";
import { runTone, useLayout, useTheme } from "@/theme";

export default function RunDetail() {
	const { runId } = useLocalSearchParams<{ runId: string }>();
	const { colors } = useTheme();
	const { regular } = useLayout();
	const run = useWorkflowRun(runId);
	const logs = useWorkflowLogs(runId);
	const action = useAction();
	const [selected, setSelected] = useState<string | null>(null);

	if (run.isPending)
		return (
			<Screen>
				<Loading />
			</Screen>
		);
	if (run.error)
		return (
			<Screen>
				<ErrorState error={run.error} onRetry={run.refetch} />
			</Screen>
		);
	const r = run.data;
	const tone = runTone(r.status);
	const active = r.status === "in_progress" || r.status === "queued";
	const jobs = r.jobs ?? [];
	const focused =
		selected ??
		jobs.find((j) => j.status === "failure" || j.status === "in_progress")
			?.workflowJobId ??
		jobs[0]?.workflowJobId;
	const job = jobs.find((j) => j.workflowJobId === focused);
	const jobLog = logs.data?.jobs.find((j) => j.workflowJobId === focused);

	return (
		<>
			<Stack.Screen options={{ title: `${r.workflowName} #${r.runNumber}` }} />
			<Screen>
				<Secondary
					style={{ marginTop: -18, paddingHorizontal: 4 }}
					numberOfLines={2}
				>
					{r.title}
				</Secondary>
				<ActionButtons
					actions={[
						active
							? {
									label: "Cancel Run",
									symbol: "xmark",
									kind: "destructive",
									loading: action.isPending,
									onPress: () =>
										action.mutate(
											{
												path: "workflow.cancelRun",
												input: { workflowRunId: runId },
											},
											{
												onError: (e) =>
													Alert.alert("Couldn't cancel", e.message),
											},
										),
								}
							: {
									label: "Re-run",
									symbol: "arrow.clockwise",
									kind: "prominent",
									loading: action.isPending,
									onPress: () =>
										action.mutate(
											{
												path: "workflow.rerun",
												input: { workflowRunId: runId },
											},
											{
												onError: (e) =>
													Alert.alert("Couldn't re-run", e.message),
											},
										),
								},
					]}
				/>
				<Columns
					ratio={[2, 3]}
					left={
						<>
							<ListSection>
								<Row
									title="Status"
									trailing={
										<StatusText color={tone.color} label={tone.label} />
									}
								/>
								{r.repository && (
									<Row title="Repository" value={r.repository.repository} />
								)}
								<Row title="Branch" value={r.branch ?? "—"} />
								<Row title="Commit" value={r.sha.slice(0, 7)} />
								<Row title="Trigger" value={r.event.replace(/_/g, " ")} />
								<Row
									title="Started"
									value={timeAgo(r.startedAt ?? r.createdAt)}
								/>
								<Row
									title="Duration"
									value={duration(r.startedAt, r.finishedAt) || "—"}
								/>
							</ListSection>
							<ListSection title="Jobs" inset={ICON_INSET}>
								{jobs.map((j) => {
									const jt = runTone(j.status);
									return (
										<Row
											key={j.workflowJobId}
											leading={
												<View style={{ width: 30, alignItems: "center" }}>
													{j.status === "in_progress" ? (
														<ActivityIndicator size="small" />
													) : (
														<SymbolView
															name={jt.symbol}
															size={22}
															tintColor={jt.color}
														/>
													)}
												</View>
											}
											title={j.name}
											subtitle={jt.label}
											chevron={false}
											trailing={
												j.workflowJobId === focused ? (
													<SymbolView
														name="checkmark"
														size={15}
														tintColor={colors.accent}
														weight="semibold"
													/>
												) : undefined
											}
											onPress={() => setSelected(j.workflowJobId)}
										/>
									);
								})}
							</ListSection>
						</>
					}
					right={
						<>
							{!!job?.steps?.length && (
								<ListSection title={`Steps · ${job.name}`} inset={ICON_INSET}>
									{job.steps.map((s) => {
										const st = runTone(s.status);
										return (
											<Row
												key={s.name}
												leading={
													<View style={{ width: 30, alignItems: "center" }}>
														<SymbolView
															name={st.symbol}
															size={18}
															tintColor={st.color}
														/>
													</View>
												}
												title={s.name}
											/>
										);
									})}
								</ListSection>
							)}
							<ListSection title="Log">
								{logs.isPending ? (
									<Loading />
								) : (
									<View style={{ padding: 6 }}>
										<LogView
											text={jobLog?.log ?? logs.data?.runLog ?? ""}
											height={regular ? 560 : 340}
											live={active}
										/>
									</View>
								)}
							</ListSection>
						</>
					}
				/>
			</Screen>
		</>
	);
}
