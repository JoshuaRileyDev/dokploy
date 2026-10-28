import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { SessionProvider, useSession } from "@/lib/session";
import { useTheme } from "@/theme";

SplashScreen.preventAutoHideAsync();

// Emitted by native-driven animations in react-native-screens' header and
// harmless; without this the dev toast covers the tab bar.
LogBox.ignoreLogs([
	"Sending `onAnimatedValueUpdate` with no listeners registered",
]);

const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

function RootStack() {
	const { ready, connection } = useSession();
	const { scheme } = useTheme();

	useEffect(() => {
		if (ready) SplashScreen.hideAsync();
	}, [ready]);

	if (!ready) return null;

	const base = scheme === "dark" ? DarkTheme : DefaultTheme;
	const sheet = {
		presentation: "formSheet" as const,
		sheetGrabberVisible: true,
		sheetCornerRadius: 34,
		headerShown: false,
		contentStyle: { backgroundColor: "transparent" },
	};

	return (
		<ThemeProvider
			value={{
				...base,
				colors: {
					...base.colors,
					background: scheme === "dark" ? "#000000" : "#F2F2F7",
				},
			}}
		>
			<Stack screenOptions={{ headerShown: false }}>
				<Stack.Protected guard={!!connection}>
					<Stack.Screen name="(tabs)" />
					<Stack.Screen
						name="deployment/[id]"
						options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }}
					/>
					<Stack.Screen
						name="command/[serverId]"
						options={{ ...sheet, sheetAllowedDetents: [0.7, 1] }}
					/>
					<Stack.Screen
						name="project-settings/[projectId]"
						options={{
							presentation: "modal",
							headerShown: true,
							title: "Project Settings",
						}}
					/>
					<Stack.Screen
						name="settings"
						options={{ ...sheet, sheetAllowedDetents: [0.85, 1] }}
					/>
				</Stack.Protected>
				<Stack.Protected guard={!connection}>
					<Stack.Screen name="connect" options={{ animation: "fade" }} />
				</Stack.Protected>
			</Stack>
		</ThemeProvider>
	);
}

export default function RootLayout() {
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<QueryClientProvider client={queryClient}>
				<SessionProvider>
					<RootStack />
				</SessionProvider>
			</QueryClientProvider>
		</GestureHandlerRootView>
	);
}
