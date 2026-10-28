import {
	type ColorValue,
	Platform,
	PlatformColor,
	useColorScheme,
	useWindowDimensions,
} from "react-native";

import type { DeploymentStatus, RunStatus, ServiceStatus } from "@/lib/types";

const ios = Platform.OS === "ios";

// iOS semantic colours adapt to dark mode and Increase Contrast on their own;
// Android gets the equivalent hex values for the current scheme.
const system = (
	name: string,
	dark: string,
	light: string,
	scheme: "dark" | "light",
): ColorValue => (ios ? PlatformColor(name) : scheme === "dark" ? dark : light);

export function useTheme() {
	const scheme = useColorScheme() === "light" ? "light" : "dark";
	const c = (name: string, dark: string, light: string) =>
		system(name, dark, light, scheme);
	return {
		scheme,
		colors: {
			background: c("systemGroupedBackground", "#000000", "#F2F2F7"),
			card: c("secondarySystemGroupedBackground", "#1C1C1E", "#FFFFFF"),
			text: c("label", "#FFFFFF", "#000000"),
			secondary: c(
				"secondaryLabel",
				"rgba(235,235,245,0.6)",
				"rgba(60,60,67,0.6)",
			),
			tertiary: c(
				"tertiaryLabel",
				"rgba(235,235,245,0.3)",
				"rgba(60,60,67,0.3)",
			),
			separator: c("separator", "rgba(84,84,88,0.65)", "rgba(60,60,67,0.29)"),
			fill: c(
				"tertiarySystemFill",
				"rgba(118,118,128,0.24)",
				"rgba(118,118,128,0.12)",
			),
			highlight: c("systemGray5", "#2C2C2E", "#E5E5EA"),
			accent: c("systemIndigo", "#5E5CE6", "#5856D6"),
			// Logs read best on a dark surface in either appearance.
			code: "#111214",
			codeText: "#D8DAE0",
			codeDim: "rgba(216,218,224,0.45)",
		},
	};
}

export type Colors = ReturnType<typeof useTheme>["colors"];

export const status = {
	ok: ios ? PlatformColor("systemGreen") : "#30D158",
	warn: ios ? PlatformColor("systemOrange") : "#FF9F0A",
	error: ios ? PlatformColor("systemRed") : "#FF453A",
	idle: ios ? PlatformColor("systemGray") : "#8E8E93",
	info: ios ? PlatformColor("systemBlue") : "#0A84FF",
};

/** Breakpoints for iPad and landscape: regular widths get side-by-side columns. */
export function useLayout() {
	const { width } = useWindowDimensions();
	const regular = width >= 700;
	return {
		width,
		regular,
		gutter: regular ? 28 : 16,
		maxWidth: regular ? 1100 : 720,
	};
}

export function serviceTone(s: ServiceStatus | null | undefined) {
	switch (s) {
		case "done":
			return { color: status.ok, label: "Running" };
		case "running":
			return { color: status.warn, label: "Deploying" };
		case "error":
			return { color: status.error, label: "Failed" };
		default:
			return { color: status.idle, label: "Stopped" };
	}
}

export function deploymentTone(s: DeploymentStatus | null | undefined) {
	switch (s) {
		case "done":
			return {
				color: status.ok,
				label: "Succeeded",
				symbol: "checkmark.circle.fill" as const,
			};
		case "running":
			return {
				color: status.warn,
				label: "Building",
				symbol: "circle.dotted" as const,
			};
		case "error":
			return {
				color: status.error,
				label: "Failed",
				symbol: "xmark.circle.fill" as const,
			};
		default:
			return {
				color: status.idle,
				label: "Cancelled",
				symbol: "minus.circle.fill" as const,
			};
	}
}

export function runTone(s: RunStatus) {
	switch (s) {
		case "success":
			return {
				color: status.ok,
				label: "Succeeded",
				symbol: "checkmark.circle.fill" as const,
			};
		case "in_progress":
			return {
				color: status.warn,
				label: "In progress",
				symbol: "circle.dotted" as const,
			};
		case "queued":
			return {
				color: status.info,
				label: "Queued",
				symbol: "clock.fill" as const,
			};
		case "failure":
			return {
				color: status.error,
				label: "Failed",
				symbol: "xmark.circle.fill" as const,
			};
		case "skipped":
			return {
				color: status.idle,
				label: "Skipped",
				symbol: "arrow.uturn.right.circle.fill" as const,
			};
		default:
			return {
				color: status.idle,
				label: "Cancelled",
				symbol: "minus.circle.fill" as const,
			};
	}
}

export function diskColor(percent: number) {
	return percent >= 85 ? status.error : percent >= 70 ? status.warn : status.ok;
}
