import type { ServiceType } from "@dokploy/server/db/schema";
import { ArrowRight, Cloud, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
	EMPTY_NEW_SERVER,
	isNewServerComplete,
	type NewServerConfig,
	NewServerFields,
} from "./migrate-new-server";
import { ServiceTypeIcon } from "./server-services";

const LOCAL_SERVER = "dokploy";
const NEW_SERVER = "__new__";

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
	incompatible: number;
}

const describeArchitecture = (arch: string | null) =>
	arch === "amd64"
		? "x86-64 (amd64)"
		: arch === "arm64"
			? "Arm (arm64)"
			: (arch ?? "unknown");

const groupByEnvironment = (services: ServicePlan[]) => {
	const groups = new Map<string, EnvironmentGroup>();
	for (const service of services) {
		const group = groups.get(service.environmentId) ?? {
			environmentId: service.environmentId,
			label: `${service.projectName} / ${service.environmentName}`,
			services: [],
			manualDns: 0,
			incompatible: 0,
		};
		group.services.push(service);
		group.manualDns += service.domains.filter(needsManualDns).length;
		if (service.architecture?.status === "incompatible") {
			group.incompatible += 1;
		}
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

const ArchitectureBadges = ({ service }: { service: ServicePlan }) => {
	const check = service.architecture;
	if (!check) return null;
	return (
		<>
			{check.status !== "ok" && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Badge
							variant={check.status === "incompatible" ? "red" : "yellow"}
							className="cursor-help"
						>
							{check.status === "incompatible" ? "Wrong CPU" : "CPU unchecked"}
						</Badge>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">{check.message}</TooltipContent>
				</Tooltip>
			)}
			{check.dataWarning && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Badge variant="orange" className="cursor-help">
							Data check
						</Badge>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{check.dataWarning}
					</TooltipContent>
				</Tooltip>
			)}
		</>
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
	const [newServer, setNewServer] = useState<NewServerConfig>(EMPTY_NEW_SERVER);
	const [acknowledgedArchitecture, setAcknowledgedArchitecture] =
		useState(false);
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
		provision?: NewServerConfig;
	} | null>(null);

	const targets = [
		...(!isCloud ? [{ serverId: LOCAL_SERVER, name: "Dokploy Server" }] : []),
		...(servers ?? []).filter((server) => server.serverId !== serverId),
	];
	const isNewServer = target === NEW_SERVER;
	const targetServerId = target === LOCAL_SERVER || isNewServer ? null : target;
	const onNewServerChange = useCallback(
		(value: NewServerConfig) => setNewServer(value),
		[],
	);

	const {
		data: plan,
		isFetching: isPlanning,
		error: planError,
	} = api.transfer.planServer.useQuery(
		{
			sourceServerId: serverId,
			targetServerId,
			newServer: isNewServer
				? {
						cloudProviderAccountId: newServer.cloudProviderAccountId,
						serverType: newServer.serverType,
					}
				: undefined,
		},
		{
			enabled:
				isOpen &&
				target !== "" &&
				(!isNewServer ||
					(!!newServer.cloudProviderAccountId && !!newServer.serverType)),
			refetchOnWindowFocus: false,
		},
	);

	useEffect(() => {
		setAcknowledgedArchitecture(false);
	}, [plan?.architecture.source, plan?.architecture.target]);

	const groups = useMemo(
		() => groupByEnvironment(plan?.services ?? []),
		[plan],
	);

	// Environments whose domains can't all be switched automatically would go
	// down until someone edits DNS, and ones with images built for the wrong
	// CPU wouldn't start, so both have to be opted into.
	useEffect(() => {
		setSelected(
			new Set(
				groups
					.filter((group) => group.manualDns === 0 && group.incompatible === 0)
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
			provision: request?.provision,
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
			provision: isNewServer ? newServer : undefined,
		});
		setLogs([]);
		setIsDrawerOpen(true);
		setIsMigrating(true);
		setIsOpen(false);
	};

	return (
		<>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
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
										<SelectItem value={NEW_SERVER}>
											<span className="flex items-center gap-2">
												<Plus className="size-4" />
												Provision a new server
											</span>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{isNewServer && (
								<NewServerFields
									value={newServer}
									onChange={onNewServerChange}
									sourceArchitecture={plan?.architecture.source}
								/>
							)}

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
											{isNewServer
												? newServer.name || "new server"
												: plan.target.name}
											{plan.target.ip && ` (${plan.target.ip})`}
										</span>
									</div>

									{plan.architecture.mismatch ? (
										<AlertBlock type="warning">
											<div className="grid gap-2">
												<span>
													{plan.source.name} runs on{" "}
													{describeArchitecture(plan.architecture.source)} but
													the target is{" "}
													{describeArchitecture(plan.architecture.target)}. Apps
													built from source are rebuilt for the new CPU, but
													prebuilt images only start if they are published for
													it, and some data needs checking. Services marked
													"Wrong CPU" are left unselected.
												</span>
												<label
													htmlFor="migrate-ack-architecture"
													className="flex cursor-pointer items-center gap-2 font-medium"
												>
													<Checkbox
														id="migrate-ack-architecture"
														checked={acknowledgedArchitecture}
														onCheckedChange={(checked) =>
															setAcknowledgedArchitecture(checked === true)
														}
													/>
													I understand the servers have different CPU
													architectures
												</label>
											</div>
										</AlertBlock>
									) : (
										(!plan.architecture.source ||
											!plan.architecture.target) && (
											<AlertBlock type="info">
												Could not read the CPU architecture of{" "}
												{!plan.architecture.source
													? plan.source.name
													: "the target"}
												, so it isn't known whether both servers can run the
												same images.
											</AlertBlock>
										)
									)}

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
																	<ArchitectureBadges service={service} />
																	{service.exposedPorts.length > 0 && (
																		<Tooltip>
																			<TooltipTrigger asChild>
																				<Badge
																					variant="yellow"
																					className="cursor-help"
																				>
																					Port {service.exposedPorts.join(", ")}
																				</Badge>
																			</TooltipTrigger>
																			<TooltipContent className="max-w-xs">
																				Published directly on {plan.source.name}
																				. Anything that connects to it by the
																				old server's IP or hostname has to be
																				pointed at the new server by hand, and
																				the port opened in its firewall.
																			</TooltipContent>
																		</Tooltip>
																	)}
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

									<AlertBlock type="warning">
										<div className="grid gap-1">
											<span className="font-medium">
												Not moved automatically
											</span>
											<ul className="list-disc space-y-1 pl-4">
												{dnsSummary.manual > 0 && (
													<li>
														{dnsSummary.manual} domain(s) aren't on a Cloudflare
														zone Dokploy can edit (or use a CNAME, wildcard or
														generated domain). Point them at the new server by
														hand; they're down from cutover until you do.
													</li>
												)}
												{plan.notices.map((notice) => (
													<li key={notice}>{notice}</li>
												))}
												<li>
													Changes made on {plan.source.name} itself: Traefik's
													traefik.yml and file middlewares, extra entrypoints,
													firewall rules, cron jobs and anything installed
													outside Dokploy.
												</li>
												{isNewServer && (
													<li>
														The new server is created first and billed by the
														provider from then on. If the migration fails, it is
														kept so you can retry or delete it.
													</li>
												)}
											</ul>
										</div>
									</AlertBlock>

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
								disabled={
									selectedServices.length === 0 ||
									isPlanning ||
									(plan.architecture.mismatch && !acknowledgedArchitecture) ||
									(isNewServer && !isNewServerComplete(newServer))
								}
								onClick={onMigrate}
							>
								{isNewServer
									? `Create server and migrate ${selectedServices.length} service(s)`
									: `Migrate ${selectedServices.length} service(s)`}
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
