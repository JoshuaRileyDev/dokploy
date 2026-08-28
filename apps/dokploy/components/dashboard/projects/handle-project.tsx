import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { PlusIcon, SquarePen } from "lucide-react";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { TagSelector } from "@/components/shared/tag-selector";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const AddProjectSchema = z.object({
	name: z
		.string()
		.min(1, "Project name is required")
		.refine(
			(name) => {
				const trimmedName = name.trim();
				const validNameRegex =
					/^[\p{L}\p{N}_-][\p{L}\p{N}\s_.-]*[\p{L}\p{N}_-]$/u;
				return validNameRegex.test(trimmedName);
			},
			{
				message:
					"Project name must start and end with a letter, number, hyphen or underscore. Spaces are allowed in between.",
			},
		)
		.refine((name) => !/^\d/.test(name.trim()), {
			message: "Project name cannot start with a number",
		})
		.transform((name) => name.trim()),
	description: z.string().optional(),
	isFolder: z.boolean().default(false),
	parentProjectId: z.string().nullable().optional(),
});

type AddProject = z.infer<typeof AddProjectSchema>;

interface Props {
	projectId?: string;
	defaultIsFolder?: boolean;
	parentProjectId?: string | null;
	buttonText?: string;
	asDropdownItem?: boolean;
}

export const HandleProject = ({
	projectId,
	defaultIsFolder = false,
	parentProjectId = null,
	buttonText,
	asDropdownItem = false,
}: Props) => {
	const utils = api.useUtils();
	const [isOpen, setIsOpen] = useState(false);
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const isEditing = Boolean(projectId);
	const { data: allProjects } = api.project.allWithServicesTree.useQuery();

	const { mutateAsync, error, isError } = projectId
		? api.project.update.useMutation()
		: api.project.create.useMutation();

	const { data, refetch } = api.project.one.useQuery(
		{
			projectId: projectId || "",
		},
		{
			enabled: !!projectId,
		},
	);

	const { data: availableTags = [] } = api.tag.all.useQuery();
	const bulkAssignMutation = api.tag.bulkAssign.useMutation();

	const router = useRouter();
	const form = useForm<AddProject>({
		defaultValues: {
			description: "",
			name: "",
			isFolder: defaultIsFolder,
			parentProjectId,
		},
		resolver: zodResolver(AddProjectSchema),
	});

	useEffect(() => {
		form.reset({
			description: data?.description ?? "",
			name: data?.name ?? "",
			isFolder: data?.isFolder ?? defaultIsFolder,
			parentProjectId: data?.parentProjectId ?? parentProjectId,
		});

		if (data?.projectTags) {
			const tagIds = data.projectTags.map((projectTag) => projectTag.tagId);
			setSelectedTagIds(tagIds);
		} else {
			setSelectedTagIds([]);
		}
	}, [
		form,
		form.reset,
		form.formState.isSubmitSuccessful,
		data,
		defaultIsFolder,
		parentProjectId,
	]);

	const onSubmit = async (values: AddProject) => {
		await mutateAsync({
			name: values.name,
			description: values.description,
			isFolder: values.isFolder,
			parentProjectId: values.parentProjectId ?? null,
			projectId: projectId || "",
		})
			.then(async (response) => {
				const projectIdToUse =
					projectId ||
					(response && "project" in response ? response.project.projectId : "");

				if (projectIdToUse) {
					try {
						await bulkAssignMutation.mutateAsync({
							projectId: projectIdToUse,
							tagIds: selectedTagIds,
						});
					} catch {
						toast.error("Failed to assign tags to project");
					}
				}

				await utils.project.all.invalidate();
				await utils.project.allWithServices.invalidate();
				await utils.project.allWithServicesTree.invalidate();
				toast.success(projectId ? "Project Updated" : "Project Created");
				setIsOpen(false);

				if (!projectId) {
					const environmentIdToUse =
						response && "environment" in response
							? response.environment?.environmentId
							: undefined;

					if (environmentIdToUse && projectIdToUse) {
						router.push(
							`/dashboard/project/${projectIdToUse}/environment/${environmentIdToUse}`,
						);
					}
				} else {
					refetch();
				}
			})
			.catch(() => {
				toast.error(
					projectId ? "Error updating a project" : "Error creating a project",
				);
			});
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				{projectId || asDropdownItem ? (
					<DropdownMenuItem
						className="w-full cursor-pointer space-x-3"
						onSelect={(event) => event.preventDefault()}
					>
						{projectId ? (
							<>
								<SquarePen className="size-4" />
								<span>Update</span>
							</>
						) : (
							<>
								<PlusIcon className="size-4" />
								<span>{buttonText || "Create Project"}</span>
							</>
						)}
					</DropdownMenuItem>
				) : (
					<Button>
						<PlusIcon className="h-4 w-4" />
						{buttonText || "Create Project"}
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:m:max-w-lg">
				<DialogHeader>
					<DialogTitle>{projectId ? "Update" : "Add a"} project</DialogTitle>
					<DialogDescription>The home of something big!</DialogDescription>
				</DialogHeader>
				{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}
				<Form {...form}>
					<form
						id="hook-form-add-project"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input placeholder="Vandelay Industries" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Description</FormLabel>
									<FormControl>
										<Textarea
											placeholder="Description about your project..."
											className="resize-none"
											{...field}
										/>
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>

						{!isEditing && (
							<FormField
								control={form.control}
								name="isFolder"
								render={({ field }) => (
									<FormItem className="flex items-center justify-between rounded-lg border p-3">
										<div className="space-y-0.5">
											<FormLabel>Create as folder</FormLabel>
											<p className="text-xs text-muted-foreground">
												Folders can contain projects and sub-folders.
											</p>
										</div>
										<FormControl>
											<Switch
												checked={field.value}
												onCheckedChange={field.onChange}
											/>
										</FormControl>
									</FormItem>
								)}
							/>
						)}

						{!isEditing && (
							<FormField
								control={form.control}
								name="parentProjectId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Parent folder (optional)</FormLabel>
										<FormControl>
											<select
												className="w-full rounded-md border bg-background p-2 text-sm"
												value={field.value ?? ""}
												onChange={(event) => {
													const value = event.target.value;
													field.onChange(value.length > 0 ? value : null);
												}}
											>
												<option value="">Root level</option>
												{flattenFolderOptions(allProjects).map((folder) => (
													<option key={folder.projectId} value={folder.projectId}>
														{folder.label}
													</option>
												))}
											</select>
										</FormControl>
									</FormItem>
								)}
							/>
						)}

						<div className="space-y-2">
							<FormLabel>Tags</FormLabel>
							<TagSelector
								tags={availableTags.map((tag) => ({
									id: tag.tagId,
									name: tag.name,
									color: tag.color ?? undefined,
								}))}
								selectedTags={selectedTagIds}
								onTagsChange={setSelectedTagIds}
								placeholder="Select tags..."
							/>
						</div>
					</form>

					<DialogFooter>
						<Button
							isLoading={form.formState.isSubmitting}
							form="hook-form-add-project"
							type="submit"
						>
							{projectId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};

type FolderOption = {
	projectId: string;
	label: string;
};

function flattenFolderOptions(
	projects:
		| Array<{
				projectId: string;
				name: string;
				isFolder: boolean;
				children?: any[];
		  }>
		| undefined,
	depth = 0,
): FolderOption[] {
	if (!projects) return [];
	const options: FolderOption[] = [];

	for (const project of projects) {
		if (!project.isFolder) continue;
		options.push({
			projectId: project.projectId,
			label: `${"  ".repeat(depth)}${project.name}`,
		});
		options.push(...flattenFolderOptions(project.children || [], depth + 1));
	}

	return options;
}
