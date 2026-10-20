import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	ArrowLeft,
	ChevronRight,
	Cloud,
	Cpu,
	HardDrive,
	Loader2,
	MemoryStick,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { HandleCloudProvider } from "@/components/dashboard/settings/cloud-providers/handle-cloud-provider";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
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
import {
	Form,
	FormControl,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";
import {
	hasOrphanedServer,
	ServerProvisioningList,
	useServerProvisionings,
} from "./server-provisionings";

type ProviderDefinition = RouterOutputs["cloudProvider"]["providers"][number];
type Account = RouterOutputs["cloudProvider"]["all"][number];

const Schema = z.object({
	cloudProviderAccountId: z.string().min(1, "Choose an account"),
	name: z
		.string()
		.min(1, "Name is required")
		.max(63, "Name must be 63 characters or fewer")
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
			"Use lowercase letters, numbers and hyphens",
		),
	location: z.string().min(1, "Choose a location"),
	serverType: z.string().min(1, "Choose a server type"),
	image: z.string().min(1, "Choose an image"),
	role: z.enum(["deploy", "build"]),
});

type Schema = z.infer<typeof Schema>;

const flagOf = (country: string) =>
	country
		.toUpperCase()
		.replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));

type Step =
	| { kind: "choose" }
	| { kind: "configure"; provider: ProviderDefinition }
	| { kind: "progress" };

export const ProvisionServer = () => {
	const [isOpen, setIsOpen] = useState(false);
	const [step, setStep] = useState<Step>({ kind: "choose" });
	const { provisionings, runningCount } = useServerProvisionings();

	const { data: providers, isPending: isLoadingProviders } =
		api.cloudProvider.providers.useQuery(undefined, { enabled: isOpen });
	const { data: accounts } = api.cloudProvider.all.useQuery(undefined, {
		enabled: isOpen,
	});

	const onOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (open) {
			const needsAttention =
				runningCount > 0 || provisionings.some(hasOrphanedServer);
			setStep(needsAttention ? { kind: "progress" } : { kind: "choose" });
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline" className="cursor-pointer">
					{runningCount > 0 ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Cloud className="size-4" />
					)}
					{runningCount > 0
						? `Provisioning ${runningCount}…`
						: "Provision Server"}
				</Button>
			</DialogTrigger>
			<DialogContent
				className={cn(
					"max-h-[92vh] overflow-y-auto",
					step.kind === "configure" ? "sm:max-w-3xl" : "sm:max-w-2xl",
				)}
			>
				{step.kind === "choose" && (
					<ChooseProvider
						providers={providers}
						accounts={accounts}
						isLoading={isLoadingProviders}
						hasProvisionings={provisionings.length > 0}
						onChoose={(provider) => setStep({ kind: "configure", provider })}
						onShowProgress={() => setStep({ kind: "progress" })}
					/>
				)}
				{step.kind === "configure" && (
					<ConfigureServer
						provider={step.provider}
						accounts={
							accounts?.filter((a) => a.providerType === step.provider.type) ??
							[]
						}
						onBack={() => setStep({ kind: "choose" })}
						onProvisioned={() => setStep({ kind: "progress" })}
					/>
				)}
				{step.kind === "progress" && (
					<>
						<DialogHeader>
							<DialogTitle>Provisioning</DialogTitle>
							<DialogDescription>
								Servers appear in your list once Dokploy starts installing on
								them. You can close this window; progress carries on.
							</DialogDescription>
						</DialogHeader>
						{provisionings.length === 0 ? (
							<div className="py-8 text-center text-sm text-muted-foreground">
								Nothing is being provisioned.
							</div>
						) : (
							<ServerProvisioningList provisionings={provisionings} />
						)}
						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => setStep({ kind: "choose" })}
							>
								Provision another
							</Button>
							<Button onClick={() => setIsOpen(false)}>Done</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
};

const ChooseProvider = ({
	providers,
	accounts,
	isLoading,
	hasProvisionings,
	onChoose,
	onShowProgress,
}: {
	providers?: ProviderDefinition[];
	accounts?: Account[];
	isLoading: boolean;
	hasProvisionings: boolean;
	onChoose: (provider: ProviderDefinition) => void;
	onShowProgress: () => void;
}) => (
	<>
		<DialogHeader>
			<DialogTitle>Provision a server</DialogTitle>
			<DialogDescription>
				Choose where to create it. Dokploy creates the server, installs Docker
				and Traefik over SSH, and adds it to your servers.
			</DialogDescription>
		</DialogHeader>
		{isLoading ? (
			<div className="flex min-h-[20vh] items-center justify-center">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		) : (
			<ul className="flex flex-col gap-2">
				{providers?.map((provider) => {
					const connected =
						accounts?.filter((a) => a.providerType === provider.type).length ??
						0;
					const row = (
						<button
							type="button"
							onClick={connected ? () => onChoose(provider) : undefined}
							className="group flex w-full items-center gap-3 rounded-lg border bg-background px-4 py-3 text-left transition-colors duration-150 ease-out hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<CloudProviderIcon
								providerType={provider.type}
								className="size-9 shrink-0"
							/>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium">{provider.label}</span>
									{connected > 0 ? (
										<Badge variant="secondary">
											{connected} account{connected === 1 ? "" : "s"}
										</Badge>
									) : (
										<Badge variant="outline">Not connected</Badge>
									)}
								</div>
								<span className="text-xs text-muted-foreground">
									{provider.description}
								</span>
							</div>
							<span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground transition-colors group-hover:text-foreground">
								{connected ? "Continue" : "Connect"}
								<ChevronRight className="size-4" />
							</span>
						</button>
					);
					return (
						<li key={provider.type}>
							{connected ? (
								row
							) : (
								<HandleCloudProvider
									providerType={provider.type}
									onConnected={() => onChoose(provider)}
								>
									{row}
								</HandleCloudProvider>
							)}
						</li>
					);
				})}
			</ul>
		)}
		{hasProvisionings && (
			<button
				type="button"
				onClick={onShowProgress}
				className="self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
			>
				View recent provisioning
			</button>
		)}
	</>
);

const ConfigureServer = ({
	provider,
	accounts,
	onBack,
	onProvisioned,
}: {
	provider: ProviderDefinition;
	accounts: Account[];
	onBack: () => void;
	onProvisioned: () => void;
}) => {
	const utils = api.useUtils();
	const [family, setFamily] = useState("");

	const form = useForm<Schema>({
		defaultValues: {
			cloudProviderAccountId: accounts[0]?.cloudProviderAccountId ?? "",
			name: "",
			location: "",
			serverType: "",
			image: "",
			role: "deploy",
		},
		resolver: zodResolver(Schema),
	});

	const accountId = form.watch("cloudProviderAccountId");
	const location = form.watch("location");
	const serverTypeId = form.watch("serverType");
	const imageId = form.watch("image");

	useEffect(() => {
		if (!accountId && accounts[0]) {
			form.setValue(
				"cloudProviderAccountId",
				accounts[0].cloudProviderAccountId,
			);
		}
	}, [accounts, accountId, form]);

	const {
		data: catalog,
		isFetching: isLoadingCatalog,
		error: catalogError,
	} = api.cloudProvider.catalog.useQuery(
		{ cloudProviderAccountId: accountId },
		{ enabled: !!accountId, staleTime: 5 * 60_000, retry: false },
	);

	const { mutateAsync: provision, isPending: isProvisioning } =
		api.cloudProvider.provision.useMutation();

	const money = useMemo(
		() =>
			new Intl.NumberFormat(undefined, {
				style: "currency",
				currency: catalog?.currency ?? "EUR",
				minimumFractionDigits: 2,
			}),
		[catalog?.currency],
	);

	const families = useMemo(
		() => [...new Set(catalog?.serverTypes.map((type) => type.family))],
		[catalog],
	);

	useEffect(() => {
		if (families.length && !families.includes(family)) {
			setFamily(families[0] as string);
		}
	}, [families, family]);

	const selectedLocation = catalog?.locations.find((l) => l.id === location);
	const selectedType = catalog?.serverTypes.find((t) => t.id === serverTypeId);

	const typesInFamily = useMemo(
		() =>
			(catalog?.serverTypes ?? []).filter(
				(type) =>
					type.family === family &&
					type.prices.some((price) => price.location === location),
			),
		[catalog, family, location],
	);

	const images = useMemo(
		() =>
			(catalog?.images ?? []).filter(
				(image) => image.architecture === (selectedType?.architecture ?? "x86"),
			),
		[catalog, selectedType],
	);

	useEffect(() => {
		if (!catalog || catalog.locations.some((l) => l.id === location)) return;
		const first = catalog.locations[0];
		if (first) form.setValue("location", first.id);
	}, [catalog, location, form]);

	useEffect(() => {
		if (!selectedLocation) return;
		const stillValid =
			selectedType &&
			selectedType.family === family &&
			selectedLocation.availableServerTypes.includes(selectedType.id);
		if (stillValid) return;
		const firstAvailable = typesInFamily.find((type) =>
			selectedLocation.availableServerTypes.includes(type.id),
		);
		form.setValue("serverType", firstAvailable?.id ?? "");
	}, [selectedLocation, selectedType, typesInFamily, family, form]);

	useEffect(() => {
		if (images.some((image) => image.id === imageId)) return;
		const ubuntu = images.find((image) => image.osFlavor === "ubuntu");
		form.setValue("image", (ubuntu ?? images[0])?.id ?? "");
	}, [images, imageId, form]);

	const monthlyPrice = selectedType?.prices.find(
		(price) => price.location === location,
	)?.monthly;

	const onSubmit = async (data: Schema) => {
		await provision(data)
			.then(async () => {
				toast.success(`Creating ${data.name} on ${provider.label}`);
				await utils.cloudProvider.provisionings.invalidate();
				onProvisioned();
			})
			.catch((error) => {
				toast.error("Could not start provisioning", {
					description: error.message,
				});
			});
	};

	return (
		<>
			<DialogHeader>
				<div className="flex items-center gap-3">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-8 shrink-0"
						onClick={onBack}
					>
						<ArrowLeft className="size-4" />
						<span className="sr-only">Back</span>
					</Button>
					<CloudProviderIcon
						providerType={provider.type}
						className="size-9 shrink-0"
					/>
					<div className="flex flex-col gap-1">
						<DialogTitle>Create a server on {provider.label}</DialogTitle>
						<DialogDescription>
							It takes about two minutes. You can close this window while it
							runs.
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex flex-col gap-6"
				>
					<div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Server name</FormLabel>
									<FormControl>
										<Input
											placeholder="web-1"
											autoComplete="off"
											{...field}
											onChange={(e) =>
												field.onChange(e.target.value.toLowerCase())
											}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="cloudProviderAccountId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Account</FormLabel>
									<Select
										value={field.value}
										onValueChange={(value) => {
											field.onChange(value);
											form.setValue("location", "");
										}}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select an account" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{accounts.map((a) => (
												<SelectItem
													key={a.cloudProviderAccountId}
													value={a.cloudProviderAccountId}
												>
													{a.name}
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
							name="role"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Use as</FormLabel>
									<Tabs value={field.value} onValueChange={field.onChange}>
										<TabsList>
											<TabsTrigger value="deploy">Deploy</TabsTrigger>
											<TabsTrigger value="build">Build</TabsTrigger>
										</TabsList>
									</Tabs>
								</FormItem>
							)}
						/>
					</div>

					{catalogError ? (
						<AlertBlock type="error">{catalogError.message}</AlertBlock>
					) : isLoadingCatalog && !catalog ? (
						<div className="flex min-h-[30vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-5 animate-spin" />
							Loading locations and prices from {provider.label}…
						</div>
					) : (
						catalog && (
							<>
								<FormField
									control={form.control}
									name="location"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Location</FormLabel>
											<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
												{catalog.locations.map((loc) => {
													const selected = field.value === loc.id;
													return (
														<button
															key={loc.id}
															type="button"
															onClick={() => field.onChange(loc.id)}
															aria-pressed={selected}
															className={cn(
																"flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
																selected &&
																	"border-primary bg-primary/5 ring-1 ring-primary hover:border-primary hover:bg-primary/5",
															)}
														>
															<span className="text-xl leading-none">
																{flagOf(loc.country)}
															</span>
															<span className="flex min-w-0 flex-col">
																<span className="truncate text-sm font-medium">
																	{loc.city}
																</span>
																<span className="text-xs text-muted-foreground">
																	{loc.id} · {loc.region}
																</span>
															</span>
														</button>
													);
												})}
											</div>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="serverType"
									render={({ field }) => (
										<FormItem>
											<div className="flex flex-wrap items-center justify-between gap-2">
												<FormLabel>Server type</FormLabel>
												{families.length > 1 && (
													<Tabs value={family} onValueChange={setFamily}>
														<TabsList>
															{families.map((f) => (
																<TabsTrigger key={f} value={f}>
																	{f}
																</TabsTrigger>
															))}
														</TabsList>
													</Tabs>
												)}
											</div>
											<div className="overflow-hidden rounded-lg border">
												<div className="grid grid-cols-[1.2fr_repeat(3,1fr)_1fr] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
													<span>Type</span>
													<span>vCPU</span>
													<span>Memory</span>
													<span>Disk</span>
													<span className="text-right">Monthly</span>
												</div>
												<div className="max-h-56 overflow-y-auto">
													{typesInFamily.length === 0 ? (
														<div className="px-4 py-6 text-center text-sm text-muted-foreground">
															None of these are offered in{" "}
															{selectedLocation?.city ?? "this location"}.
														</div>
													) : (
														typesInFamily.map((type) => {
															const available =
																selectedLocation?.availableServerTypes.includes(
																	type.id,
																) ?? false;
															const price = type.prices.find(
																(p) => p.location === location,
															);
															const selected = field.value === type.id;
															return (
																<button
																	key={type.id}
																	type="button"
																	disabled={!available}
																	onClick={() => field.onChange(type.id)}
																	aria-pressed={selected}
																	className={cn(
																		"grid w-full grid-cols-[1.2fr_repeat(3,1fr)_1fr] items-center gap-2 border-b px-4 py-2.5 text-left text-sm transition-colors duration-150 ease-out last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
																		selected &&
																			"bg-primary/5 shadow-[inset_3px_0_0_var(--primary)] hover:bg-primary/5",
																	)}
																>
																	<span className="flex items-center gap-2 font-medium">
																		{type.label}
																		{!available && (
																			<span className="text-[10px] font-normal text-muted-foreground">
																				sold out
																			</span>
																		)}
																	</span>
																	<span className="flex items-center gap-1.5 text-muted-foreground">
																		<Cpu className="size-3.5" />
																		{type.cores}
																	</span>
																	<span className="flex items-center gap-1.5 text-muted-foreground">
																		<MemoryStick className="size-3.5" />
																		{type.memoryGb} GB
																	</span>
																	<span className="flex items-center gap-1.5 text-muted-foreground">
																		<HardDrive className="size-3.5" />
																		{type.diskGb} GB
																	</span>
																	<span className="text-right font-medium tabular-nums">
																		{price ? money.format(price.monthly) : "–"}
																	</span>
																</button>
															);
														})
													)}
												</div>
											</div>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="image"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Operating system</FormLabel>
											<Select
												value={field.value}
												onValueChange={field.onChange}
											>
												<FormControl>
													<SelectTrigger className="w-full sm:w-80">
														<SelectValue placeholder="Select an image" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{images.map((image) => (
														<SelectItem key={image.id} value={image.id}>
															{image.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)
					)}

					<DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 flex-col items-stretch gap-3 rounded-b-xl border-t bg-popover px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex flex-col text-sm">
							{selectedType && selectedLocation ? (
								<>
									<span className="font-medium">
										{selectedType.label} in {selectedLocation.city}
									</span>
									<span className="text-muted-foreground">
										{monthlyPrice !== undefined
											? `${money.format(monthlyPrice)} / month, billed by ${provider.label}`
											: `Billed by ${provider.label}`}
									</span>
								</>
							) : (
								<span className="text-muted-foreground">
									Pick a location and server type
								</span>
							)}
						</div>
						<div className="flex gap-2">
							<Button type="button" variant="outline" onClick={onBack}>
								Back
							</Button>
							<Button
								type="submit"
								isLoading={isProvisioning}
								disabled={!catalog}
							>
								Create server
							</Button>
						</div>
					</DialogFooter>
				</form>
			</Form>
		</>
	);
};
