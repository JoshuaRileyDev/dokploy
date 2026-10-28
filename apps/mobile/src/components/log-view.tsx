import { type ComponentRef, useRef } from "react";
import { ScrollView, Text, View } from "react-native";

import { useTheme } from "@/theme";

const ERROR = "#FF6B6B";
const OK = "#5BD68A";
const STEP = "#A5A3FF";

function lineColor(line: string, fallback: string) {
	if (/❌|\berror\b|failed|failure|exit code: [1-9]/i.test(line)) return ERROR;
	if (/✅|✓|succeeded|converged|done in/i.test(line)) return OK;
	if (/^#\d+ \[|⭐|Initializing/.test(line)) return STEP;
	return fallback;
}

/** Monospaced log output that follows the tail as lines arrive. */
export function LogView({
	text,
	lines,
	height,
	fill,
	live,
	placeholder = "No output",
}: {
	text?: string;
	lines?: string[];
	height?: number;
	fill?: boolean;
	live?: boolean;
	placeholder?: string;
}) {
	const { colors } = useTheme();
	const ref = useRef<ComponentRef<typeof ScrollView>>(null);
	const all = (lines ?? (text ?? "").split("\n")).filter(
		(l, i, arr) => l || i < arr.length - 1,
	);

	return (
		<View
			style={{
				flex: fill ? 1 : undefined,
				height,
				backgroundColor: colors.code,
				borderRadius: 22,
				borderCurve: "continuous",
				overflow: "hidden",
			}}
		>
			<ScrollView
				ref={ref}
				nestedScrollEnabled
				style={height || fill ? { flex: 1 } : undefined}
				contentContainerStyle={{ padding: 16 }}
				onContentSizeChange={() =>
					ref.current?.scrollToEnd({ animated: !!live })
				}
			>
				{all.length === 0 ? (
					<Text
						style={{ color: colors.codeDim, fontFamily: "Menlo", fontSize: 12 }}
					>
						{live ? "Waiting for output…" : placeholder}
					</Text>
				) : (
					all.map((line, i) => (
						<Text
							key={i}
							selectable
							style={{
								color: lineColor(line, colors.codeText),
								fontFamily: "Menlo",
								fontSize: 11.5,
								lineHeight: 17,
							}}
						>
							{line || " "}
						</Text>
					))
				)}
			</ScrollView>
		</View>
	);
}
