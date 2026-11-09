import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	providers: vi.fn(),
	domains: vi.fn(),
	mounts: vi.fn(),
	services: vi.fn(),
	ipCandidates: vi.fn(),
	resolveNs: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	fetch: vi.fn(),
	agentOptions: [] as { connect: { lookup?: unknown } }[],
	reloadDockerResource: vi.fn(),
	prepareTransfer: vi.fn(),
	stageTransfer: vi.fn(),
	waitUntilHealthy: vi.fn(),
	commitTransfer: vi.fn(),
	rollbackTransfer: vi.fn(),
	selectRows: vi.fn(),
	schedules: vi.fn(),
	certificates: vi.fn(),
	detectArchitecture: vi.fn(),
	checkArchitecture: vi.fn(),
	findAccount: vi.fn(),
	catalog: vi.fn(),
	cloudflare: {
		listZones: vi.fn(),
		listRecords: vi.fn(),
		updateRecord: vi.fn(),
		deleteRecord: vi.fn(),
		upsertRecord: vi.fn(),
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			dnsProvider: { findMany: mocks.providers },
			domains: { findMany: mocks.domains },
			mounts: { findMany: mocks.mounts },
			schedules: { findMany: mocks.schedules },
			certificates: { findMany: mocks.certificates },
		},
		select: () => ({
			from: (table: unknown) => ({
				where: async () => mocks.selectRows(table),
			}),
		}),
	},
}));

vi.mock("@dokploy/server/services/server-architecture", () => ({
	detectServerArchitecture: mocks.detectArchitecture,
	checkServicesArchitecture: mocks.checkArchitecture,
	catalogArchitecture: (value: string) => (value === "arm" ? "arm64" : "amd64"),
}));

vi.mock("@dokploy/server/services/cloud-provider", () => ({
	findCloudProviderAccountInOrganization: mocks.findAccount,
	getCloudCatalog: mocks.catalog,
}));

vi.mock("node:dns/promises", () => ({
	Resolver: class {
		resolveNs = mocks.resolveNs;
	},
}));

vi.mock("undici", () => ({
	Agent: class {
		constructor(options: { connect: { lookup?: unknown } }) {
			mocks.agentOptions.push(options);
		}
		close = async () => undefined;
	},
	fetch: mocks.fetch,
}));

vi.mock("@dokploy/server/utils/dns", () => ({
	getDnsClient: () => mocks.cloudflare,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/services/domain", () => ({
	getServerIpCandidates: mocks.ipCandidates,
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: async (serverId: string) => ({
		serverId,
		name: serverId === "src" ? "Old box" : "New box",
		organizationId: "org",
		ipAddress:
			serverId === "src"
				? "10.0.0.5"
				: serverId === "vpn-only"
					? "100.64.1.2"
					: "203.0.113.20",
	}),
}));

vi.mock("@dokploy/server/services/server-services", () => ({
	getServerServices: mocks.services,
}));

vi.mock("@dokploy/server/services/settings", () => ({
	reloadDockerResource: mocks.reloadDockerResource,
}));

vi.mock("@dokploy/server/services/transfer", () => ({
	prepareTransfer: mocks.prepareTransfer,
	stageTransfer: mocks.stageTransfer,
	waitUntilHealthy: mocks.waitUntilHealthy,
	commitTransfer: mocks.commitTransfer,
	rollbackTransfer: mocks.rollbackTransfer,
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: async () => ({ serverIp: "198.51.100.1" }),
}));

import { ports, postgres } from "@dokploy/server/db/schema";
import {
	migrateServer,
	planServerMigration,
} from "@dokploy/server/services/server-migration";

const DATABASES = new Set(["postgres", "mysql", "mariadb", "mongo", "redis"]);

const service = (id: string, type: string, environmentId = "env1") => ({
	id,
	type,
	name: id,
	appName: `${id}-app`,
	serverId: "src",
	projectId: "p",
	projectName: "Shop",
	environmentId,
	environmentName: environmentId === "env1" ? "production" : environmentId,
	status: "running",
	lastDeployedAt: null,
	domain: null,
	url: "",
});

const record = (
	id: string,
	name: string,
	content: string,
	{ type = "A", proxied = true, ttl = 1 } = {},
) => ({ id, type, name, content, ttl, proxied });

const domain = (host: string, applicationId: string, https = true) => ({
	host,
	https,
	path: "/",
	customEntrypoint: null,
	applicationId,
	composeId: null,
});

const response = (status: number, body = "ok") => ({
	status,
	text: async () => body,
});

const NO_WAIT = {
	healthTimeoutMs: 0,
	pollMs: 0,
	proxiedPropagationMs: 0,
	publicCheckTimeoutMs: 0,
	maxDrainMs: 0,
};

const base = {
	sourceServerId: "src",
	targetServerId: "dst",
	organizationId: "org",
};

const migrate = (
	services: { serviceType: string; serviceId: string }[],
	overrides: Record<string, unknown> = {},
) =>
	migrateServer(
		{
			...base,
			services: services as never,
			removeSourceData: false,
			updateDns: true,
			...overrides,
		},
		vi.fn(),
		{ timing: NO_WAIT },
	);

const trackCalls = () => {
	const order: string[] = [];
	mocks.stageTransfer.mockImplementation(async (staged) => {
		order.push(`stage:${staged.serviceId}`);
	});
	mocks.commitTransfer.mockImplementation(async (staged) => {
		order.push(`commit:${staged.serviceId}`);
	});
	mocks.rollbackTransfer.mockImplementation(async (staged) => {
		order.push(`rollback:${staged.serviceId}`);
	});
	mocks.cloudflare.updateRecord.mockImplementation(
		async (_config, _zone, id, data: { content: string }) => {
			order.push(`dns:${id}:${data.content}`);
			return { id };
		},
	);
	return order;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.agentOptions.length = 0;
	mocks.providers.mockResolvedValue([
		{
			name: "main",
			providerType: "cloudflare",
			config: { providerType: "cloudflare", apiToken: "t" },
		},
	]);
	mocks.cloudflare.listZones.mockResolvedValue([
		{ id: "z1", name: "example.com" },
	]);
	mocks.cloudflare.listRecords.mockResolvedValue([]);
	mocks.mounts.mockResolvedValue([]);
	mocks.domains.mockResolvedValue([]);
	mocks.ipCandidates.mockImplementation(async (serverId: string) =>
		serverId === "src" ? ["10.0.0.5", "192.0.2.10"] : ["203.0.113.20"],
	);
	mocks.resolveNs.mockRejectedValue(new Error("ENOTFOUND"));
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "200\nok", stderr: "" });
	mocks.fetch.mockResolvedValue(response(200));
	mocks.selectRows.mockResolvedValue([]);
	mocks.schedules.mockResolvedValue([]);
	mocks.certificates.mockResolvedValue([]);
	mocks.detectArchitecture.mockResolvedValue("amd64");
	mocks.checkArchitecture.mockResolvedValue(new Map());
	mocks.prepareTransfer.mockImplementation(
		async (input: { serviceId: string; serviceType: string }) => ({
			serviceId: input.serviceId,
			serviceType: input.serviceType,
			stateful: DATABASES.has(input.serviceType),
			source: { name: input.serviceId, appName: `${input.serviceId}-app` },
		}),
	);
});

describe("planServerMigration", () => {
	it("classifies each domain's DNS against the source and target servers", async () => {
		mocks.services.mockResolvedValue([
			service("web", "application"),
			service("db", "postgres"),
		]);
		mocks.domains.mockResolvedValue([
			domain("www.example.com", "web"),
			domain("api.example.com", "web"),
			domain("cdn.example.com", "web"),
			domain("done.example.com", "web"),
			domain("web-1-2-3-4.traefik.me", "web"),
			domain("shop.other.io", "web"),
			domain("blog.cf-only.dev", "web"),
		]);
		mocks.cloudflare.listRecords.mockResolvedValue([
			record("r1", "www.example.com", "192.0.2.10"),
			record("r2", "api.example.com", "8.8.8.8"),
			record("r3", "cdn.example.com", "edge.vendor.net", { type: "CNAME" }),
			record("r4", "done.example.com", "203.0.113.20"),
		]);
		mocks.resolveNs.mockImplementation(async (name: string) => {
			if (name === "cf-only.dev") return ["ada.ns.cloudflare.com"];
			if (name === "other.io") return ["ns1.registrar.com"];
			throw new Error("ENOTFOUND");
		});

		const plan = await planServerMigration(base);

		expect(plan.target).toEqual({
			name: "New box",
			ip: "203.0.113.20",
			pending: false,
		});
		expect(plan.architecture).toEqual({
			source: "amd64",
			target: "amd64",
			mismatch: false,
		});
		expect(mocks.checkArchitecture).not.toHaveBeenCalled();
		expect(plan.services.map((s) => [s.id, s.stateful])).toEqual([
			["db", true],
			["web", false],
		]);
		const statuses = Object.fromEntries(
			plan.services[1]!.domains.map((d) => [d.host, d.status]),
		);
		expect(statuses).toEqual({
			"www.example.com": "auto",
			"api.example.com": "points-elsewhere",
			"cdn.example.com": "cname",
			"done.example.com": "already-migrated",
			"web-1-2-3-4.traefik.me": "generated",
			"shop.other.io": "not-cloudflare",
			"blog.cf-only.dev": "cloudflare-no-provider",
		});
		expect(mocks.cloudflare.listRecords).toHaveBeenCalledTimes(1);
	});

	it("marks apps with mounts and composes with volumes as stateful", async () => {
		mocks.services.mockResolvedValue([
			service("uploads", "application"),
			service("api", "application"),
			service("stack", "compose"),
			service("static", "compose"),
		]);
		mocks.mounts.mockResolvedValue([
			{ applicationId: "uploads", composeId: null },
		]);
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "stack-app|\n|other-ns\n",
			stderr: "",
		});

		const plan = await planServerMigration(base);

		expect(
			Object.fromEntries(plan.services.map((s) => [s.id, s.stateful])),
		).toEqual({ uploads: true, api: false, stack: true, static: false });
	});

	it("flags a domain covered only by a wildcard record", async () => {
		mocks.services.mockResolvedValue([service("web", "application")]);
		mocks.domains.mockResolvedValue([domain("x.example.com", "web")]);
		mocks.cloudflare.listRecords.mockResolvedValue([
			record("w", "*.example.com", "192.0.2.10"),
		]);

		const plan = await planServerMigration(base);

		expect(plan.services[0]!.domains[0]!.status).toBe("wildcard");
	});

	it("never writes a private target address to DNS", async () => {
		mocks.services.mockResolvedValue([service("web", "application")]);
		mocks.domains.mockResolvedValue([domain("www.example.com", "web")]);
		mocks.cloudflare.listRecords.mockResolvedValue([
			record("r1", "www.example.com", "192.0.2.10"),
		]);
		mocks.ipCandidates.mockImplementation(async (serverId: string) =>
			serverId === "src" ? ["192.0.2.10"] : ["100.64.1.2", "203.0.113.99"],
		);

		const plan = await planServerMigration({
			...base,
			targetServerId: "vpn-only",
		});
		expect(plan.target.ip).toBe("203.0.113.99");

		mocks.ipCandidates.mockImplementation(async (serverId: string) =>
			serverId === "src" ? ["192.0.2.10"] : ["100.64.1.2"],
		);
		const unreachable = await planServerMigration({
			...base,
			targetServerId: "vpn-only",
		});
		expect(unreachable.target.ip).toBeNull();
		expect(unreachable.services[0]!.domains[0]!.status).toBe("no-target-ip");
	});
});

describe("planServerMigration extras", () => {
	it("checks each service when the target has a different CPU", async () => {
		mocks.services.mockResolvedValue([
			service("web", "application"),
			service("db", "postgres"),
		]);
		mocks.detectArchitecture.mockImplementation(async (serverId: string) =>
			serverId === "src" ? "amd64" : "arm64",
		);
		mocks.checkArchitecture.mockResolvedValue(
			new Map([["db", { status: "incompatible", message: "no arm64 build" }]]),
		);

		const plan = await planServerMigration(base);

		expect(plan.architecture).toEqual({
			source: "amd64",
			target: "arm64",
			mismatch: true,
		});
		const [, services, target] = mocks.checkArchitecture.mock.calls[0]!;
		expect(target).toBe("arm64");
		expect(services).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "db", stateful: true }),
				expect.objectContaining({ id: "web", stateful: false }),
			]),
		);
		const db = plan.services.find((s) => s.id === "db");
		expect(db?.architecture?.status).toBe("incompatible");
	});

	it("plans against a server that will be provisioned", async () => {
		mocks.services.mockResolvedValue([service("web", "application")]);
		mocks.domains.mockResolvedValue([domain("www.example.com", "web")]);
		mocks.cloudflare.listRecords.mockResolvedValue([
			record("r1", "www.example.com", "192.0.2.10"),
		]);
		mocks.findAccount.mockResolvedValue({ cloudProviderAccountId: "acc" });
		mocks.catalog.mockResolvedValue({
			serverTypes: [{ id: "cax11", architecture: "arm" }],
		});

		const plan = await planServerMigration({
			...base,
			targetServerId: null,
			newServer: { cloudProviderAccountId: "acc", serverType: "cax11" },
		});

		expect(plan.target).toEqual({
			name: "the new server",
			ip: null,
			pending: true,
		});
		expect(plan.services[0]!.domains[0]!.status).toBe("auto");
		expect(plan.architecture).toEqual({
			source: "amd64",
			target: "arm64",
			mismatch: true,
		});
		// The Dokploy host must not stand in for a server that doesn't exist yet.
		expect(mocks.ipCandidates).not.toHaveBeenCalledWith(null);
	});

	it("lists published ports and server-level leftovers", async () => {
		mocks.services.mockResolvedValue([
			service("web", "application"),
			service("db", "postgres"),
		]);
		mocks.selectRows.mockImplementation(async (table: unknown) =>
			table === ports
				? [{ id: "web", port: 8080 }]
				: table === postgres
					? [{ id: "db", port: 5432 }]
					: [],
		);
		mocks.schedules.mockResolvedValue([{ scheduleId: "s1" }]);
		mocks.certificates.mockResolvedValue([{ certificateId: "c1" }]);

		const plan = await planServerMigration(base);

		expect(
			Object.fromEntries(plan.services.map((s) => [s.id, s.exposedPorts])),
		).toEqual({ web: [8080], db: [5432] });
		expect(plan.notices).toHaveLength(2);
		expect(plan.notices.join(" ")).toMatch(/scheduled job/);
		expect(plan.notices.join(" ")).toMatch(/certificate/);
	});
});

describe("migrateServer", () => {
	beforeEach(() => {
		mocks.services.mockResolvedValue([
			service("web", "application"),
			service("db", "postgres"),
		]);
		mocks.domains.mockResolvedValue([domain("www.example.com", "web")]);
		mocks.cloudflare.listRecords.mockResolvedValue([
			record("r1", "www.example.com", "192.0.2.10"),
		]);
	});

	const both = [
		{ serviceType: "postgres", serviceId: "db" },
		{ serviceType: "application", serviceId: "web" },
	];

	it("stages stateless services first and only removes the old copies after DNS is live", async () => {
		const order = trackCalls();

		const result = await migrate(both);

		expect(order).toEqual([
			"stage:web",
			"stage:db",
			"dns:r1:203.0.113.20",
			"commit:web",
			"commit:db",
		]);
		expect(mocks.waitUntilHealthy).toHaveBeenCalledTimes(2);
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"dst",
			expect.stringContaining("--resolve www.example.com\\:443\\:127.0.0.1"),
		);
		expect(result).toEqual({
			migrated: ["Shop / production / web", "Shop / production / db"],
			failed: [],
			manualDns: [],
		});
	});

	it("rolls the whole environment back when a deploy fails, without touching DNS", async () => {
		const order = trackCalls();
		mocks.stageTransfer.mockImplementation(async (staged) => {
			order.push(`stage:${staged.serviceId}`);
			if (staged.serviceId === "db") throw new Error("build failed");
		});

		const result = await migrate(both);

		expect(order).toEqual([
			"stage:web",
			"stage:db",
			"rollback:db",
			"rollback:web",
		]);
		expect(result.failed).toEqual([
			{ name: "Shop / production", error: "build failed" },
		]);
		expect(mocks.cloudflare.updateRecord).not.toHaveBeenCalled();
		expect(mocks.commitTransfer).not.toHaveBeenCalled();
	});

	it("rolls back before DNS when the target's Traefik has no route for the domain", async () => {
		const order = trackCalls();
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "404\n404 page not found\n",
			stderr: "",
		});

		const result = await migrate(both);

		expect(result.failed[0]!.error).toContain(
			"www.example.com is not served on New box (HTTP 404)",
		);
		expect(order).not.toContain("dns:r1:203.0.113.20");
		expect(order).toContain("rollback:web");
	});

	it("restores DNS and rolls back when the site is down after the switch", async () => {
		const order = trackCalls();
		mocks.fetch
			.mockResolvedValueOnce(response(200))
			.mockResolvedValue(response(526));

		const result = await migrate(both);

		expect(order).toEqual([
			"stage:web",
			"stage:db",
			"dns:r1:203.0.113.20",
			"dns:r1:192.0.2.10",
			"rollback:db",
			"rollback:web",
		]);
		expect(mocks.reloadDockerResource).toHaveBeenCalledWith(
			"dokploy-traefik",
			"dst",
		);
		expect(result.failed[0]!.error).toContain("HTTP 526");
	});

	it("doesn't hold a migration back for a site that was already down", async () => {
		trackCalls();
		mocks.fetch.mockResolvedValue(response(503));

		const result = await migrate(both);

		expect(result.failed).toEqual([]);
		expect(mocks.commitTransfer).toHaveBeenCalledTimes(2);
	});

	it("checks a DNS-only record against the target IP, not a cached address", async () => {
		trackCalls();
		mocks.cloudflare.listRecords.mockResolvedValue([
			record("r1", "www.example.com", "192.0.2.10", { proxied: false }),
		]);

		await migrate(both);

		const pinned = mocks.agentOptions
			.map((options) => options.connect.lookup)
			.filter(Boolean) as ((
			host: string,
			options: { all?: boolean },
			cb: (...args: unknown[]) => void,
		) => void)[];
		expect(pinned).toHaveLength(1);
		const callback = vi.fn();
		pinned[0]!("www.example.com", {}, callback);
		expect(callback).toHaveBeenCalledWith(null, "203.0.113.20", 4);
	});

	it("rolls back one environment and still migrates the next", async () => {
		const order = trackCalls();
		mocks.services.mockResolvedValue([
			service("web", "application"),
			service("api", "application", "staging"),
		]);
		mocks.stageTransfer.mockImplementation(async (staged) => {
			order.push(`stage:${staged.serviceId}`);
			if (staged.serviceId === "web") throw new Error("disk full");
		});

		const result = await migrate([
			{ serviceType: "application", serviceId: "web" },
			{ serviceType: "application", serviceId: "api" },
		]);

		expect(result.failed).toEqual([
			{ name: "Shop / production", error: "disk full" },
		]);
		expect(result.migrated).toEqual(["Shop / staging / api"]);
		expect(order).toContain("commit:api");
		expect(order).not.toContain("commit:web");
	});

	it("refuses a second migration on a server that is already migrating", async () => {
		trackCalls();
		let release!: () => void;
		mocks.stageTransfer.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const first = migrate(both);
		await vi.waitFor(() => expect(mocks.stageTransfer).toHaveBeenCalled());
		await expect(migrate(both)).rejects.toThrow("already running");

		release();
		await first;
		await expect(migrate(both)).resolves.toBeTruthy();
	});

	it("ignores services that are not on the source server", async () => {
		await expect(
			migrate([{ serviceType: "application", serviceId: "elsewhere" }]),
		).rejects.toThrow("None of the selected services are on Old box");
		expect(mocks.prepareTransfer).not.toHaveBeenCalled();
	});
});
