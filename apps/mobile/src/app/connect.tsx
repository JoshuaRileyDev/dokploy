import { SymbolView } from "expo-symbols";
import { type ReactNode, useEffect, useState } from "react";
import {
	KeyboardAvoidingView,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	type TextInputProps,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ActionButtons } from "@/components/native";
import { Footnote, ListSection, Secondary, TextButton } from "@/components/ui";
import { createHttpTransport, normalizeBaseUrl } from "@/lib/api";
import { sessionHeaders, signIn, verifyTwoFactor } from "@/lib/auth";
import { useSession } from "@/lib/session";
import { status, useTheme } from "@/theme";

type Step =
	| { kind: "signIn" }
	| { kind: "apiKey" }
	| { kind: "twoFactor"; challengeCookie: string };

export default function Connect() {
	const { colors } = useTheme();
	const insets = useSafeAreaInsets();
	const { connect, expired, lastLogin } = useSession();
	const [step, setStep] = useState<Step>({ kind: "signIn" });
	const [url, setUrl] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [code, setCode] = useState("");
	const [useBackupCode, setUseBackupCode] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!lastLogin) return;
		setUrl((u) => u || lastLogin.baseUrl.replace(/^https:\/\//, ""));
		setEmail((e) => e || lastLogin.email || "");
	}, [lastLogin]);

	const baseUrl = normalizeBaseUrl(url);

	async function run(task: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await task();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't reach that server.");
		} finally {
			setBusy(false);
		}
	}

	const finishSession = async (credentials: {
		token: string;
		cookieName: string;
	}) => {
		// Confirms the session is accepted by the API, not just by the auth routes.
		await createHttpTransport(baseUrl, sessionHeaders(credentials)).request(
			"GET",
			"user.get",
		);
		await connect({
			mode: "session",
			baseUrl,
			email: email.trim(),
			...credentials,
		});
	};

	const onSignIn = () =>
		run(async () => {
			const result = await signIn(baseUrl, email.trim(), password);
			if (result.status === "twoFactor") {
				setCode("");
				setStep({ kind: "twoFactor", challengeCookie: result.challengeCookie });
			} else await finishSession(result.credentials);
		});

	const onVerify = () =>
		run(async () => {
			if (step.kind !== "twoFactor") return;
			const credentials = await verifyTwoFactor(
				baseUrl,
				step.challengeCookie,
				code,
				useBackupCode ? "backup" : "totp",
			);
			await finishSession(credentials);
		});

	const onApiKey = () =>
		run(async () => {
			await createHttpTransport(baseUrl, {
				"x-api-key": apiKey.trim(),
			}).request("GET", "user.get");
			await connect({ mode: "apiKey", baseUrl, apiKey: apiKey.trim() });
		});

	const field: TextInputProps = {
		placeholderTextColor: colors.tertiary as string,
		autoCapitalize: "none",
		autoCorrect: false,
		style: { flex: 1, color: colors.text, fontSize: 17, textAlign: "right" },
	};
	const footer = error ? (
		<Footnote style={{ color: status.error }}>{error}</Footnote>
	) : undefined;
	const serverRow = (
		<FormRow label="Server">
			<TextInput
				{...field}
				value={url}
				onChangeText={setUrl}
				placeholder="dokploy.example.com"
				keyboardType="url"
				textContentType="URL"
				returnKeyType="next"
			/>
		</FormRow>
	);

	return (
		<KeyboardAvoidingView
			behavior="padding"
			style={{ flex: 1, backgroundColor: colors.background }}
		>
			<ScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{
					flexGrow: 1,
					justifyContent: "center",
					padding: 20,
					paddingTop: insets.top + 20,
					paddingBottom: insets.bottom + 20,
				}}
			>
				<View
					style={{ width: "100%", maxWidth: 440, alignSelf: "center", gap: 32 }}
				>
					<View style={{ alignItems: "center", gap: 10 }}>
						<View
							style={{
								width: 76,
								height: 76,
								borderRadius: 18,
								borderCurve: "continuous",
								backgroundColor: colors.accent,
								alignItems: "center",
								justifyContent: "center",
								marginBottom: 10,
							}}
						>
							<SymbolView
								name={
									step.kind === "twoFactor"
										? "lock.shield.fill"
										: "shippingbox.fill"
								}
								size={38}
								tintColor="#FFFFFF"
							/>
						</View>
						<Text
							style={{
								color: colors.text,
								fontSize: 34,
								fontWeight: "700",
								letterSpacing: -0.8,
								textAlign: "center",
							}}
						>
							{step.kind === "twoFactor"
								? "Two-Factor Authentication"
								: "Dokploy"}
						</Text>
						<Secondary style={{ textAlign: "center", fontSize: 17 }}>
							{step.kind === "twoFactor"
								? useBackupCode
									? "Enter one of the backup codes you saved when you set up two-factor authentication."
									: `Enter the 6-digit code from your authenticator app for ${email.trim()}.`
								: expired
									? "Your session has ended. Sign in again to continue."
									: "Sign in to your Dokploy server to manage deployments on the go."}
						</Secondary>
					</View>

					{step.kind === "signIn" && (
						<ListSection footer={footer}>
							{serverRow}
							<FormRow label="Email">
								<TextInput
									{...field}
									value={email}
									onChangeText={setEmail}
									placeholder="you@example.com"
									keyboardType="email-address"
									textContentType="username"
									autoComplete="email"
									returnKeyType="next"
								/>
							</FormRow>
							<FormRow label="Password">
								<TextInput
									{...field}
									value={password}
									onChangeText={setPassword}
									placeholder="Required"
									secureTextEntry
									textContentType="password"
									autoComplete="current-password"
									returnKeyType="go"
									onSubmitEditing={onSignIn}
								/>
							</FormRow>
						</ListSection>
					)}

					{step.kind === "apiKey" && (
						<ListSection
							footer={
								footer ??
								"Create an API key in Dokploy under Settings → Profile."
							}
						>
							{serverRow}
							<FormRow label="API Key">
								<TextInput
									{...field}
									value={apiKey}
									onChangeText={setApiKey}
									placeholder="Required"
									secureTextEntry
									returnKeyType="go"
									onSubmitEditing={onApiKey}
								/>
							</FormRow>
						</ListSection>
					)}

					{step.kind === "twoFactor" && (
						<ListSection footer={footer}>
							<TextInput
								value={code}
								onChangeText={setCode}
								placeholder={useBackupCode ? "Backup code" : "000000"}
								placeholderTextColor={colors.tertiary as string}
								autoFocus
								autoCapitalize="none"
								autoCorrect={false}
								keyboardType={useBackupCode ? "default" : "number-pad"}
								textContentType="oneTimeCode"
								autoComplete="one-time-code"
								maxLength={useBackupCode ? 32 : 6}
								returnKeyType="go"
								onSubmitEditing={onVerify}
								style={{
									color: colors.text,
									fontSize: useBackupCode ? 20 : 28,
									fontVariant: ["tabular-nums"],
									letterSpacing: useBackupCode ? 1 : 8,
									textAlign: "center",
									height: 64,
								}}
							/>
						</ListSection>
					)}

					<View style={{ gap: 20, alignItems: "center" }}>
						{step.kind === "signIn" && (
							<ActionButtons
								actions={[
									{
										label: "Sign In",
										symbol: "arrow.right",
										kind: "prominent",
										loading: busy,
										disabled: !url.trim() || !email.trim() || !password,
										onPress: onSignIn,
									},
								]}
							/>
						)}
						{step.kind === "apiKey" && (
							<ActionButtons
								actions={[
									{
										label: "Connect",
										symbol: "arrow.right",
										kind: "prominent",
										loading: busy,
										disabled: !url.trim() || !apiKey.trim(),
										onPress: onApiKey,
									},
								]}
							/>
						)}
						{step.kind === "twoFactor" && (
							<ActionButtons
								actions={[
									{
										label: "Verify",
										symbol: "checkmark",
										kind: "prominent",
										loading: busy,
										disabled: useBackupCode
											? code.trim().length < 4
											: code.length !== 6,
										onPress: onVerify,
									},
								]}
							/>
						)}

						{step.kind === "twoFactor" ? (
							<>
								<TextButton
									label={
										useBackupCode
											? "Use Authenticator Code"
											: "Use a Backup Code"
									}
									onPress={() => {
										setUseBackupCode((b) => !b);
										setCode("");
										setError(null);
									}}
								/>
								<TextButton
									label="Back"
									onPress={() => {
										setStep({ kind: "signIn" });
										setError(null);
									}}
								/>
							</>
						) : (
							<>
								<TextButton
									label={
										step.kind === "signIn"
											? "Use an API Key Instead"
											: "Sign In with Email Instead"
									}
									onPress={() => {
										setStep({
											kind: step.kind === "signIn" ? "apiKey" : "signIn",
										});
										setError(null);
									}}
								/>
								<TextButton
									label="Try the Demo"
									onPress={() => connect({ mode: "demo" })}
								/>
							</>
						)}
					</View>
				</View>
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

function FormRow({ label, children }: { label: string; children: ReactNode }) {
	const { colors } = useTheme();
	return (
		<View style={styles.formRow}>
			<Text style={[styles.label, { color: colors.text }]}>{label}</Text>
			{children}
		</View>
	);
}

const styles = StyleSheet.create({
	formRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		paddingHorizontal: 16,
		height: 50,
	},
	label: { fontSize: 17, width: 84 },
});
