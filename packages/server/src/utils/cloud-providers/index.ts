import { hetzner } from "./hetzner";
import type {
	CloudCredentials,
	CloudProviderDefinition,
	CloudProviderType,
} from "./types";

export * from "./types";

export const cloudProviders: Record<
	CloudProviderType,
	CloudProviderDefinition
> = {
	hetzner,
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
