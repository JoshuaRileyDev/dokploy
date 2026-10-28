import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LogView } from "@/components/log-view";
import { IconButton } from "@/components/native";
import { StatusText } from "@/components/ui";
import { duration } from "@/lib/format";
import { useRecentDeployments } from "@/lib/hooks";
import { useLiveLog } from "@/lib/live-log";
import type { DeploymentStatus } from "@/lib/types";
import { deploymentTone, useTheme } from "@/theme";

export default function DeploymentSheet() {
	const params = useLocalSearchParams<{
		id: string;
		logPath: string;
		serverId: string;
		title: string;
		status: DeploymentStatus;
	}>();
	const { colors } = useTheme();
	const insets = useSafeAreaInsets();
	const recent = useRecentDeployments();
	const current = recent.data?.find((d) => d.deploymentId === params.id);
	const statusNow = current?.status ?? params.status;
	const running = statusNow === "running";
	const tone = deploymentTone(statusNow);
	const { lines } = useLiveLog({
		deploymentId: params.id,
		logPath: params.logPath,
		serverId: params.serverId || null,
		running,
	});
	const elapsed = current
		? duration(current.startedAt ?? current.createdAt, current.finishedAt)
		: "";

	return (
		<View
			style={{
				flex: 1,
				paddingHorizontal: 16,
				paddingTop: 20,
				paddingBottom: insets.bottom + 8,
				gap: 16,
			}}
		>
			<View
				style={{
					flexDirection: "row",
					alignItems: "center",
					gap: 12,
					paddingLeft: 4,
				}}
			>
				<View style={{ flex: 1, gap: 4 }}>
					<Text
						numberOfLines={2}
						style={{
							color: colors.text,
							fontSize: 20,
							fontWeight: "700",
							letterSpacing: -0.4,
						}}
					>
						{params.title}
					</Text>
					<StatusText
						color={tone.color}
						label={elapsed ? `${tone.label} · ${elapsed}` : tone.label}
					/>
				</View>
				<IconButton
					symbol="doc.on.doc"
					label="Copy Log"
					onPress={() => {
						Clipboard.setStringAsync(lines.join("\n"));
						Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
					}}
				/>
				<IconButton
					symbol="xmark"
					label="Close"
					onPress={() => router.back()}
				/>
			</View>
			<LogView lines={lines} live={running} fill />
		</View>
	);
}
