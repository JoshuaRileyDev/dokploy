import {
	Host,
	HStack,
	Label,
	Picker,
	Button as SwiftButton,
	Text as SwiftText,
} from "@expo/ui/swift-ui";
import {
	buttonBorderShape,
	buttonStyle,
	controlSize,
	disabled as disabledModifier,
	frame,
	labelStyle,
	pickerStyle,
	tag,
	tint,
} from "@expo/ui/swift-ui/modifiers";
import * as Haptics from "expo-haptics";
import type { SFSymbol } from "expo-symbols";
import { SymbolView } from "expo-symbols";
import {
	ActivityIndicator,
	Platform,
	Pressable,
	Text,
	View,
} from "react-native";

import { status, useTheme } from "@/theme";

const ios = Platform.OS === "ios";

export interface Action {
	label: string;
	symbol: SFSymbol;
	onPress: () => void;
	/** `prominent` is the screen's primary action; `destructive` tints it red. */
	kind?: "prominent" | "default" | "destructive";
	disabled?: boolean;
	loading?: boolean;
}

/**
 * A row of full-width buttons. On iOS these are SwiftUI buttons, so they get the
 * system Liquid Glass styles and press behaviour rather than an imitation.
 */
export function ActionButtons({ actions }: { actions: Action[] }) {
	const { colors } = useTheme();
	if (ios) {
		return (
			<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
				<HStack spacing={10}>
					{actions.map((a) => (
						<SwiftButton
							key={a.label}
							role={a.kind === "destructive" ? "destructive" : undefined}
							onPress={() => {
								Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
								a.onPress();
							}}
							modifiers={[
								buttonStyle(
									a.kind === "prominent" ? "glassProminent" : "glass",
								),
								controlSize("large"),
								...(a.kind === "prominent" ? [tint(colors.accent)] : []),
								disabledModifier(!!(a.disabled || a.loading)),
							]}
						>
							<Label
								title={a.loading ? `${a.label}…` : a.label}
								systemImage={a.symbol}
								modifiers={[frame({ maxWidth: Number.POSITIVE_INFINITY })]}
							/>
						</SwiftButton>
					))}
				</HStack>
			</Host>
		);
	}
	return (
		<View style={{ flexDirection: "row", gap: 10 }}>
			{actions.map((a) => {
				const prominent = a.kind === "prominent";
				const fg = prominent
					? "#FFFFFF"
					: a.kind === "destructive"
						? status.error
						: colors.text;
				return (
					<Pressable
						key={a.label}
						accessibilityRole="button"
						disabled={a.disabled || a.loading}
						onPress={a.onPress}
						style={({ pressed }) => ({
							flex: 1,
							height: 50,
							borderRadius: 25,
							flexDirection: "row",
							gap: 8,
							alignItems: "center",
							justifyContent: "center",
							backgroundColor: prominent ? colors.accent : colors.fill,
							opacity: a.disabled ? 0.4 : pressed ? 0.7 : 1,
						})}
					>
						{a.loading ? (
							<ActivityIndicator color={fg} />
						) : (
							<SymbolView name={a.symbol} size={17} tintColor={fg} />
						)}
						<Text style={{ color: fg, fontSize: 17, fontWeight: "600" }}>
							{a.label}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

export function SegmentedControl<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (v: T) => void;
}) {
	const { colors } = useTheme();
	if (ios) {
		return (
			<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
				<Picker
					selection={value}
					onSelectionChange={(v) => onChange(v as T)}
					modifiers={[pickerStyle("segmented")]}
				>
					{options.map((o) => (
						<SwiftText key={o.value} modifiers={[tag(o.value)]}>
							{o.label}
						</SwiftText>
					))}
				</Picker>
			</Host>
		);
	}
	return (
		<View
			style={{
				flexDirection: "row",
				backgroundColor: colors.fill,
				borderRadius: 9,
				padding: 2,
			}}
		>
			{options.map((o) => (
				<Pressable
					key={o.value}
					onPress={() => onChange(o.value)}
					style={{
						flex: 1,
						height: 30,
						borderRadius: 7,
						alignItems: "center",
						justifyContent: "center",
						backgroundColor: o.value === value ? colors.card : "transparent",
					}}
				>
					<Text
						style={{
							color: colors.text,
							fontSize: 13,
							fontWeight: o.value === value ? "600" : "500",
						}}
					>
						{o.label}
					</Text>
				</Pressable>
			))}
		</View>
	);
}

/** A circular glass button holding a single SF Symbol, for sheet chrome. */
export function IconButton({
	symbol,
	label,
	onPress,
}: {
	symbol: SFSymbol;
	label: string;
	onPress: () => void;
}) {
	const { colors } = useTheme();
	if (ios) {
		return (
			<Host matchContents>
				<SwiftButton
					label={label}
					systemImage={symbol}
					onPress={onPress}
					modifiers={[
						buttonStyle("glass"),
						buttonBorderShape("circle"),
						controlSize("large"),
						labelStyle("iconOnly"),
					]}
				/>
			</Host>
		);
	}
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={onPress}
			hitSlop={8}
			style={{
				width: 40,
				height: 40,
				borderRadius: 20,
				backgroundColor: colors.fill,
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<SymbolView name={symbol} size={17} tintColor={colors.text} />
		</Pressable>
	);
}
