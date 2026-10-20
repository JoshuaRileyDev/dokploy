import {
	type CloudCatalog,
	type CloudProviderClient,
	type CloudProviderDefinition,
	CloudProviderError,
	type CloudServer,
	type CloudServerType,
} from "./types";

const HETZNER_API_URL = "https://api.hetzner.cloud/v1";

// Dokploy's server setup script only supports these distributions.
const SUPPORTED_OS_FLAVORS = new Set(["ubuntu", "debian"]);

interface Paginated {
	meta?: { pagination?: { next_page: number | null } };
}

interface HetznerLocation {
	name: string;
	country: string;
	city: string;
	network_zone: string;
}

interface HetznerServerType {
	id: number;
	name: string;
	cores: number;
	memory: number;
	disk: number;
	cpu_type: "shared" | "dedicated";
	architecture: "x86" | "arm";
	deprecated: boolean | null;
	locations?: {
		name: string;
		available: boolean;
		deprecation: { unavailable_after: string } | null;
	}[];
	prices: {
		location: string;
		price_hourly: { gross: string };
		price_monthly: { gross: string };
	}[];
}

interface HetznerImage {
	name: string | null;
	description: string;
	os_flavor: string;
	os_version: string | null;
	architecture: "x86" | "arm";
	deprecated: string | null;
}

interface HetznerServer {
	id: number;
	status: string;
	public_net: {
		ipv4: { ip: string } | null;
		ipv6: { ip: string } | null;
	};
}

const toCloudServer = (server: HetznerServer): CloudServer => ({
	id: String(server.id),
	status:
		server.status === "running"
			? "running"
			: server.status === "unknown"
				? "error"
				: "starting",
	ipv4: server.public_net.ipv4?.ip ?? null,
	ipv6: server.public_net.ipv6?.ip ?? null,
});

const familyOf = (type: HetznerServerType) =>
	type.cpu_type === "dedicated"
		? "Dedicated"
		: type.architecture === "arm"
			? "Shared · Arm"
			: "Shared · x86";

class HetznerClient implements CloudProviderClient {
	constructor(private readonly apiToken: string) {}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetch(`${HETZNER_API_URL}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				"Content-Type": "application/json",
				...init.headers,
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status === 204) {
			return undefined as T;
		}
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			const message =
				(body as { error?: { message?: string } }).error?.message ??
				`Hetzner API request failed (${response.status})`;
			throw new CloudProviderError(
				response.status === 401
					? "Hetzner rejected the API token. Check that it is correct and has not been revoked."
					: message,
				response.status === 401
					? "unauthorized"
					: response.status === 403
						? "forbidden"
						: response.status === 404
							? "not_found"
							: response.status === 429 || response.status >= 500
								? "unavailable"
								: "invalid",
				response.status,
			);
		}
		return body as T;
	}

	private async paginate<T>(
		path: string,
		key: string,
		params: Record<string, string> = {},
	): Promise<T[]> {
		const items: T[] = [];
		let page: number | null = 1;
		while (page) {
			const query = new URLSearchParams({
				...params,
				page: String(page),
				per_page: "50",
			});
			const response = await this.request<Paginated & Record<string, T[]>>(
				`${path}?${query}`,
			);
			items.push(...(response[key] ?? []));
			page = response.meta?.pagination?.next_page ?? null;
		}
		return items;
	}

	async validateCredentials() {
		await this.request("/locations?per_page=1");
		// Read-only tokens can list resources but every create call fails, which
		// would only surface halfway through provisioning. An empty body gets a
		// 400 from a writable token and a 403 from a read-only one; anything else
		// (rate limits, outages) proves nothing, so it fails the check.
		try {
			await this.request("/ssh_keys", {
				method: "POST",
				body: JSON.stringify({}),
			});
		} catch (error) {
			if (error instanceof CloudProviderError && error.kind === "forbidden") {
				throw new CloudProviderError(
					"This API token is read-only. Create a token with Read & Write permission.",
					"forbidden",
					403,
				);
			}
			const rejectedOnlyForBadInput =
				error instanceof CloudProviderError &&
				(error.status === 400 || error.status === 422);
			if (!rejectedOnlyForBadInput) {
				throw error;
			}
		}
	}

	async getCatalog(): Promise<CloudCatalog> {
		const [locations, types, images] = await Promise.all([
			this.paginate<HetznerLocation>("/locations", "locations"),
			this.paginate<HetznerServerType>("/server_types", "server_types"),
			this.paginate<HetznerImage>("/images", "images", {
				type: "system",
				status: "available",
			}),
		]);

		// Hetzner removed /datacenters in June 2026; availability now lives on
		// each server type. Types being retired from a location stay listed
		// there (unavailable, with a deprecation), so they're dropped entirely
		// rather than shown as sold out.
		const offeredIn = (type: HetznerServerType, location: string) => {
			if (!type.locations) return true;
			const entry = type.locations.find((l) => l.name === location);
			return !!entry && !entry.deprecation;
		};
		const availableIn = (type: HetznerServerType, location: string) =>
			offeredIn(type, location) &&
			(type.locations?.find((l) => l.name === location)?.available ?? true);

		const activeTypes = types.filter((type) => !type.deprecated);

		const serverTypes: CloudServerType[] = activeTypes
			.sort((a, b) => a.cores - b.cores || a.memory - b.memory)
			.map((type) => ({
				id: type.name,
				label: type.name.toUpperCase(),
				family: familyOf(type),
				cores: type.cores,
				memoryGb: type.memory,
				diskGb: type.disk,
				architecture: type.architecture,
				prices: type.prices
					.filter((price) => offeredIn(type, price.location))
					.map((price) => ({
						location: price.location,
						hourly: Number.parseFloat(price.price_hourly.gross),
						monthly: Number.parseFloat(price.price_monthly.gross),
					})),
			}))
			.filter((type) => type.prices.length > 0);

		return {
			currency: "EUR",
			locations: locations.map((location) => ({
				id: location.name,
				city: location.city,
				country: location.country,
				region: location.network_zone,
				availableServerTypes: activeTypes
					.filter((type) => availableIn(type, location.name))
					.map((type) => type.name),
			})),
			serverTypes,
			images: images
				.filter(
					(image) =>
						image.name &&
						!image.deprecated &&
						SUPPORTED_OS_FLAVORS.has(image.os_flavor),
				)
				.sort((a, b) =>
					a.os_flavor === b.os_flavor
						? (b.os_version ?? "").localeCompare(
								a.os_version ?? "",
								undefined,
								{
									numeric: true,
								},
							)
						: a.os_flavor === "ubuntu"
							? -1
							: 1,
				)
				.map((image) => ({
					id: image.name as string,
					label: image.description,
					osFlavor: image.os_flavor,
					architecture: image.architecture,
				})),
		};
	}

	async importSshKey(name: string, publicKey: string) {
		const response = await this.request<{ ssh_key: { id: number } }>(
			"/ssh_keys",
			{
				method: "POST",
				body: JSON.stringify({
					name,
					public_key: publicKey,
					labels: { "managed-by": "dokploy" },
				}),
			},
		);
		return String(response.ssh_key.id);
	}

	async deleteSshKey(id: string) {
		await this.request(`/ssh_keys/${id}`, { method: "DELETE" }).catch(
			(error) => {
				if (
					!(error instanceof CloudProviderError && error.kind === "not_found")
				)
					throw error;
			},
		);
	}

	async createServer(input: {
		name: string;
		location: string;
		serverType: string;
		image: string;
		sshKeyId: string;
	}) {
		const response = await this.request<{ server: HetznerServer }>("/servers", {
			method: "POST",
			body: JSON.stringify({
				name: input.name,
				server_type: input.serverType,
				location: input.location,
				image: input.image,
				ssh_keys: [Number(input.sshKeyId)],
				start_after_create: true,
				public_net: { enable_ipv4: true, enable_ipv6: true },
				labels: { "managed-by": "dokploy" },
			}),
		});
		return toCloudServer(response.server);
	}

	async getServer(id: string) {
		const response = await this.request<{ server: HetznerServer }>(
			`/servers/${id}`,
		);
		return toCloudServer(response.server);
	}

	async deleteServer(id: string) {
		await this.request(`/servers/${id}`, { method: "DELETE" }).catch(
			(error) => {
				if (
					!(error instanceof CloudProviderError && error.kind === "not_found")
				)
					throw error;
			},
		);
	}
}

export const hetzner: CloudProviderDefinition = {
	type: "hetzner",
	label: "Hetzner Cloud",
	description: "Cloud servers in Germany, Finland, the US and Singapore.",
	credentialFields: [
		{
			name: "apiToken",
			label: "API Token",
			secret: true,
			placeholder: "Paste your API token",
		},
	],
	credentialsHelp:
		"In the Hetzner Console open your project, then Security → API tokens → Generate API token with Read & Write permission.",
	credentialsHelpUrl:
		"https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/",
	sshUsername: "root",
	createClient: (credentials) => new HetznerClient(credentials.apiToken ?? ""),
};
