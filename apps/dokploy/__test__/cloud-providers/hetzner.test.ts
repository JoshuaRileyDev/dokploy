import {
	type CloudProviderError,
	cloudProviders,
	cloudProviderTypes,
	listCloudProviderDefinitions,
} from "@dokploy/server/utils/cloud-providers";
import { afterEach, describe, expect, it, vi } from "vitest";

const page = (key: string, items: unknown[]) => ({
	[key]: items,
	meta: { pagination: { next_page: null } },
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const mockHetzner = (
	routes: Record<string, (init?: RequestInit) => Response>,
) =>
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const path = new URL(String(input)).pathname.replace("/v1", "");
		const route = routes[`${init?.method ?? "GET"} ${path}`];
		return route ? route(init) : json({ error: { message: "nope" } }, 404);
	});

const client = () => cloudProviders.hetzner.createClient({ apiToken: "t" });

afterEach(() => vi.restoreAllMocks());

describe("cloud provider registry", () => {
	it("registers a definition for every provider type", () => {
		for (const type of cloudProviderTypes) {
			expect(cloudProviders[type].type).toBe(type);
		}
	});

	it("exposes definitions without the client factory", () => {
		for (const definition of listCloudProviderDefinitions()) {
			expect(definition).not.toHaveProperty("createClient");
		}
	});
});

describe("hetzner adapter", () => {
	it("maps the catalog, hiding retired types and marking sold-out ones", async () => {
		mockHetzner({
			"GET /locations": () =>
				json(
					page("locations", [
						{
							name: "fsn1",
							city: "Falkenstein",
							country: "DE",
							network_zone: "eu-central",
						},
					]),
				),
			"GET /server_types": () =>
				json(
					page("server_types", [
						{
							id: 1,
							name: "cax11",
							cores: 2,
							memory: 4,
							disk: 40,
							cpu_type: "shared",
							architecture: "arm",
							deprecated: false,
							locations: [{ name: "fsn1", available: true, deprecation: null }],
							prices: [
								{
									location: "fsn1",
									price_hourly: { gross: "0.0062" },
									price_monthly: { gross: "4.51" },
								},
							],
						},
						{
							id: 3,
							name: "cpx11",
							cores: 2,
							memory: 2,
							disk: 40,
							cpu_type: "shared",
							architecture: "x86",
							deprecated: false,
							locations: [
								{
									name: "fsn1",
									available: false,
									deprecation: { unavailable_after: "2025-12-31T23:59:59Z" },
								},
							],
							prices: [
								{
									location: "fsn1",
									price_hourly: { gross: "0.008" },
									price_monthly: { gross: "5.18" },
								},
							],
						},
						{
							id: 4,
							name: "cx23",
							cores: 2,
							memory: 4,
							disk: 40,
							cpu_type: "shared",
							architecture: "x86",
							deprecated: false,
							locations: [
								{ name: "fsn1", available: false, deprecation: null },
							],
							prices: [
								{
									location: "fsn1",
									price_hourly: { gross: "0.006" },
									price_monthly: { gross: "3.49" },
								},
							],
						},
						{
							id: 2,
							name: "cx11",
							cores: 1,
							memory: 2,
							disk: 20,
							cpu_type: "shared",
							architecture: "x86",
							deprecated: true,
							prices: [],
						},
					]),
				),
			"GET /images": () =>
				json(
					page("images", [
						{
							name: "ubuntu-24.04",
							description: "Ubuntu 24.04",
							os_flavor: "ubuntu",
							os_version: "24.04",
							architecture: "arm",
							deprecated: null,
						},
						{
							name: "rocky-9",
							description: "Rocky Linux 9",
							os_flavor: "rocky",
							os_version: "9",
							architecture: "x86",
							deprecated: null,
						},
					]),
				),
		});

		const catalog = await client().getCatalog();

		expect(catalog.currency).toBe("EUR");
		expect(catalog.locations).toEqual([
			{
				id: "fsn1",
				city: "Falkenstein",
				country: "DE",
				region: "eu-central",
				availableServerTypes: ["cax11"],
			},
		]);
		expect(catalog.serverTypes.map((type) => type.id)).toEqual([
			"cax11",
			"cx23",
		]);
		expect(catalog.serverTypes[0]).toEqual({
			id: "cax11",
			label: "CAX11",
			family: "Shared · Arm",
			cores: 2,
			memoryGb: 4,
			diskGb: 40,
			architecture: "arm",
			prices: [{ location: "fsn1", hourly: 0.0062, monthly: 4.51 }],
		});
		expect(catalog.images.map((image) => image.id)).toEqual(["ubuntu-24.04"]);
	});

	it("accepts a writable token", async () => {
		mockHetzner({
			"GET /locations": () => json(page("locations", [])),
			"POST /ssh_keys": () =>
				json({ error: { code: "invalid_input", message: "invalid" } }, 400),
		});
		await expect(client().validateCredentials()).resolves.toBeUndefined();
	});

	it("rejects a read-only token", async () => {
		mockHetzner({
			"GET /locations": () => json(page("locations", [])),
			"POST /ssh_keys": () =>
				json({ error: { code: "forbidden", message: "forbidden" } }, 403),
		});
		await expect(client().validateCredentials()).rejects.toThrow(/read-only/);
	});

	it("doesn't accept a token when the write check is rate limited", async () => {
		mockHetzner({
			"GET /locations": () => json(page("locations", [])),
			"POST /ssh_keys": () =>
				json(
					{ error: { code: "rate_limit_exceeded", message: "slow down" } },
					429,
				),
		});
		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "unavailable",
			status: 429,
		});
	});

	it("doesn't accept a token when the write check hits an outage", async () => {
		mockHetzner({
			"GET /locations": () => json(page("locations", [])),
			"POST /ssh_keys": () => json({}, 503),
		});
		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "unavailable",
		});
	});

	it("reports a bad token as unauthorized", async () => {
		mockHetzner({
			"GET /locations": () =>
				json({ error: { code: "unauthorized", message: "bad" } }, 401),
		});
		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "unauthorized",
		} satisfies Partial<CloudProviderError>);
	});

	it("treats deleting a missing server as success", async () => {
		mockHetzner({});
		await expect(client().deleteServer("42")).resolves.toBeUndefined();
	});

	it("maps server status and addresses", async () => {
		mockHetzner({
			"GET /servers/7": () =>
				json({
					server: {
						id: 7,
						status: "initializing",
						public_net: { ipv4: { ip: "1.2.3.4" }, ipv6: null },
					},
				}),
		});
		await expect(client().getServer("7")).resolves.toEqual({
			id: "7",
			status: "starting",
			ipv4: "1.2.3.4",
			ipv6: null,
		});
	});
});
