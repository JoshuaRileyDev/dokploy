import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { CheckIcon, ChevronsUpDown, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

const NO_SERVER = "none";

const Schema = z.object({
	githubId: z.string().min(1, "Select a GitHub account"),
	repository: z.object({
		owner: z.string().min(1, "Select a repository"),
		repo: z.string().min(1, "Select a repository"),
	}),
	defaultServerId: z.string(),
});

type Schema = z.infer<typeof Schema>;

export const ImportWorkflowRepository = () => {
	const router = useRouter();
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const { data: githubProviders } = api.github.githubProviders.useQuery();
	const { data: workflowServers } = api.server.workflowServers.useQuery();
	const { mutateAsync, isPending, error, isError } =
		api.workflow.importRepository.useMutation();

	const form = useForm<Schema>({
		defaultValues: {
			githubId: "",
			repository: { owner: "", repo: "" },
			defaultServerId: NO_SERVER,
		},
		resolver: zodResolver(Schema),
	});

	const githubId = form.watch("githubId");
	const { data: repositories, isPending: isLoadingRepositories } =
		api.github.getGithubRepositories.useQuery(
			{ githubId },
			{ enabled: !!githubId },
		);

	const onSubmit = async (data: Schema) => {
		const repository = await mutateAsync({
			githubId: data.githubId,
			owner: data.repository.owner,
			repository: data.repository.repo,
			defaultServerId:
				data.defaultServerId === NO_SERVER ? null : data.defaultServerId,
		}).catch(() => null);
		if (!repository) return;

		toast.success(`Imported ${repository.owner}/${repository.repository}`);
		await utils.workflow.allRepositories.invalidate();
		setOpen(false);
		form.reset();
		router.push(
			`/dashboard/workflows/repositories/${repository.workflowRepositoryId}`,
		);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<PlusIcon className="size-4" />
					Import Repository
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Import Repository</DialogTitle>
					<DialogDescription>
						Run the workflows in a repository's .dokploy/workflows folder (and
						optionally .github/workflows) on your workflow servers. The
						repository doesn't need to be deployed with Dokploy.
					</DialogDescription>
				</DialogHeader>
				{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}
				{githubProviders?.length === 0 && (
					<AlertBlock type="warning">
						Connect a GitHub account first in{" "}
						<Link
							href="/dashboard/settings/git-providers"
							className="underline"
						>
							Git Providers
						</Link>
						.
					</AlertBlock>
				)}
				{workflowServers?.length === 0 && (
					<AlertBlock type="info">
						You don't have any workflow servers yet. You can import now, but
						runs need a server with the Workflows role. Add one in{" "}
						<Link href="/dashboard/settings/servers" className="underline">
							Servers
						</Link>
						.
					</AlertBlock>
				)}
				<Form {...form}>
					<form
						id="import-workflow-repository"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid gap-4"
					>
						<FormField
							control={form.control}
							name="githubId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>GitHub Account</FormLabel>
									<Select
										value={field.value}
										onValueChange={(value) => {
											field.onChange(value);
											form.setValue("repository", { owner: "", repo: "" });
										}}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a GitHub account" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{githubProviders?.map((provider) => (
												<SelectItem
													key={provider.githubId}
													value={provider.githubId}
												>
													{provider.gitProvider.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="repository"
							render={({ field }) => (
								<FormItem className="flex flex-col">
									<FormLabel>Repository</FormLabel>
									<Popover modal open={pickerOpen} onOpenChange={setPickerOpen}>
										<PopoverTrigger asChild>
											<FormControl>
												<Button
													variant="outline"
													className={cn(
														"w-full justify-between",
														!field.value.repo && "text-muted-foreground",
													)}
												>
													{field.value.repo
														? `${field.value.owner}/${field.value.repo}`
														: "Select repository"}
													<ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
												</Button>
											</FormControl>
										</PopoverTrigger>
										<PopoverContent
											className="w-[var(--radix-popover-trigger-width)] p-0"
											align="start"
										>
											<Command>
												<CommandInput
													placeholder="Search repository..."
													className="h-9"
												/>
												{!githubId ? (
													<span className="py-6 text-center text-sm text-muted-foreground">
														Select a GitHub account first
													</span>
												) : isLoadingRepositories ? (
													<span className="py-6 text-center text-sm">
														Loading repositories...
													</span>
												) : null}
												<CommandEmpty>No repositories found.</CommandEmpty>
												<ScrollArea className="h-72">
													<CommandGroup>
														{repositories?.map((repo) => (
															<CommandItem
																key={repo.id}
																value={`${repo.owner.login}/${repo.name}`}
																onSelect={() => {
																	form.setValue(
																		"repository",
																		{
																			owner: repo.owner.login,
																			repo: repo.name,
																		},
																		{ shouldValidate: true },
																	);
																	setPickerOpen(false);
																}}
															>
																<span className="flex min-w-0 items-center gap-2">
																	<span className="truncate">{repo.name}</span>
																	<span className="text-xs text-muted-foreground">
																		{repo.owner.login}
																	</span>
																</span>
																<CheckIcon
																	className={cn(
																		"ml-auto size-4",
																		repo.name === field.value.repo &&
																			repo.owner.login === field.value.owner
																			? "opacity-100"
																			: "opacity-0",
																	)}
																/>
															</CommandItem>
														))}
													</CommandGroup>
												</ScrollArea>
											</Command>
										</PopoverContent>
									</Popover>
									{form.formState.errors.repository && (
										<p className="text-sm font-medium text-destructive">
											Select a repository
										</p>
									)}
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="defaultServerId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Workflow Server</FormLabel>
									<Select value={field.value} onValueChange={field.onChange}>
										<FormControl>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value={NO_SERVER}>
												Any workflow server
											</SelectItem>
											{workflowServers?.map((server) => (
												<SelectItem
													key={server.serverId}
													value={server.serverId}
												>
													{server.name} ({server.ipAddress})
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormDescription>
										Where this repository's runs execute.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<DialogFooter>
					<Button
						type="submit"
						form="import-workflow-repository"
						isLoading={isPending}
					>
						Import
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
