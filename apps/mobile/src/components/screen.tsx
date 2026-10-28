import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
	RefreshControl,
	ScrollView,
	type StyleProp,
	View,
	type ViewStyle,
} from "react-native";

import { useLayout, useTheme } from "@/theme";

interface ScreenProps {
	children: ReactNode;
	refreshable?: boolean;
	/** Caps a single list at a comfortable reading width on iPad. */
	readable?: boolean;
	contentStyle?: StyleProp<ViewStyle>;
}

// The ScrollView has to be the screen's root view: the native header only
// collapses its large title when it can track the screen's first subview.
export function Screen({
	children,
	refreshable = true,
	readable,
	contentStyle,
}: ScreenProps) {
	const { gutter, maxWidth } = useLayout();
	const { colors } = useTheme();
	const queryClient = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);

	return (
		<ScrollView
			style={{ backgroundColor: colors.background }}
			contentInsetAdjustmentBehavior="automatic"
			keyboardDismissMode="on-drag"
			refreshControl={
				refreshable ? (
					<RefreshControl
						refreshing={refreshing}
						onRefresh={async () => {
							setRefreshing(true);
							await queryClient.refetchQueries({ type: "active" });
							setRefreshing(false);
						}}
					/>
				) : undefined
			}
			contentContainerStyle={{
				paddingHorizontal: gutter,
				paddingTop: 4,
				paddingBottom: 48,
			}}
		>
			<View
				style={[
					{
						width: "100%",
						maxWidth: readable ? Math.min(maxWidth, 760) : maxWidth,
						alignSelf: "center",
						gap: 28,
					},
					contentStyle,
				]}
			>
				{children}
			</View>
		</ScrollView>
	);
}

/** Side-by-side columns on iPad and landscape; stacked on phones. */
export function Columns({
	left,
	right,
	ratio = [1, 1],
}: {
	left: ReactNode;
	right: ReactNode;
	ratio?: [number, number];
}) {
	const { regular } = useLayout();
	if (!regular) {
		return (
			<>
				{left}
				{right}
			</>
		);
	}
	return (
		<View style={{ flexDirection: "row", gap: 28, alignItems: "flex-start" }}>
			<View style={{ flex: ratio[0], gap: 28 }}>{left}</View>
			<View style={{ flex: ratio[1], gap: 28 }}>{right}</View>
		</View>
	);
}
