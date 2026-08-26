import { zodResolver } from "@hookform/resolvers/zod";
import { CloudIcon, Key, Loader2, RocketIcon, Search } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CloudProviderLogo } from "@/components/icons/cloud-provider-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/utils/api";
import {
	getCloudProviderDefinition,
	cloudProviderCatalogDefinitions,
	supportedCloudProviderIds,
	type CloudProviderDefinition,
} from "@dokploy/server/providers/registry-client";

const provisionServerSchema = z.object({
	provider: z.enum(supportedCloudProviderIds),
	name: z
		.string()
		.min(1, "Server name is required")
		.max(63, "Server name must be less than 63 characters")
		.regex(
			/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/,
			"Server name must start and end with alphanumeric characters and contain only letters, numbers, and hyphens",
		),
	location: z.string().min(1, "Location is required"),
	serverType: z.string().min(1, "Server type is required"),
	image: z.string().min(1, "Image is required"),
});

type ProvisionServerInput = z.infer<typeof provisionServerSchema>;
type ProviderId = ProvisionServerInput["provider"];

const ProviderCard = ({
	provider,
	disabled,
	onSelect,
	hasCredentials,
}: {
	provider: CloudProviderDefinition;
	disabled: boolean;
	onSelect: (provider: ProviderId) => void;
	hasCredentials: boolean;
}) => {
	const statusLabel =
		provider.availability === "supported"
			? hasCredentials
				? "Ready"
				: "Not configured"
			: "Coming soon";

	return (
		<div className="rounded-lg border bg-background p-4 transition-colors hover:bg-muted/30">
			<div className="flex items-start gap-4">
				<div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
					<CloudProviderLogo icon={provider.icon} className="size-7" />
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<div className="flex items-center gap-2">
						<span className="font-semibold">{provider.label}</span>
						<Badge
							variant={
								provider.availability === "supported" && hasCredentials
									? "default"
									: provider.availability === "planned"
										? "secondary"
										: "outline"
							}
						>
							{statusLabel}
						</Badge>
					</div>
					<span className="line-clamp-2 text-sm text-muted-foreground">
						{provider.description}
					</span>
					<Button
						type="button"
						variant={
							hasCredentials && provider.availability === "supported"
								? "default"
								: "outline"
						}
						className="w-fit"
						onClick={() => onSelect(provider.id as ProviderId)}
						disabled={disabled}
					>
						{provider.availability === "supported"
							? hasCredentials
								? "Select"
								: "Not configured"
							: "Coming soon"}
					</Button>
				</div>
			</div>
		</div>
	);
};

export const ProvisionServerWizard = () => {
	const [isOpen, setIsOpen] = useState(false);
	const [step, setStep] = useState<"provider" | "config">("provider");
	const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(
		null,
	);
	const [providerQuery, setProviderQuery] = useState("");
	const utils = api.useUtils();

	const { data: credentials } = api.cloudProvider.credentials.list.useQuery();
	const { data: locations, isLoading: locationsLoading } =
		api.cloudProvider.provider.listLocations.useQuery(
			{ provider: selectedProvider! },
			{ enabled: !!selectedProvider },
		);
	const { data: serverTypes, isLoading: serverTypesLoading } =
		api.cloudProvider.provider.listServerTypes.useQuery(
			{ provider: selectedProvider! },
			{ enabled: !!selectedProvider },
		);
	const { data: images, isLoading: imagesLoading } =
		api.cloudProvider.provider.listImages.useQuery(
			{ provider: selectedProvider! },
			{ enabled: !!selectedProvider },
		);

	const { mutateAsync: provisionServer, isLoading: isProvisioning } =
		api.cloudProvider.server.provision.useMutation({
			onSuccess: async () => {
				await utils.cloudProvider.job.list.refetch();
			},
		});

	const form = useForm<ProvisionServerInput>({
		defaultValues: {
			provider: supportedCloudProviderIds[0],
			name: "",
			location: "",
			serverType: "",
			image: "",
		},
		resolver: (zodResolver as any)(provisionServerSchema),
	});

	const hasValidCredentials = (provider: ProviderId) =>
		credentials?.some(
			(credential: any) =>
				credential.provider === provider && credential.isValid === "valid",
		) ?? false;

	const filteredProviders = cloudProviderCatalogDefinitions.filter((provider) => {
		const matchesQuery =
			providerQuery.trim() === "" ||
			provider.label.toLowerCase().includes(providerQuery.toLowerCase()) ||
			provider.description.toLowerCase().includes(providerQuery.toLowerCase());
		return matchesQuery;
	});

	const onSubmit = async (data: ProvisionServerInput) => {
		await provisionServer(data)
			.then(async (result: any) => {
				toast.success(
					`Server provisioning started! Job ID: ${result.jobId.slice(0, 8)}`,
					{
						duration: 5000,
					},
				);

				setIsOpen(false);
				form.reset();
				setStep("provider");
				setSelectedProvider(null);

				await utils.cloudProvider.job.list.refetch();
				await utils.server.all.invalidate();

				setTimeout(() => {
					const jobsSection = document.querySelector(
						"[data-provisioning-jobs]",
					);
					if (jobsSection) {
						jobsSection.scrollIntoView({
							behavior: "smooth",
							block: "start",
						});
					}
				}, 100);
			})
			.catch((error: unknown) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Error starting server provisioning",
				);
			});
	};

	const handleProviderSelect = (provider: ProviderId) => {
		setSelectedProvider(provider);
		form.setValue("provider", provider);
		setStep("config");
	};

	const handleBack = () => {
		setStep("provider");
		form.reset();
	};

	const handleClose = () => {
		setIsOpen(false);
		setStep("provider");
		setSelectedProvider(null);
		setProviderQuery("");
		form.reset();
	};

	const selectedProviderDefinition =
		selectedProvider && getCloudProviderDefinition(selectedProvider);

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button className="cursor-pointer space-x-3" variant="default">
					<RocketIcon className="h-4 w-4" />
					<span>Provision Server</span>
				</Button>
			</DialogTrigger>
			<DialogContent className="w-[92vw] max-w-[72rem] sm:max-w-[72rem] max-h-[90vh] overflow-hidden p-0">
				<div className="flex max-h-[90vh] min-h-0 flex-col">
					<DialogHeader className="border-b px-6 py-5">
						<div className="space-y-4 pr-10">
							<div className="space-y-1">
								<DialogTitle className="flex items-center gap-2">
									<CloudIcon className="size-5" />
									Provision New Server
								</DialogTitle>
								<DialogDescription className="leading-relaxed">
									{step === "provider" ? (
										<>
											<span className="block">
												Search providers, compare availability, and choose where to
												provision.
											</span>
											<span className="block">
												Use credentials management if you need to connect a provider
												first.
											</span>
										</>
									) : selectedProviderDefinition ? (
										<>
											<span className="block">
												Configure your {selectedProviderDefinition.label} server and
												continue.
											</span>
											<span className="block">
												Then pick the location, size, and image for the server.
											</span>
										</>
									) : (
										<>
											<span className="block">
												Configure your new server and continue.
											</span>
											<span className="block">
												Then pick the location, size, and image for the server.
											</span>
										</>
									)}
								</DialogDescription>
							</div>

							<Button
								type="button"
								variant="outline"
								className="bg-white text-foreground hover:bg-muted/50"
								onClick={() => {
									setIsOpen(false);
									window.location.href =
										"/dashboard/settings/configuration#cloud-providers";
								}}
							>
								<Key className="size-4" />
								Manage credentials
							</Button>
						</div>
					</DialogHeader>

					{step === "provider" ? (
						<div className="flex min-h-0 flex-1 flex-col">
							<div className="border-b px-6 py-4 space-y-4">
								{credentials?.length === 0 && (
									<div className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
										No cloud provider credentials configured. Please add your
										provider credentials in{" "}
										<a
											href="/dashboard/settings/configuration#cloud-providers"
											className="text-primary hover:underline"
											onClick={() => setIsOpen(false)}
											>
												Configuration
											</a>{" "}
											first.
										</div>
									)}

								<div className="grid gap-3 lg:grid-cols-[1fr_auto]">
									<div className="relative">
										<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
										<Input
											value={providerQuery}
											onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
												setProviderQuery(event.target.value)
											}
											placeholder="Search providers..."
											className="pl-9"
										/>
									</div>
								</div>

								<div className="flex items-center justify-between text-sm text-muted-foreground">
									<span>
										{filteredProviders.length} provider
										{filteredProviders.length === 1 ? "" : "s"}
									</span>
								</div>
							</div>

							<ScrollArea className="flex-1 px-6 py-6">
								<div className="grid gap-4 md:grid-cols-2">
									{filteredProviders.map((provider) => (
										<ProviderCard
											key={provider.id}
											provider={provider}
											disabled={
												provider.availability !== "supported" ||
												!hasValidCredentials(provider.id as ProviderId)
											}
											hasCredentials={hasValidCredentials(
												provider.id as ProviderId,
											)}
											onSelect={handleProviderSelect}
										/>
									))}
								</div>
								{filteredProviders.length === 0 && (
									<div className="flex min-h-[30vh] items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-10 text-sm text-muted-foreground">
										No providers match your search.
									</div>
								)}
							</ScrollArea>
						</div>
					) : (
						<div className="flex-1 overflow-y-auto px-6 py-6">
					<Form {...form}>
						<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Server Name</FormLabel>
										<FormControl>
											<Input placeholder="my-app-server" {...field} />
										</FormControl>
										<FormDescription>
											A unique name for your server (lowercase letters, numbers,
											and hyphens only)
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="location"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Location</FormLabel>
										<Select
											onValueChange={field.onChange}
											defaultValue={field.value}
											disabled={locationsLoading}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select a location" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{locationsLoading ? (
													<div className="flex items-center justify-center p-4">
														<Loader2 className="size-4 animate-spin" />
													</div>
												) : (
													locations?.map((location: any) => (
														<SelectItem key={location.id} value={location.id}>
															{location.city}, {location.country} -{" "}
															{location.name}
														</SelectItem>
													))
												)}
											</SelectContent>
										</Select>
										<FormDescription>
											Select the datacenter location for your server
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="serverType"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Server Type</FormLabel>
										<Select
											onValueChange={field.onChange}
											defaultValue={field.value}
											disabled={serverTypesLoading}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select server type" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{serverTypesLoading ? (
													<div className="flex items-center justify-center p-4">
														<Loader2 className="size-4 animate-spin" />
													</div>
												) : (
													serverTypes?.map((type: any) => (
														<SelectItem key={type.id} value={type.id}>
															{type.name} - {type.cores} vCPU, {type.memory} GB
															RAM, {type.disk}GB SSD (€{type.priceMonthly.toFixed(2)}
															/mo)
														</SelectItem>
													))
												)}
											</SelectContent>
										</Select>
										<FormDescription>
											Choose your server size and specifications
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="image"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Operating System</FormLabel>
										<Select
											onValueChange={field.onChange}
											defaultValue={field.value}
											disabled={imagesLoading}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select OS image" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{imagesLoading ? (
													<div className="flex items-center justify-center p-4">
														<Loader2 className="size-4 animate-spin" />
													</div>
												) : (
													images?.map((image: any) => (
														<SelectItem key={image.id} value={image.id}>
															{image.name} ({image.osType}{" "}
															{image.osVersion && `- ${image.osVersion}`})
														</SelectItem>
													))
												)}
											</SelectContent>
										</Select>
										<FormDescription>
											Select the operating system for your server
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>

							<div className="flex gap-2 justify-end pt-4">
								<Button type="button" variant="outline" onClick={handleBack}>
									Back
								</Button>
								<Button type="button" variant="secondary" onClick={handleClose}>
									Cancel
								</Button>
								<Button type="submit" isLoading={isProvisioning}>
									<RocketIcon className="mr-2 size-4" />
									Provision Server
								</Button>
							</div>
						</form>
					</Form>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
};
