import {
	type CloudCatalog,
	type CloudCostReport,
	type CloudMoney,
	type CloudProviderClient,
	type CloudProviderDefinition,
	CloudProviderError,
	type CloudServer,
	type CloudServerType,
	type CreateCloudServerInput,
} from "./types";

const DIGITALOCEAN_API_URL = "https://api.digitalocean.com/v2";

const SUPPORTED_DISTRIBUTIONS = new Set(["ubuntu", "debian"]);

// Region slugs carry no location; these are DigitalOcean's datacenters.
const LOCATIONS: Record<
	string,
	{ city: string; country: string; region: string }
> = {
	nyc: { city: "New York", country: "US", region: "North America" },
	sfo: { city: "San Francisco", country: "US", region: "North America" },
	atl: { city: "Atlanta", country: "US", region: "North America" },
	ric: { city: "Richmond", country: "US", region: "North America" },
	tor: { city: "Toronto", country: "CA", region: "North America" },
	ams: { city: "Amsterdam", country: "NL", region: "Europe" },
	lon: { city: "London", country: "GB", region: "Europe" },
	fra: { city: "Frankfurt", country: "DE", region: "Europe" },
	sgp: { city: "Singapore", country: "SG", region: "Asia" },
	blr: { city: "Bangalore", country: "IN", region: "Asia" },
	syd: { city: "Sydney", country: "AU", region: "Australia" },
};

interface DoLinks {
	links?: { pages?: { next?: string } };
}

interface DoRegion {
	slug: string;
	name: string;
	available: boolean;
	sizes: string[];
}

interface DoSize {
	slug: string;
	memory: number;
	vcpus: number;
	disk: number;
	price_monthly: number;
	price_hourly: number;
	regions: string[];
	available: boolean;
	description: string;
	gpu_info?: unknown;
}

interface DoImage {
	id: number;
	slug: string | null;
	name: string;
	distribution: string;
	status?: string;
	public?: boolean;
}

interface DoDroplet {
	id: number;
	name: string;
	status: "new" | "active" | "off" | "archive";
	size_slug: string;
	size?: { price_monthly: number };
	region: { slug: string };
	features?: string[];
	networks: {
		v4: { ip_address: string; type: string }[];
		v6: { ip_address: string; type: string }[];
	};
}

const publicIp = (droplet: DoDroplet, version: "v4" | "v6") =>
	droplet.networks[version].find((network) => network.type === "public")
		?.ip_address ?? null;

const toCloudServer = (droplet: DoDroplet): CloudServer => ({
	id: String(droplet.id),
	status:
		droplet.status === "active"
			? "running"
			: droplet.status === "new"
				? "starting"
				: "error",
	ipv4: publicIp(droplet, "v4"),
	ipv6: publicIp(droplet, "v6"),
	...(droplet.status !== "active" &&
		droplet.status !== "new" && {
			statusMessage: `DigitalOcean reports the droplet as ${droplet.status}`,
		}),
});

const locationOf = (slug: string, name: string) =>
	LOCATIONS[slug.replace(/\d+$/, "")] ?? {
		city: name,
		country: "",
		region: "",
	};

const familyOf = (description: string) => description || "Basic";

class DigitalOceanClient implements CloudProviderClient {
	constructor(private readonly apiToken: string) {}

	private async request<T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<T> {
		let response: Response;
		try {
			response = await fetch(
				path.startsWith("https://") ? path : `${DIGITALOCEAN_API_URL}${path}`,
				{
					method: init.method ?? "GET",
					headers: {
						Authorization: `Bearer ${this.apiToken}`,
						"Content-Type": "application/json",
					},
					...(init.body !== undefined && { body: JSON.stringify(init.body) }),
					signal: AbortSignal.timeout(30_000),
				},
			);
		} catch (error) {
			throw new CloudProviderError(
				`Could not reach the DigitalOcean API: ${error instanceof Error ? error.message : String(error)}`,
				"unavailable",
			);
		}
		if (response.status === 204) return undefined as T;
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			const message = (body as { message?: string }).message;
			throw new CloudProviderError(
				response.status === 401
					? "DigitalOcean rejected the API token. Check that it is correct and has not been revoked."
					: (message ?? `DigitalOcean API request failed (${response.status})`),
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

	private async listAll<T>(path: string, key: string) {
		const items: T[] = [];
		let next: string | undefined =
			`${path}${path.includes("?") ? "&" : "?"}per_page=200`;
		while (next) {
			const page: DoLinks & Record<string, T[]> = await this.request(next);
			items.push(...(page[key] ?? []));
			next = page.links?.pages?.next;
		}
		return items;
	}

	async validateCredentials() {
		await this.request("/account");
		// A read-only token can list everything but fails every create, which
		// would only surface halfway through provisioning. An empty key gets a
		// 422 from a writable token and a 403 from a read-only one; anything
		// else proves nothing, so it fails the check.
		try {
			await this.request("/account/keys", { method: "POST", body: {} });
		} catch (error) {
			if (error instanceof CloudProviderError && error.kind === "forbidden") {
				throw new CloudProviderError(
					"This API token can't create resources. Create a token with Full Access, or custom scopes including droplet and ssh_key create and delete.",
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
		const [regions, sizes, images] = await Promise.all([
			this.listAll<DoRegion>("/regions", "regions"),
			this.listAll<DoSize>("/sizes", "sizes"),
			this.listAll<DoImage>("/images?type=distribution", "images"),
		]);
		const usableSizes = sizes.filter((size) => !size.gpu_info);
		const sizeSlugs = new Set(usableSizes.map((size) => size.slug));

		const serverTypes: CloudServerType[] = usableSizes
			.filter((size) => size.regions.length > 0)
			.sort(
				(a, b) => a.vcpus - b.vcpus || a.memory - b.memory || a.disk - b.disk,
			)
			.map((size) => ({
				id: size.slug,
				label: size.slug,
				family: familyOf(size.description),
				cores: size.vcpus,
				memoryGb: Math.round(size.memory / 102.4) / 10,
				diskGb: size.disk,
				// DigitalOcean only sells x86 droplets.
				architecture: "x86",
				prices: size.regions.map((region) => ({
					location: region,
					hourly: size.price_hourly,
					monthly: size.price_monthly,
				})),
			}));

		return {
			currency: "USD",
			locations: regions
				.filter((region) => region.available)
				.sort((a, b) => a.slug.localeCompare(b.slug))
				.map((region) => ({
					id: region.slug,
					...locationOf(region.slug, region.name),
					availableServerTypes: region.sizes.filter((slug) =>
						sizeSlugs.has(slug),
					),
				})),
			serverTypes,
			images: images
				.filter(
					(image) =>
						image.slug &&
						image.status !== "deleted" &&
						SUPPORTED_DISTRIBUTIONS.has(image.distribution.toLowerCase()),
				)
				.sort((a, b) => {
					const distA = a.distribution.toLowerCase();
					const distB = b.distribution.toLowerCase();
					if (distA !== distB) return distA === "ubuntu" ? -1 : 1;
					return b.name.localeCompare(a.name, undefined, { numeric: true });
				})
				.map((image) => ({
					id: image.slug as string,
					label: `${image.distribution} ${image.name}`,
					osFlavor: image.distribution.toLowerCase(),
					architecture: "x86" as const,
				})),
		};
	}

	async importSshKey(name: string, publicKey: string) {
		const response = await this.request<{ ssh_key: { id: number } }>(
			"/account/keys",
			{ method: "POST", body: { name, public_key: publicKey } },
		);
		return String(response.ssh_key.id);
	}

	async deleteSshKey(id: string) {
		await this.request(`/account/keys/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}

	async createServer(input: CreateCloudServerInput) {
		const response = await this.request<{ droplet: DoDroplet }>("/droplets", {
			method: "POST",
			body: {
				name: input.name,
				region: input.location,
				size: input.serverType,
				image: input.image,
				ssh_keys: [Number(input.sshKeyId)],
				ipv6: true,
				tags: ["dokploy"],
			},
		});
		return toCloudServer(response.droplet);
	}

	async getServer(id: string) {
		const response = await this.request<{ droplet: DoDroplet }>(
			`/droplets/${encodeURIComponent(id)}`,
		);
		return toCloudServer(response.droplet);
	}

	async deleteServer(id: string) {
		await this.request(`/droplets/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}

	async listServerCosts(): Promise<CloudCostReport> {
		const droplets = await this.listAll<DoDroplet>("/droplets", "droplets");
		const zero: CloudMoney = { net: 0, gross: 0 };
		return {
			currency: "USD",
			// DigitalOcean's list prices exclude tax, which depends on the
			// billing address the API doesn't expose.
			vatRate: 0,
			servers: droplets.map((droplet) => {
				const price = droplet.size?.price_monthly ?? 0;
				const server = { net: price, gross: price };
				return {
					id: String(droplet.id),
					name: droplet.name,
					serverType: droplet.size_slug,
					location: droplet.region.slug,
					status: droplet.status,
					ipv4: publicIp(droplet, "v4"),
					ipv6: publicIp(droplet, "v6"),
					monthly: {
						server,
						// Backups and volumes are priced by plan and size the
						// droplet doesn't report, so they're left out.
						backups: zero,
						primaryIps: zero,
						volumes: zero,
						total: server,
					},
				};
			}),
		};
	}
}

export const digitalocean: CloudProviderDefinition = {
	type: "digitalocean",
	label: "DigitalOcean",
	description: "Droplets in North America, Europe, Asia and Australia.",
	credentialFields: [
		{
			name: "apiToken",
			label: "API Token",
			secret: true,
			placeholder: "dop_v1_…",
		},
	],
	credentialsHelp:
		"In the DigitalOcean control panel open API → Tokens → Generate New Token with Full Access, or custom scopes covering droplets and SSH keys.",
	credentialsHelpUrl:
		"https://docs.digitalocean.com/reference/api/create-personal-access-token/",
	sshUsername: "root",
	createClient: (credentials) =>
		new DigitalOceanClient(credentials.apiToken ?? ""),
};
