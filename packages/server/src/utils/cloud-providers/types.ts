/**
 * Adding a provider: add its id here, implement `CloudProviderDefinition` in
 * its own file, and register it in `./index.ts`. See docs/cloud-providers.md.
 */
export const cloudProviderTypes = [
	"hetzner",
	"ovhcloud",
	"digitalocean",
	"vultr",
	"contabo",
] as const;

export type CloudProviderType = (typeof cloudProviderTypes)[number];

export interface CloudCredentialField {
	name: string;
	label: string;
	/** Secret fields are masked in API responses and kept when left blank on update. */
	secret: boolean;
	placeholder?: string;
	description?: string;
	/** Renders a select instead of a text input; the first option is the default. */
	options?: { value: string; label: string }[];
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
	/** Null when the provider doesn't say. */
	cores: number | null;
	memoryGb: number | null;
	diskGb: number;
	architecture: "x86" | "arm";
	/**
	 * One entry per location it's offered in; null prices when the provider
	 * doesn't publish them. `hourly` and `monthly` are what the provider
	 * charges (some include VAT); `monthlyNet` is before tax, for comparing
	 * providers, and defaults to `monthly`.
	 */
	prices: {
		location: string;
		hourly: number | null;
		monthly: number | null;
		monthlyNet?: number | null;
	}[];
}

export interface CloudImage {
	id: string;
	label: string;
	osFlavor: string;
	architecture: "x86" | "arm";
}

export interface CloudCatalog {
	currency: string;
	/**
	 * Set on a public catalog whose locations are the provider's usual ones
	 * rather than confirmed availability, which needs an account.
	 */
	approximateLocations?: boolean;
	locations: CloudLocation[];
	serverTypes: CloudServerType[];
	images: CloudImage[];
}

export interface CloudServer {
	id: string;
	status: "starting" | "running" | "error";
	ipv4: string | null;
	ipv6: string | null;
	/** Overrides the definition's `sshUsername` when the login user depends on the image. */
	sshUsername?: string;
	/** Why the server isn't starting, e.g. a payment or verification hold. */
	statusMessage?: string;
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

/** A block storage volume and the provider server it is attached to, if any. */
export interface CloudVolume {
	id: string;
	name: string;
	sizeGb: number;
	location: string;
	status: string;
	/** Where the provider says the volume appears on the attached server */
	linuxDevice: string | null;
	server: { id: string; ipv4: string | null; ipv6: string | null } | null;
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
	/**
	 * Must succeed when the server is already gone. For providers with
	 * `removal: "cancel"` this cancels the contract instead.
	 */
	deleteServer(id: string): Promise<void>;
	/** Optional: providers without pricing data are left out of cost totals. */
	listServerCosts?(): Promise<CloudCostReport>;
	/** Optional: providers without block storage are skipped. */
	listVolumes?(): Promise<CloudVolume[]>;
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
	/**
	 * "cancel": servers can't be deleted, only cancelled for the end of their
	 * paid term. A failed provisioning then keeps the server instead of
	 * throwing away a month that's already billed. Defaults to "delete".
	 */
	removal?: "delete" | "cancel";
	/** How long a new server may take to start. Defaults to five minutes. */
	bootTimeoutMs?: number;
	/**
	 * Server types and prices the provider publishes without credentials, so
	 * they can be browsed before an account is connected. Images may be empty.
	 */
	getPublicCatalog?: () => Promise<CloudCatalog>;
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
