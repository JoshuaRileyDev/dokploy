import { cloudProviders } from "@dokploy/server/utils/cloud-providers";
import { afterEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

type Route = (init?: RequestInit, url?: URL) => Response;

const TOKEN_PATH = "/auth/realms/contabo/protocol/openid-connect/token";

const mockContabo = (routes: Record<string, Route>) =>
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === TOKEN_PATH) {
			return routes.token
				? routes.token(init, url)
				: json({ access_token: "tok", expires_in: 300 });
		}
		const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
		return route ? route(init, url) : json({ message: "nope" }, 404);
	});

const client = () =>
	cloudProviders.contabo.createClient({
		clientId: "id",
		clientSecret: "secret",
		apiUser: "me@example.com",
		apiPassword: "pw",
	});

const page = <T>(data: T[]) => ({
	data,
	_pagination: { page: 1, totalPages: 1 },
});

afterEach(() => vi.restoreAllMocks());

describe("contabo adapter", () => {
	it("logs in once with the password grant and sends a request id on every call", async () => {
		const fetchSpy = mockContabo({
			"GET /v1/compute/instances/1": () =>
				json(page([{ instanceId: 1, status: "running" }])),
		});
		const api = client();

		await api.getServer("1");
		await api.getServer("1");

		const tokenCalls = fetchSpy.mock.calls.filter(([url]) =>
			String(url).includes(TOKEN_PATH),
		);
		expect(tokenCalls).toHaveLength(1);
		const form = new URLSearchParams(String(tokenCalls[0]![1]?.body));
		expect(Object.fromEntries(form)).toEqual({
			grant_type: "password",
			client_id: "id",
			client_secret: "secret",
			username: "me@example.com",
			password: "pw",
		});
		const apiCalls = fetchSpy.mock.calls.filter(
			([url]) => !String(url).includes(TOKEN_PATH),
		);
		const requestIds = apiCalls.map(
			([, init]) => (init?.headers as Record<string, string>)["x-request-id"],
		);
		expect(new Set(requestIds).size).toBe(2);
		expect(
			(apiCalls[0]![1]?.headers as Record<string, string>).Authorization,
		).toBe("Bearer tok");
	});

	it("reports bad credentials as unauthorized", async () => {
		mockContabo({ token: () => json({ error: "invalid_grant" }, 401) });

		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "unauthorized",
		});
	});

	it("rejects an API user that can read but not create", async () => {
		mockContabo({
			"GET /v1/compute/instances": () => json(page([])),
			"POST /v1/secrets": () => json({ message: "Forbidden" }, 403),
		});

		await expect(client().validateCredentials()).rejects.toMatchObject({
			kind: "forbidden",
		});
	});

	it("builds the catalog from the documented products, existing instances and usable regions", async () => {
		mockContabo({
			"GET /v1/compute/instances": () =>
				json(
					page([
						{
							instanceId: 9,
							status: "running",
							productId: "V159",
							cpuCores: 6,
							ramMb: 12288,
						},
						{
							instanceId: 10,
							status: "running",
							productId: "V999",
							productName: "Core VPS 2",
							cpuCores: 2,
							ramMb: 4096,
							diskMb: 51200,
						},
					]),
				),
			"GET /v1/data-centers": () =>
				json(page([{ regionSlug: "EU" }, { regionSlug: "UK" }])),
			"GET /v1/compute/images": () =>
				json(
					page([
						{
							imageId: "u22",
							name: "ubuntu-22.04",
							version: "22.04",
							osType: "Linux",
						},
						{
							imageId: "u24",
							name: "ubuntu-24.04",
							version: "24.04",
							osType: "Linux",
						},
						{
							imageId: "d12",
							name: "debian-12",
							version: "12",
							osType: "Linux",
						},
						{ imageId: "w", name: "windows-server-2022", osType: "Windows" },
						{
							imageId: "g",
							name: "ubuntu-24.04-gpu",
							osType: "Linux",
							gpu: true,
						},
					]),
				),
		});

		const catalog = await client().getCatalog();

		expect(catalog.locations.map((l) => l.id)).toEqual(["EU", "UK"]);
		const plus4 = catalog.serverTypes.find((t) => t.id === "V159");
		expect(plus4).toMatchObject({
			label: "Cloud VPS Plus 4",
			family: "Cloud VPS Plus",
			cores: 6,
			memoryGb: 12,
			diskGb: 150,
			architecture: "x86",
		});
		expect(plus4!.prices).toEqual([
			{ location: "EU", hourly: null, monthly: null },
			{ location: "UK", hourly: null, monthly: null },
		]);
		expect(catalog.serverTypes.find((t) => t.id === "V153")).toMatchObject({
			cores: null,
			memoryGb: null,
		});
		expect(catalog.serverTypes.find((t) => t.id === "V999")).toMatchObject({
			label: "Core VPS 2",
			cores: 2,
			memoryGb: 4,
			diskGb: 50,
		});
		expect(catalog.images.map((i) => i.id)).toEqual(["u24", "u22", "d12"]);
	});

	it("creates a one-month root instance with the stored key", async () => {
		let body: Record<string, unknown> = {};
		mockContabo({
			"POST /v1/compute/instances": (init) => {
				body = JSON.parse(String(init?.body));
				return json(page([{ instanceId: 42, status: "provisioning" }]), 201);
			},
		});

		const server = await client().createServer({
			name: "web-2",
			location: "EU",
			serverType: "V159",
			image: "u24",
			sshKeyId: "77",
		});

		expect(body).toEqual({
			displayName: "web-2",
			productId: "V159",
			region: "EU",
			imageId: "u24",
			sshKeys: [77],
			defaultUser: "root",
			period: 1,
		});
		expect(server).toMatchObject({ id: "42", status: "starting" });
	});

	it("explains why a server is held instead of starting", async () => {
		mockContabo({
			"GET /v1/compute/instances/42": () =>
				json(page([{ instanceId: 42, status: "pending_payment" }])),
		});

		const server = await client().getServer("42");

		expect(server.status).toBe("error");
		expect(server.statusMessage).toMatch(/payment/);
	});

	it("cancels instead of deleting, and treats a missing instance as done", async () => {
		const fetchSpy = mockContabo({
			"POST /v1/compute/instances/42/cancel": () => json(page([{}]), 201),
		});

		await client().deleteServer("42");
		await expect(client().deleteServer("gone")).resolves.toBeUndefined();

		expect(
			fetchSpy.mock.calls.some(
				([url, init]) =>
					String(url).endsWith("/v1/compute/instances/42/cancel") &&
					init?.method === "POST",
			),
		).toBe(true);
		expect(cloudProviders.contabo.removal).toBe("cancel");
	});
});
