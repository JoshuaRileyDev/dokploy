import {
	OVH_API_ENDPOINTS,
	type OvhApiEndpoint,
	signedOvhRequest,
} from "../ovh/signing";
import {
	type CloudCatalog,
	type CloudCostReport,
	type CloudCredentials,
	type CloudMoney,
	type CloudProviderClient,
	type CloudProviderDefinition,
	CloudProviderError,
	type CloudServer,
	type CloudServerType,
	type CreateCloudServerInput,
} from "./types";

// Public Cloud only exists behind the three OVHcloud endpoints, not the
// Kimsufi or So you Start ones the DNS provider also accepts.
const PUBLIC_CLOUD_ENDPOINTS = ["ovh-eu", "ovh-ca", "ovh-us"] as const;
type PublicCloudEndpoint = (typeof PUBLIC_CLOUD_ENDPOINTS)[number];

// Used when the consumer key can't read /me to find the account's subsidiary.
const DEFAULT_SUBSIDIARY: Record<PublicCloudEndpoint, string> = {
	"ovh-eu": "FR",
	"ovh-ca": "CA",
	"ovh-us": "US",
};

// OVHcloud bills instances by the hour with no monthly cap, and quotes
// monthly figures as 730 hours.
const HOURS_PER_MONTH = 730;

// Catalog prices are integers in hundred-millionths of the currency unit.
const CATALOG_PRICE_SCALE = 100_000_000;

const REGION_CONCURRENCY = 8;

const SUPPORTED_OS_FLAVORS = ["ubuntu", "debian"] as const;

const FAMILIES: Record<string, string> = {
	b: "General purpose",
	c: "Compute",
	r: "Memory",
	d: "Discovery",
	i: "Storage",
};

const CITIES: Record<string, string> = {
	GRA: "Gravelines",
	SBG: "Strasbourg",
	RBX: "Roubaix",
	BHS: "Beauharnois",
	DE: "Frankfurt",
	UK: "London",
	WAW: "Warsaw",
	SGP: "Singapore",
	SYD: "Sydney",
	"EU-WEST-PAR": "Paris",
	"EU-SOUTH-MIL": "Milan",
	"EU-WEST-LZ-BRU": "Brussels",
	"EU-WEST-LZ-AMS": "Amsterdam",
	"EU-WEST-LZ-LUX": "Luxembourg",
	"EU-WEST-LZ-DLN": "Dublin",
	"EU-WEST-LZ-MAD": "Madrid",
	"EU-WEST-LZ-LIS": "Lisbon",
	"EU-CENTRAL-LZ-PRG": "Prague",
	"EU-CENTRAL-LZ-VIE": "Vienna",
	"EU-CENTRAL-LZ-ZRH": "Zurich",
	"EU-SOUTH-LZ-MRS": "Marseille",
	"EU-NORTH-LZ-CPH": "Copenhagen",
	"EU-NORTH-LZ-HEL": "Helsinki",
	"EU-NORTH-LZ-OSL": "Oslo",
	"EU-NORTH-LZ-STO": "Stockholm",
	"CA-EAST-TOR": "Toronto",
	"US-EAST-VA": "Vint Hill",
	"US-WEST-OR": "Hillsboro",
	"AP-SOUTH-MUM": "Mumbai",
	"AP-SOUTHEAST-SYD": "Sydney",
	"AP-SOUTHEAST-SGP": "Singapore",
};

interface OvhFlavor {
	id: string;
	name: string;
	region: string;
	vcpus: number;
	/** Megabytes */
	ram: number;
	/** Gigabytes */
	disk: number;
	osType: string;
	available: boolean;
	planCodes: { hourly: string | null; monthly: string | null };
}

interface OvhImage {
	id: string;
	name: string;
	region: string;
	type: string;
	status: string;
	visibility: string;
	flavorType: string | null;
	user: string;
}

interface OvhRegion {
	name: string;
	countryCode?: string;
	continentCode?: string;
	datacenterLocation?: string;
	status: string;
	services?: { name: string; status: string }[];
}

interface OvhInstance {
	id: string;
	name: string;
	status: string;
	region: string;
	planCode: string | null;
	flavorId: string;
	ipAddresses: { ip: string; type: string; version: number }[];
}

interface OvhCatalog {
	locale: { currencyCode: string; taxRate: number };
	addons: {
		planCode: string;
		product?: string;
		pricings: { price: number; intervalUnit: string; interval: number }[];
		blobs?: {
			technical?: {
				name?: string;
				cpu?: { cores?: number };
				memory?: { size?: number };
				os?: { family?: string };
				storage?: { disks?: { capacity?: number; number?: number }[] };
			};
		};
	}[];
}

// Region availability needs an account, so the public catalog assumes the
// main Public Cloud regions, which offer the standard flavors.
const PUBLIC_REGIONS = [
	{ id: "GRA11", city: "Gravelines", country: "FR", region: "EU" },
	{ id: "SBG5", city: "Strasbourg", country: "FR", region: "EU" },
	{ id: "DE1", city: "Frankfurt", country: "DE", region: "EU" },
	{ id: "UK1", city: "London", country: "GB", region: "EU" },
	{ id: "WAW1", city: "Warsaw", country: "PL", region: "EU" },
	{ id: "BHS5", city: "Beauharnois", country: "CA", region: "NA" },
	{ id: "SGP1", city: "Singapore", country: "SG", region: "ASIA" },
	{ id: "SYD1", city: "Sydney", country: "AU", region: "ASIA" },
];

const PUBLIC_CATALOG_URL = `${OVH_API_ENDPOINTS["ovh-eu"]}/order/catalog/public/cloud?ovhSubsidiary=FR`;

/**
 * Flavors, specs and hourly prices from the public order catalog, which needs
 * no credentials. Plan codes with a suffix (".LZ.EU", ".3AZ") are local or
 * multi-zone variants and are left out.
 */
export const parseOvhPublicCatalog = (catalog: OvhCatalog): CloudCatalog => {
	const vat = catalog.locale.taxRate;
	const serverTypes: CloudServerType[] = [];
	for (const addon of catalog.addons) {
		const match = addon.planCode.match(/^([a-z0-9-]+)\.consumption$/);
		const technical = addon.blobs?.technical;
		const name = match?.[1];
		if (!name || addon.product !== "publiccloud-instance") continue;
		if (technical?.os?.family !== "linux" || !familyOf(name)) continue;
		const cores = technical.cpu?.cores;
		const memory = technical.memory?.size;
		if (!cores || !memory) continue;
		const pricing = addon.pricings.find(
			(p) => p.intervalUnit === "hour" && p.interval === 1,
		);
		if (!pricing) continue;
		const hourlyNet = pricing.price / CATALOG_PRICE_SCALE;
		const diskGb = (technical.storage?.disks ?? []).reduce(
			(total, disk) => total + (disk.capacity ?? 0) * (disk.number ?? 1),
			0,
		);
		serverTypes.push({
			id: name,
			label: name.toUpperCase(),
			family: familyOf(name) as string,
			cores,
			memoryGb: memory,
			diskGb,
			architecture: "x86",
			prices: PUBLIC_REGIONS.map((region) => ({
				location: region.id,
				hourly: hourlyNet * (1 + vat / 100),
				monthly: hourlyNet * HOURS_PER_MONTH * (1 + vat / 100),
				monthlyNet: hourlyNet * HOURS_PER_MONTH,
			})),
		});
	}
	serverTypes.sort(
		(a, b) =>
			a.family.localeCompare(b.family) ||
			(a.cores ?? 0) - (b.cores ?? 0) ||
			(a.memoryGb ?? 0) - (b.memoryGb ?? 0),
	);
	return {
		currency: catalog.locale.currencyCode,
		approximateLocations: true,
		locations: PUBLIC_REGIONS.map((region) => ({
			...region,
			availableServerTypes: serverTypes.map((type) => type.id),
		})),
		serverTypes,
		images: [],
	};
};

interface PriceList {
	currency: string;
	vatRate: number;
	/** Net hourly price by plan code. */
	hourly: Map<string, number>;
}

const isPublicCloudEndpoint = (value: string): value is PublicCloudEndpoint =>
	(PUBLIC_CLOUD_ENDPOINTS as readonly string[]).includes(value);

const toOsFlavor = (imageName: string) =>
	SUPPORTED_OS_FLAVORS.find((flavor) =>
		imageName.toLowerCase().startsWith(flavor),
	);

const familyOf = (flavorName: string) => FAMILIES[flavorName.charAt(0)];

const cityOf = (region: OvhRegion) => {
	const name = region.name.toUpperCase();
	const key = Object.keys(CITIES)
		.filter((prefix) => name.startsWith(prefix))
		.sort((a, b) => b.length - a.length)[0];
	return key ? (CITIES[key] as string) : region.name;
};

const publicIp = (instance: OvhInstance, version: 4 | 6) =>
	instance.ipAddresses.find(
		(address) => address.type === "public" && address.version === version,
	)?.ip ?? null;

const toCloudServer = (instance: OvhInstance): CloudServer => ({
	id: instance.id,
	status:
		instance.status === "ACTIVE"
			? "running"
			: instance.status === "ERROR" ||
					instance.status === "DELETED" ||
					instance.status === "SHUTOFF"
				? "error"
				: "starting",
	ipv4: publicIp(instance, 4),
	ipv6: publicIp(instance, 6),
});

const byVersionDesc = (a: string, b: string) =>
	b.localeCompare(a, undefined, { numeric: true });

const mapWithConcurrency = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
) => {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index] as T);
			}
		}),
	);
	return results;
};

const httpError = (status: number, body: unknown) => {
	const { message, errorCode } = (body ?? {}) as {
		message?: string;
		errorCode?: string;
	};
	// OVHcloud answers bad keys with 403 and an errorCode rather than a 401.
	const badCredentials =
		status === 401 ||
		(errorCode !== undefined &&
			["INVALID_CREDENTIAL", "INVALID_KEY", "INVALID_SIGNATURE"].includes(
				errorCode,
			));
	if (badCredentials) {
		return new CloudProviderError(
			"OVHcloud rejected the API keys. Check the application key, secret and consumer key, and that the consumer key has not expired.",
			"unauthorized",
			status,
		);
	}
	return new CloudProviderError(
		message ?? `OVHcloud API request failed (${status})`,
		status === 403
			? "forbidden"
			: status === 404
				? "not_found"
				: status === 429 || status >= 500
					? "unavailable"
					: "invalid",
		status,
	);
};

class OvhCloudClient implements CloudProviderClient {
	private readonly baseUrl: string;
	private priceList?: Promise<PriceList | null>;

	constructor(
		private readonly endpoint: PublicCloudEndpoint,
		private readonly credentials: {
			applicationKey: string;
			applicationSecret: string;
			consumerKey: string;
		},
		private readonly projectId: string,
	) {
		this.baseUrl = OVH_API_ENDPOINTS[endpoint as OvhApiEndpoint];
	}

	private async request<T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<T> {
		let response: Response;
		try {
			response = await signedOvhRequest(
				this.baseUrl,
				this.credentials,
				path,
				init,
				(url, requestInit) =>
					fetch(url, { ...requestInit, signal: AbortSignal.timeout(30_000) }),
			);
		} catch (error) {
			throw new CloudProviderError(
				`Could not reach the OVHcloud API: ${error instanceof Error ? error.message : String(error)}`,
				"unavailable",
			);
		}
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

	private project(path = "") {
		return `/cloud/project/${encodeURIComponent(this.projectId)}${path}`;
	}

	async validateCredentials() {
		try {
			await this.request(this.project());
		} catch (error) {
			if (error instanceof CloudProviderError && error.kind === "not_found") {
				throw new CloudProviderError(
					`No Public Cloud project with the ID "${this.projectId}" on this account. Copy the project ID from the OVHcloud Control Panel.`,
					"not_found",
					404,
				);
			}
			if (error instanceof CloudProviderError && error.kind === "forbidden") {
				throw new CloudProviderError(
					"The consumer key can't read this Public Cloud project. Grant it GET, POST and DELETE on /cloud/project/*.",
					"forbidden",
					403,
				);
			}
			throw error;
		}
		// A key limited to GET would only fail once provisioning creates
		// something. An empty body gets a 400 when POST is granted and a 403
		// when it isn't; anything else proves nothing, so it fails the check.
		try {
			await this.request(this.project("/sshkey"), { method: "POST", body: {} });
		} catch (error) {
			if (error instanceof CloudProviderError && error.kind === "forbidden") {
				throw new CloudProviderError(
					"The consumer key is read-only for this project. Grant it GET, POST and DELETE on /cloud/project/*.",
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

	private async subsidiary() {
		try {
			const me = await this.request<{ ovhSubsidiary?: string }>("/me");
			if (me.ovhSubsidiary) return me.ovhSubsidiary;
		} catch {}
		return DEFAULT_SUBSIDIARY[this.endpoint];
	}

	/** Public prices for the account's subsidiary; null when they can't be loaded. */
	private prices() {
		this.priceList ??= (async () => {
			try {
				const subsidiary = await this.subsidiary();
				const response = await fetch(
					`${this.baseUrl}/order/catalog/public/cloud?ovhSubsidiary=${encodeURIComponent(subsidiary)}`,
					{ signal: AbortSignal.timeout(30_000) },
				);
				if (!response.ok) return null;
				const catalog = (await response.json()) as OvhCatalog;
				const hourly = new Map<string, number>();
				for (const addon of catalog.addons) {
					const pricing = addon.pricings.find(
						(p) => p.intervalUnit === "hour" && p.interval === 1,
					);
					if (pricing) {
						hourly.set(addon.planCode, pricing.price / CATALOG_PRICE_SCALE);
					}
				}
				return {
					currency: catalog.locale.currencyCode,
					vatRate: catalog.locale.taxRate,
					hourly,
				};
			} catch {
				return null;
			}
		})();
		return this.priceList;
	}

	async getCatalog(): Promise<CloudCatalog> {
		const [regionNames, flavors, images, prices] = await Promise.all([
			this.request<string[]>(this.project("/region")),
			this.request<OvhFlavor[]>(this.project("/flavor")),
			this.request<OvhImage[]>(this.project("/image?osType=linux")),
			this.prices(),
		]);
		const regions = await mapWithConcurrency(
			regionNames,
			REGION_CONCURRENCY,
			(name) =>
				this.request<OvhRegion>(
					this.project(`/region/${encodeURIComponent(name)}`),
				).catch(() => null),
		);
		const gross = (net: number) => net * (1 + (prices?.vatRate ?? 0) / 100);

		const usableFlavors = flavors.filter(
			(flavor) => flavor.osType === "linux" && familyOf(flavor.name),
		);

		const typesByName = new Map<string, CloudServerType>();
		for (const flavor of usableFlavors) {
			const type = typesByName.get(flavor.name) ?? {
				id: flavor.name,
				label: flavor.name.toUpperCase(),
				family: familyOf(flavor.name) as string,
				cores: flavor.vcpus,
				memoryGb: Math.round(flavor.ram / 100) / 10,
				diskGb: flavor.disk,
				// OVHcloud Public Cloud has no Arm instances.
				architecture: "x86" as const,
				prices: [],
			};
			const hourly = flavor.planCodes.hourly
				? prices?.hourly.get(flavor.planCodes.hourly)
				: undefined;
			if (hourly !== undefined) {
				type.prices.push({
					location: flavor.region,
					hourly: gross(hourly),
					monthly: gross(hourly * HOURS_PER_MONTH),
					monthlyNet: hourly * HOURS_PER_MONTH,
				});
			}
			typesByName.set(flavor.name, type);
		}

		const instanceRegions = regions.filter(
			(region): region is OvhRegion =>
				!!region &&
				region.status === "UP" &&
				(region.services ?? []).some(
					(service) => service.name === "instance" && service.status === "UP",
				),
		);

		const imagesByName = new Map<string, OvhImage>();
		for (const image of images) {
			if (
				image.status !== "active" ||
				image.visibility !== "public" ||
				image.flavorType ||
				!toOsFlavor(image.name)
			) {
				continue;
			}
			imagesByName.set(image.name, image);
		}

		return {
			currency: prices?.currency ?? "EUR",
			locations: instanceRegions
				.map((region) => ({
					id: region.name,
					city: cityOf(region),
					country: (region.countryCode ?? "").toUpperCase(),
					region: region.continentCode ?? region.datacenterLocation ?? "",
					availableServerTypes: [
						...new Set(
							usableFlavors
								.filter((f) => f.region === region.name && f.available)
								.map((f) => f.name),
						),
					],
				}))
				.filter((location) => location.availableServerTypes.length > 0)
				.sort((a, b) => a.id.localeCompare(b.id)),
			serverTypes: [...typesByName.values()]
				// Without prices the UI can't place a type in a location, so a
				// failed price lookup still lists every type in its regions.
				.map((type) =>
					type.prices.length > 0 || prices
						? type
						: {
								...type,
								prices: usableFlavors
									.filter((f) => f.name === type.id)
									.map((f) => ({
										location: f.region,
										hourly: null,
										monthly: null,
									})),
							},
				)
				.filter((type) => type.prices.length > 0)
				.sort(
					(a, b) =>
						a.family.localeCompare(b.family) ||
						(a.cores ?? 0) - (b.cores ?? 0) ||
						(a.memoryGb ?? 0) - (b.memoryGb ?? 0),
				),
			images: [...imagesByName.values()]
				.sort((a, b) => {
					const flavorA = toOsFlavor(a.name) as string;
					const flavorB = toOsFlavor(b.name) as string;
					if (flavorA !== flavorB) return flavorA === "ubuntu" ? -1 : 1;
					return byVersionDesc(a.name, b.name);
				})
				.map((image) => ({
					id: image.name,
					label: image.name,
					osFlavor: toOsFlavor(image.name) as string,
					architecture: "x86" as const,
				})),
		};
	}

	async importSshKey(name: string, publicKey: string) {
		const key = await this.request<{ id: string }>(this.project("/sshkey"), {
			method: "POST",
			body: { name, publicKey },
		});
		return key.id;
	}

	async deleteSshKey(id: string) {
		await this.request(this.project(`/sshkey/${encodeURIComponent(id)}`), {
			method: "DELETE",
		}).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}

	// Flavor and image IDs differ per region, so the catalog exposes names and
	// they're resolved against the chosen region here.
	async createServer(input: CreateCloudServerInput) {
		const [flavors, images] = await Promise.all([
			this.request<OvhFlavor[]>(
				this.project(`/flavor?region=${encodeURIComponent(input.location)}`),
			),
			this.request<OvhImage[]>(
				this.project(
					`/image?osType=linux&region=${encodeURIComponent(input.location)}`,
				),
			),
		]);
		const flavor = flavors.find((f) => f.name === input.serverType);
		if (!flavor) {
			throw new CloudProviderError(
				`${input.serverType} is not offered in ${input.location}`,
				"invalid",
			);
		}
		const image = images.find(
			(i) =>
				i.name === input.image &&
				i.status === "active" &&
				i.visibility === "public" &&
				!i.flavorType,
		);
		if (!image) {
			throw new CloudProviderError(
				`${input.image} is not available in ${input.location}`,
				"invalid",
			);
		}
		const instance = await this.request<OvhInstance>(
			this.project("/instance"),
			{
				method: "POST",
				body: {
					name: input.name,
					region: input.location,
					flavorId: flavor.id,
					imageId: image.id,
					sshKeyId: input.sshKeyId,
					monthlyBilling: false,
				},
			},
		);
		return { ...toCloudServer(instance), sshUsername: image.user };
	}

	async getServer(id: string) {
		return toCloudServer(
			await this.request<OvhInstance>(
				this.project(`/instance/${encodeURIComponent(id)}`),
			),
		);
	}

	async deleteServer(id: string) {
		await this.request(this.project(`/instance/${encodeURIComponent(id)}`), {
			method: "DELETE",
		}).catch((error) => {
			if (!(error instanceof CloudProviderError && error.kind === "not_found"))
				throw error;
		});
	}

	async listServerCosts(): Promise<CloudCostReport> {
		const [instances, prices] = await Promise.all([
			this.request<OvhInstance[]>(this.project("/instance")),
			this.prices(),
		]);
		if (!prices) {
			throw new CloudProviderError(
				"Could not load OVHcloud prices",
				"unavailable",
			);
		}
		const zero: CloudMoney = { net: 0, gross: 0 };
		const withVat = (net: number): CloudMoney => ({
			net,
			gross: net * (1 + prices.vatRate / 100),
		});
		return {
			currency: prices.currency,
			vatRate: prices.vatRate,
			servers: instances.map((instance) => {
				const hourly = instance.planCode
					? prices.hourly.get(instance.planCode)
					: undefined;
				const server = withVat((hourly ?? 0) * HOURS_PER_MONTH);
				return {
					id: instance.id,
					name: instance.name,
					serverType: instance.planCode?.split(".")[0] ?? instance.flavorId,
					location: instance.region,
					status: instance.status.toLowerCase(),
					ipv4: publicIp(instance, 4),
					ipv6: publicIp(instance, 6),
					monthly: {
						server,
						// Backups and block storage are separate OVHcloud resources
						// that aren't tied to the instance in this API.
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

const createClient = (credentials: CloudCredentials) => {
	const endpoint = credentials.endpoint || "ovh-eu";
	if (!isPublicCloudEndpoint(endpoint)) {
		throw new CloudProviderError(
			`Unsupported OVHcloud API endpoint: ${endpoint}`,
			"invalid",
		);
	}
	return new OvhCloudClient(
		endpoint,
		{
			applicationKey: credentials.applicationKey ?? "",
			applicationSecret: credentials.applicationSecret ?? "",
			consumerKey: credentials.consumerKey ?? "",
		},
		credentials.projectId ?? "",
	);
};

export const ovhcloud: CloudProviderDefinition = {
	type: "ovhcloud",
	label: "OVHcloud",
	description:
		"Public Cloud instances in Europe, North America and Asia-Pacific.",
	credentialFields: [
		{
			name: "endpoint",
			label: "API endpoint",
			secret: false,
			options: [
				{ value: "ovh-eu", label: "OVHcloud Europe (eu.api.ovh.com)" },
				{ value: "ovh-ca", label: "OVHcloud Canada (ca.api.ovh.com)" },
				{ value: "ovh-us", label: "OVHcloud US (api.us.ovhcloud.com)" },
			],
		},
		{
			name: "projectId",
			label: "Project ID",
			secret: false,
			placeholder: "e.g. 5f3c…",
			description:
				"Shown under the project name in Public Cloud in the Control Panel.",
		},
		{
			name: "applicationKey",
			label: "Application key",
			secret: false,
		},
		{
			name: "applicationSecret",
			label: "Application secret",
			secret: true,
		},
		{
			name: "consumerKey",
			label: "Consumer key",
			secret: true,
		},
	],
	credentialsHelp:
		"Create an application and consumer key at the createToken page for your endpoint (e.g. eu.api.ovh.com/createToken) with GET, POST and DELETE on /cloud/project/*. Add GET /me so prices use your account's currency.",
	credentialsHelpUrl:
		"https://help.ovhcloud.com/csm/en-gb-api-getting-started-ovhcloud-api?id=kb_article_view&sysparm_article=KB0042784",
	sshUsername: "ubuntu",
	createClient,
	getPublicCatalog: async () => {
		const response = await fetch(PUBLIC_CATALOG_URL, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new CloudProviderError(
				`OVHcloud price catalog request failed (${response.status})`,
				"unavailable",
				response.status,
			);
		}
		return parseOvhPublicCatalog((await response.json()) as OvhCatalog);
	},
};
