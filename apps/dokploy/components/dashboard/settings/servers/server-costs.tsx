import { AlertTriangle, RefreshCw, ServerIcon, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";

type Costs = RouterOutputs["cloudProvider"]["costs"];
export type ServerCost = Costs["servers"][number];

export interface ServerProvider {
	providerType: string;
	label: string;
}
type Money = ServerCost["monthly"]["total"];

const formatMoney = (amount: number, currency: string) =>
	new Intl.NumberFormat(undefined, {
		style: "currency",
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);

const pick = (value: Money, includeVat: boolean) =>
	includeVat ? value.gross : value.net;

export const useServerCosts = () => {
	const query = api.cloudProvider.costs.useQuery(undefined, {
		staleTime: 5 * 60_000,
		refetchOnWindowFocus: false,
	});
	const byServerId = useMemo(
		() =>
			new Map(
				(query.data?.servers ?? []).flatMap((cost) =>
					cost.dokployServerId ? [[cost.dokployServerId, cost] as const] : [],
				),
			),
		[query.data],
	);
	const providerByServerId = useMemo(() => {
		const providers = new Map<string, ServerProvider>();
		for (const { serverId } of query.data?.unpricedHetznerServers ?? []) {
			providers.set(serverId, {
				providerType: "hetzner",
				label: "Hetzner (not in a connected account)",
			});
		}
		for (const [serverId, cost] of byServerId) {
			providers.set(serverId, {
				providerType: cost.providerType,
				label: cost.providerLabel,
			});
		}
		return providers;
	}, [query.data, byServerId]);
	return { ...query, byServerId, providerByServerId };
};

export const ServerProviderIcon = ({
	provider,
	className,
}: {
	provider: ServerProvider | undefined;
	className?: string;
}) =>
	provider ? (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex shrink-0">
					<CloudProviderIcon
						providerType={provider.providerType}
						className={className}
					/>
				</span>
			</TooltipTrigger>
			<TooltipContent>{provider.label}</TooltipContent>
		</Tooltip>
	) : (
		<ServerIcon className={cn("text-muted-foreground", className)} />
	);

const Breakdown = ({ cost }: { cost: ServerCost }) => {
	const lines: [string, Money][] = [
		[cost.serverType.toUpperCase(), cost.monthly.server],
		["Backups", cost.monthly.backups],
		["Primary IPv4", cost.monthly.primaryIps],
		["Volumes", cost.monthly.volumes],
	];
	return (
		<div className="space-y-1 text-xs">
			<p className="font-medium">
				{cost.providerLabel} · {cost.name} · {cost.location}
			</p>
			{lines
				.filter(([, value]) => value.gross > 0)
				.map(([label, value]) => (
					<div key={label} className="flex justify-between gap-6">
						<span>{label}</span>
						<span className="tabular-nums">
							{formatMoney(value.gross, cost.currency)}
						</span>
					</div>
				))}
			<p className="text-muted-foreground">Monthly, incl. VAT</p>
		</div>
	);
};

export const ServerCostBadge = ({ cost }: { cost: ServerCost | undefined }) => {
	if (!cost) return null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge variant="outline" className="h-5 cursor-help px-1.5 text-[11px]">
					{formatMoney(cost.monthly.total.gross, cost.currency)}/mo
				</Badge>
			</TooltipTrigger>
			<TooltipContent>
				<Breakdown cost={cost} />
			</TooltipContent>
		</Tooltip>
	);
};

const CostTable = ({
	costs,
	includeVat,
}: {
	costs: Costs;
	includeVat: boolean;
}) => {
	const columns = [
		["Server", "server"],
		["Backups", "backups"],
		["IPv4", "primaryIps"],
		["Volumes", "volumes"],
	] as const;
	return (
		<div className="max-h-[50vh] overflow-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead className="hidden sm:table-cell">Type</TableHead>
						{columns.map(([label]) => (
							<TableHead
								key={label}
								className="hidden text-right md:table-cell"
							>
								{label}
							</TableHead>
						))}
						<TableHead className="text-right">Monthly</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{costs.servers.map((cost) => (
						<TableRow key={`${cost.cloudProviderAccountId}:${cost.id}`}>
							<TableCell className="py-2">
								<p className="font-medium">
									{cost.dokployServerName ?? cost.name}
								</p>
								<div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
									<span>
										{cost.accountName}
										{cost.dokployServerName &&
											cost.dokployServerName !== cost.name &&
											` · ${cost.name}`}
									</span>
									{cost.isDokployHost && (
										<Badge variant="secondary" className="h-4 px-1 text-[10px]">
											Dokploy host
										</Badge>
									)}
									{!cost.dokployServerId && !cost.isDokployHost && (
										<Badge variant="outline" className="h-4 px-1 text-[10px]">
											Not in Dokploy
										</Badge>
									)}
									{cost.status !== "running" && (
										<Badge variant="outline" className="h-4 px-1 text-[10px]">
											{cost.status}
										</Badge>
									)}
								</div>
							</TableCell>
							<TableCell className="hidden py-2 text-xs sm:table-cell">
								{cost.serverType.toUpperCase()} · {cost.location}
							</TableCell>
							{columns.map(([label, key]) => (
								<TableCell
									key={label}
									className="hidden py-2 text-right text-xs tabular-nums text-muted-foreground md:table-cell"
								>
									{cost.monthly[key].gross > 0
										? formatMoney(
												pick(cost.monthly[key], includeVat),
												cost.currency,
											)
										: "–"}
								</TableCell>
							))}
							<TableCell className="py-2 text-right font-medium tabular-nums">
								{formatMoney(
									pick(cost.monthly.total, includeVat),
									cost.currency,
								)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
				<TableFooter>
					{costs.totals.map((total) => (
						<TableRow key={total.currency}>
							<TableCell colSpan={2} className="font-medium">
								Total
							</TableCell>
							<TableCell colSpan={4} className="hidden md:table-cell" />
							<TableCell className="text-right font-semibold tabular-nums">
								{formatMoney(
									includeVat ? total.gross : total.net,
									total.currency,
								)}
							</TableCell>
						</TableRow>
					))}
				</TableFooter>
			</Table>
		</div>
	);
};

export const ServerCostSummary = () => {
	const { data, isPending, isFetching, refetch } = useServerCosts();
	const [includeVat, setIncludeVat] = useState(true);

	if (isPending || !data) return null;

	const failed = data.accounts.filter((account) => account.error);
	const unpriced = data.unpricedHetznerServers;

	if (data.accounts.length === 0) {
		if (unpriced.length === 0) return null;
		return (
			<div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
				<Wallet className="size-4 shrink-0" />
				<span>
					{unpriced.length === 1
						? `${unpriced[0]?.name} looks like a Hetzner server.`
						: `${unpriced.length} servers look like Hetzner servers.`}{" "}
					Connect the Hetzner Cloud project under Create server to track what
					they cost each month.
				</span>
			</div>
		);
	}

	const vatRates = [
		...new Set(
			data.accounts.flatMap((a) => (a.vatRate === null ? [] : [a.vatRate])),
		),
	];

	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
			<div className="flex min-w-0 items-center gap-3">
				<Wallet className="size-4 shrink-0 text-muted-foreground" />
				<div className="min-w-0">
					<p className="text-sm">
						<span className="font-semibold tabular-nums">
							{data.totals.length === 0
								? formatMoney(0, "EUR")
								: data.totals
										.map((total) => formatMoney(total.gross, total.currency))
										.join(" + ")}
						</span>
						<span className="text-muted-foreground"> per month</span>
					</p>
					<p className="text-xs text-muted-foreground">
						{data.servers.length} cloud{" "}
						{data.servers.length === 1 ? "server" : "servers"} across{" "}
						{data.accounts.length}{" "}
						{data.accounts.length === 1 ? "account" : "accounts"}, at live
						prices incl. VAT
					</p>
				</div>
			</div>
			<div className="flex items-center gap-2">
				{(failed.length > 0 || unpriced.length > 0) && (
					<Tooltip>
						<TooltipTrigger asChild>
							<AlertTriangle className="size-4 text-amber-500" />
						</TooltipTrigger>
						<TooltipContent className="max-w-xs space-y-1 text-xs">
							{failed.map((account) => (
								<p key={account.cloudProviderAccountId}>
									{account.name}: {account.error}
								</p>
							))}
							{unpriced.length > 0 && (
								<p>
									Not in any connected account, so not counted:{" "}
									{unpriced.map((s) => s.name).join(", ")}
								</p>
							)}
						</TooltipContent>
					</Tooltip>
				)}
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					aria-label="Refresh prices"
					disabled={isFetching}
					onClick={() => refetch()}
				>
					<RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
				</Button>
				<Dialog>
					<DialogTrigger asChild>
						<Button variant="outline" size="sm">
							Breakdown
						</Button>
					</DialogTrigger>
					<DialogContent className="sm:max-w-4xl">
						<DialogHeader>
							<DialogTitle>Monthly server costs</DialogTitle>
							<DialogDescription>
								Live prices from your connected cloud accounts. Servers are
								billed hourly up to this monthly cap; traffic overage isn't
								included.
							</DialogDescription>
						</DialogHeader>
						<div className="flex items-center justify-end gap-2">
							<Label htmlFor="costs-include-vat" className="text-sm">
								Include VAT
								{vatRates.length === 1 && ` (${vatRates[0]}%)`}
							</Label>
							<Switch
								id="costs-include-vat"
								checked={includeVat}
								onCheckedChange={setIncludeVat}
							/>
						</div>
						<CostTable costs={data} includeVat={includeVat} />
						{unpriced.length > 0 && (
							<p className="text-xs text-muted-foreground">
								Not counted because no connected account owns them:{" "}
								{unpriced.map((s) => s.name).join(", ")}. Dedicated (Robot)
								servers can't be priced through the Cloud API.
							</p>
						)}
					</DialogContent>
				</Dialog>
			</div>
		</div>
	);
};
