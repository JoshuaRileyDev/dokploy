import type { ServiceType } from "@dokploy/server/db/schema";
import { ArrowRight, Cloud, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DrawerLogs } from "@/components/shared/drawer-logs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import { type LogLine, parseLogs } from "../../docker/logs/utils";
import { ServiceTypeIcon } from "./server-services";

const LOCAL_SERVER = "dokploy";

type Plan = RouterOutputs["transfer"]["planServer"];
type ServicePlan = Plan["services"][number];
type DomainPlan = ServicePlan["domains"][number];

const NO_ACTION_NEEDED = new Set<DomainPlan["status"]>([
	"auto",
	"already-migrated",
	"points-elsewhere",
]);

const needsManualDns = (domain: DomainPlan) =>
	!NO_ACTION_NEEDED.has(domain.status);

interface EnvironmentGroup {
	environmentId: string;
	label: string;
	services: ServicePlan[];
	manualDns: number;
}

const groupByEnvironment = (services: ServicePlan[]) => {
	const groups = new Map<string, EnvironmentGroup>();
	for (const service of services) {
		const group = groups.get(service.environmentId) ?? {
			environmentId: service.environmentId,
			label: `${service.projectName} / ${service.environmentName}`,
			services: [],
			manualDns: 0,
		};
		group.services.push(service);
		group.manualDns += service.domains.filter(needsManualDns).length;
		groups.set(service.environmentId, group);
	}
	return [...groups.values()];
};

const DNS_BADGE: Record<
	DomainPlan["status"],
	{ label: string; variant: "green" | "blue" | "yellow" | "red" | "blank" }
> = {
	auto: { label: "Auto DNS", variant: "green" },
	"already-migrated": { label: "Up to date", variant: "blue" },
	generated: { label: "Generated", variant: "blank" },
	"not-cloudflare": { label: "Manual DNS", variant: "yellow" },
	"cloudflare-no-provider": { label: "No provider", variant: "yellow" },
	"no-record": { label: "No record", variant: "yellow" },
	"points-elsewhere": { label: "Elsewhere", variant: "blank" },
	cname: { label: "CNAME", variant: "yellow" },
	wildcard: { label: "Wildcard", variant: "yellow" },
	"no-target-ip": { label: "No target IP", variant: "red" },
	error: { label: "DNS error", variant: "red" },
};

const DomainRow = ({ domain }: { domain: DomainPlan }) => {
	const badge = DNS_BADGE[domain.status];
	return (
		<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
			<span className="truncate">{domain.host}</span>
			{domain.proxied && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Cloud className="size-3 shrink-0 text-orange-500" />
					</TooltipTrigger>
					<TooltipContent>Proxied through Cloudflare</TooltipContent>
				</Tooltip>
			)}
			<Tooltip>
				<TooltipTrigger asChild>
					<Badge variant={badge.variant} className="cursor-help">
						{badge.label}
					</Badge>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{domain.message}
					{domain.dnsProviderName &&
						` (provider ${domain.dnsProviderName}, zone ${domain.zoneName})`}
				</TooltipContent>
			</Tooltip>
		</div>
	);
};

interface Props {
	serverId: string;
	serverName: string;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}

// Controlled from outside so the subscription survives the dropdown that opens it closing.
export const MigrateServer = ({
	serverId,
	serverName,
	isOpen,
	onOpenChange: setIsOpen,
}: Props) => {
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: servers } = api.server.withSSHKey.useQuery();
	const [target, setTarget] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [removeSourceData, setRemoveSourceData] = useState(false);
	const [updateDns, setUpdateDns] = useState(true);
	const [isDrawerOpen, setIsDrawerOpen] = useState(false);
	const [isMigrating, setIsMigrating] = useState(false);
	const [logs, setLogs] = useState<LogLine[]>([]);
	const [request, setRequest] = useState<{
		targetServerId: string | null;
		services: { serviceType: ServiceType; serviceId: string }[];
		removeSourceData: boolean;
		updateDns: boolean;
	} | null>(null);

	const targets = [
		...(!isCloud ? [{ serverId: LOCAL_SERVER, name: "Dokploy Server" }] : []),
		...(servers ?? []).filter((server) => server.serverId !== serverId),
	];
	const targetServerId = target === LOCAL_SERVER ? null : target;

	const {
		data: plan,
		isFetching: isPlanning,
		error: planError,
	} = api.transfer.planServer.useQuery(
		{ sourceServerId: serverId, targetServerId },
		{ enabled: isOpen && target !== "", refetchOnWindowFocus: false },
	);

	const groups = useMemo(
		() => groupByEnvironment(plan?.services ?? []),
		[plan],
	);

	// Environments whose domains can't all be switched automatically would go
	// down until someone edits DNS, so they have to be opted into.
	useEffect(() => {
		setSelected(
			new Set(
				groups
					.filter((group) => group.manualDns === 0)
					.map((group) => group.environmentId),
			),
		);
	}, [groups]);

	const selectedServices = useMemo(
		() =>
			groups
				.filter((group) => selected.has(group.environmentId))
				.flatMap((group) => group.services),
		[groups, selected],
	);

	const dnsSummary = useMemo(() => {
		const domains = selectedServices.flatMap((service) => service.domains);
		return {
			auto: domains.filter((d) => d.status === "auto").length,
			manual: domains.filter(needsManualDns).length,
		};
	}, [selectedServices]);

	api.transfer.startServer.useSubscription(
		{
			sourceServerId: serverId,
			targetServerId: request?.targetServerId ?? null,
			services: request?.services ?? [],
			removeSourceData: request?.removeSourceData ?? false,
			updateDns: request?.updateDns ?? true,
		},
		{
			enabled: isMigrating && request !== null,
			onData(line) {
				setLogs((prev) => [...prev, ...parseLogs(line)]);
				if (line.startsWith("Migration completed")) {
					setIsMigrating(false);
					toast.success("Server migration completed");
					utils.invalidate();
				} else if (
					line.startsWith("Migration finished") ||
					line.startsWith("Migration failed")
				) {
					setIsMigrating(false);
					toast.error("Some services were not migrated, check the logs");
					utils.invalidate();
				}
			},
			onError(error) {
				setIsMigrating(false);
				toast.error(error.message);
			},
		},
	);

	const toggle = (id: string, checked: boolean) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});

	const allSelected = groups.length > 0 && selected.size === groups.length;

	const onMigrate = () => {
		if (!plan) return;
		setRequest({
			targetServerId,
			services: selectedServices.map((service) => ({
				serviceType: service.type,
				serviceId: service.id,
			})),
			removeSourceData,
			updateDns,
		});
		setLogs([]);
		setIsDrawerOpen(true);
		setIsMigrating(true);
		setIsOpen(false);
	};

	return (
		<>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Migrate services from {serverName}</DialogTitle>
						<DialogDescription>
							Moves one environment at a time. Each is deployed and
							health-checked on the target before its Cloudflare DNS records are
							switched, and the old copies are only removed once the new ones
							are live.
						</DialogDescription>
					</DialogHeader>

					{isMigrating ? (
						<AlertBlock type="info">
							A migration is already running.{" "}
							<button
								type="button"
								className="underline"
								onClick={() => {
									setIsOpen(false);
									setIsDrawerOpen(true);
								}}
							>
								View logs
							</button>
						</AlertBlock>
					) : targets.length === 0 ? (
						<AlertBlock type="info">
							There are no other deploy servers to migrate to.
						</AlertBlock>
					) : (
						<div className="grid min-w-0 gap-4">
							<div className="grid gap-2">
								<Label>Target server</Label>
								<Select value={target} onValueChange={setTarget}>
									<SelectTrigger>
										<SelectValue placeholder="Select a server" />
									</SelectTrigger>
									<SelectContent>
										{targets.map((server) => (
											<SelectItem key={server.serverId} value={server.serverId}>
												{server.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{isPlanning && (
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Checking services and DNS records…
								</div>
							)}
							{planError && (
								<AlertBlock type="error">{planError.message}</AlertBlock>
							)}

							{plan && !isPlanning && (
								<>
									<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
										<span>{plan.source.name}</span>
										<ArrowRight className="size-3" />
										<span>
											{plan.target.name}
											{plan.target.ip && ` (${plan.target.ip})`}
										</span>
									</div>

									{plan.services.length === 0 ? (
										<AlertBlock type="info">
											There are no services on this server you can migrate.
										</AlertBlock>
									) : (
										<div className="rounded-md border">
											<div className="flex items-center gap-2 border-b px-3 py-2">
												<Checkbox
													id="migrate-select-all"
													checked={allSelected}
													onCheckedChange={(checked) =>
														setSelected(
															checked
																? new Set(groups.map((g) => g.environmentId))
																: new Set(),
														)
													}
												/>
												<Label
													htmlFor="migrate-select-all"
													className="text-sm font-medium"
												>
													{selectedServices.length} of {plan.services.length}{" "}
													services
												</Label>
											</div>
											<div className="max-h-80 overflow-y-auto">
												{groups.map((group) => (
													<div
														key={group.environmentId}
														className="border-b last:border-b-0"
													>
														<label
															htmlFor={`migrate-${group.environmentId}`}
															className="flex cursor-pointer items-center gap-2 bg-muted/30 px-3 py-2 hover:bg-muted/50"
														>
															<Checkbox
																id={`migrate-${group.environmentId}`}
																checked={selected.has(group.environmentId)}
																onCheckedChange={(checked) =>
																	toggle(group.environmentId, checked === true)
																}
															/>
															<span className="truncate text-sm font-medium">
																{group.label}
															</span>
															{group.manualDns > 0 && (
																<Badge variant="yellow">
																	{group.manualDns} manual DNS
																</Badge>
															)}
														</label>
														{group.services.map((service) => (
															<div
																key={service.id}
																className="grid min-w-0 gap-1 py-2 pr-3 pl-9"
															>
																<div className="flex min-w-0 items-center gap-2 text-sm">
																	<ServiceTypeIcon
																		type={service.type}
																		className="size-4 shrink-0"
																	/>
																	<span className="truncate">
																		{service.name}
																	</span>
																	<Tooltip>
																		<TooltipTrigger asChild>
																			<Badge
																				variant={
																					service.stateful ? "orange" : "blank"
																				}
																				className="cursor-help"
																			>
																				{service.stateful
																					? "Stops to copy"
																					: "Stays up"}
																			</Badge>
																		</TooltipTrigger>
																		<TooltipContent className="max-w-xs">
																			{service.stateful
																				? "Has persistent data, so it is stopped on the old server while the data is copied and comes back on the new one."
																				: "No persistent data, so the old copy keeps serving until DNS has moved to the new one."}
																		</TooltipContent>
																	</Tooltip>
																</div>
																{service.domains.map((domain) => (
																	<DomainRow
																		key={domain.host}
																		domain={domain}
																	/>
																))}
															</div>
														))}
													</div>
												))}
											</div>
										</div>
									)}

									{plan.cloudflareProviders === 0 && (
										<AlertBlock type="warning">
											No Cloudflare DNS provider is set up, so DNS records will
											not be updated. Add one in Settings › DNS to switch
											domains automatically.
										</AlertBlock>
									)}
									{plan.cloudflareErrors.map((error) => (
										<AlertBlock key={error} type="error">
											{error}
										</AlertBlock>
									))}

									<div className="grid gap-3">
										<div className="flex items-center justify-between gap-4">
											<Label
												htmlFor="migrate-update-dns"
												className="grid gap-1"
											>
												<span>Update Cloudflare DNS</span>
												<span className="text-xs font-normal text-muted-foreground">
													{dnsSummary.auto} record(s) switched once the new
													copies pass health checks
													{dnsSummary.manual > 0 &&
														`, ${dnsSummary.manual} domain(s) need manual changes`}
												</span>
											</Label>
											<Switch
												id="migrate-update-dns"
												checked={updateDns}
												onCheckedChange={setUpdateDns}
											/>
										</div>
										<div className="flex items-center justify-between gap-4">
											<Label
												htmlFor="migrate-remove-source"
												className="grid gap-1"
											>
												<span>Remove volumes from {plan.source.name}</span>
												<span className="text-xs font-normal text-muted-foreground">
													Otherwise they are kept as a fallback
												</span>
											</Label>
											<Switch
												id="migrate-remove-source"
												checked={removeSourceData}
												onCheckedChange={setRemoveSourceData}
											/>
										</div>
									</div>

									<AlertBlock type="info">
										Services marked "Stops to copy" are offline from the start
										of their copy until DNS has switched. If anything in an
										environment fails before it is live, that whole environment,
										DNS included, is rolled back to {plan.source.name} and the
										next one continues.
									</AlertBlock>
								</>
							)}
						</div>
					)}

					<DialogFooter>
						<Button variant="secondary" onClick={() => setIsOpen(false)}>
							Cancel
						</Button>
						{!isMigrating && plan && plan.services.length > 0 && (
							<Button
								disabled={selectedServices.length === 0 || isPlanning}
								onClick={onMigrate}
							>
								Migrate {selectedServices.length} service(s)
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<DrawerLogs
				isOpen={isDrawerOpen}
				onClose={() => setIsDrawerOpen(false)}
				filteredLogs={logs}
			/>
		</>
	);
};
