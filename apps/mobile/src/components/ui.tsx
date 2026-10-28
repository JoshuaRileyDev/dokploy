import * as Haptics from "expo-haptics";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { Children, Fragment, type ReactNode } from "react";
import {
	ActivityIndicator,
	type ColorValue,
	Pressable,
	type PressableProps,
	type StyleProp,
	StyleSheet,
	Text,
	type TextStyle,
	View,
	type ViewStyle,
} from "react-native";

import { status, useTheme } from "@/theme";

type TextProps = {
	children: ReactNode;
	style?: StyleProp<TextStyle>;
	numberOfLines?: number;
	selectable?: boolean;
};

export function Body({
	children,
	style,
	numberOfLines,
	selectable,
}: TextProps) {
	const { colors } = useTheme();
	return (
		<Text
			selectable={selectable}
			numberOfLines={numberOfLines}
			style={[{ color: colors.text, fontSize: 17, letterSpacing: -0.4 }, style]}
		>
			{children}
		</Text>
	);
}

export function Secondary({ children, style, numberOfLines }: TextProps) {
	const { colors } = useTheme();
	return (
		<Text
			numberOfLines={numberOfLines}
			style={[
				{ color: colors.secondary, fontSize: 15, letterSpacing: -0.2 },
				style,
			]}
		>
			{children}
		</Text>
	);
}

export function Footnote({ children, style, numberOfLines }: TextProps) {
	const { colors } = useTheme();
	return (
		<Text
			numberOfLines={numberOfLines}
			style={[{ color: colors.secondary, fontSize: 13 }, style]}
		>
			{children}
		</Text>
	);
}

/** An inset-grouped list section, the way UITableView draws one. */
export function ListSection({
	title,
	action,
	footer,
	children,
	inset = 16,
	style,
}: {
	title?: string;
	action?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
	inset?: number;
	style?: StyleProp<ViewStyle>;
}) {
	const { colors } = useTheme();
	const rows = Children.toArray(children).filter(Boolean);
	return (
		<View style={style}>
			{(title || action) && (
				<View style={styles.header}>
					{title ? (
						<Text style={[styles.headerText, { color: colors.text }]}>
							{title}
						</Text>
					) : (
						<View />
					)}
					{action}
				</View>
			)}
			{rows.length > 0 && (
				<View style={[styles.card, { backgroundColor: colors.card }]}>
					{rows.map((row, i) => (
						<Fragment key={i}>
							{i > 0 && (
								<View
									style={{
										height: StyleSheet.hairlineWidth,
										marginLeft: inset,
										backgroundColor: colors.separator,
									}}
								/>
							)}
							{row}
						</Fragment>
					))}
				</View>
			)}
			{footer && (
				<View style={styles.footer}>
					{typeof footer === "string" ? <Footnote>{footer}</Footnote> : footer}
				</View>
			)}
		</View>
	);
}

/** Inset that lines separators up with the text of rows that have an icon tile. */
export const ICON_INSET = 60;

export function IconTile({
	symbol,
	color,
}: {
	symbol: SFSymbol;
	color: ColorValue;
}) {
	return (
		<View
			style={{
				width: 30,
				height: 30,
				borderRadius: 7,
				borderCurve: "continuous",
				backgroundColor: color,
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<SymbolView
				accessible={false}
				name={symbol}
				size={17}
				tintColor="#FFFFFF"
				weight="medium"
			/>
		</View>
	);
}

export interface RowProps
	extends Pick<PressableProps, "onPress" | "onLongPress"> {
	title: string;
	subtitle?: string;
	value?: string;
	icon?: { symbol: SFSymbol; color: ColorValue };
	leading?: ReactNode;
	trailing?: ReactNode;
	chevron?: boolean;
	destructive?: boolean;
	mono?: boolean;
	disabled?: boolean;
	/** Spoken in place of the trailing view, e.g. a status. */
	accessibilityValue?: string;
}

export function Row({
	title,
	subtitle,
	value,
	icon,
	leading,
	trailing,
	onPress,
	onLongPress,
	chevron = !!onPress,
	destructive,
	mono,
	disabled,
	accessibilityValue,
}: RowProps) {
	const { colors } = useTheme();
	return (
		<Pressable
			accessible
			accessibilityRole={onPress ? "button" : undefined}
			accessibilityLabel={[title, subtitle, value, accessibilityValue]
				.filter(Boolean)
				.join(", ")}
			disabled={disabled || !onPress}
			onPress={(e) => {
				Haptics.selectionAsync();
				onPress?.(e);
			}}
			onLongPress={onLongPress}
			style={({ pressed }) => [
				styles.row,
				{ minHeight: subtitle ? 60 : 50, opacity: disabled ? 0.4 : 1 },
				pressed && { backgroundColor: colors.highlight },
			]}
		>
			{icon ? <IconTile {...icon} /> : leading}
			<View style={{ flex: 1, gap: 1 }}>
				<Text
					numberOfLines={1}
					style={{
						color: destructive ? status.error : colors.text,
						fontSize: 17,
						letterSpacing: -0.4,
						fontFamily: mono ? "Menlo" : undefined,
					}}
				>
					{title}
				</Text>
				{subtitle ? <Secondary numberOfLines={1}>{subtitle}</Secondary> : null}
			</View>
			{value ? (
				<Text
					numberOfLines={1}
					style={{
						color: colors.secondary,
						fontSize: 17,
						letterSpacing: -0.4,
						maxWidth: "55%",
						fontVariant: ["tabular-nums"],
					}}
				>
					{value}
				</Text>
			) : null}
			{trailing}
			{chevron && (
				<SymbolView
					accessible={false}
					name="chevron.right"
					size={13}
					tintColor={colors.tertiary}
					weight="semibold"
				/>
			)}
		</Pressable>
	);
}

export function StatusText({
	color,
	label,
}: {
	color: ColorValue;
	label: string;
}) {
	const { colors } = useTheme();
	return (
		<View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
			<View
				style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }}
			/>
			<Text style={{ color: colors.secondary, fontSize: 15 }}>{label}</Text>
		</View>
	);
}

export function Meter({
	percent,
	color,
}: {
	percent: number;
	color: ColorValue;
}) {
	const { colors } = useTheme();
	return (
		<View
			style={{
				height: 6,
				borderRadius: 3,
				backgroundColor: colors.fill,
				overflow: "hidden",
			}}
		>
			<View
				style={{
					width: `${Math.max(0, Math.min(100, percent))}%`,
					height: "100%",
					borderRadius: 3,
					backgroundColor: color,
				}}
			/>
		</View>
	);
}

export function TextButton({
	label,
	onPress,
}: {
	label: string;
	onPress: () => void;
}) {
	const { colors } = useTheme();
	return (
		<Pressable hitSlop={10} onPress={onPress} accessibilityRole="button">
			{({ pressed }) => (
				<Text
					style={{
						color: colors.accent,
						fontSize: 15,
						opacity: pressed ? 0.5 : 1,
					}}
				>
					{label}
				</Text>
			)}
		</Pressable>
	);
}

export function Loading() {
	return (
		<View style={{ paddingVertical: 80, alignItems: "center" }}>
			<ActivityIndicator />
		</View>
	);
}

export function EmptyState({
	symbol,
	title,
	message,
	action,
}: {
	symbol: SFSymbol;
	title: string;
	message?: string;
	action?: { label: string; onPress: () => void };
}) {
	const { colors } = useTheme();
	return (
		<View
			style={{
				alignItems: "center",
				paddingVertical: 60,
				paddingHorizontal: 32,
				gap: 8,
			}}
		>
			<SymbolView name={symbol} size={44} tintColor={colors.tertiary} />
			<Text
				style={{
					color: colors.text,
					fontSize: 20,
					fontWeight: "600",
					marginTop: 8,
					textAlign: "center",
				}}
			>
				{title}
			</Text>
			{message && (
				<Secondary style={{ textAlign: "center" }}>{message}</Secondary>
			)}
			{action && (
				<View style={{ marginTop: 8 }}>
					<TextButton label={action.label} onPress={action.onPress} />
				</View>
			)}
		</View>
	);
}

export function ErrorState({
	error,
	onRetry,
}: {
	error: Error;
	onRetry?: () => void;
}) {
	return (
		<EmptyState
			symbol="exclamationmark.triangle"
			title="Couldn't load"
			message={error.message}
			action={onRetry ? { label: "Try Again", onPress: onRetry } : undefined}
		/>
	);
}

const styles = StyleSheet.create({
	header: {
		flexDirection: "row",
		alignItems: "baseline",
		justifyContent: "space-between",
		paddingHorizontal: 4,
		paddingBottom: 8,
	},
	headerText: { fontSize: 20, fontWeight: "700", letterSpacing: -0.4 },
	card: { borderRadius: 26, borderCurve: "continuous", overflow: "hidden" },
	footer: { paddingHorizontal: 16, paddingTop: 8 },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 14,
		paddingHorizontal: 16,
		paddingVertical: 10,
	},
});
