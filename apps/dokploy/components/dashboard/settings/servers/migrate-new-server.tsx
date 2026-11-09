import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import { defaultImage } from "./default-image";

export interface NewServerConfig {
	cloudProviderAccountId: string;
	name: string;
	location: string;
	serverType: string;
	image: string;
}

export const EMPTY_NEW_SERVER: NewServerConfig = {
	cloudProviderAccountId: "",
	name: "",
	location: "",
	serverType: "",
	image: "",
};

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const isNewServerComplete = (config: NewServerConfig) =>
	!!config.cloudProviderAccountId &&
	NAME_PATTERN.test(config.name) &&
	config.name.length <= 63 &&
	!!config.location &&
	!!config.serverType &&
	!!config.image;

/** "amd64"/"arm64" as detected on a server, mapped to the catalog's names. */
const toCatalogArchitecture = (arch: string | null | undefined) =>
	arch === "amd64" ? "x86" : arch === "arm64" ? "arm" : null;

interface Props {
	value: NewServerConfig;
	onChange: (value: NewServerConfig) => void;
	/** The source server's CPU, so the matching server types come first. */
	sourceArchitecture?: string | null;
}

export const NewServerFields = ({
	value,
	onChange,
	sourceArchitecture,
}: Props) => {
	const { data: accounts, isPending: isLoadingAccounts } =
		api.cloudProvider.all.useQuery();
	const { data: providers } = api.cloudProvider.providers.useQuery();
	const set = (patch: Partial<NewServerConfig>) =>
		onChange({ ...value, ...patch });

	useEffect(() => {
		const first = accounts?.[0];
		if (!value.cloudProviderAccountId && first) {
			onChange({
				...value,
				cloudProviderAccountId: first.cloudProviderAccountId,
			});
		}
	}, [accounts, value, onChange]);

	const {
		data: catalog,
		isFetching: isLoadingCatalog,
		error: catalogError,
	} = api.cloudProvider.catalog.useQuery(
		{ cloudProviderAccountId: value.cloudProviderAccountId },
		{
			enabled: !!value.cloudProviderAccountId,
			staleTime: 5 * 60_000,
			retry: false,
		},
	);

	const preferredArch = toCatalogArchitecture(sourceArchitecture);
	const location = catalog?.locations.find((l) => l.id === value.location);

	const types = useMemo(
		() =>
			(catalog?.serverTypes ?? [])
				.filter(
					(type) =>
						location?.availableServerTypes.includes(type.id) &&
						type.prices.some((price) => price.location === value.location),
				)
				.sort(
					(a, b) =>
						Number(a.architecture !== preferredArch) -
						Number(b.architecture !== preferredArch),
				),
		[catalog, location, value.location, preferredArch],
	);
	const selectedType = types.find((type) => type.id === value.serverType);
	const images = useMemo(
		() =>
			(catalog?.images ?? []).filter(
				(image) => image.architecture === selectedType?.architecture,
			),
		[catalog, selectedType],
	);

	useEffect(() => {
		if (!catalog) return;
		const patch: Partial<NewServerConfig> = {};
		if (!catalog.locations.some((l) => l.id === value.location)) {
			patch.location = catalog.locations[0]?.id ?? "";
		}
		if (location && !selectedType && types[0]) {
			patch.serverType = types[0].id;
		}
		if (selectedType && !images.some((image) => image.id === value.image)) {
			patch.image = defaultImage(images)?.id ?? "";
		}
		const changed = (
			Object.entries(patch) as [keyof NewServerConfig, string][]
		).some(([key, next]) => value[key] !== next);
		if (changed) onChange({ ...value, ...patch });
	}, [catalog, location, selectedType, types, images, value, onChange]);

	const money = useMemo(
		() =>
			new Intl.NumberFormat(undefined, {
				style: "currency",
				currency: catalog?.currency ?? "EUR",
			}),
		[catalog?.currency],
	);

	if (isLoadingAccounts) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				Loading cloud accounts…
			</div>
		);
	}
	if (!accounts || accounts.length === 0) {
		return (
			<AlertBlock type="info">
				Connect a cloud provider account in{" "}
				<Link href="/dashboard/settings/cloud-providers" className="underline">
					Settings › Cloud providers
				</Link>{" "}
				to create a server to migrate to.
			</AlertBlock>
		);
	}

	const providerLabel = (type: string) =>
		providers?.find((p) => p.type === type)?.label ?? type;
	const selectedProvider = providers?.find(
		(p) =>
			p.type ===
			accounts.find(
				(a) => a.cloudProviderAccountId === value.cloudProviderAccountId,
			)?.providerType,
	);

	return (
		<div className="grid gap-3 rounded-md border p-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="grid gap-2">
					<Label htmlFor="migrate-new-name">Server name</Label>
					<Input
						id="migrate-new-name"
						placeholder="web-2"
						autoComplete="off"
						value={value.name}
						onChange={(e) => set({ name: e.target.value.toLowerCase() })}
					/>
					{value.name && !NAME_PATTERN.test(value.name) && (
						<span className="text-xs text-destructive">
							Use lowercase letters, numbers and hyphens
						</span>
					)}
				</div>
				<div className="grid gap-2">
					<Label>Account</Label>
					<Select
						value={value.cloudProviderAccountId}
						onValueChange={(id) =>
							set({
								cloudProviderAccountId: id,
								location: "",
								serverType: "",
								image: "",
							})
						}
					>
						<SelectTrigger>
							<SelectValue placeholder="Select an account" />
						</SelectTrigger>
						<SelectContent>
							{accounts.map((account) => (
								<SelectItem
									key={account.cloudProviderAccountId}
									value={account.cloudProviderAccountId}
								>
									<span className="flex items-center gap-2">
										<CloudProviderIcon
											providerType={account.providerType}
											className="size-4 shrink-0"
										/>
										{providerLabel(account.providerType)} · {account.name}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{catalogError ? (
				<AlertBlock type="error">{catalogError.message}</AlertBlock>
			) : isLoadingCatalog && !catalog ? (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					Loading locations and prices…
				</div>
			) : (
				catalog && (
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid min-w-0 gap-2">
							<Label>Location</Label>
							<Select
								value={value.location}
								onValueChange={(id) =>
									set({ location: id, serverType: "", image: "" })
								}
							>
								<SelectTrigger className="w-full min-w-0 [&>span]:truncate">
									<SelectValue placeholder="Location" />
								</SelectTrigger>
								<SelectContent>
									{catalog.locations.map((loc) => (
										<SelectItem key={loc.id} value={loc.id}>
											{loc.city} ({loc.id})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid min-w-0 gap-2 sm:order-last sm:col-span-2">
							<Label>Server type</Label>
							<Select
								value={value.serverType}
								onValueChange={(id) => set({ serverType: id })}
							>
								<SelectTrigger className="w-full min-w-0 [&>span]:truncate">
									<SelectValue placeholder="Server type" />
								</SelectTrigger>
								<SelectContent>
									{types.map((type) => {
										const price = type.prices.find(
											(p) => p.location === value.location,
										);
										const differs =
											!!preferredArch && type.architecture !== preferredArch;
										return (
											<SelectItem key={type.id} value={type.id}>
												{type.label}
												{type.cores !== null && ` · ${type.cores} vCPU`}
												{type.memoryGb !== null && ` · ${type.memoryGb} GB`}
												{price?.monthly
													? ` · ${money.format(price.monthly)}/mo`
													: ""}
												{type.architecture === "arm" ? " · Arm" : " · x86"}
												{differs && (
													<span className="text-yellow-600 dark:text-yellow-500">
														{" "}
														(different CPU)
													</span>
												)}
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						</div>
						<div className="grid min-w-0 gap-2">
							<Label>Operating system</Label>
							<Select
								value={value.image}
								onValueChange={(id) => set({ image: id })}
							>
								<SelectTrigger className="w-full min-w-0 [&>span]:truncate">
									<SelectValue placeholder="Image" />
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
				)
			)}
			{selectedProvider?.removal === "cancel" && (
				<AlertBlock type="warning">
					{selectedProvider.label} bills by the month and servers can only be
					cancelled for the end of their term, not deleted. Its API has no
					prices, so check them on its site first.
				</AlertBlock>
			)}
		</div>
	);
};
