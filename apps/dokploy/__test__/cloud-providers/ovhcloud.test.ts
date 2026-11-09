import {
	type CloudProviderError,
	cloudProviders,
} from "@dokploy/server/utils/cloud-providers";
import { afterEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

type Route = (init?: RequestInit, url?: URL) => Response;

const mockOvh = (routes: Record<string, Route>) =>
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/1\.0/, "");
		if (path === "/auth/time") {
			return new Response(String(Math.floor(Date.now() / 1000)));
		}
		const route = routes[`${init?.method ?? "GET"} ${path}`];
		return route ? route(init, url) : json({ message: "nope" }, 404);
	});

const credentials = {
	endpoint: "ovh-eu",
	projectId: "proj",
	applicationKey: "ak",
	applicationSecret: "as",
	consumerKey: "ck",
};

const client = () => cloudProviders.ovhcloud.createClient(credentials);

const P = "/cloud/project/proj";

const flavor = (
	name: string,
	region: string,
	extra: Record<string, unknown> = {},
) => ({
	id: `${name}-${region}-id`,
	name,
	region,
	vcpus: 2,
	ram: 7000,
	disk: 50,
	osType: "linux",
	available: true,
	planCodes: { hourly: `${name}.consumption`, monthly: null },
	...extra,
});

const image = (name: string, region: string, user: string) => ({
	id: `${name}-${region}-img`,
	name,
	region,
	type: "linux",
	status: "active",
	visibility: "public",
	flavorType: null,
	user,
});

const region = (name: string, countryCode: string) => ({
	name,
	countryCode,
	continentCode: "EU",
	status: "UP",
	services: [{ name: "instance", status: "UP" }],
});

afterEach(() => vi.restoreAllMocks());

describe("ovhcloud adapter", () => {
	it("signs requests with the application and consumer keys", async () => {
		const fetchSpy = mockOvh({
			[`GET ${P}/instance/i1`]: () =>
				json({
					id: "i1",
					status: "ACTIVE",
					ipAddresses: [],
				}),
		});

		await client().getServer("i1");

		const [, init] = fetchSpy.mock.calls.find(([url]) =>
			String(url).endsWith("/instance/i1"),
		)!;
		const headers = init?.headers as Record<string, string>;
		expect(headers["X-Ovh-Application"]).toBe("ak");
		expect(headers["X-Ovh-Consumer"]).toBe("ck");
		expect(headers["X-Ovh-Signature"]).toMatch(/^\$1\$[0-9a-f]{40}$/);
	});

	it("maps regions, flavors, prices and images into the catalog", async () => {
		mockOvh({
			[`GET ${P}/region`]: () => json(["GRA11", "UK1", "DOWN1"]),
			[`GET ${P}/region/GRA11`]: () => json(region("GRA11", "fr")),
			[`GET ${P}/region/UK1`]: () => json(region("UK1", "gb")),
			[`GET ${P}/region/DOWN1`]: () =>
				json({ ...region("DOWN1", "fr"), status: "DOWN" }),
			[`GET ${P}/flavor`]: () =>
				json([
					flavor("b3-8", "GRA11"),
					flavor("b3-8", "UK1", { available: false }),
					flavor("win-b3-8", "GRA11", { osType: "windows" }),
					flavor("l4-90", "GRA11"),
				]),
			[`GET ${P}/image`]: () =>
				json([
					image("Ubuntu 22.04", "GRA11", "ubuntu"),
					image("Ubuntu 24.04", "GRA11", "ubuntu"),
					image("Debian 12", "GRA11", "debian"),
					image("Rocky Linux 9", "GRA11", "rocky"),
					{
						...image("Ubuntu 24.04 GPU", "GRA11", "ubuntu"),
						flavorType: "gpu",
					},
				]),
			"GET /me": () => json({ ovhSubsidiary: "GB" }),
			"GET /order/catalog/public/cloud": (_init, url) => {
				expect(url?.searchParams.get("ovhSubsidiary")).toBe("GB");
				return json({
					locale: { currencyCode: "GBP", taxRate: 20 },
					addons: [
						{
							planCode: "b3-8.consumption",
							pricings: [
								{ price: 4_000_000, intervalUnit: "hour", interval: 1 },
							],
						},
					],
				});
			},
		});

		const catalog = await client().getCatalog();

		expect(catalog.currency).toBe("GBP");
		expect(catalog.locations).toEqual([
			{
				id: "GRA11",
				city: "Gravelines",
				country: "FR",
				region: "EU",
				availableServerTypes: ["b3-8"],
			},
		]);
		expect(catalog.serverTypes).toHaveLength(1);
		const [type] = catalog.serverTypes;
		expect(type).toMatchObject({
			id: "b3-8",
			family: "General purpose",
			memoryGb: 7,
			architecture: "x86",
		});
		// 0.04 net per hour plus 20% VAT, over 730 hours.
		expect(type!.prices[0]!.hourly).toBeCloseTo(0.048);
		expect(type!.prices[0]!.monthly).toBeCloseTo(35.04);
		expect(catalog.images.map((i) => i.id)).toEqual([
			"Ubuntu 24.04",
			"Ubuntu 22.04",
			"Debian 12",
		]);
	});

	it("resolves the region's flavor and image IDs and logs in as the image's user", async () => {
		let body: Record<string, unknown> = {};
		mockOvh({
			[`GET ${P}/flavor`]: (_init, url) => {
				expect(url?.searchParams.get("region")).toBe("GRA11");
				return json([flavor("b3-8", "GRA11")]);
			},
			[`GET ${P}/image`]: () => json([image("Debian 12", "GRA11", "debian")]),
			[`POST ${P}/instance`]: (init) => {
				body = JSON.parse(String(init?.body));
				return json({
					id: "i1",
					status: "BUILD",
					ipAddresses: [
						{ ip: "10.0.0.2", type: "private", version: 4 },
						{ ip: "51.1.2.3", type: "public", version: 4 },
					],
				});
			},
		});

		const server = await client().createServer({
			name: "web-2",
			location: "GRA11",
			serverType: "b3-8",
			image: "Debian 12",
			sshKeyId: "key1",
		});

		expect(body).toEqual({
			name: "web-2",
			region: "GRA11",
			flavorId: "b3-8-GRA11-id",
			imageId: "Debian 12-GRA11-img",
			sshKeyId: "key1",
			monthlyBilling: false,
		});
		expect(server).toEqual({
			id: "i1",
			status: "starting",
			ipv4: "51.1.2.3",
			ipv6: null,
			sshUsername: "debian",
		});
	});

	it("rejects a consumer key that can read the project but not create in it", async () => {
		mockOvh({
			[`GET ${P}`]: () => json({ project_id: "proj" }),
			[`POST ${P}/sshkey`]: () =>
				json({ message: "This call has not been granted" }, 403),
		});

		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "forbidden",
			message: expect.stringContaining("read-only"),
		} satisfies Partial<CloudProviderError>);
	});

	it("accepts a key whose write probe only fails validation", async () => {
		mockOvh({
			[`GET ${P}`]: () => json({ project_id: "proj" }),
			[`POST ${P}/sshkey`]: () => json({ message: "Missing parameter" }, 400),
		});

		await expect(client().validateCredentials()).resolves.toBeUndefined();
	});

	it("reports invalid keys as unauthorized", async () => {
		mockOvh({
			[`GET ${P}`]: () =>
				json(
					{ message: "Invalid credential", errorCode: "INVALID_CREDENTIAL" },
					403,
				),
		});

		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "unauthorized",
		});
	});

	it("treats deleting a missing instance as done", async () => {
		mockOvh({});
		await expect(client().deleteServer("gone")).resolves.toBeUndefined();
	});
});
