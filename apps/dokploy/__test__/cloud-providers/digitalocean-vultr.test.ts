import { cloudProviders } from "@dokploy/server/utils/cloud-providers";
import { afterEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

type Route = (init?: RequestInit, url?: URL) => Response;

const mockApi = (prefix: string, routes: Record<string, Route>) =>
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(prefix, "");
		const route = routes[`${init?.method ?? "GET"} ${path}`];
		return route ? route(init, url) : json({ message: "nope" }, 404);
	});

afterEach(() => vi.restoreAllMocks());

describe("digitalocean adapter", () => {
	const client = () =>
		cloudProviders.digitalocean.createClient({ apiToken: "t" });

	it("maps sizes, regions and distribution images, following pagination", async () => {
		mockApi("/v2", {
			"GET /regions": () =>
				json({
					regions: [
						{
							slug: "fra1",
							name: "Frankfurt 1",
							available: true,
							sizes: ["s-2vcpu-4gb", "gpu-h100x1"],
						},
						{ slug: "nyc9", name: "New York 9", available: false, sizes: [] },
					],
					links: {},
				}),
			"GET /sizes": (_init, url) =>
				url?.searchParams.get("page") === "2"
					? json({
							sizes: [
								{
									slug: "gpu-h100x1",
									memory: 245760,
									vcpus: 20,
									disk: 720,
									price_monthly: 2500,
									price_hourly: 3.4,
									regions: ["fra1"],
									available: true,
									description: "GPU",
									gpu_info: { count: 1 },
								},
							],
							links: {},
						})
					: json({
							sizes: [
								{
									slug: "s-2vcpu-4gb",
									memory: 4096,
									vcpus: 2,
									disk: 80,
									price_monthly: 24,
									price_hourly: 0.0357,
									regions: ["fra1"],
									available: true,
									description: "Basic",
								},
							],
							links: {
								pages: {
									next: "https://api.digitalocean.com/v2/sizes?page=2&per_page=200",
								},
							},
						}),
			"GET /images": () =>
				json({
					images: [
						{
							id: 1,
							slug: "ubuntu-22-04-x64",
							name: "22.04 (LTS) x64",
							distribution: "Ubuntu",
						},
						{
							id: 2,
							slug: "ubuntu-24-04-x64",
							name: "24.04 (LTS) x64",
							distribution: "Ubuntu",
						},
						{
							id: 3,
							slug: "debian-12-x64",
							name: "12 x64",
							distribution: "Debian",
						},
						{
							id: 4,
							slug: "fedora-41-x64",
							name: "41 x64",
							distribution: "Fedora",
						},
					],
					links: {},
				}),
		});

		const catalog = await client().getCatalog();

		expect(catalog.currency).toBe("USD");
		expect(catalog.locations).toEqual([
			{
				id: "fra1",
				city: "Frankfurt",
				country: "DE",
				region: "Europe",
				availableServerTypes: ["s-2vcpu-4gb"],
			},
		]);
		expect(catalog.serverTypes).toEqual([
			expect.objectContaining({
				id: "s-2vcpu-4gb",
				family: "Basic",
				cores: 2,
				memoryGb: 4,
				diskGb: 80,
				prices: [{ location: "fra1", hourly: 0.0357, monthly: 24 }],
			}),
		]);
		expect(catalog.images.map((i) => i.id)).toEqual([
			"ubuntu-24-04-x64",
			"ubuntu-22-04-x64",
			"debian-12-x64",
		]);
	});

	it("creates a droplet with the key and reports it running once active", async () => {
		let body: Record<string, unknown> = {};
		mockApi("/v2", {
			"POST /droplets": (init) => {
				body = JSON.parse(String(init?.body));
				return json(
					{
						droplet: {
							id: 7,
							status: "new",
							networks: { v4: [], v6: [] },
						},
					},
					202,
				);
			},
			"GET /droplets/7": () =>
				json({
					droplet: {
						id: 7,
						status: "active",
						networks: {
							v4: [
								{ ip_address: "10.1.0.2", type: "private" },
								{ ip_address: "164.90.1.2", type: "public" },
							],
							v6: [],
						},
					},
				}),
		});

		const created = await client().createServer({
			name: "web-2",
			location: "fra1",
			serverType: "s-2vcpu-4gb",
			image: "ubuntu-24-04-x64",
			sshKeyId: "55",
		});
		const running = await client().getServer("7");

		expect(body).toMatchObject({
			name: "web-2",
			region: "fra1",
			size: "s-2vcpu-4gb",
			image: "ubuntu-24-04-x64",
			ssh_keys: [55],
		});
		expect(created.status).toBe("starting");
		expect(running).toMatchObject({ status: "running", ipv4: "164.90.1.2" });
	});

	it("rejects a read-only token", async () => {
		mockApi("/v2", {
			"GET /account": () => json({ account: {} }),
			"POST /account/keys": () => json({ message: "forbidden" }, 403),
		});

		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "forbidden",
		});
	});
});

describe("vultr adapter", () => {
	const client = () => cloudProviders.vultr.createClient({ apiKey: "k" });

	const plan = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		type: id.split("-")[0],
		vcpu_count: 2,
		ram: 4096,
		disk: 80,
		monthly_cost: 20,
		hourly_cost: 0.03,
		locations: ["fra", "sao"],
		deploy_ondemand: true,
		gpu_brand: "none",
		...extra,
	});

	it("maps plans with per-location prices and skips GPU, free, IPv6-only and block-boot plans", async () => {
		mockApi("/v2", {
			"GET /regions": () =>
				json({
					regions: [
						{
							id: "fra",
							city: "Frankfurt",
							country: "DE",
							continent: "Europe",
						},
						{
							id: "sao",
							city: "São Paulo",
							country: "BR",
							continent: "South America",
						},
					],
					meta: { links: { next: "" } },
				}),
			"GET /plans": () =>
				json({
					plans: [
						plan("vc2-2c-4gb", {
							location_cost: { sao: { monthly_cost: 26, hourly_cost: 0.039 } },
						}),
						plan("vcg-a16-6c-60g", { gpu_brand: "NVIDIA" }),
						plan("vc2-1c-0.5gb-free", { monthly_cost: 0 }),
						plan("vc2-1c-0.5gb-v6", { monthly_cost: 2.5 }),
						plan("vx1-g-2c-8g", { disk: 1 }),
					],
					meta: { links: { next: "" } },
				}),
			"GET /os": () =>
				json({
					os: [
						{
							id: 2284,
							name: "Ubuntu 24.04 LTS x64",
							arch: "x64",
							family: "ubuntu",
						},
						{
							id: 2136,
							name: "Debian 12 x64 (bookworm)",
							arch: "x64",
							family: "debian",
						},
						{ id: 9, name: "Windows 2022", arch: "x64", family: "windows" },
					],
					meta: { links: { next: "" } },
				}),
		});

		const catalog = await client().getCatalog();

		expect(catalog.serverTypes).toHaveLength(1);
		expect(catalog.serverTypes[0]).toMatchObject({
			id: "vc2-2c-4gb",
			family: "Regular",
			memoryGb: 4,
			prices: [
				{ location: "fra", hourly: 0.03, monthly: 20 },
				{ location: "sao", hourly: 0.039, monthly: 26 },
			],
		});
		expect(catalog.locations.map((l) => l.region)).toEqual([
			"Europe",
			"South America",
		]);
		expect(catalog.images.map((i) => i.id)).toEqual(["2284", "2136"]);
	});

	it("waits until the instance is active, running, ok and has an address", async () => {
		const states = [
			{
				status: "pending",
				power_status: "stopped",
				server_status: "none",
				main_ip: "0.0.0.0",
			},
			{
				status: "active",
				power_status: "running",
				server_status: "installingbooting",
				main_ip: "45.1.2.3",
			},
			{
				status: "active",
				power_status: "running",
				server_status: "ok",
				main_ip: "45.1.2.3",
			},
		];
		let call = 0;
		mockApi("/v2", {
			"GET /instances/abc": () =>
				json({ instance: { id: "abc", v6_main_ip: "", ...states[call++] } }),
		});

		const results = [
			await client().getServer("abc"),
			await client().getServer("abc"),
			await client().getServer("abc"),
		];

		expect(results.map((r) => r.status)).toEqual([
			"starting",
			"starting",
			"running",
		]);
		expect(results[0]!.ipv4).toBeNull();
		expect(results[2]!.ipv4).toBe("45.1.2.3");
	});

	it("creates an instance from the OS id with the key", async () => {
		let body: Record<string, unknown> = {};
		mockApi("/v2", {
			"POST /instances": (init) => {
				body = JSON.parse(String(init?.body));
				return json(
					{
						instance: {
							id: "abc",
							status: "pending",
							power_status: "stopped",
							server_status: "none",
							main_ip: "0.0.0.0",
							v6_main_ip: "::",
						},
					},
					202,
				);
			},
		});

		await client().createServer({
			name: "web-2",
			location: "fra",
			serverType: "vc2-2c-4gb",
			image: "2284",
			sshKeyId: "key-uuid",
		});

		expect(body).toMatchObject({
			region: "fra",
			plan: "vc2-2c-4gb",
			os_id: 2284,
			sshkey_id: ["key-uuid"],
			label: "web-2",
		});
	});

	it("reads the public catalog without an API key", async () => {
		const fetchSpy = mockApi("/v2", {
			"GET /regions": () =>
				json({ regions: [], meta: { links: { next: "" } } }),
			"GET /plans": () => json({ plans: [], meta: { links: { next: "" } } }),
			"GET /os": () => json({ os: [], meta: { links: { next: "" } } }),
		});

		await cloudProviders.vultr.getPublicCatalog?.();

		for (const [, init] of fetchSpy.mock.calls) {
			expect(
				(init?.headers as Record<string, string>).Authorization,
			).toBeUndefined();
		}
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});
});
