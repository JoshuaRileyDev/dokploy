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

const VULTR_API_URL = "https://api.vultr.com/v2";

const SUPPORTED_OS_FAMILIES = new Set(["ubuntu", "debian"]);

const FAMILIES: Record<string, string> = {
	vc2: "Regular",
	vhf: "High Frequency",
	vhp: "High Performance",
	"voc-g": "Optimized · General",
	"voc-c": "Optimized · CPU",
	"voc-m": "Optimized · Memory",
	"voc-s": "Optimized · Storage",
};

// Plans with less local disk than this boot from block storage, which
// provisioning doesn't attach.
const MIN_LOCAL_DISK_GB = 10;

interface VultrMeta {
	meta?: { links?: { next?: string } };
}

interface VultrRegion {
	id: string;
	city: string;
	country: string;
	continent: string;
}

interface VultrPlan {
	id: string;
	type: string;
	vcpu_count: number;
	ram: number;
	disk: number;
	monthly_cost: number;
	hourly_cost?: number;
	locations: string[];
	location_cost?: Record<string, { monthly_cost: number; hourly_cost: number }>;
	deploy_ondemand?: boolean;
	gpu_brand?: string;
}

interface VultrOs {
	id: number;
	name: string;
	arch: string;
	family: string;
}

interface VultrInstance {
	id: string;
	label: string;
	plan: string;
	region: string;
	status: string;
	power_status: string;
	server_status: string;
	main_ip: string;
	v6_main_ip: string;
}

const familyOf = (plan: VultrPlan) =>
	FAMILIES[plan.type] ??
	FAMILIES[plan.id.split("-").slice(0, 2).join("-")] ??
	undefined;

const usableIp = (ip: string | undefined) =>
	ip && ip !== "0.0.0.0" && ip !== "::" ? ip : null;

const toCloudServer = (instance: VultrInstance): CloudServer => {
	if (instance.status === "suspended") {
		return {
			id: instance.id,
			status: "error",
			ipv4: usableIp(instance.main_ip),
			ipv6: usableIp(instance.v6_main_ip),
			statusMessage:
				"Vultr suspended the server. Check the billing and verification status of the account.",
		};
	}
	// The IP is assigned and the OS is up only once all three agree.
	const ready =
		instance.status === "active" &&
		instance.power_status === "running" &&
		instance.server_status === "ok" &&
		!!usableIp(instance.main_ip);
	return {
		id: instance.id,
		status: ready ? "running" : "starting",
		ipv4: usableIp(instance.main_ip),
		ipv6: usableIp(instance.v6_main_ip),
	};
};

class VultrClient implements CloudProviderClient {
	constructor(private readonly apiKey: string) {}

	private async request<T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`${VULTR_API_URL}${path}`, {
				method: init.method ?? "GET",
				headers: {
					// Plans, regions and OS images are public, so the catalog can be
					// read without a key.
					...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
					"Content-Type": "application/json",
				},
				...(init.body !== undefined && { body: JSON.stringify(init.body) }),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new CloudProviderError(
				`Could not reach the Vultr API: ${error instanceof Error ? error.message : String(error)}`,
				"unavailable",
			);
		}
		if (response.status === 204) return undefined as T;
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			const message = (body as { error?: string }).error;
			throw new CloudProviderError(
				response.status === 401
					? "Vultr rejected the API key. Check that it is correct and that Dokploy's IP address is allowed under Account → API."
					: (message ?? `Vultr API request failed (${response.status})`),
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
		let cursor = "";
		do {
			const query = new URLSearchParams({ per_page: "500" });
			if (cursor) query.set("cursor", cursor);
			const page: VultrMeta & Record<string, T[]> = await this.request(
				`${path}${path.includes("?") ? "&" : "?"}${query}`,
			);
			items.push(...(page[key] ?? []));
			cursor = page.meta?.links?.next ?? "";
		} while (cursor);
		return items;
	}

	async validateCredentials() {
		await this.request("/account");
		// A sub-account without create rights can list but not create. An
		// empty key gets a 400 when creating is allowed and a 403 otherwise;
		// anything else proves nothing, so it fails the check.
		try {
			await this.request("/ssh-keys", { method: "POST", body: {} });
		} catch (error) {
			if (error instanceof CloudProviderError && error.kind === "forbidden") {
				throw new CloudProviderError(
					"This API key can't create servers. Use a key from a user with the Manage Servers permission.",
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
		const [regions, plans, images] = await Promise.all([
			this.listAll<VultrRegion>("/regions", "regions"),
			this.listAll<VultrPlan>("/plans?type=all", "plans"),
			this.listAll<VultrOs>("/os", "os"),
		]);
		const usablePlans = plans.filter(
			(plan) =>
				familyOf(plan) &&
				// IPv6-only plans get no IPv4 address, which provisioning needs.
				!plan.id.endsWith("-v6") &&
				plan.monthly_cost > 0 &&
				plan.deploy_ondemand !== false &&
				(!plan.gpu_brand || plan.gpu_brand === "none") &&
				plan.disk >= MIN_LOCAL_DISK_GB &&
				plan.locations.length > 0,
		);

		const serverTypes: CloudServerType[] = usablePlans
			.sort(
				(a, b) =>
					a.vcpu_count - b.vcpu_count || a.ram - b.ram || a.disk - b.disk,
			)
			.map((plan) => ({
				id: plan.id,
				label: plan.id,
				family: familyOf(plan) as string,
				cores: plan.vcpu_count,
				memoryGb: Math.round(plan.ram / 102.4) / 10,
				diskGb: plan.disk,
				// Vultr's cloud compute plans are all x86.
				architecture: "x86",
				prices: plan.locations.map((location) => {
					const local = plan.location_cost?.[location];
					return {
						location,
						hourly: local?.hourly_cost ?? plan.hourly_cost ?? null,
						monthly: local?.monthly_cost ?? plan.monthly_cost,
					};
				}),
			}));

		return {
			currency: "USD",
			locations: regions
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((region) => ({
					id: region.id,
					city: region.city,
					country: region.country,
					region: region.continent,
					availableServerTypes: usablePlans
						.filter((plan) => plan.locations.includes(region.id))
						.map((plan) => plan.id),
				}))
				.filter((location) => location.availableServerTypes.length > 0),
			serverTypes,
			images: images
				.filter(
					(image) =>
						image.arch === "x64" && SUPPORTED_OS_FAMILIES.has(image.family),
				)
				.sort((a, b) =>
					a.family === b.family
						? b.name.localeCompare(a.name, undefined, { numeric: true })
						: a.family === "ubuntu"
							? -1
							: 1,
				)
				.map((image) => ({
					id: String(image.id),
					label: image.name,
					osFlavor: image.family,
					architecture: "x86" as const,
				})),
		};
	}

	async importSshKey(name: string, publicKey: string) {
		const response = await this.request<{ ssh_key: { id: string } }>(
			"/ssh-keys",
			{ method: "POST", body: { name, ssh_key: publicKey } },
		);
		return response.ssh_key.id;
	}

	async deleteSshKey(id: string) {
		await this.request(`/ssh-keys/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}

	async createServer(input: CreateCloudServerInput) {
		const response = await this.request<{ instance: VultrInstance }>(
			"/instances",
			{
				method: "POST",
				body: {
					region: input.location,
					plan: input.serverType,
					os_id: Number(input.image),
					label: input.name,
					hostname: input.name,
					sshkey_id: [input.sshKeyId],
					enable_ipv6: true,
					tags: ["dokploy"],
				},
			},
		);
		return toCloudServer(response.instance);
	}

	async getServer(id: string) {
		const response = await this.request<{ instance: VultrInstance }>(
			`/instances/${encodeURIComponent(id)}`,
		);
		return toCloudServer(response.instance);
	}

	async deleteServer(id: string) {
		await this.request(`/instances/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}

	async listServerCosts(): Promise<CloudCostReport> {
		const [instances, plans] = await Promise.all([
			this.listAll<VultrInstance>("/instances", "instances"),
			this.listAll<VultrPlan>("/plans?type=all", "plans"),
		]);
		const planById = new Map(plans.map((plan) => [plan.id, plan]));
		const zero: CloudMoney = { net: 0, gross: 0 };
		return {
			currency: "USD",
			// Vultr's list prices exclude tax, which depends on the billing
			// address the API doesn't expose.
			vatRate: 0,
			servers: instances.map((instance) => {
				const plan = planById.get(instance.plan);
				const price =
					plan?.location_cost?.[instance.region]?.monthly_cost ??
					plan?.monthly_cost ??
					0;
				const server = { net: price, gross: price };
				return {
					id: instance.id,
					name: instance.label,
					serverType: instance.plan,
					location: instance.region,
					status: instance.power_status,
					ipv4: usableIp(instance.main_ip),
					ipv6: usableIp(instance.v6_main_ip),
					monthly: {
						server,
						// Backups and block storage are billed separately and
						// aren't reported on the instance.
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

export const vultr: CloudProviderDefinition = {
	type: "vultr",
	label: "Vultr",
	description: "Cloud compute in 30+ locations on six continents.",
	credentialFields: [
		{
			name: "apiKey",
			label: "API Key",
			secret: true,
			placeholder: "Paste your API key",
		},
	],
	credentialsHelp:
		"In the Vultr customer portal open Account → API, enable the API and copy the key. Allow Dokploy's IP address in the access control list, or allow all IPv4.",
	credentialsHelpUrl:
		"https://docs.vultr.com/platform/other/api/manage-api-keys",
	sshUsername: "root",
	createClient: (credentials) => new VultrClient(credentials.apiKey ?? ""),
	getPublicCatalog: () => new VultrClient("").getCatalog(),
};
