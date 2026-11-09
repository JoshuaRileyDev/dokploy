import { Resolver } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { db } from "@dokploy/server/db";
import {
	type apiMigrateServer,
	type apiPlanServerMigration,
	type CloudflareDnsConfig,
	certificates,
	dnsProvider,
	domains,
	libsql,
	mariadb,
	mongo,
	mounts,
	mysql,
	ports,
	postgres,
	redis,
	type ServiceType,
	schedules,
} from "@dokploy/server/db/schema";
import { type DnsRecord, getDnsClient } from "@dokploy/server/utils/dns";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { quote } from "shell-quote";
import { Agent, fetch as undiciFetch } from "undici";
import type { z } from "zod";
import {
	findCloudProviderAccountInOrganization,
	getCloudCatalog,
} from "./cloud-provider";
import { getServerIpCandidates } from "./domain";
import { findServerById } from "./server";
import {
	type CpuArchitecture,
	catalogArchitecture,
	checkServicesArchitecture,
	detectServerArchitecture,
	type ServiceArchitectureCheck,
} from "./server-architecture";
import {
	getServerServices,
	type ServerServiceSummary,
} from "./server-services";
import { reloadDockerResource } from "./settings";
import {
	commitTransfer,
	prepareTransfer,
	rollbackTransfer,
	type StagedTransfer,
	stageTransfer,
	waitUntilHealthy,
} from "./transfer";
import { getWebServerSettings } from "./web-server-settings";

type Logger = (line: string) => void;

export type DomainDnsStatus =
	| "auto"
	| "already-migrated"
	| "generated"
	| "not-cloudflare"
	| "cloudflare-no-provider"
	| "no-record"
	| "points-elsewhere"
	| "cname"
	| "wildcard"
	| "no-target-ip"
	| "error";

export interface DomainDnsPlan {
	host: string;
	status: DomainDnsStatus;
	message: string;
	dnsProviderName?: string;
	zoneName?: string;
	proxied?: boolean;
}

interface DnsChange {
	config: CloudflareDnsConfig;
	zoneId: string;
	update: DnsRecord[];
	remove: DnsRecord[];
}

interface DomainAnalysis {
	plan: DomainDnsPlan;
	change?: DnsChange;
}

export interface MigrationServicePlan {
	id: string;
	type: ServiceType;
	name: string;
	appName: string;
	projectName: string;
	environmentId: string;
	environmentName: string;
	status: ServerServiceSummary["status"];
	/** Stopped while its data is copied; stateless services keep serving until cutover. */
	stateful: boolean;
	domains: DomainDnsPlan[];
	/** Ports published on the source's IP, which clients reach without DNS. */
	exposedPorts: number[];
	/** Set when the target has a different CPU architecture. */
	architecture?: ServiceArchitectureCheck;
}

const LOCAL_SERVER_NAME = "Dokploy Server";

// Data stores come up first so the apps that depend on them find a database
// that is already running on the target.
const MIGRATION_ORDER: Record<ServiceType, number> = {
	postgres: 0,
	mysql: 0,
	mariadb: 0,
	mongo: 0,
	redis: 0,
	libsql: 0,
	compose: 1,
	application: 2,
};

const GENERATED_DOMAIN_SUFFIXES = [".traefik.me", ".sslip.io", ".nip.io"];

const nonPublicAddresses = new BlockList();
for (const [subnet, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
] as const) {
	nonPublicAddresses.addSubnet(subnet, prefix, "ipv4");
}

const isPublicIpv4 = (ip: string) =>
	isIP(ip) === 4 && !nonPublicAddresses.check(ip, "ipv4");

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const normalizeHost = (host: string) =>
	host.trim().toLowerCase().replace(/\.$/, "");

interface ResolvedServer {
	serverId: string | null;
	name: string;
	ipAddress?: string;
	/** Not created yet, so it has no address to point DNS at. */
	pending?: boolean;
}

const NEW_SERVER: ResolvedServer = {
	serverId: null,
	name: "the new server",
	pending: true,
};

const resolveServer = async (
	serverId: string | null,
	organizationId: string,
): Promise<ResolvedServer> => {
	if (!serverId) return { serverId: null, name: LOCAL_SERVER_NAME };
	const server = await findServerById(serverId);
	if (server.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to use this server",
		});
	}
	return {
		serverId: server.serverId,
		name: server.name,
		ipAddress: server.ipAddress,
	};
};

/**
 * The address the target's DNS records should point to. The configured
 * server IP is often a private or VPN address used for SSH, which would
 * break the site if written to public DNS.
 */
const resolveTargetIp = async (
	targetServerId: string | null,
	configuredIp: string | undefined,
) => {
	const preferred = targetServerId
		? configuredIp
		: (await getWebServerSettings())?.serverIp;
	if (preferred && isPublicIpv4(preferred)) return preferred;
	const candidates = await getServerIpCandidates(targetServerId);
	return candidates.find(isPublicIpv4) ?? null;
};

const lookupNameservers = async (host: string) => {
	const resolver = new Resolver({ timeout: 3000, tries: 1 });
	const labels = host.split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		try {
			const ns = await resolver.resolveNs(labels.slice(i).join("."));
			if (ns.length > 0) return ns;
		} catch {}
	}
	return [];
};

interface ManagedZone {
	zoneId: string;
	zoneName: string;
	providerName: string;
	config: CloudflareDnsConfig;
}

const createCloudflareLookup = async (organizationId: string) => {
	const providers = await db.query.dnsProvider.findMany({
		where: and(
			eq(dnsProvider.organizationId, organizationId),
			eq(dnsProvider.providerType, "cloudflare"),
		),
	});
	const client = getDnsClient("cloudflare");
	const zones: ManagedZone[] = [];
	const errors: string[] = [];

	await Promise.all(
		providers.map(async (provider) => {
			const config = provider.config as CloudflareDnsConfig;
			try {
				for (const zone of await client.listZones(config)) {
					zones.push({
						zoneId: zone.id,
						zoneName: normalizeHost(zone.name),
						providerName: provider.name,
						config,
					});
				}
			} catch (error) {
				errors.push(`${provider.name}: ${errorMessage(error)}`);
			}
		}),
	);

	const records = new Map<string, Promise<DnsRecord[]>>();

	return {
		providerCount: providers.length,
		errors,
		findZone: (host: string) =>
			zones
				.filter(
					(zone) =>
						host === zone.zoneName || host.endsWith(`.${zone.zoneName}`),
				)
				.sort((a, b) => b.zoneName.length - a.zoneName.length)[0],
		listRecords: (zone: ManagedZone) => {
			let cached = records.get(zone.zoneId);
			if (!cached) {
				cached = client.listRecords(zone.config, zone.zoneId);
				cached.catch(() => records.delete(zone.zoneId));
				records.set(zone.zoneId, cached);
			}
			return cached;
		},
		forgetRecords: (zoneId: string) => records.delete(zoneId),
	};
};

type CloudflareLookup = Awaited<ReturnType<typeof createCloudflareLookup>>;

interface DnsContext {
	cloudflare: CloudflareLookup;
	sourceIps: Set<string>;
	targetIp: string | null;
	targetName: string;
	targetPending: boolean;
}

const analyzeDomain = async (
	rawHost: string,
	ctx: DnsContext,
): Promise<DomainAnalysis> => {
	const host = normalizeHost(rawHost);
	const plan = (
		status: DomainDnsStatus,
		message: string,
		extra: Partial<DomainDnsPlan> = {},
	): DomainAnalysis => ({ plan: { host, status, message, ...extra } });

	if (GENERATED_DOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return plan(
			"generated",
			"Generated domain that embeds the old server IP, create a new one after the migration",
		);
	}

	const zone = ctx.cloudflare.findZone(host);
	if (!zone) {
		const nameservers = await lookupNameservers(host);
		if (nameservers.some((ns) => ns.endsWith(".ns.cloudflare.com"))) {
			return plan(
				"cloudflare-no-provider",
				"Domain is on Cloudflare but no Cloudflare DNS provider in Settings › DNS can access its zone",
			);
		}
		return plan(
			"not-cloudflare",
			nameservers.length > 0
				? `Not on Cloudflare (nameservers: ${nameservers.slice(0, 2).join(", ")}), update the DNS record manually`
				: "Could not find the domain's nameservers, update the DNS record manually",
		);
	}

	const zoneInfo = {
		dnsProviderName: zone.providerName,
		zoneName: zone.zoneName,
	};
	let records: DnsRecord[];
	try {
		records = await ctx.cloudflare.listRecords(zone);
	} catch (error) {
		return plan("error", errorMessage(error), zoneInfo);
	}

	const exact = records.filter((record) => normalizeHost(record.name) === host);
	const cname = exact.find((record) => record.type === "CNAME");
	if (cname) {
		return plan(
			"cname",
			`CNAME to ${cname.content}, update its target manually if needed`,
			{ ...zoneInfo, proxied: cname.proxied },
		);
	}

	const aRecords = exact.filter((record) => record.type === "A");
	if (aRecords.length === 0) {
		const wildcard = `*.${host.split(".").slice(1).join(".")}`;
		const wildcardRecord = records.find(
			(record) =>
				normalizeHost(record.name) === wildcard &&
				["A", "CNAME"].includes(record.type),
		);
		if (wildcardRecord) {
			return plan(
				"wildcard",
				`Served by the wildcard record ${wildcard}, which other domains may share, update it manually`,
				{ ...zoneInfo, proxied: wildcardRecord.proxied },
			);
		}
		return plan(
			"no-record",
			`No A record for ${host} in ${zone.zoneName}`,
			zoneInfo,
		);
	}

	const onSource = aRecords.filter((record) =>
		ctx.sourceIps.has(record.content),
	);
	const onTarget = aRecords.filter(
		(record) => ctx.targetIp && record.content === ctx.targetIp,
	);
	const proxied = aRecords.some((record) => record.proxied);
	const hasAaaa = exact.some((record) => record.type === "AAAA");

	if (onSource.length === 0) {
		if (onTarget.length > 0) {
			return plan("already-migrated", `Already points to ${ctx.targetName}`, {
				...zoneInfo,
				proxied,
			});
		}
		return plan(
			"points-elsewhere",
			`A record points to ${aRecords.map((r) => r.content).join(", ")}, not the source server, left unchanged`,
			{ ...zoneInfo, proxied },
		);
	}

	if (!ctx.targetIp && ctx.targetPending) {
		return plan(
			"auto",
			`${onSource.map((r) => r.content).join(", ")} → the new server's IP once it is created${hasAaaa ? " (AAAA records must be updated manually)" : ""}`,
			{ ...zoneInfo, proxied },
		);
	}

	if (!ctx.targetIp) {
		return plan(
			"no-target-ip",
			`Could not find a public IPv4 address for ${ctx.targetName}`,
			{ ...zoneInfo, proxied },
		);
	}

	return {
		plan: {
			host,
			status: "auto",
			message: `${onSource.map((r) => r.content).join(", ")} → ${ctx.targetIp}${hasAaaa ? " (AAAA records must be updated manually)" : ""}`,
			...zoneInfo,
			proxied,
		},
		change: {
			config: zone.config,
			zoneId: zone.zoneId,
			// Cloudflare rejects an update that would duplicate an existing record,
			// so source records are deleted when the target IP is already present.
			update: onTarget.length > 0 ? [] : onSource,
			remove: onTarget.length > 0 ? onSource : [],
		},
	};
};

interface ServiceDomain {
	host: string;
	https: boolean;
	path: string;
	customEntrypoint: string | null;
}

const findServiceDomains = async (
	services: { id: string; type: ServiceType }[],
) => {
	const applicationIds = services
		.filter((s) => s.type === "application")
		.map((s) => s.id);
	const composeIds = services
		.filter((s) => s.type === "compose")
		.map((s) => s.id);
	const result = new Map<string, ServiceDomain[]>();
	if (applicationIds.length === 0 && composeIds.length === 0) return result;

	const rows = await db.query.domains.findMany({
		where: and(
			isNull(domains.previewDeploymentId),
			or(
				applicationIds.length > 0
					? inArray(domains.applicationId, applicationIds)
					: undefined,
				composeIds.length > 0
					? inArray(domains.composeId, composeIds)
					: undefined,
			),
		),
		columns: {
			host: true,
			https: true,
			path: true,
			customEntrypoint: true,
			applicationId: true,
			composeId: true,
		},
	});

	for (const row of rows) {
		const id = row.applicationId ?? row.composeId;
		if (!id) continue;
		const list = result.get(id) ?? [];
		const host = normalizeHost(row.host);
		if (!list.some((domain) => domain.host === host)) {
			list.push({
				host,
				https: row.https,
				path: row.path || "/",
				customEntrypoint: row.customEntrypoint,
			});
		}
		result.set(id, list);
	}
	return result;
};

const DATABASE_TYPES = new Set<ServiceType>([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

/** Mirrors StagedTransfer.stateful without loading every service in full. */
const findStatefulServices = async (
	serverId: string,
	services: ServerServiceSummary[],
) => {
	const stateful = new Set(
		services.filter((s) => DATABASE_TYPES.has(s.type)).map((s) => s.id),
	);
	const others = services.filter((s) => !DATABASE_TYPES.has(s.type));
	if (others.length === 0) return stateful;

	const ids = others.map((s) => s.id);
	const mountRows = await db.query.mounts.findMany({
		where: and(
			inArray(mounts.type, ["volume", "bind"]),
			or(inArray(mounts.applicationId, ids), inArray(mounts.composeId, ids)),
		),
		columns: { applicationId: true, composeId: true },
	});
	for (const row of mountRows) {
		const id = row.applicationId ?? row.composeId;
		if (id) stateful.add(id);
	}

	const composes = others.filter((s) => s.type === "compose");
	if (composes.length > 0) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`docker volume ls --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.stack.namespace"}}'`,
		).catch(() => ({ stdout: "" }));
		const projects = new Set(
			stdout
				.split("\n")
				.flatMap((line) => line.split("|"))
				.map((name) => name.trim())
				.filter(Boolean),
		);
		for (const service of composes) {
			if (projects.has(service.appName)) stateful.add(service.id);
		}
	}
	return stateful;
};

interface ProbeResult {
	status: number;
	body: string;
	error?: string;
}

const UNAVAILABLE_STATUSES = new Set([
	502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530,
]);

// Traefik answers with this when no router matches, i.e. the app isn't wired up.
const TRAEFIK_NOT_FOUND = "404 page not found";

const isServing = (result: ProbeResult) =>
	result.status !== 0 &&
	!UNAVAILABLE_STATUSES.has(result.status) &&
	!(result.status === 404 && result.body.trim() === TRAEFIK_NOT_FOUND);

const describeProbe = (result: ProbeResult) =>
	result.status === 0
		? (result.error ?? "no response")
		: `HTTP ${result.status}`;

const isProbeable = (domain: ServiceDomain) =>
	!domain.customEntrypoint && !domain.host.startsWith("*.");

const domainUrl = (domain: ServiceDomain) =>
	`${domain.https ? "https" : "http"}://${domain.host}${domain.path}`;

const CURL_IMAGE = "curlimages/curl:8.11.1";

/**
 * Requests the domain from the target's own Traefik, bypassing DNS, so the
 * new copy can be checked while the domain still points at the old server.
 * Certificates are ignored: Let's Encrypt can't issue one until DNS moves.
 */
const probeOnTarget = async (
	targetServerId: string | null,
	domain: ServiceDomain,
): Promise<ProbeResult> => {
	const port = domain.https ? 443 : 80;
	const script = `f=$(mktemp); code=$(curl -sk -o "$f" -w '%{http_code}' --max-time 10 --resolve ${quote([`${domain.host}:${port}:127.0.0.1`])} ${quote([domainUrl(domain)])} || true); echo "$code"; head -c 200 "$f"; rm -f "$f"`;
	try {
		const { stdout } = targetServerId
			? await execAsyncRemote(targetServerId, script)
			: // The Dokploy container's loopback isn't the host's, where Traefik listens.
				await execAsync(
					`docker run --rm --network host --entrypoint sh ${CURL_IMAGE} -c ${quote([script])}`,
				);
		const [status = "", ...body] = stdout.split("\n");
		return { status: Number(status.trim()) || 0, body: body.join("\n") };
	} catch (error) {
		return { status: 0, body: "", error: errorMessage(error) };
	}
};

/**
 * Requests the domain the way a visitor would, with certificate checks. A
 * DNS-only record is pinned to the target IP so a resolver still caching the
 * old address can't make a broken target look healthy.
 */
const probePublic = async (
	domain: ServiceDomain,
	pinIp?: string,
): Promise<ProbeResult> => {
	const lookup: LookupFunction | undefined = pinIp
		? (_hostname, options, callback) => {
				if (options.all) callback(null, [{ address: pinIp, family: 4 }]);
				else callback(null, pinIp, 4);
			}
		: undefined;
	const dispatcher = new Agent({ connect: { lookup, timeout: 10_000 } });
	try {
		const response = await undiciFetch(domainUrl(domain), {
			dispatcher,
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
		});
		const body = (await response.text()).slice(0, 200);
		return { status: response.status, body };
	} catch (error) {
		const cause = (error as { cause?: unknown }).cause;
		return { status: 0, body: "", error: errorMessage(cause ?? error) };
	} finally {
		await dispatcher.close().catch(() => undefined);
	}
};

interface DnsRevert {
	host: string;
	run: () => Promise<unknown>;
}

const applyDnsChange = async (
	host: string,
	change: DnsChange,
	targetIp: string,
	cloudflare: CloudflareLookup,
): Promise<DnsRevert[]> => {
	const client = getDnsClient("cloudflare");
	const reverts: DnsRevert[] = [];
	try {
		for (const record of change.update) {
			await client.updateRecord(change.config, change.zoneId, record.id, {
				type: "A",
				name: record.name,
				content: targetIp,
				ttl: record.ttl,
				proxied: record.proxied,
			});
			reverts.push({
				host,
				run: () =>
					client.updateRecord(change.config, change.zoneId, record.id, {
						type: "A",
						name: record.name,
						content: record.content,
						ttl: record.ttl,
						proxied: record.proxied,
					}),
			});
		}
		for (const record of change.remove) {
			await client.deleteRecord(change.config, change.zoneId, record.id);
			reverts.push({
				host,
				run: () =>
					client.upsertRecord(change.config, {
						zoneId: change.zoneId,
						type: "A",
						name: record.name,
						content: record.content,
						ttl: record.ttl,
						proxied: record.proxied,
					}),
			});
		}
	} finally {
		cloudflare.forgetRecords(change.zoneId);
	}
	return reverts;
};

const createDnsContext = async (
	organizationId: string,
	source: ResolvedServer,
	target: ResolvedServer,
): Promise<DnsContext> => {
	const [cloudflare, sourceCandidates, targetIp] = await Promise.all([
		createCloudflareLookup(organizationId),
		getServerIpCandidates(source.serverId),
		target.pending ? null : resolveTargetIp(target.serverId, target.ipAddress),
	]);
	return {
		cloudflare,
		sourceIps: new Set(sourceCandidates),
		targetIp,
		targetName: target.name,
		targetPending: !!target.pending,
	};
};

const validateServers = async (
	input: z.infer<typeof apiPlanServerMigration>,
	organizationId: string,
) => {
	if (input.newServer) {
		return {
			source: await resolveServer(input.sourceServerId, organizationId),
			target: NEW_SERVER,
		};
	}
	if (input.sourceServerId === input.targetServerId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The source and target servers must be different",
		});
	}
	const [source, target] = await Promise.all([
		resolveServer(input.sourceServerId, organizationId),
		resolveServer(input.targetServerId, organizationId),
	]);
	return { source, target };
};

const byMigrationOrder = (a: ServerServiceSummary, b: ServerServiceSummary) =>
	MIGRATION_ORDER[a.type] - MIGRATION_ORDER[b.type] ||
	a.name.localeCompare(b.name);

const resolveArchitectures = async (
	input: z.infer<typeof apiPlanServerMigration> & { organizationId: string },
) => {
	const targetArchitecture = async () => {
		if (!input.newServer) {
			return detectServerArchitecture(input.targetServerId);
		}
		const account = await findCloudProviderAccountInOrganization(
			input.newServer.cloudProviderAccountId,
			input.organizationId,
		);
		const catalog = await getCloudCatalog(account);
		const type = catalog.serverTypes.find(
			(t) => t.id === input.newServer?.serverType,
		);
		return type ? catalogArchitecture(type.architecture) : null;
	};
	const [source, target] = await Promise.all([
		detectServerArchitecture(input.sourceServerId),
		targetArchitecture().catch(() => null),
	]);
	return {
		source,
		target,
		mismatch: !!source && !!target && source !== target,
	};
};

const findExposedPorts = async (services: ServerServiceSummary[]) => {
	const exposed = new Map<string, number[]>();
	const add = (id: string, port: number | null) => {
		if (!port) return;
		const list = exposed.get(id) ?? [];
		if (!list.includes(port)) list.push(port);
		exposed.set(id, list);
	};
	const idsOf = (type: ServiceType) =>
		services.filter((s) => s.type === type).map((s) => s.id);

	const applicationIds = idsOf("application");
	const lookups: Promise<void>[] = [];
	if (applicationIds.length > 0) {
		lookups.push(
			db
				.select({ id: ports.applicationId, port: ports.publishedPort })
				.from(ports)
				.where(inArray(ports.applicationId, applicationIds))
				.then((rows) => {
					for (const row of rows) add(row.id, row.port);
				}),
		);
	}
	const databases = [
		[postgres, postgres.postgresId, "postgres"],
		[mysql, mysql.mysqlId, "mysql"],
		[mariadb, mariadb.mariadbId, "mariadb"],
		[mongo, mongo.mongoId, "mongo"],
		[redis, redis.redisId, "redis"],
		[libsql, libsql.libsqlId, "libsql"],
	] as const;
	for (const [table, idColumn, type] of databases) {
		const ids = idsOf(type);
		if (ids.length === 0) continue;
		lookups.push(
			db
				.select({ id: idColumn, port: table.externalPort })
				.from(table)
				.where(inArray(idColumn, ids))
				.then((rows) => {
					for (const row of rows) add(row.id, row.port);
				}),
		);
	}
	await Promise.all(lookups);
	return exposed;
};

/** Things tied to the source server itself that a migration leaves behind. */
const findServerLevelNotices = async (
	sourceServerId: string,
	sourceName: string,
) => {
	const [serverSchedules, serverCertificates] = await Promise.all([
		db.query.schedules.findMany({
			where: eq(schedules.serverId, sourceServerId),
			columns: { scheduleId: true },
		}),
		db.query.certificates.findMany({
			where: eq(certificates.serverId, sourceServerId),
			columns: { certificateId: true },
		}),
	]);
	const notices: string[] = [];
	if (serverSchedules.length > 0) {
		notices.push(
			`${serverSchedules.length} scheduled job(s) belong to ${sourceName} itself and stay there. Recreate them on the target if they're still needed.`,
		);
	}
	if (serverCertificates.length > 0) {
		notices.push(
			`${serverCertificates.length} custom certificate(s) are installed on ${sourceName}. Add them to the target under Settings › Certificates.`,
		);
	}
	return notices;
};

export const planServerMigration = async (
	input: z.infer<typeof apiPlanServerMigration> & { organizationId: string },
	filterServices: (
		services: ServerServiceSummary[],
	) => Promise<ServerServiceSummary[]> = async (services) => services,
) => {
	const { source, target } = await validateServers(input, input.organizationId);
	const services = await filterServices(
		await getServerServices([input.sourceServerId]),
	);
	const [dns, serviceDomains, stateful, architecture, exposedPorts, notices] =
		await Promise.all([
			createDnsContext(input.organizationId, source, target),
			findServiceDomains(services),
			findStatefulServices(input.sourceServerId, services),
			resolveArchitectures(input),
			findExposedPorts(services),
			findServerLevelNotices(input.sourceServerId, source.name),
		]);
	const architectureChecks = architecture.mismatch
		? await checkServicesArchitecture(
				input.sourceServerId,
				services.map((service) => ({
					id: service.id,
					type: service.type,
					appName: service.appName,
					stateful: stateful.has(service.id),
				})),
				architecture.target as CpuArchitecture,
			)
		: new Map<string, ServiceArchitectureCheck>();

	const plannedServices: MigrationServicePlan[] = await Promise.all(
		[...services]
			.sort(
				(a, b) =>
					a.projectName.localeCompare(b.projectName) ||
					a.environmentName.localeCompare(b.environmentName) ||
					byMigrationOrder(a, b),
			)
			.map(async (service) => ({
				id: service.id,
				type: service.type,
				name: service.name,
				appName: service.appName,
				projectName: service.projectName,
				environmentId: service.environmentId,
				environmentName: service.environmentName,
				status: service.status,
				stateful: stateful.has(service.id),
				exposedPorts: exposedPorts.get(service.id) ?? [],
				architecture: architectureChecks.get(service.id),
				domains: await Promise.all(
					(serviceDomains.get(service.id) ?? []).map(
						async (domain) => (await analyzeDomain(domain.host, dns)).plan,
					),
				),
			})),
	);

	return {
		source: { name: source.name, ips: [...dns.sourceIps] },
		target: { name: target.name, ip: dns.targetIp, pending: !!target.pending },
		architecture,
		notices,
		cloudflareProviders: dns.cloudflare.providerCount,
		cloudflareErrors: dns.cloudflare.errors,
		services: plannedServices,
	};
};

export type ServerMigrationPlan = Awaited<
	ReturnType<typeof planServerMigration>
>;

export interface MigrationTiming {
	healthTimeoutMs: number;
	pollMs: number;
	/** How long a proxied record takes to reach Cloudflare's edge. */
	proxiedPropagationMs: number;
	publicCheckTimeoutMs: number;
	/** Upper bound on waiting for resolvers to drop the old address of a DNS-only record. */
	maxDrainMs: number;
}

const DEFAULT_TIMING: MigrationTiming = {
	healthTimeoutMs: 5 * 60_000,
	pollMs: 10_000,
	proxiedPropagationMs: 15_000,
	publicCheckTimeoutMs: 4 * 60_000,
	maxDrainMs: 5 * 60_000,
};

// Cloudflare reports "automatic" TTL as 1, which it serves as 300 seconds.
const effectiveTtlMs = (ttl: number) => (ttl <= 1 ? 300 : ttl) * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const activeServers = new Set<string>();

const lockServers = (keys: string[]) => {
	if (keys.some((key) => activeServers.has(key))) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "A migration involving one of these servers is already running",
		});
	}
	for (const key of keys) activeServers.add(key);
	return () => {
		for (const key of keys) activeServers.delete(key);
	};
};

interface MigrationGroup {
	label: string;
	services: ServerServiceSummary[];
}

const groupByEnvironment = (services: ServerServiceSummary[]) => {
	const groups = new Map<string, MigrationGroup>();
	for (const service of services) {
		const group = groups.get(service.environmentId) ?? {
			label: `${service.projectName} / ${service.environmentName}`,
			services: [],
		};
		group.services.push(service);
		groups.set(service.environmentId, group);
	}
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
};

interface CutoverDomain {
	domain: ServiceDomain;
	change: DnsChange;
	proxied: boolean;
	baseline: ProbeResult;
}

interface CommittedGroup {
	label: string;
	staged: StagedTransfer[];
	drainUntil: number;
}

export interface MigrateServerOptions {
	onTransferred?: (result: {
		serviceId: string;
		appName: string;
	}) => Promise<void>;
	timing?: Partial<MigrationTiming>;
}

/**
 * Moves services environment by environment, so an app and the database it
 * uses switch together. For each environment: stateless services are
 * deployed on the target while the source keeps serving, stateful ones are
 * stopped and copied, everything is health-checked on the target, then DNS
 * is switched and checked publicly. Any failure up to that point rolls the
 * whole environment back, DNS included. Old copies are only removed once
 * every environment has cut over and resolvers have had time to catch up.
 */
export const migrateServer = async (
	input: z.infer<typeof apiMigrateServer> & { organizationId: string },
	log: Logger,
	options: MigrateServerOptions = {},
) => {
	const timing = { ...DEFAULT_TIMING, ...options.timing };
	const { source, target } = await validateServers(input, input.organizationId);
	const onSource = new Map(
		(await getServerServices([input.sourceServerId])).map((service) => [
			service.id,
			service,
		]),
	);
	const selected = input.services
		.map((item) => onSource.get(item.serviceId))
		.filter(
			(service, index): service is ServerServiceSummary =>
				service?.type === input.services[index]?.serviceType,
		);
	if (selected.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `None of the selected services are on ${source.name}`,
		});
	}

	const unlock = lockServers([
		input.sourceServerId,
		input.targetServerId ?? "dokploy",
	]);
	try {
		const dns = await createDnsContext(input.organizationId, source, target);
		if (input.updateDns) {
			for (const error of dns.cloudflare.errors) {
				log(`Warning: Cloudflare provider ${error}`);
			}
			if (!dns.targetIp) {
				log(
					`Warning: no public IPv4 address found for ${target.name}, DNS records will not be updated`,
				);
			}
		}
		const serviceDomains = await findServiceDomains(selected);
		const groups = groupByEnvironment(selected);

		const architecture = await resolveArchitectures({
			...input,
			newServer: undefined,
		});
		if (architecture.mismatch) {
			log(
				`Warning: ${source.name} is ${architecture.source} but ${target.name} is ${architecture.target}`,
			);
			const stateful = await findStatefulServices(
				input.sourceServerId,
				selected,
			);
			const checks = await checkServicesArchitecture(
				input.sourceServerId,
				selected.map((service) => ({
					id: service.id,
					type: service.type,
					appName: service.appName,
					stateful: stateful.has(service.id),
				})),
				architecture.target as CpuArchitecture,
			);
			for (const service of selected) {
				const check = checks.get(service.id);
				if (!check) continue;
				if (check.status !== "ok") {
					log(`  ${service.name}: ${check.message}`);
				}
				if (check.dataWarning) {
					log(`  ${service.name}: ${check.dataWarning}`);
				}
			}
		} else if (!architecture.source || !architecture.target) {
			log("Warning: could not compare the CPU architecture of the two servers");
		}

		const migrated: string[] = [];
		const failed: { name: string; error: string }[] = [];
		const manualDns: { host: string; message: string }[] = [];
		const committed: CommittedGroup[] = [];

		log(
			`Migrating ${selected.length} service(s) in ${groups.length} environment(s) from ${source.name} to ${target.name}`,
		);

		for (const [groupIndex, group] of groups.entries()) {
			log("");
			log(`[${groupIndex + 1}/${groups.length}] ${group.label}`);
			const prefix = (line: string) => log(`  ${line}`);
			const staged: StagedTransfer[] = [];
			const reverts: DnsRevert[] = [];
			const groupManual: { host: string; message: string }[] = [];

			try {
				const prepared: StagedTransfer[] = [];
				for (const service of [...group.services].sort(byMigrationOrder)) {
					prepared.push(
						await prepareTransfer({
							serviceType: service.type,
							serviceId: service.id,
							targetServerId: input.targetServerId,
							organizationId: input.organizationId,
						}),
					);
				}
				// Stateless services build and start while the source still
				// serves, so only the data copy falls inside the downtime.
				const ordered = [
					...prepared.filter((item) => !item.stateful),
					...prepared.filter((item) => item.stateful),
				];

				const domainsInGroup = group.services.flatMap(
					(service) => serviceDomains.get(service.id) ?? [],
				);
				const cutover: CutoverDomain[] = [];
				for (const domain of domainsInGroup) {
					const analysis = await analyzeDomain(domain.host, dns);
					if (input.updateDns && analysis.change) {
						cutover.push({
							domain,
							change: analysis.change,
							proxied: !!analysis.plan.proxied,
							baseline: isProbeable(domain)
								? await probePublic(domain)
								: { status: 200, body: "" },
						});
					} else if (analysis.change) {
						groupManual.push({
							host: domain.host,
							message: `DNS updates are off, point it to ${dns.targetIp ?? target.name}`,
						});
					} else if (analysis.plan.status !== "already-migrated") {
						groupManual.push({
							host: domain.host,
							message: analysis.plan.message,
						});
					}
				}

				for (const item of ordered) {
					staged.push(item);
					await stageTransfer(item, prefix);
				}

				prefix("Checking that everything is healthy on the target");
				for (const item of staged) {
					await waitUntilHealthy(item, prefix, timing.healthTimeoutMs);
				}
				for (const domain of domainsInGroup.filter(isProbeable)) {
					const deadline = Date.now() + timing.healthTimeoutMs;
					let result = await probeOnTarget(input.targetServerId, domain);
					while (!isServing(result) && Date.now() < deadline) {
						await sleep(timing.pollMs);
						result = await probeOnTarget(input.targetServerId, domain);
					}
					if (!isServing(result)) {
						throw new Error(
							`${domain.host} is not served on ${target.name} (${describeProbe(result)})`,
						);
					}
					prefix(
						`${domain.host} answers on ${target.name} (${describeProbe(result)})`,
					);
				}

				let drainMs = 0;
				if (cutover.length > 0 && dns.targetIp) {
					prefix("Switching DNS");
					for (const item of cutover) {
						reverts.push(
							...(await applyDnsChange(
								item.domain.host,
								item.change,
								dns.targetIp,
								dns.cloudflare,
							)),
						);
						prefix(
							`DNS ${item.domain.host} → ${dns.targetIp}${item.proxied ? " (proxied)" : ""}`,
						);
						drainMs = Math.max(
							drainMs,
							item.proxied
								? timing.proxiedPropagationMs
								: Math.min(
										timing.maxDrainMs,
										Math.max(
											...item.change.update
												.concat(item.change.remove)
												.map((record) => effectiveTtlMs(record.ttl)),
										),
									),
						);
					}

					if (cutover.some((item) => item.proxied)) {
						await sleep(timing.proxiedPropagationMs);
					}
					const pending = cutover.filter((item) => isProbeable(item.domain));
					const deadline = Date.now() + timing.publicCheckTimeoutMs;
					let reloadedTraefik = false;
					while (pending.length > 0) {
						for (const item of [...pending]) {
							const result = await probePublic(
								item.domain,
								item.proxied ? undefined : (dns.targetIp ?? undefined),
							);
							if (isServing(result) || !isServing(item.baseline)) {
								if (!isServing(item.baseline)) {
									prefix(
										`${item.domain.host} was not serving before the migration either (${describeProbe(item.baseline)}), not waiting for it`,
									);
								} else {
									prefix(
										`${item.domain.host} is live (${describeProbe(result)})`,
									);
								}
								pending.splice(pending.indexOf(item), 1);
							} else if (
								Date.now() >= deadline &&
								(reloadedTraefik || !item.domain.https)
							) {
								throw new Error(
									`${item.domain.host} is not reachable after the DNS switch (${describeProbe(result)})`,
								);
							} else {
								prefix(
									`Waiting for ${item.domain.host}: ${describeProbe(result)}`,
								);
							}
						}
						if (pending.length === 0) break;
						// Traefik doesn't retry a certificate whose challenge failed while
						// DNS still pointed at the old server; a restart makes it try again.
						if (!reloadedTraefik && pending.some((item) => item.domain.https)) {
							reloadedTraefik = true;
							prefix(
								`Restarting Traefik on ${target.name} so it requests certificates now that DNS points to it`,
							);
							await reloadDockerResource(
								"dokploy-traefik",
								input.targetServerId ?? undefined,
							);
						}
						await sleep(timing.pollMs);
					}
				}

				for (const item of groupManual) {
					prefix(`DNS ${item.host}: ${item.message}`);
				}
				manualDns.push(...groupManual);
				committed.push({
					label: group.label,
					staged,
					drainUntil: Date.now() + drainMs,
				});
				migrated.push(
					...staged.map((item) => `${group.label} / ${item.source.name}`),
				);
				prefix(`${group.label} is live on ${target.name}`);
			} catch (error) {
				prefix(`Failed: ${errorMessage(error)}`);
				for (const revert of [...reverts].reverse()) {
					try {
						await revert.run();
						prefix(`DNS ${revert.host} restored`);
					} catch (revertError) {
						prefix(
							`Could not restore DNS for ${revert.host}: ${errorMessage(revertError)}`,
						);
					}
				}
				for (const item of [...staged].reverse()) {
					try {
						await rollbackTransfer(item, prefix);
					} catch (rollbackError) {
						prefix(
							`Rollback of ${item.source.appName} failed: ${errorMessage(rollbackError)}`,
						);
					}
				}
				failed.push({ name: group.label, error: errorMessage(error) });
			}
		}

		if (committed.length > 0) {
			log("");
			const keptRunning = committed.some((group) =>
				group.staged.some((item) => !item.stateful),
			);
			const waitMs = Math.max(
				0,
				...committed.map((group) => group.drainUntil - Date.now()),
			);
			if (keptRunning && waitMs > 0) {
				log(
					`Keeping the old copies on ${source.name} running for ${Math.ceil(waitMs / 1000)}s while DNS caches expire`,
				);
				await sleep(waitMs);
			}
			log(`Removing the old copies from ${source.name}`);
			for (const group of committed) {
				for (const item of group.staged) {
					try {
						await commitTransfer(item, input.removeSourceData, (line) =>
							log(`  ${line}`),
						);
						await options.onTransferred?.({
							serviceId: item.serviceId,
							appName: item.source.appName,
						});
					} catch (error) {
						log(
							`  Warning: could not clean up ${item.source.appName}: ${errorMessage(error)}`,
						);
					}
				}
			}
		}

		log("");
		log(
			`Migrated ${migrated.length} of ${selected.length} service(s) to ${target.name}`,
		);
		for (const item of failed) {
			log(`  Rolled back ${item.name}: ${item.error}`);
		}
		if (manualDns.length > 0) {
			log(`${manualDns.length} domain(s) need a manual DNS update:`);
			for (const item of manualDns) {
				log(`  ${item.host}: ${item.message}`);
			}
		}

		return { migrated, failed, manualDns };
	} finally {
		unlock();
	}
};
