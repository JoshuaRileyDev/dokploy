import { lookup, reverse } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { server } from "@dokploy/server/db/schema";
import {
	type CloudCredentials,
	type CloudServerCost,
	createCloudProviderClient,
	getCloudProviderDefinition,
} from "@dokploy/server/utils/cloud-providers";
import { eq } from "drizzle-orm";
import { findCloudProviderAccountsByOrganizationId } from "./cloud-provider";
import { getWebServerSettings } from "./web-server-settings";

const DNS_TIMEOUT_MS = 3_000;

// Hetzner's default reverse DNS for cloud and dedicated IPs, e.g.
// static.1.2.3.4.clients.your-server.de.
const HETZNER_PTR_SUFFIX = ".your-server.de";

interface AddressedServer {
	serverId: string;
	name: string;
	addresses: string[];
}

const withTimeout = <T>(promise: Promise<T>, fallback: T) =>
	Promise.race([
		promise.catch(() => fallback),
		new Promise<T>((resolve) =>
			setTimeout(() => resolve(fallback), DNS_TIMEOUT_MS),
		),
	]);

/** Server addresses may be hostnames, so they're resolved before matching. */
export const resolveAddresses = async (host: string) => {
	const value = host.trim().toLowerCase();
	if (!value) return [];
	if (isIP(value)) return [value];
	const found = await withTimeout(lookup(value, { all: true }), []);
	return found.map((entry) => entry.address.toLowerCase());
};

const inIpv6Network = (address: string, network: string) => {
	if (isIP(address) !== 6) return false;
	const [prefix, length = "128"] = network.split("/");
	if (!prefix || isIP(prefix) !== 6) return false;
	const list = new BlockList();
	list.addSubnet(prefix, Number(length), "ipv6");
	return list.check(address, "ipv6");
};

export const costMatchesAddresses = (
	cost: Pick<CloudServerCost, "ipv4" | "ipv6">,
	addresses: string[],
) =>
	addresses.some(
		(address) =>
			address === cost.ipv4 ||
			(!!cost.ipv6 && inIpv6Network(address, cost.ipv6)),
	);

const looksLikeHetzner = async (addresses: string[]) => {
	for (const address of addresses) {
		const names = await withTimeout(reverse(address), []);
		if (names.some((name) => name.toLowerCase().endsWith(HETZNER_PTR_SUFFIX)))
			return true;
	}
	return false;
};

export const readCredentials = (raw: string): CloudCredentials | null => {
	try {
		return JSON.parse(raw) as CloudCredentials;
	} catch {
		return null;
	}
};

export const getServerCosts = async (organizationId: string) => {
	const [accounts, dokployServers, settings] = await Promise.all([
		findCloudProviderAccountsByOrganizationId(organizationId),
		db.query.server.findMany({
			where: eq(server.organizationId, organizationId),
			columns: { serverId: true, name: true, ipAddress: true },
		}),
		IS_CLOUD ? null : getWebServerSettings().catch(() => null),
	]);

	const [addressed, hostAddresses] = await Promise.all([
		Promise.all(
			dokployServers.map(
				async (s): Promise<AddressedServer> => ({
					serverId: s.serverId,
					name: s.name,
					addresses: await resolveAddresses(s.ipAddress),
				}),
			),
		),
		settings?.serverIp ? resolveAddresses(settings.serverIp) : [],
	]);

	const reports = await Promise.all(
		accounts.map(async (account) => {
			const definition = getCloudProviderDefinition(account.providerType);
			const credentials = readCredentials(account.credentials);
			const summary = {
				cloudProviderAccountId: account.cloudProviderAccountId,
				name: account.name,
				providerType: account.providerType,
				providerLabel: definition.label,
			};
			if (!credentials) {
				return {
					...summary,
					error: "Stored credentials could not be read. Re-enter them.",
					report: null,
				};
			}
			const client = createCloudProviderClient(
				account.providerType,
				credentials,
			);
			if (!client.listServerCosts) return null;
			try {
				return {
					...summary,
					error: null,
					report: await client.listServerCosts(),
				};
			} catch (error) {
				return {
					...summary,
					error:
						error instanceof Error ? error.message : "Could not load prices",
					report: null,
				};
			}
		}),
	);

	const seen = new Set<string>();
	const matchedServerIds = new Set<string>();
	const servers = reports.flatMap((entry) => {
		if (!entry?.report) return [];
		const { currency } = entry.report;
		return entry.report.servers.flatMap((cost) => {
			// The same provider project can be connected under two account names.
			const key = `${entry.providerType}:${cost.id}`;
			if (seen.has(key)) return [];
			seen.add(key);
			const match = addressed.find((s) =>
				costMatchesAddresses(cost, s.addresses),
			);
			if (match) matchedServerIds.add(match.serverId);
			return [
				{
					...cost,
					currency,
					cloudProviderAccountId: entry.cloudProviderAccountId,
					accountName: entry.name,
					providerType: entry.providerType,
					providerLabel: entry.providerLabel,
					dokployServerId: match?.serverId ?? null,
					dokployServerName: match?.name ?? null,
					isDokployHost: costMatchesAddresses(cost, hostAddresses),
				},
			];
		});
	});

	const totals = [
		...servers
			.reduce((byCurrency, cost) => {
				const current = byCurrency.get(cost.currency) ?? { net: 0, gross: 0 };
				byCurrency.set(cost.currency, {
					net: current.net + cost.monthly.total.net,
					gross: current.gross + cost.monthly.total.gross,
				});
				return byCurrency;
			}, new Map<string, { net: number; gross: number }>())
			.entries(),
	].map(([currency, total]) => ({ currency, ...total }));

	// Servers on Hetzner that no connected account covers can't be priced, but
	// flagging them tells the user which project token is missing.
	const unmatched = addressed.filter((s) => !matchedServerIds.has(s.serverId));
	const flags = await Promise.all(
		unmatched.map(async (s) =>
			(await looksLikeHetzner(s.addresses)) ? s : null,
		),
	);

	return {
		accounts: reports.flatMap((entry) =>
			entry
				? [
						{
							cloudProviderAccountId: entry.cloudProviderAccountId,
							name: entry.name,
							providerType: entry.providerType,
							providerLabel: entry.providerLabel,
							error: entry.error,
							vatRate: entry.report?.vatRate ?? null,
						},
					]
				: [],
		),
		servers: servers.sort(
			(a, b) => b.monthly.total.gross - a.monthly.total.gross,
		),
		totals,
		unpricedHetznerServers: flags
			.filter((s): s is AddressedServer => !!s)
			.map(({ serverId, name }) => ({ serverId, name })),
	};
};
