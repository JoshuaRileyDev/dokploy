import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Pressable,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LogView } from "@/components/log-view";
import { IconButton } from "@/components/native";
import { Secondary, StatusText } from "@/components/ui";
import { useTransport } from "@/lib/session";
import type { ServerCommand } from "@/lib/types";
import { status, useTheme } from "@/theme";

const SUGGESTIONS = ["uptime", "df -h", "free -h", "docker ps"];

type Chunk = ServerCommand & { data: string; nextOffset: number; size: number };

export default function CommandSheet() {
	const { serverId, name, commandId } = useLocalSearchParams<{
		serverId: string;
		name: string;
		commandId?: string;
	}>();
	const { colors } = useTheme();
	const insets = useSafeAreaInsets();
	const transport = useTransport();
	const [command, setCommand] = useState("");
	const [active, setActive] = useState<string | null>(commandId ?? null);
	const [output, setOutput] = useState("");
	const [state, setState] = useState<Chunk["status"] | null>(null);
	const [exitCode, setExitCode] = useState<number | null>(null);
	const offset = useRef(0);

	useEffect(() => {
		if (!active) return;
		let stopped = false;
		offset.current = 0;
		setOutput("");
		const tick = async () => {
			try {
				const chunk = await transport.request<Chunk>(
					"GET",
					"serverCommand.logs",
					{ serverCommandId: active, offset: offset.current },
				);
				if (stopped) return;
				if (chunk.data) setOutput((o) => o + chunk.data);
				offset.current = chunk.nextOffset;
				setState(chunk.status);
				setExitCode(chunk.exitCode);
				if (chunk.status === "running" || chunk.nextOffset < chunk.size)
					setTimeout(tick, 600);
			} catch (e) {
				if (!stopped)
					setOutput(
						(o) => `${o}\n${e instanceof Error ? e.message : String(e)}`,
					);
			}
		};
		tick();
		return () => {
			stopped = true;
		};
	}, [active, transport]);

	async function run(cmd = command) {
		if (!cmd.trim()) return;
		try {
			const started = await transport.request<ServerCommand>(
				"POST",
				"serverCommand.run",
				{ serverId, command: cmd.trim() },
			);
			setState("running");
			setActive(started.serverCommandId);
			setCommand(cmd);
		} catch (e) {
			Alert.alert(
				"Couldn't run the command",
				e instanceof Error ? e.message : String(e),
			);
		}
	}

	const result =
		state === "running"
			? { color: status.warn, label: "Running" }
			: state === "success"
				? { color: status.ok, label: `Exited with ${exitCode ?? 0}` }
				: state
					? {
							color: status.error,
							label:
								state === "cancelled"
									? "Cancelled"
									: `Exited with ${exitCode ?? 1}`,
						}
					: null;

	return (
		<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
			<View
				style={{
					flex: 1,
					paddingHorizontal: 16,
					paddingTop: 20,
					paddingBottom: insets.bottom + 8,
					gap: 14,
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
					<View style={{ flex: 1, gap: 2 }}>
						<Text
							style={{
								color: colors.text,
								fontSize: 20,
								fontWeight: "700",
								letterSpacing: -0.4,
							}}
						>
							Run Command
						</Text>
						{result ? (
							<StatusText {...result} />
						) : (
							<Secondary>on {name}</Secondary>
						)}
					</View>
					<IconButton
						symbol="xmark"
						label="Close"
						onPress={() => router.back()}
					/>
				</View>

				<View
					style={{
						flexDirection: "row",
						alignItems: "center",
						height: 50,
						borderRadius: 25,
						backgroundColor: colors.fill,
						paddingLeft: 18,
						paddingRight: 6,
						gap: 8,
					}}
				>
					<TextInput
						value={command}
						onChangeText={setCommand}
						onSubmitEditing={() => run()}
						placeholder="Command"
						placeholderTextColor={colors.tertiary}
						autoCapitalize="none"
						autoCorrect={false}
						spellCheck={false}
						returnKeyType="go"
						style={{
							flex: 1,
							color: colors.text,
							fontFamily: "Menlo",
							fontSize: 15,
						}}
					/>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Run"
						disabled={!command.trim() || state === "running"}
						onPress={() => run()}
						style={({ pressed }) => ({
							height: 38,
							paddingHorizontal: 16,
							borderRadius: 19,
							backgroundColor: colors.accent,
							justifyContent: "center",
							opacity:
								!command.trim() || state === "running"
									? 0.4
									: pressed
										? 0.7
										: 1,
						})}
					>
						<Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "600" }}>
							Run
						</Text>
					</Pressable>
				</View>

				{/* A horizontal ScrollView here gets repositioned by the form sheet's scroll handling. */}
				<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
					{SUGGESTIONS.map((q) => (
						<Pressable
							key={q}
							onPress={() => run(q)}
							style={({ pressed }) => ({
								paddingHorizontal: 14,
								height: 32,
								borderRadius: 16,
								justifyContent: "center",
								backgroundColor: pressed ? colors.highlight : colors.fill,
							})}
						>
							<Text
								style={{
									color: colors.text,
									fontFamily: "Menlo",
									fontSize: 13,
								}}
							>
								{q}
							</Text>
						</Pressable>
					))}
				</View>

				<LogView
					text={active ? output : ""}
					live={state === "running"}
					placeholder="Output appears here."
					fill
				/>
			</View>
		</KeyboardAvoidingView>
	);
}
