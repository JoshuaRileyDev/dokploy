import { randomUUID } from "node:crypto";
import {
	type CloudCatalog,
	type CloudCredentials,
	type CloudLocation,
	type CloudProviderClient,
	type CloudProviderDefinition,
	CloudProviderError,
	type CloudServer,
	type CloudServerType,
	type CreateCloudServerInput,
} from "./types";

const CONTABO_API_URL = "https://api.contabo.com";
const CONTABO_TOKEN_URL =
	"https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";

const SUPPORTED_OS_FLAVORS = ["ubuntu", "debian"] as const;

const PAGE_SIZE = 100;

// The API has no product catalog, so these come from the product table in
// Contabo's API documentation, which only gives disk sizes. CPU and memory are
// filled in from instances already on the account when there are any, and
// products those instances use that aren't listed here are added too.
const PRODUCTS: { id: string; name: string; diskGb: number }[] = [
	{ id: "V153", name: "Cloud VPS 4", diskGb: 100 },
	{ id: "V154", name: "Cloud VPS 6", diskGb: 200 },
	{ id: "V155", name: "Cloud VPS 8", diskGb: 300 },
	{ id: "V156", name: "Cloud VPS 12", diskGb: 400 },
	{ id: "V157", name: "Cloud VPS 16", diskGb: 500 },
	{ id: "V158", name: "Cloud VPS 18", diskGb: 600 },
	{ id: "V159", name: "Cloud VPS Plus 4", diskGb: 150 },
	{ id: "V160", name: "Cloud VPS Plus 6", diskGb: 300 },
	{ id: "V161", name: "Cloud VPS Plus 8", diskGb: 450 },
	{ id: "V162", name: "Cloud VPS Plus 12", diskGb: 600 },
	{ id: "V163", name: "Cloud VPS Plus 16", diskGb: 750 },
	{ id: "V164", name: "Cloud VPS Plus 18", diskGb: 900 },
	{ id: "V93", name: "VPS 10 Storage", diskGb: 300 },
	{ id: "V96", name: "VPS 20 Storage", diskGb: 400 },
	{ id: "V99", name: "VPS 30 Storage", diskGb: 1000 },
	{ id: "V102", name: "VPS 40 Storage", diskGb: 1200 },
	{ id: "V105", name: "VPS 50 Storage", diskGb: 1400 },
	{ id: "V8", name: "VDS S", diskGb: 180 },
	{ id: "V9", name: "VDS M", diskGb: 240 },
	{ id: "V10", name: "VDS L", diskGb: 360 },
	{ id: "V11", name: "VDS XL", diskGb: 480 },
	{ id: "V16", name: "VDS XXL", diskGb: 720 },
];

// The values `region` accepts when creating an instance.
const REGIONS: Omit<CloudLocation, "availableServerTypes">[] = [
	{ id: "EU", city: "Germany", country: "DE", region: "Europe" },
	{ id: "UK", city: "Portsmouth", country: "GB", region: "Europe" },
	{ id: "US-central", city: "St. Louis", country: "US", region: "US central" },
	{ id: "US-east", city: "New York", country: "US", region: "US east" },
	{ id: "US-west", city: "Seattle", country: "US", region: "US west" },
	{ id: "SIN", city: "Singapore", country: "SG", region: "Asia" },
	{ id: "JPN", city: "Tokyo", country: "JP", region: "Asia" },
	{ id: "IND", city: "Mumbai", country: "IN", region: "Asia" },
	{ id: "AUS", city: "Sydney", country: "AU", region: "Australia" },
];

const STARTING_STATUSES = new Set([
	"provisioning",
	"installing",
	"manual_provisioning",
	"uninstalled",
	"reset_password",
	"unknown",
	"other",
]);

const STATUS_MESSAGES: Record<string, string> = {
	pending_payment:
		"Contabo is waiting for payment for this server. Pay the invoice in the Contabo Customer Control Panel, then add the server to Dokploy by hand.",
	verification_required:
		"Contabo needs to verify your account before it starts this server. Complete the verification in the Contabo Customer Control Panel, then add the server to Dokploy by hand.",
	product_not_available:
		"Contabo can't provide this product in the chosen region right now.",
	stopped: "The server was stopped before it finished starting.",
	rescue: "The server booted into rescue mode.",
};

interface Envelope<T> {
	data: T[];
	_pagination?: { totalPages?: number; page?: number };
}

interface ContaboInstance {
	instanceId: number;
	displayName?: string;
	name?: string;
	status: string;
	errorMessage?: string | null;
	productId?: string;
	productName?: string;
	cpuCores?: number;
	ramMb?: number;
	diskMb?: number;
	ipConfig?: { v4?: { ip?: string }; v6?: { ip?: string } };
}

interface ContaboImage {
	imageId: string;
	name: string;
	description?: string;
	osType?: string;
	version?: string;
	status?: string;
	standardImage?: boolean;
	gpu?: boolean;
}

interface ContaboDataCenter {
	regionSlug?: string;
}

const familyOf = (name: string) =>
	name.startsWith("VDS")
		? "Dedicated (VDS)"
		: name.includes("Storage")
			? "Storage VPS"
			: name.includes("Plus")
				? "Cloud VPS Plus"
				: "Cloud VPS";

const toOsFlavor = (image: ContaboImage) =>
	SUPPORTED_OS_FLAVORS.find((flavor) =>
		image.name.toLowerCase().startsWith(flavor),
	);

const toCloudServer = (instance: ContaboInstance): CloudServer => {
	const status =
		instance.status === "running"
			? "running"
			: STARTING_STATUSES.has(instance.status)
				? "starting"
				: "error";
	return {
		id: String(instance.instanceId),
		status,
		ipv4: instance.ipConfig?.v4?.ip || null,
		ipv6: instance.ipConfig?.v6?.ip || null,
		...(status === "error" && {
			statusMessage:
				STATUS_MESSAGES[instance.status] ??
				instance.errorMessage ??
				`Contabo reports the server as ${instance.status}`,
		}),
	};
};

const httpError = (status: number, body: unknown) => {
	const { message } = (body ?? {}) as { message?: string | string[] };
	const text = Array.isArray(message) ? message.join(", ") : message;
	return new CloudProviderError(
		status === 401
			? "Contabo rejected the API credentials. Check the client ID, client secret, API user and API password."
			: (text ?? `Contabo API request failed (${status})`),
		status === 401
			? "unauthorized"
			: status === 403
				? "forbidden"
				: status === 404
					? "not_found"
					: status === 429 || status >= 500
						? "unavailable"
						: "invalid",
		status,
	);
};

class ContaboClient implements CloudProviderClient {
	private token?: { value: string; expiresAt: number };

	constructor(private readonly credentials: CloudCredentials) {}

	private async accessToken() {
		if (this.token && Date.now() < this.token.expiresAt) {
			return this.token.value;
		}
		const response = await fetch(CONTABO_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "password",
				client_id: this.credentials.clientId ?? "",
				client_secret: this.credentials.clientSecret ?? "",
				username: this.credentials.apiUser ?? "",
				password: this.credentials.apiPassword ?? "",
			}),
			signal: AbortSignal.timeout(30_000),
		}).catch((error) => {
			throw new CloudProviderError(
				`Could not reach Contabo's login service: ${error instanceof Error ? error.message : String(error)}`,
				"unavailable",
			);
		});
		const body = (await response.json().catch(() => ({}))) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!response.ok || !body.access_token) {
			throw new CloudProviderError(
				response.status >= 500
					? `Contabo's login service is unavailable (${response.status})`
					: "Contabo rejected the API credentials. Check the client ID, client secret, API user and API password.",
				response.status >= 500 ? "unavailable" : "unauthorized",
				response.status,
			);
		}
		// Renew a little early so a request never goes out with a token that
		// expires in flight.
		this.token = {
			value: body.access_token,
			expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 300) - 30) * 1000,
		};
		return this.token.value;
	}

	private async request<T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<T> {
		const token = await this.accessToken();
		let response: Response;
		try {
			response = await fetch(`${CONTABO_API_URL}${path}`, {
				method: init.method ?? "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					// Required on every call; Contabo uses it to deduplicate retries.
					"x-request-id": randomUUID(),
				},
				...(init.body !== undefined && { body: JSON.stringify(init.body) }),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new CloudProviderError(
				`Could not reach the Contabo API: ${error instanceof Error ? error.message : String(error)}`,
				"unavailable",
			);
		}
		if (response.status === 204) return undefined as T;
		const text = await response.text();
		let body: unknown = null;
		if (text) {
			try {
				body = JSON.parse(text);
			} catch {}
		}
		if (!response.ok) throw httpError(response.status, body);
		return body as T;
	}

	private async listAll<T>(path: string, params: Record<string, string> = {}) {
		const items: T[] = [];
		for (let page = 1; ; page++) {
			const query = new URLSearchParams({
				...params,
				page: String(page),
				size: String(PAGE_SIZE),
			});
			const response = await this.request<Envelope<T>>(`${path}?${query}`);
			items.push(...(response.data ?? []));
			const totalPages = response._pagination?.totalPages ?? 1;
			if (page >= totalPages || (response.data ?? []).length === 0) {
				return items;
			}
		}
	}

	async validateCredentials() {
		await this.request("/v1/compute/instances?size=1");
		// An API user whose role can read but not create would only fail once
		// provisioning starts. An empty body gets a 400 when creating secrets is
		// allowed and a 403 when it isn't; anything else proves nothing.
		try {
			await this.request("/v1/secrets", { method: "POST", body: {} });
		} catch (error) {
			if (error instanceof CloudProviderError && error.kind === "forbidden") {
				throw new CloudProviderError(
					"This API user can't create resources. Give its role permission to manage instances and secrets.",
					"forbidden",
					403,
				);
			}
			const rejectedOnlyForBadInput =
				error instanceof CloudProviderError &&
				(error.status === 400 || error.status === 422);
			if (!rejectedOnlyForBadInput) throw error;
		}
	}

	async getCatalog(): Promise<CloudCatalog> {
		const [instances, images, dataCenters] = await Promise.all([
			this.listAll<ContaboInstance>("/v1/compute/instances").catch(() => []),
			this.listAll<ContaboImage>("/v1/compute/images", {
				standardImage: "true",
			}),
			this.listAll<ContaboDataCenter>("/v1/data-centers").catch(() => []),
		]);

		const products = new Map(
			PRODUCTS.map((product) => [
				product.id,
				{
					...product,
					cores: null as number | null,
					memoryGb: null as number | null,
				},
			]),
		);
		for (const instance of instances) {
			if (!instance.productId) continue;
			const known = products.get(instance.productId);
			products.set(instance.productId, {
				id: instance.productId,
				name: known?.name ?? instance.productName ?? instance.productId,
				diskGb:
					known?.diskGb ??
					(instance.diskMb ? Math.round(instance.diskMb / 1024) : 0),
				cores: instance.cpuCores ?? known?.cores ?? null,
				memoryGb: instance.ramMb
					? Math.round(instance.ramMb / 1024)
					: (known?.memoryGb ?? null),
			});
		}

		// Data centers say which regions the account can use; if that lookup
		// fails, every region the create call accepts is offered.
		const usableRegions = new Set(
			dataCenters
				.map((dc) => dc.regionSlug)
				.filter((slug): slug is string => !!slug),
		);
		const regions =
			usableRegions.size > 0
				? REGIONS.filter((region) => usableRegions.has(region.id))
				: REGIONS;

		const serverTypes: CloudServerType[] = [...products.values()].map(
			(product) => ({
				id: product.id,
				label: product.name,
				family: familyOf(product.name),
				cores: product.cores,
				memoryGb: product.memoryGb,
				diskGb: product.diskGb,
				// Contabo only sells x86 servers.
				architecture: "x86",
				prices: regions.map((region) => ({
					location: region.id,
					hourly: null,
					monthly: null,
				})),
			}),
		);

		return {
			currency: "EUR",
			locations: regions.map((region) => ({
				...region,
				availableServerTypes: serverTypes.map((type) => type.id),
			})),
			serverTypes,
			images: images
				.filter(
					(image) =>
						!image.gpu &&
						(image.osType ?? "linux").toLowerCase() === "linux" &&
						toOsFlavor(image),
				)
				.sort((a, b) => {
					const flavorA = toOsFlavor(a) as string;
					const flavorB = toOsFlavor(b) as string;
					if (flavorA !== flavorB) return flavorA === "ubuntu" ? -1 : 1;
					return (b.version ?? b.name).localeCompare(
						a.version ?? a.name,
						undefined,
						{ numeric: true },
					);
				})
				.map((image) => ({
					id: image.imageId,
					label: image.description || image.name,
					osFlavor: toOsFlavor(image) as string,
					architecture: "x86" as const,
				})),
		};
	}

	async importSshKey(name: string, publicKey: string) {
		const response = await this.request<Envelope<{ secretId: number }>>(
			"/v1/secrets",
			{ method: "POST", body: { name, value: publicKey, type: "ssh" } },
		);
		const secret = response.data?.[0];
		if (!secret) {
			throw new CloudProviderError(
				"Contabo did not return the stored SSH key",
				"invalid",
			);
		}
		return String(secret.secretId);
	}

	async deleteSshKey(id: string) {
		await this.request(`/v1/secrets/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}

	async createServer(input: CreateCloudServerInput) {
		const response = await this.request<Envelope<ContaboInstance>>(
			"/v1/compute/instances",
			{
				method: "POST",
				body: {
					displayName: input.name,
					productId: input.serverType,
					region: input.location,
					imageId: input.image,
					sshKeys: [Number(input.sshKeyId)],
					defaultUser: "root",
					period: 1,
				},
			},
		);
		const created = response.data?.[0];
		if (!created) {
			throw new CloudProviderError(
				"Contabo did not return the new instance",
				"invalid",
			);
		}
		return toCloudServer({
			...created,
			status: created.status ?? "provisioning",
		});
	}

	async getServer(id: string) {
		const response = await this.request<Envelope<ContaboInstance>>(
			`/v1/compute/instances/${encodeURIComponent(id)}`,
		);
		const instance = response.data?.[0];
		if (!instance) {
			throw new CloudProviderError(
				`Contabo instance ${id} not found`,
				"not_found",
				404,
			);
		}
		return toCloudServer(instance);
	}

	async deleteServer(id: string) {
		await this.request(
			`/v1/compute/instances/${encodeURIComponent(id)}/cancel`,
			{ method: "POST", body: {} },
		).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}
}

export const contabo: CloudProviderDefinition = {
	type: "contabo",
	label: "Contabo",
	description:
		"Monthly-billed VPS and VDS in Europe, the US, Asia and Australia.",
	credentialFields: [
		{ name: "clientId", label: "Client ID", secret: false },
		{ name: "clientSecret", label: "Client Secret", secret: true },
		{
			name: "apiUser",
			label: "API User",
			secret: false,
			placeholder: "you@example.com",
		},
		{ name: "apiPassword", label: "API Password", secret: true },
	],
	credentialsHelp:
		"All four are on the API page of the Contabo Customer Control Panel (my.contabo.com/api/details). Set an API password there if you haven't yet.",
	credentialsHelpUrl: "https://my.contabo.com/api/details",
	sshUsername: "root",
	removal: "cancel",
	// New Contabo servers regularly take 10 to 20 minutes before they run.
	bootTimeoutMs: 25 * 60_000,
	createClient: (credentials) => new ContaboClient(credentials),
};
