import { NativeTabs } from "expo-router/native-tabs";

import { useRecentDeployments } from "@/lib/hooks";
import { useTheme } from "@/theme";

export default function TabsLayout() {
	const { colors } = useTheme();
	const { data: deployments } = useRecentDeployments();
	const building =
		deployments?.filter((d) => d.status === "running").length ?? 0;

	return (
		<NativeTabs tintColor={colors.accent} minimizeBehavior="onScrollDown">
			<NativeTabs.Trigger name="(home)">
				<NativeTabs.Trigger.Label>Overview</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon
					sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }}
					md="dashboard"
				/>
				{building > 0 && (
					<NativeTabs.Trigger.Badge>
						{String(building)}
					</NativeTabs.Trigger.Badge>
				)}
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(projects)">
				<NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon
					sf={{ default: "folder", selected: "folder.fill" }}
					md="folder"
				/>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(servers)">
				<NativeTabs.Trigger.Label>Servers</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon
					sf={{ default: "server.rack", selected: "server.rack" }}
					md="dns"
				/>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(workflows)">
				<NativeTabs.Trigger.Label>Workflows</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon
					sf={{
						default: "arrow.triangle.branch",
						selected: "arrow.triangle.branch",
					}}
					md="account_tree"
				/>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(search)" role="search">
				<NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
			</NativeTabs.Trigger>
		</NativeTabs>
	);
}
