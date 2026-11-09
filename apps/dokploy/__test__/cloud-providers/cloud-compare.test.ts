import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accounts: vi.fn(),
	catalog: vi.fn(),
}));

vi.mock("@dokploy/server/services/cloud-provider", () => ({
	findCloudProviderAccountsByOrganizationId: mocks.accounts,
	getCloudCatalog: mocks.catalog,
}));

import {
	compareCloudOffers,
	continentOf,
	parseEcbRates,
} from "@dokploy/server/services/cloud-compare";

const ECB = `<gesmes:Envelope><Cube><Cube time='2026-11-06'>
<Cube currency='USD' rate='1.1165'/><Cube currency='GBP' rate='0.83415'/>
</Cube></Cube></gesmes:Envelope>`;

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ECB));
});

describe("cloud price comparison", () => {
	it("parses the ECB daily reference rates", () => {
		expect(parseEcbRates(ECB)).toEqual({
			date: "2026-11-06",
			perEuro: { EUR: 1, USD: 1.1165, GBP: 0.83415 },
		});
		expect(parseEcbRates("<html/>")).toBeNull();
	});

	it("groups countries into continents", () => {
		expect(continentOf("de")).toBe("Europe");
		expect(continentOf("US")).toBe("North America");
		expect(continentOf("SG")).toBe("Asia");
		expect(continentOf("XX")).toBe("Other");
	});

	it("lists orderable locations with pre-tax prices and reports failed accounts", async () => {
		mocks.accounts.mockResolvedValue([
			{ cloudProviderAccountId: "h", name: "main", providerType: "hetzner" },
			{ cloudProviderAccountId: "d", name: "do", providerType: "digitalocean" },
		]);
		mocks.catalog.mockImplementation(
			async (account: { providerType: string }) => {
				if (account.providerType === "digitalocean") {
					throw new Error("token revoked");
				}
				return {
					currency: "EUR",
					locations: [
						{
							id: "fsn1",
							city: "Falkenstein",
							country: "DE",
							region: "eu",
							availableServerTypes: ["cx22"],
						},
						{
							id: "ash",
							city: "Ashburn",
							country: "US",
							region: "us",
							availableServerTypes: [],
						},
					],
					serverTypes: [
						{
							id: "cx22",
							label: "CX22",
							family: "Shared · x86",
							cores: 2,
							memoryGb: 4,
							diskGb: 40,
							architecture: "x86",
							prices: [
								{
									location: "fsn1",
									hourly: 0.007,
									monthly: 4.51,
									monthlyNet: 3.79,
								},
								{
									location: "ash",
									hourly: 0.008,
									monthly: 5.0,
									monthlyNet: 4.2,
								},
							],
						},
					],
					images: [],
				};
			},
		);

		const result = await compareCloudOffers("org");

		expect(result.rates?.perEuro.USD).toBe(1.1165);
		expect(result.offers).toEqual([
			expect.objectContaining({
				cloudProviderAccountId: "h",
				serverType: "cx22",
				// Sold out in Ashburn, so only Falkenstein, at its net price.
				locations: [{ id: "fsn1", monthly: 3.79 }],
			}),
		]);
		const hetzner = result.accounts.find(
			(a) => a.cloudProviderAccountId === "h",
		);
		expect(hetzner?.locations[0]).toMatchObject({ continent: "Europe" });
		expect(
			result.accounts.find((a) => a.cloudProviderAccountId === "d"),
		).toMatchObject({ error: "token revoked", currency: null });
	});
});
