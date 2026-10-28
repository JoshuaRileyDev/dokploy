import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
	ActionSheetIOS,
	Alert,
	Platform,
	ScrollView,
	TextInput,
} from "react-native";

import { EmptyState, ListSection, Loading, Row } from "@/components/ui";
import { usePost, useProjects } from "@/lib/hooks";
import { flattenEnvironment } from "@/lib/services";
import { useTheme } from "@/theme";

export default function ProjectSettings() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { colors } = useTheme();
	const projects = useProjects();
	const project = projects.data?.find((p) => p.projectId === projectId);
	const [name, setName] = useState<string | null>(null);
	const [description, setDescription] = useState<string | null>(null);
	const update = usePost<{
		projectId: string;
		name: string;
		description: string;
	}>("project.update");

	if (projects.isPending) return <Loading />;
	if (!project)
		return (
			<EmptyState symbol="questionmark.folder" title="Project Not Found" />
		);

	const nameValue = name ?? project.name;
	const descriptionValue = description ?? project.description ?? "";
	const dirty =
		nameValue !== project.name ||
		descriptionValue !== (project.description ?? "");
	const valid = nameValue.trim().length > 0;
	const services = project.environments.flatMap(flattenEnvironment).length;

	function save() {
		update.mutate(
			{
				projectId,
				name: nameValue.trim(),
				description: descriptionValue.trim(),
			},
			{
				onSuccess: () => router.back(),
				onError: (e) => Alert.alert("Couldn't save the project", e.message),
			},
		);
	}

	function cancel() {
		if (!dirty) return router.back();
		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					options: ["Discard Changes", "Keep Editing"],
					destructiveButtonIndex: 0,
					cancelButtonIndex: 1,
				},
				(i) => i === 0 && router.back(),
			);
		} else {
			Alert.alert("Discard changes?", undefined, [
				{ text: "Keep Editing", style: "cancel" },
				{
					text: "Discard",
					style: "destructive",
					onPress: () => router.back(),
				},
			]);
		}
	}

	const input = {
		color: colors.text,
		fontSize: 17,
		paddingHorizontal: 16,
		paddingVertical: 14,
	};

	return (
		<>
			{/* Blocks swipe-to-dismiss so unsaved edits go through the Cancel prompt. */}
			<Stack.Screen options={{ gestureEnabled: !dirty }} />
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button
					icon="xmark"
					accessibilityLabel="Cancel"
					onPress={cancel}
				/>
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button
					icon="checkmark"
					variant="done"
					accessibilityLabel="Save"
					disabled={!dirty || !valid || update.isPending}
					onPress={save}
				/>
			</Stack.Toolbar>
			<ScrollView
				style={{ backgroundColor: colors.background }}
				contentInsetAdjustmentBehavior="automatic"
				keyboardDismissMode="interactive"
				contentContainerStyle={{ padding: 16, gap: 28 }}
			>
				<ListSection
					title="Name"
					footer={valid ? undefined : "A project needs a name."}
				>
					<TextInput
						value={nameValue}
						onChangeText={setName}
						placeholder="Project name"
						placeholderTextColor={colors.tertiary}
						autoFocus
						returnKeyType="done"
						style={input}
					/>
				</ListSection>
				<ListSection title="Description">
					<TextInput
						value={descriptionValue}
						onChangeText={setDescription}
						placeholder="What runs in this project?"
						placeholderTextColor={colors.tertiary}
						multiline
						style={[input, { minHeight: 96, textAlignVertical: "top" }]}
					/>
				</ListSection>
				<ListSection title="Details">
					<Row
						title="Environments"
						value={String(project.environments.length)}
					/>
					<Row title="Services" value={String(services)} />
					<Row
						title="Created"
						value={new Date(project.createdAt).toLocaleDateString(undefined, {
							day: "numeric",
							month: "short",
							year: "numeric",
						})}
					/>
				</ListSection>
			</ScrollView>
		</>
	);
}
