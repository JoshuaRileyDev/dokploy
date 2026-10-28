import { Stack } from "expo-router";

import { useTheme } from "@/theme";

export const unstable_settings = {
	anchor: "index",
	projects: { anchor: "projects" },
	servers: { anchor: "servers" },
	workflows: { anchor: "workflows" },
	search: { anchor: "search" },
};

export default function TabStack() {
	const { colors } = useTheme();
	return (
		<Stack
			screenOptions={{
				headerTransparent: true,
				headerLargeTitleEnabled: true,
				headerShadowVisible: false,
				headerLargeTitleShadowVisible: false,
				headerBackButtonDisplayMode: "minimal",
				contentStyle: { backgroundColor: colors.background },
			}}
		>
			<Stack.Screen name="index" options={{ title: "Overview" }} />
			<Stack.Screen name="projects" options={{ title: "Projects" }} />
			<Stack.Screen name="servers" options={{ title: "Servers" }} />
			<Stack.Screen name="workflows" options={{ title: "Workflows" }} />
			<Stack.Screen name="search" options={{ title: "Search" }} />
		</Stack>
	);
}
