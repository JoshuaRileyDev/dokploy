import { db } from "@dokploy/server/db";
import { server } from "@dokploy/server/db/schema";
import {
	type CloudVolume,
	createCloudProviderClient,
	getCloudProviderDefinition,
} from "@dokploy/server/utils/cloud-providers";
import { eq } from "drizzle-orm";
import {
	costMatchesAddresses,
	readCredentials,
	resolveAddresses,
} from "./cloud-costs";
import { findCloudProviderAccountsByOrganizationId } from "./cloud-provider";

// Every open storage popover asks for this, so one provider round trip is shared for a while.
const CACHE_MS = 60_000;

const cache = new Map<
	string,
	{ at: number; volumes: Promise<CloudVolume[]> }
>();

const listAccountVolumes = (
	accountId: string,
	load: () => Promise<CloudVolume[]>,
) => {
	const hit = cache.get(accountId);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.volumes;
	const volumes = load();
	cache.set(accountId, { at: Date.now(), volumes });
	volumes.catch(() => cache.delete(accountId));
	return volumes;
};

export interface ServerCloudVolume extends CloudVolume {
	accountName: string;
	providerType: string;
	providerLabel: string;
}

/**
 * Volumes the connected cloud accounts report as attached to this Dokploy server,
 * matched by its public address the same way server costs are.
 */
export const getServerCloudVolumes = async (
	organizationId: string,
	serverId: string,
) => {
	const [accounts, target] = await Promise.all([
		findCloudProviderAccountsByOrganizationId(organizationId),
		db.query.server.findFirst({
			where: eq(server.serverId, serverId),
			columns: { ipAddress: true },
		}),
	]);
	const addresses = target ? await resolveAddresses(target.ipAddress) : [];

	const results = await Promise.all(
		accounts.map(async (account) => {
			const definition = getCloudProviderDefinition(account.providerType);
			const credentials = readCredentials(account.credentials);
			if (!credentials) {
				return {
					accountName: account.name,
					error: "Stored credentials could not be read. Re-enter them.",
					volumes: [] as ServerCloudVolume[],
				};
			}
			const client = createCloudProviderClient(
				account.providerType,
				credentials,
			);
			if (!client.listVolumes) return null;
			try {
				const volumes = await listAccountVolumes(
					account.cloudProviderAccountId,
					() => client.listVolumes!(),
				);
				return {
					accountName: account.name,
					error: null,
					volumes: volumes
						.filter(
							(volume) =>
								volume.server && costMatchesAddresses(volume.server, addresses),
						)
						.map(
							(volume): ServerCloudVolume => ({
								...volume,
								accountName: account.name,
								providerType: account.providerType,
								providerLabel: definition.label,
							}),
						),
				};
			} catch (error) {
				return {
					accountName: account.name,
					error:
						error instanceof Error ? error.message : "Could not list volumes",
					volumes: [] as ServerCloudVolume[],
				};
			}
		}),
	);

	const seen = new Set<string>();
	const volumes = results.flatMap((result) =>
		(result?.volumes ?? []).filter((volume) => {
			// The same project can be connected under two account names.
			const key = `${volume.providerType}:${volume.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	);

	return {
		hasAccounts: results.some(Boolean),
		volumes,
		errors: results.flatMap((result) =>
			result?.error
				? [{ accountName: result.accountName, error: result.error }]
				: [],
		),
	};
};
