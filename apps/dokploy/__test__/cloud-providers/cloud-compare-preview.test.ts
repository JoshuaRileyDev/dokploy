import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accounts: vi.fn(),
	catalog: vi.fn(),
	vultrPublic: vi.fn(),
}));

vi.mock("@dokploy/server/services/cloud-provider", () => ({
	findCloudProviderAccountsByOrganizationId: mocks.accounts,
	getCloudCatalog: mocks.catalog,
}));

vi.mock("@dokploy/server/utils/cloud-providers", () => {
	const definitions = {
		hetzner: { type: "hetzner", label: "Hetzner Cloud" },
		vultr: {
			type: "vultr",
			label: "Vultr",
			getPublicCatalog: mocks.vultrPublic,
		},
		digitalocean: { type: "digitalocean", label: "DigitalOcean" },
	};
	return {
		cloudProviders: definitions,
		getCloudProviderDefinition: (type: keyof typeof definitions) =>
			definitions[type],
	};
});

import { compareCloudOffers } from "@dokploy/server/services/cloud-compare";

const catalog = (id: string) => ({
	currency: "USD",
	locations: [
		{
			id: "fra",
			city: "Frankfurt",
			country: "DE",
			region: "Europe",
			availableServerTypes: [id],
		},
	],
	serverTypes: [
		{
			id,
			label: id,
			family: "Regular",
			cores: 2,
			memoryGb: 4,
			diskGb: 80,
			architecture: "x86",
			prices: [{ location: "fra", hourly: 0.03, monthly: 20 }],
		},
	],
	images: [],
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<none/>"));
});

describe("previews of unconnected providers", () => {
	it("lists public catalogs as preview accounts and the rest as needing an account", async () => {
		mocks.accounts.mockResolvedValue([
			{ cloudProviderAccountId: "h", name: "main", providerType: "hetzner" },
		]);
		mocks.catalog.mockResolvedValue(catalog("cx23"));
		mocks.vultrPublic.mockResolvedValue(catalog("vc2-2c-4gb"));

		const result = await compareCloudOffers("org");

		expect(result.accounts).toEqual([
			expect.objectContaining({ cloudProviderAccountId: "h", connected: true }),
			expect.objectContaining({
				cloudProviderAccountId: "preview:vultr",
				providerType: "vultr",
				connected: false,
			}),
		]);
		expect(result.offers.map((o) => o.cloudProviderAccountId)).toEqual([
			"h",
			"preview:vultr",
		]);
		expect(result.needsAccount).toEqual([
			{ providerType: "digitalocean", providerLabel: "DigitalOcean" },
		]);
	});

	it("doesn't preview a provider that already has an account", async () => {
		mocks.accounts.mockResolvedValue([
			{ cloudProviderAccountId: "v", name: "vultr", providerType: "vultr" },
		]);
		mocks.catalog.mockResolvedValue(catalog("vc2-2c-4gb"));

		const result = await compareCloudOffers("org");

		expect(mocks.vultrPublic).not.toHaveBeenCalled();
		expect(result.accounts.map((a) => a.cloudProviderAccountId)).toEqual(["v"]);
		expect(result.needsAccount.map((p) => p.providerType)).toEqual([
			"hetzner",
			"digitalocean",
		]);
	});
});
