import { useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { IconButton } from "@/components/native";
import { ListSection, Row, Secondary } from "@/components/ui";
import { initials } from "@/lib/format";
import {
	useActiveOrganization,
	useMe,
	useOrganizations,
	useVersion,
} from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { useTheme } from "@/theme";

export default function Settings() {
	const { colors } = useTheme();
	const insets = useSafeAreaInsets();
	const queryClient = useQueryClient();
	const { connection, disconnect, switchOrganization } = useSession();
	const me = useMe();
	const version = useVersion();
	const organizations = useOrganizations();
	const active = useActiveOrganization();
	const [switching, setSwitching] = useState<string | null>(null);
	const user = me.data?.user;
	const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
	const mode = connection?.mode;
	const canSwitch = mode === "session" || mode === "demo";

	async function choose(organizationId: string) {
		if (organizationId === active.data?.id) return;
		setSwitching(organizationId);
		try {
			await switchOrganization(organizationId);
			// Everything the API returns is scoped to the active organization.
			await queryClient.resetQueries();
		} catch (e) {
			Alert.alert(
				"Couldn't switch organization",
				e instanceof Error ? e.message : String(e),
			);
		} finally {
			setSwitching(null);
		}
	}

	const signOutCopy =
		mode === "demo"
			? {
					row: "Leave Demo",
					title: "Leave the demo?",
					body: undefined,
					cta: "Leave",
				}
			: mode === "session"
				? {
						row: "Sign Out",
						title: "Sign out of Dokploy?",
						body: "This ends the session on this device.",
						cta: "Sign Out",
					}
				: {
						row: "Disconnect",
						title: "Disconnect from this server?",
						body: "Your API key will be removed from this device.",
						cta: "Disconnect",
					};

	return (
		<ScrollView
			contentContainerStyle={{
				paddingHorizontal: 16,
				paddingTop: 20,
				paddingBottom: insets.bottom + 24,
				gap: 28,
			}}
		>
			<View
				style={{ flexDirection: "row", alignItems: "center", paddingLeft: 4 }}
			>
				<Text
					style={{
						flex: 1,
						color: colors.text,
						fontSize: 28,
						fontWeight: "700",
						letterSpacing: -0.6,
					}}
				>
					Settings
				</Text>
				<IconButton
					symbol="xmark"
					label="Close"
					onPress={() => router.back()}
				/>
			</View>

			<ListSection>
				<View
					style={{
						flexDirection: "row",
						alignItems: "center",
						gap: 14,
						padding: 16,
					}}
				>
					<View
						style={{
							width: 52,
							height: 52,
							borderRadius: 26,
							backgroundColor: colors.fill,
							alignItems: "center",
							justifyContent: "center",
						}}
					>
						<Text
							style={{ color: colors.text, fontWeight: "600", fontSize: 19 }}
						>
							{fullName ? initials(fullName) : "?"}
						</Text>
					</View>
					<View style={{ flex: 1, gap: 2 }}>
						<Text
							style={{ color: colors.text, fontSize: 19, fontWeight: "600" }}
						>
							{fullName || "Dokploy user"}
						</Text>
						<Secondary numberOfLines={1}>{user?.email}</Secondary>
					</View>
				</View>
				{me.data?.role && (
					<Row
						title="Role"
						value={me.data.role[0]!.toUpperCase() + me.data.role.slice(1)}
					/>
				)}
			</ListSection>

			{!!organizations.data?.length && (
				<ListSection
					title="Organization"
					footer={
						mode === "apiKey"
							? "API keys belong to one organization. Sign in with your email to switch."
							: "Projects, servers and workflows are shown for the selected organization."
					}
				>
					{(canSwitch
						? organizations.data
						: organizations.data.filter((o) => o.id === active.data?.id)
					).map((o) => (
						<Row
							key={o.id}
							title={o.name}
							chevron={false}
							disabled={!!switching}
							onPress={canSwitch ? () => choose(o.id) : undefined}
							accessibilityValue={
								o.id === active.data?.id ? "Selected" : undefined
							}
							trailing={
								switching === o.id ? (
									<ActivityIndicator size="small" />
								) : o.id === active.data?.id ? (
									<SymbolView
										name="checkmark"
										size={16}
										weight="semibold"
										tintColor={colors.accent}
									/>
								) : undefined
							}
						/>
					))}
				</ListSection>
			)}

			<ListSection
				title="Server"
				footer={
					mode === "demo"
						? "You are exploring sample data. Nothing here is sent anywhere."
						: mode === "session"
							? "Your session is stored in the Keychain and renews while you use the app."
							: "Your API key is stored in the Keychain on this device."
				}
			>
				<Row
					title="Address"
					value={
						connection && connection.mode !== "demo"
							? connection.baseUrl.replace(/^https?:\/\//, "")
							: "Demo"
					}
				/>
				<Row title="Dokploy Version" value={version.data ?? "…"} />
				<Row
					title="Signed In With"
					value={
						mode === "session"
							? "Email and password"
							: mode === "apiKey"
								? `API key ••••${connection?.mode === "apiKey" ? connection.apiKey.slice(-4) : ""}`
								: "Demo"
					}
				/>
			</ListSection>

			<ListSection title="About">
				<Row
					title="App Version"
					value={Constants.expoConfig?.version ?? "1.0.0"}
				/>
			</ListSection>

			<ListSection>
				<Row
					title={signOutCopy.row}
					destructive
					chevron={false}
					onPress={() =>
						Alert.alert(signOutCopy.title, signOutCopy.body, [
							{ text: "Cancel", style: "cancel" },
							{
								text: signOutCopy.cta,
								style: "destructive",
								onPress: () => {
									router.dismissAll();
									disconnect();
								},
							},
						])
					}
				/>
			</ListSection>
		</ScrollView>
	);
}
