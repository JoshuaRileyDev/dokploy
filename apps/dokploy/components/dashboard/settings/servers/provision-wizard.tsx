import {
	ArrowLeft,
	Check,
	Cpu,
	Globe2,
	HardDrive,
	History,
	Loader2,
	MemoryStick,
	Plus,
	SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { HandleCloudProvider } from "@/components/dashboard/settings/cloud-providers/handle-cloud-provider";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type Comparison = RouterOutputs["cloudProvider"]["compare"];
type Account = Comparison["accounts"][number];
type Offer = Comparison["offers"][number];
type Location = Account["locations"][number];

export interface ServerSelection {
	cloudProviderAccountId: string;
	providerType: string;
	location: string;
	serverType: string;
}

type Step = "size" | "region" | "server" | "details";

const STEPS: { id: Step; label: string }[] = [
	{ id: "size", label: "Size" },
	{ id: "region", label: "Region" },
	{ id: "server", label: "Server" },
	{ id: "details", label: "Details" },
];

interface Size {
	id: string;
	label: string;
	description: string;
	cpu: number;
	memory: number;
	disk: number;
}

const PRESETS: Size[] = [
	{
		id: "starter",
		label: "Starter",
		description: "A couple of small apps, or a build server",
		cpu: 1,
		memory: 2,
		disk: 0,
	},
	{
		id: "small",
		label: "Small",
		description: "A handful of apps and a database",
		cpu: 2,
		memory: 4,
		disk: 0,
	},
	{
		id: "medium",
		label: "Medium",
		description: "Busy apps with several databases",
		cpu: 4,
		memory: 8,
		disk: 0,
	},
	{
		id: "large",
		label: "Large",
		description: "Many services or heavy builds",
		cpu: 8,
		memory: 16,
		disk: 0,
	},
	{
		id: "xlarge",
		label: "Extra large",
		description: "Large databases and high traffic",
		cpu: 16,
		memory: 32,
		disk: 0,
	},
];

const CPU_OPTIONS = [1, 2, 4, 8, 16, 32];
const MEMORY_OPTIONS = [1, 2, 4, 8, 16, 32, 64];
const DISK_OPTIONS = [0, 25, 50, 100, 200, 500];
const DISPLAY_CURRENCIES = ["EUR", "USD", "GBP"];
const SHORTLIST = 5;

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const flagOf = (country: string) =>
	country
		? country
				.toUpperCase()
				.replace(/./g, (char) =>
					String.fromCodePoint(127397 + char.charCodeAt(0)),
				)
		: "";

interface Placement {
	location: Location;
	/** In the display currency when rates are available. */
	monthly: number | null;
	nativeMonthly: number | null;
}

interface Match {
	offer: Offer;
	account: Account;
	/** Every orderable location in the chosen region, cheapest first. */
	placements: Placement[];
	cheapest: Placement;
}

const byPrice = (a: number | null, b: number | null) =>
	(a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY);

const StepIndicator = ({ current }: { current: Step }) => {
	const currentIndex = STEPS.findIndex((step) => step.id === current);
	return (
		<ol className="flex flex-wrap items-center gap-2 text-xs">
			{STEPS.map((step, index) => (
				<li key={step.id} className="flex items-center gap-2">
					<span
						className={cn(
							"flex items-center gap-1.5",
							index === currentIndex
								? "font-medium text-foreground"
								: "text-muted-foreground",
						)}
					>
						<span
							className={cn(
								"flex size-5 items-center justify-center rounded-full border text-[10px] tabular-nums",
								index < currentIndex &&
									"border-primary bg-primary text-primary-foreground",
								index === currentIndex && "border-foreground",
							)}
						>
							{index < currentIndex ? <Check className="size-3" /> : index + 1}
						</span>
						{step.label}
					</span>
					{index < STEPS.length - 1 && (
						<span className="h-px w-5 bg-border" aria-hidden />
					)}
				</li>
			))}
		</ol>
	);
};

const SpecLine = ({ offer }: { offer: Offer }) => (
	<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
		<span className="flex items-center gap-1">
			<Cpu className="size-3.5" />
			{offer.cores ?? "–"} vCPU
		</span>
		<span className="flex items-center gap-1">
			<MemoryStick className="size-3.5" />
			{offer.memoryGb !== null ? `${offer.memoryGb} GB` : "–"}
		</span>
		<span className="flex items-center gap-1">
			<HardDrive className="size-3.5" />
			{offer.diskGb} GB
		</span>
		{offer.architecture === "arm" && <Badge variant="blank">Arm</Badge>}
	</span>
);

const ChoiceCard = ({
	selected,
	onClick,
	children,
	className,
}: {
	selected: boolean;
	onClick: () => void;
	children: React.ReactNode;
	className?: string;
}) => (
	<button
		type="button"
		onClick={onClick}
		aria-pressed={selected}
		className={cn(
			"flex w-full rounded-lg border bg-background p-3 text-left transition-colors duration-150 ease-out hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			selected &&
				"border-primary bg-primary/5 ring-1 ring-primary hover:border-primary hover:bg-primary/5",
			className,
		)}
	>
		{children}
	</button>
);

export const ProvisionWizard = ({
	hasProvisionings,
	onShowProgress,
	onProvisioned,
	onConfigureManually,
}: {
	hasProvisionings: boolean;
	onShowProgress: () => void;
	onProvisioned: () => void;
	onConfigureManually: (selection: ServerSelection) => void;
}) => {
	const utils = api.useUtils();
	const { data, isPending, error } = api.cloudProvider.compare.useQuery(
		undefined,
		{ staleTime: 5 * 60_000, retry: false },
	);
	const { data: providers } = api.cloudProvider.providers.useQuery();

	const [step, setStep] = useState<Step>("size");
	const [sizeId, setSizeId] = useState("small");
	const [custom, setCustom] = useState({ cpu: 2, memory: 4, disk: 0 });
	const [architecture, setArchitecture] = useState<"any" | "x86" | "arm">(
		"any",
	);
	const [continent, setContinent] = useState("any");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [showAll, setShowAll] = useState(false);
	const [displayCurrency, setDisplayCurrency] = useState("EUR");

	const [name, setName] = useState("");
	const [locationId, setLocationId] = useState("");
	const [imageId, setImageId] = useState("");
	const [role, setRole] = useState<"deploy" | "build">("deploy");

	const size: Size =
		sizeId === "custom"
			? {
					id: "custom",
					label: "Custom",
					description: "",
					...custom,
				}
			: (PRESETS.find((preset) => preset.id === sizeId) as Size);

	const accounts = useMemo(
		() =>
			new Map(
				(data?.accounts ?? []).map((account) => [
					account.cloudProviderAccountId,
					account,
				]),
			),
		[data],
	);
	const canConvert = !!data?.rates;
	const unconnected = (providers ?? []).filter(
		(provider) =>
			!(data?.accounts ?? []).some((a) => a.providerType === provider.type),
	);

	const money = (amount: number, currency: string) =>
		new Intl.NumberFormat(undefined, {
			style: "currency",
			currency,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(amount);

	/** Offers that fit a size, with their priced locations per continent filter. */
	const findMatches = (target: Size, region: string) => {
		const convert = (amount: number | null, from: string) => {
			if (amount === null) return null;
			const rates = data?.rates?.perEuro;
			const fromRate = rates?.[from];
			const toRate = rates?.[displayCurrency];
			if (!fromRate || !toRate) return null;
			return (amount / fromRate) * toRate;
		};
		const matches: Match[] = [];
		for (const offer of data?.offers ?? []) {
			const account = accounts.get(offer.cloudProviderAccountId);
			if (!account?.currency) continue;
			if (offer.cores === null || offer.memoryGb === null) continue;
			if (offer.cores < target.cpu || offer.memoryGb < target.memory) continue;
			if (offer.diskGb < target.disk) continue;
			if (architecture !== "any" && offer.architecture !== architecture) {
				continue;
			}
			const placements = offer.locations
				.flatMap((entry) => {
					const location = account.locations.find((l) => l.id === entry.id);
					if (!location) return [];
					if (region !== "any" && location.continent !== region) return [];
					return [
						{
							location,
							nativeMonthly: entry.monthly,
							monthly: canConvert
								? convert(entry.monthly, account.currency as string)
								: entry.monthly,
						},
					];
				})
				.sort((a, b) => byPrice(a.monthly, b.monthly));
			const cheapest = placements[0];
			if (!cheapest) continue;
			matches.push({ offer, account, placements, cheapest });
		}
		return matches.sort((a, b) =>
			byPrice(a.cheapest.monthly, b.cheapest.monthly),
		);
	};

	const summarize = (matches: Match[]) => ({
		count: matches.length,
		from: matches.find((m) => m.cheapest.monthly !== null)?.cheapest.monthly,
	});

	const sizeMatches = useMemo(
		() => findMatches(size, "any"),
		[data, accounts, sizeId, custom, architecture, displayCurrency],
	);
	const regionMatches = useMemo(
		() => findMatches(size, continent),
		[data, accounts, sizeId, custom, architecture, continent, displayCurrency],
	);

	const continents = useMemo(() => {
		const names = new Set<string>();
		for (const match of sizeMatches) {
			for (const placement of match.placements) {
				names.add(placement.location.continent);
			}
		}
		return [...names].sort();
	}, [sizeMatches]);

	// One per account so providers can be compared at a glance.
	const shortlist = useMemo(() => {
		const seen = new Set<string>();
		return regionMatches
			.filter((match) => {
				const id = match.account.cloudProviderAccountId;
				if (seen.has(id)) return false;
				seen.add(id);
				return true;
			})
			.slice(0, SHORTLIST);
	}, [regionMatches]);

	const matchKey = (match: Match) =>
		`${match.account.cloudProviderAccountId}:${match.offer.serverType}`;
	const selected = regionMatches.find((m) => matchKey(m) === selectedKey);

	useEffect(() => {
		if (step === "server" && !selected && regionMatches[0]) {
			setSelectedKey(matchKey(regionMatches[0]));
		}
	}, [step, selected, regionMatches]);

	useEffect(() => {
		if (
			selected &&
			!selected.placements.some((p) => p.location.id === locationId)
		) {
			setLocationId(selected.cheapest.location.id);
		}
	}, [selected, locationId]);

	const { data: catalog, isFetching: isLoadingImages } =
		api.cloudProvider.catalog.useQuery(
			{
				cloudProviderAccountId: selected?.account.cloudProviderAccountId ?? "",
			},
			{
				enabled: step === "details" && !!selected,
				staleTime: 5 * 60_000,
				retry: false,
			},
		);
	const images = useMemo(
		() =>
			(catalog?.images ?? []).filter(
				(image) => image.architecture === selected?.offer.architecture,
			),
		[catalog, selected],
	);
	useEffect(() => {
		if (images.length === 0 || images.some((image) => image.id === imageId)) {
			return;
		}
		const ubuntu = images.find((image) => image.osFlavor === "ubuntu");
		setImageId((ubuntu ?? images[0])?.id ?? "");
	}, [images, imageId]);

	const provision = api.cloudProvider.provision.useMutation();
	const nameError =
		name && !NAME_PATTERN.test(name)
			? "Use lowercase letters, numbers and hyphens"
			: name.length > 63
				? "63 characters or fewer"
				: null;

	const onCreate = async () => {
		if (!selected) return;
		await provision
			.mutateAsync({
				cloudProviderAccountId: selected.account.cloudProviderAccountId,
				name,
				location: locationId,
				serverType: selected.offer.serverType,
				image: imageId,
				role,
			})
			.then(async () => {
				toast.success(`Creating ${name} on ${selected.account.providerLabel}`);
				await utils.cloudProvider.provisionings.invalidate();
				onProvisioned();
			})
			.catch((err) =>
				toast.error("Could not start provisioning", {
					description: err.message,
				}),
			);
	};

	const priceText = (monthly: number | null | undefined, native: string) =>
		monthly === null || monthly === undefined
			? null
			: money(monthly, canConvert ? displayCurrency : native);

	const stepIndex = STEPS.findIndex((s) => s.id === step);
	const goBack = () => setStep(STEPS[stepIndex - 1]?.id ?? "size");
	const hasAccounts = (data?.accounts.length ?? 0) > 0;
	const failed = (data?.accounts ?? []).filter((account) => account.error);

	const connectButtons =
		unconnected.length > 0 ? (
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span>Add another provider:</span>
				{unconnected.map((provider) => (
					<HandleCloudProvider
						key={provider.type}
						providerType={provider.type}
						onConnected={() => utils.cloudProvider.compare.invalidate()}
					>
						<Button variant="outline" size="sm" className="h-7 gap-1.5 px-2">
							<CloudProviderIcon
								providerType={provider.type}
								className="size-4"
							/>
							{provider.label}
							<Plus className="size-3" />
						</Button>
					</HandleCloudProvider>
				))}
			</div>
		) : null;

	const titles: Record<Step, { title: string; description: string }> = {
		size: {
			title: "How big a server do you need?",
			description:
				"Pick what you'll run on it. You can see the exact options next.",
		},
		region: {
			title: "Where should it run?",
			description: "Closer to your users means faster responses.",
		},
		server: {
			title: "Choose a server",
			description: `The cheapest ${size.label.toLowerCase()} server from each of your accounts, ${continent === "any" ? "anywhere" : `in ${continent}`}.`,
		},
		details: {
			title: "Name and create it",
			description:
				"Dokploy creates the server, installs Docker and Traefik, and adds it to your servers.",
		},
	};

	return (
		<>
			<DialogHeader className="gap-3">
				<div className="flex items-start gap-3">
					{step !== "size" && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-8 shrink-0"
							onClick={goBack}
						>
							<ArrowLeft className="size-4" />
							<span className="sr-only">Back</span>
						</Button>
					)}
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<DialogTitle>{titles[step].title}</DialogTitle>
						<DialogDescription>{titles[step].description}</DialogDescription>
					</div>
					<div className="flex shrink-0 items-center gap-2 pr-6">
						{hasProvisionings && (
							<Button
								variant="ghost"
								size="sm"
								onClick={onShowProgress}
								className="h-8"
							>
								<History className="size-4" />
								<span className="sr-only sm:not-sr-only">Recent</span>
							</Button>
						)}
						{canConvert && (
							<Select
								value={displayCurrency}
								onValueChange={setDisplayCurrency}
							>
								<SelectTrigger className="h-8 w-[84px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DISPLAY_CURRENCIES.map((currency) => (
										<SelectItem key={currency} value={currency}>
											{currency}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</div>
				</div>
				{hasAccounts && <StepIndicator current={step} />}
			</DialogHeader>

			{failed.map((account) => (
				<AlertBlock key={account.cloudProviderAccountId} type="error">
					{account.providerLabel} · {account.name}: {account.error}
				</AlertBlock>
			))}
			{error && <AlertBlock type="error">{error.message}</AlertBlock>}

			{isPending ? (
				<div className="flex min-h-[40vh] items-center justify-center gap-3 text-sm text-muted-foreground">
					<Loader2 className="size-5 animate-spin" />
					Loading server options from your accounts…
				</div>
			) : !hasAccounts ? (
				<div className="flex flex-col gap-3">
					<span className="text-sm text-muted-foreground">
						Connect a cloud provider account to create servers from here.
					</span>
					<div className="grid gap-2 sm:grid-cols-2">
						{unconnected.map((provider) => (
							<HandleCloudProvider
								key={provider.type}
								providerType={provider.type}
								onConnected={() => utils.cloudProvider.compare.invalidate()}
							>
								<button
									type="button"
									className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
								>
									<CloudProviderIcon
										providerType={provider.type}
										className="size-8 shrink-0"
									/>
									<span className="flex min-w-0 flex-col">
										<span className="text-sm font-medium">
											Connect {provider.label}
										</span>
										<span className="text-xs text-muted-foreground">
											{provider.description}
										</span>
									</span>
								</button>
							</HandleCloudProvider>
						))}
					</div>
				</div>
			) : (
				<>
					{step === "size" && (
						<div className="flex flex-col gap-4">
							<div className="grid gap-2 sm:grid-cols-2">
								{PRESETS.map((preset) => {
									const { count, from } = summarize(findMatches(preset, "any"));
									return (
										<ChoiceCard
											key={preset.id}
											selected={sizeId === preset.id}
											onClick={() => setSizeId(preset.id)}
											className="flex-col gap-1.5"
										>
											<span className="flex w-full items-center justify-between gap-2">
												<span className="text-sm font-medium">
													{preset.label}
												</span>
												<span className="text-sm tabular-nums">
													{from !== undefined && from !== null
														? `from ${priceText(from, "EUR")}`
														: count === 0
															? "Not available"
															: ""}
												</span>
											</span>
											<span className="text-xs text-muted-foreground">
												{preset.cpu}+ vCPU · {preset.memory}+ GB memory ·{" "}
												{preset.description}
											</span>
											<span className="text-[11px] text-muted-foreground">
												{count} option{count === 1 ? "" : "s"}
											</span>
										</ChoiceCard>
									);
								})}
								<ChoiceCard
									selected={sizeId === "custom"}
									onClick={() => setSizeId("custom")}
									className="flex-col gap-1.5"
								>
									<span className="flex items-center gap-2 text-sm font-medium">
										<SlidersHorizontal className="size-4" />
										Custom
									</span>
									<span className="text-xs text-muted-foreground">
										Set the minimum vCPU, memory and disk yourself
									</span>
								</ChoiceCard>
							</div>

							{sizeId === "custom" && (
								<div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
									{(
										[
											["cpu", "vCPU", CPU_OPTIONS, "vCPU"],
											["memory", "Memory", MEMORY_OPTIONS, "GB"],
											["disk", "Disk", DISK_OPTIONS, "GB"],
										] as const
									).map(([key, label, options, unit]) => (
										<div key={key} className="grid gap-1.5">
											<Label className="text-xs text-muted-foreground">
												{label}
											</Label>
											<Select
												value={String(custom[key])}
												onValueChange={(value) =>
													setCustom((current) => ({
														...current,
														[key]: Number(value),
													}))
												}
											>
												<SelectTrigger className="h-9">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{options.map((option) => (
														<SelectItem key={option} value={String(option)}>
															{option === 0 ? "Any" : `${option}+ ${unit}`}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									))}
								</div>
							)}

							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex items-center gap-2 text-sm">
									<span className="text-muted-foreground">CPU</span>
									<Tabs
										value={architecture}
										onValueChange={(value) =>
											setArchitecture(value as typeof architecture)
										}
									>
										<TabsList>
											<TabsTrigger value="any">Any</TabsTrigger>
											<TabsTrigger value="x86">x86</TabsTrigger>
											<TabsTrigger value="arm">Arm</TabsTrigger>
										</TabsList>
									</Tabs>
								</div>
								{connectButtons}
							</div>
						</div>
					)}

					{step === "region" && (
						<div className="grid gap-2 sm:grid-cols-2">
							{["any", ...continents].map((region) => {
								const { count, from } = summarize(
									region === "any" ? sizeMatches : findMatches(size, region),
								);
								return (
									<ChoiceCard
										key={region}
										selected={continent === region}
										onClick={() => setContinent(region)}
										className="items-center gap-3"
									>
										<Globe2 className="size-5 shrink-0 text-muted-foreground" />
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="text-sm font-medium">
												{region === "any" ? "Anywhere" : region}
											</span>
											<span className="text-xs text-muted-foreground">
												{region === "any"
													? "Whichever location is cheapest"
													: `${count} option${count === 1 ? "" : "s"}`}
											</span>
										</span>
										<span className="shrink-0 text-sm tabular-nums">
											{from !== undefined && from !== null
												? `from ${priceText(from, "EUR")}`
												: ""}
										</span>
									</ChoiceCard>
								);
							})}
						</div>
					)}

					{step === "server" && (
						<div className="flex flex-col gap-2">
							{regionMatches.length === 0 ? (
								<AlertBlock type="info">
									None of your accounts offer a {size.label.toLowerCase()}{" "}
									server there. Go back and pick another size or region.
								</AlertBlock>
							) : (
								<>
									{(showAll ? regionMatches : shortlist).map((match, index) => {
										const key = matchKey(match);
										return (
											<ChoiceCard
												key={key}
												selected={key === selectedKey}
												onClick={() => setSelectedKey(key)}
												className="items-center gap-3"
											>
												<CloudProviderIcon
													providerType={match.account.providerType}
													className="size-9 shrink-0"
												/>
												<span className="flex min-w-0 flex-1 flex-col gap-1">
													<span className="flex items-center gap-2">
														<span className="truncate text-sm font-medium">
															{match.offer.label}
														</span>
														{index === 0 && (
															<Badge variant="green">Lowest price</Badge>
														)}
													</span>
													<span className="truncate text-xs text-muted-foreground">
														{match.account.providerLabel} · {match.offer.family}{" "}
														· {flagOf(match.cheapest.location.country)}{" "}
														{match.cheapest.location.city}
														{match.placements.length > 1 &&
															` +${match.placements.length - 1} more`}
													</span>
													<SpecLine offer={match.offer} />
												</span>
												<span className="flex shrink-0 flex-col items-end">
													<span className="text-sm font-semibold tabular-nums">
														{priceText(
															match.cheapest.monthly,
															match.account.currency as string,
														) ?? "–"}
													</span>
													<span className="text-[11px] text-muted-foreground">
														per month
													</span>
												</span>
											</ChoiceCard>
										);
									})}
									<div className="flex flex-wrap items-center justify-between gap-2 pt-1">
										{regionMatches.length > shortlist.length ? (
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setShowAll(!showAll)}
											>
												{showAll
													? "Show fewer"
													: `Show all ${regionMatches.length} options`}
											</Button>
										) : (
											<span />
										)}
										{selected && (
											<button
												type="button"
												className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
												onClick={() =>
													onConfigureManually({
														cloudProviderAccountId:
															selected.account.cloudProviderAccountId,
														providerType: selected.account.providerType,
														location: selected.cheapest.location.id,
														serverType: selected.offer.serverType,
													})
												}
											>
												Configure manually
											</button>
										)}
									</div>
									<p className="text-xs text-muted-foreground">
										{data?.rates
											? `Before tax, converted at European Central Bank rates from ${data.rates.date}. Each provider bills in its own currency.`
											: "Before tax."}
									</p>
								</>
							)}
						</div>
					)}

					{step === "details" && selected && (
						<div className="flex flex-col gap-4">
							<div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
								<CloudProviderIcon
									providerType={selected.account.providerType}
									className="size-9 shrink-0"
								/>
								<span className="flex min-w-0 flex-1 flex-col gap-1">
									<span className="truncate text-sm font-medium">
										{selected.offer.label} · {selected.account.providerLabel}
									</span>
									<SpecLine offer={selected.offer} />
								</span>
								<span className="shrink-0 text-sm font-semibold tabular-nums">
									{priceText(
										selected.placements.find(
											(p) => p.location.id === locationId,
										)?.monthly ?? selected.cheapest.monthly,
										selected.account.currency as string,
									) ?? "–"}
									<span className="text-xs font-normal text-muted-foreground">
										/mo
									</span>
								</span>
							</div>

							<div className="grid gap-4 sm:grid-cols-2">
								<div className="grid gap-1.5">
									<Label htmlFor="provision-name">Server name</Label>
									<Input
										id="provision-name"
										placeholder="web-1"
										autoComplete="off"
										value={name}
										onChange={(e) => setName(e.target.value.toLowerCase())}
									/>
									{nameError && (
										<span className="text-xs text-destructive">
											{nameError}
										</span>
									)}
								</div>
								<div className="grid gap-1.5">
									<Label>Use as</Label>
									<Tabs
										value={role}
										onValueChange={(value) =>
											setRole(value as "deploy" | "build")
										}
									>
										<TabsList>
											<TabsTrigger value="deploy">Deploy server</TabsTrigger>
											<TabsTrigger value="build">Build server</TabsTrigger>
										</TabsList>
									</Tabs>
								</div>
								<div className="grid gap-1.5">
									<Label>Location</Label>
									<Select value={locationId} onValueChange={setLocationId}>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{selected.placements.map((placement) => (
												<SelectItem
													key={placement.location.id}
													value={placement.location.id}
												>
													{flagOf(placement.location.country)}{" "}
													{placement.location.city}
													{placement.monthly !== null &&
														` · ${priceText(placement.monthly, selected.account.currency as string)}`}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="grid gap-1.5">
									<Label>Operating system</Label>
									<Select
										value={imageId}
										onValueChange={setImageId}
										disabled={isLoadingImages && images.length === 0}
									>
										<SelectTrigger className="w-full">
											<SelectValue
												placeholder={isLoadingImages ? "Loading…" : "Select"}
											/>
										</SelectTrigger>
										<SelectContent>
											{images.map((image) => (
												<SelectItem key={image.id} value={image.id}>
													{image.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>

							{selected.account.removal === "cancel" && (
								<AlertBlock type="warning">
									{selected.account.providerLabel} bills by the month and
									servers can only be cancelled for the end of their term, not
									deleted.
								</AlertBlock>
							)}
						</div>
					)}

					<DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
						<span className="text-xs text-muted-foreground">
							{step !== "size" &&
								`${size.label}${architecture !== "any" ? ` · ${architecture === "arm" ? "Arm" : "x86"}` : ""}${step !== "region" ? ` · ${continent === "any" ? "Anywhere" : continent}` : ""}`}
						</span>
						{step === "details" ? (
							<Button
								onClick={onCreate}
								isLoading={provision.isPending}
								disabled={!name || !!nameError || !imageId || !locationId}
							>
								Create server
							</Button>
						) : (
							<Button
								onClick={() => setStep(STEPS[stepIndex + 1]?.id ?? "details")}
								disabled={
									(step === "size" && sizeMatches.length === 0) ||
									(step === "server" && !selected)
								}
							>
								Continue
							</Button>
						)}
					</DialogFooter>
				</>
			)}
		</>
	);
};
