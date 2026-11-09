import { contabo } from "./contabo";
import { digitalocean } from "./digitalocean";
import { hetzner } from "./hetzner";
import { ovhcloud } from "./ovhcloud";
import type {
	CloudCredentials,
	CloudProviderDefinition,
	CloudProviderType,
} from "./types";
import { vultr } from "./vultr";

export * from "./types";

export const cloudProviders: Record<
	CloudProviderType,
	CloudProviderDefinition
> = {
	hetzner,
	ovhcloud,
	digitalocean,
	vultr,
	contabo,
};

export const getCloudProviderDefinition = (type: string) => {
	const definition = cloudProviders[type as CloudProviderType];
	if (!definition) {
		throw new Error(`Unsupported cloud provider: ${type}`);
	}
	return definition;
};

export const createCloudProviderClient = (
	type: string,
	credentials: CloudCredentials,
) => getCloudProviderDefinition(type).createClient(credentials);

/** Provider metadata the UI needs to render forms, without server-only code. */
export const listCloudProviderDefinitions = () =>
	Object.values(cloudProviders).map(
		({ createClient: _createClient, ...definition }) => definition,
	);
