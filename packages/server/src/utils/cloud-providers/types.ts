/**
 * Adding a provider: add its id here, implement `CloudProviderDefinition` in
 * its own file, and register it in `./index.ts`. See docs/cloud-providers.md.
 */
export const cloudProviderTypes = ["hetzner"] as const;

export type CloudProviderType = (typeof cloudProviderTypes)[number];

export interface CloudCredentialField {
	name: string;
	label: string;
	/** Secret fields are masked in API responses and kept when left blank on update. */
	secret: boolean;
	placeholder?: string;
	description?: string;
}

export type CloudCredentials = Record<string, string>;

export interface CloudLocation {
	id: string;
	city: string;
	/** ISO 3166-1 alpha-2, used for the flag. */
	country: string;
	region: string;
	availableServerTypes: string[];
}

export interface CloudServerType {
	id: string;
	label: string;
	/** Groups server types into tabs in the UI, e.g. "Shared · x86". */
	family: string;
	cores: number;
	memoryGb: number;
	diskGb: number;
	architecture: "x86" | "arm";
	prices: { location: string; hourly: number; monthly: number }[];
}

export interface CloudImage {
	id: string;
	label: string;
	osFlavor: string;
	architecture: "x86" | "arm";
}

export interface CloudCatalog {
	currency: string;
	locations: CloudLocation[];
	serverTypes: CloudServerType[];
	images: CloudImage[];
}

export interface CloudServer {
	id: string;
	status: "starting" | "running" | "error";
	ipv4: string | null;
	ipv6: string | null;
}

export interface CloudMoney {
	net: number;
	gross: number;
}

/** What one server costs per month at the provider's current prices. */
export interface CloudServerCost {
	id: string;
	name: string;
	serverType: string;
	location: string;
	status: string;
	ipv4: string | null;
	/** Usually a /64 network rather than a single address. */
	ipv6: string | null;
	monthly: {
		server: CloudMoney;
		backups: CloudMoney;
		primaryIps: CloudMoney;
		volumes: CloudMoney;
		total: CloudMoney;
	};
}

export interface CloudCostReport {
	currency: string;
	/** Percent, e.g. 19 for 19%. */
	vatRate: number;
	servers: CloudServerCost[];
}

export interface CreateCloudServerInput {
	name: string;
	location: string;
	serverType: string;
	image: string;
	sshKeyId: string;
}

export interface CloudProviderClient {
	/** Throws a `CloudProviderError` when the credentials can't create servers. */
	validateCredentials(): Promise<void>;
	getCatalog(): Promise<CloudCatalog>;
	importSshKey(name: string, publicKey: string): Promise<string>;
	deleteSshKey(id: string): Promise<void>;
	createServer(input: CreateCloudServerInput): Promise<CloudServer>;
	getServer(id: string): Promise<CloudServer>;
	/** Must succeed when the server is already gone. */
	deleteServer(id: string): Promise<void>;
	/** Optional: providers without pricing data are left out of cost totals. */
	listServerCosts?(): Promise<CloudCostReport>;
}

export interface CloudProviderDefinition {
	type: CloudProviderType;
	label: string;
	description: string;
	credentialFields: CloudCredentialField[];
	credentialsHelp: string;
	credentialsHelpUrl?: string;
	/** User Dokploy connects as over SSH on freshly created servers. */
	sshUsername: string;
	createClient(credentials: CloudCredentials): CloudProviderClient;
}

export class CloudProviderError extends Error {
	constructor(
		message: string,
		readonly kind:
			| "unauthorized"
			| "forbidden"
			| "not_found"
			| "invalid"
			/** Rate limited or a provider outage; worth retrying later. */
			| "unavailable",
		readonly status?: number,
	) {
		super(message);
		this.name = "CloudProviderError";
	}
}
