import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findApplicationById: vi.fn(),
	updateApplication: vi.fn(),
	deployApplication: vi.fn(),
	findPostgresById: vi.fn(),
	updatePostgresById: vi.fn(),
	deployPostgres: vi.fn(),
	removeService: vi.fn(),
	pipeBetweenServers: vi.fn(),
	resolveBoatBuildTarget: vi.fn(),
	runOnBoatBuildMachine: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { network: { findMany: vi.fn(async () => []) } },
		update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
	},
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/utils/process/remoteStream", () => ({
	pipeBetweenServers: mocks.pipeBetweenServers,
}));
vi.mock("@dokploy/server/utils/docker/utils", () => ({
	removeService: mocks.removeService,
}));
vi.mock("@dokploy/server/utils/filesystem/directory", () => ({
	removeDirectoryCode: vi.fn(),
	removeMonitoringDirectory: vi.fn(),
}));
vi.mock("@dokploy/server/utils/traefik/application", () => ({
	readConfig: vi.fn(),
	readRemoteConfig: vi.fn(async () => null),
	removeTraefikConfig: vi.fn(),
	writeConfig: vi.fn(),
	writeConfigRemote: vi.fn(),
}));
vi.mock("@dokploy/server/utils/traefik/domain", () => ({
	manageDomain: vi.fn(),
}));
vi.mock("@dokploy/server/utils/traefik/forward-auth", () => ({
	removeForwardAuthMiddleware: vi.fn(),
}));
vi.mock("@dokploy/server/utils/traefik/middleware", () => ({
	deleteAllMiddlewares: vi.fn(),
	removePathMiddlewares: vi.fn(),
}));
vi.mock("@dokploy/server/utils/traefik/redirect", () => ({
	createRedirectMiddleware: vi.fn(),
}));
vi.mock("@dokploy/server/utils/traefik/security", () => ({
	createSecurityMiddleware: vi.fn(),
}));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
	updateApplication: mocks.updateApplication,
	deployApplication: mocks.deployApplication,
}));
vi.mock("@dokploy/server/services/compose", () => ({
	deployCompose: vi.fn(),
	findComposeById: vi.fn(),
	removeCompose: vi.fn(),
	startCompose: vi.fn(),
	stopCompose: vi.fn(),
	updateCompose: vi.fn(),
}));
vi.mock("@dokploy/server/services/postgres", () => ({
	findPostgresById: mocks.findPostgresById,
	updatePostgresById: mocks.updatePostgresById,
	deployPostgres: mocks.deployPostgres,
}));
vi.mock("@dokploy/server/services/boat-builds", () => ({
	resolveBoatBuildTarget: mocks.resolveBoatBuildTarget,
	runOnBoatBuildMachine: mocks.runOnBoatBuildMachine,
}));
vi.mock("@dokploy/server/services/libsql", () => ({}));
vi.mock("@dokploy/server/services/mariadb", () => ({}));
vi.mock("@dokploy/server/services/mongo", () => ({}));
vi.mock("@dokploy/server/services/mysql", () => ({}));
vi.mock("@dokploy/server/services/redis", () => ({}));
vi.mock("@dokploy/server/services/mount", () => ({
	createFileMount: vi.fn(),
}));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: async (serverId: string) => ({
		serverId,
		name: serverId,
		organizationId: "org",
		serverStatus: "active",
		serverRoles: ["deploy"],
	}),
}));

import {
	prepareTransfer,
	transferService,
	waitUntilHealthy,
} from "@dokploy/server/services/transfer";

const application = (serverId: string) => ({
	applicationId: "app",
	appName: "web-abc",
	name: "web",
	serverId,
	server: { name: serverId },
	replicas: 2,
	applicationStatus: "done",
	networkIds: null,
	mounts: [],
	domains: [],
	security: [],
	redirects: [],
	environment: { project: { organizationId: "org" } },
});

const postgres = (serverId: string) => ({
	postgresId: "pg",
	appName: "db-abc",
	name: "db",
	serverId,
	server: { name: serverId },
	applicationStatus: "done",
	networkIds: null,
	mounts: [
		{ mountId: "m", type: "volume", volumeName: "db-data", mountPath: "/var" },
	],
	environment: { project: { organizationId: "org" } },
});

const tasks = (...lines: string[]) => ({
	stdout: lines.join("\n"),
	stderr: "",
});

const input = {
	targetServerId: "new",
	organizationId: "org",
	removeSourceData: false,
};

describe("waitUntilHealthy", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.findApplicationById.mockResolvedValue(application("old"));
	});
	afterEach(() => vi.useRealTimers());

	const staged = async () =>
		prepareTransfer({
			...input,
			serviceType: "application",
			serviceId: "app",
		});

	it("waits until every replica has stayed up through the stability window", async () => {
		mocks.execAsyncRemote
			.mockResolvedValueOnce(tasks("t1|Starting 1 second ago|"))
			.mockResolvedValueOnce(tasks("t1|Running 2 seconds ago|"))
			.mockResolvedValue(
				tasks("t1|Running 8 seconds ago|", "t2|Running 3 seconds ago|"),
			);
		const log = vi.fn();
		let done = false;

		const wait = waitUntilHealthy(await staged(), log).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(15_000);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		await wait;

		expect(done).toBe(true);
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"new",
			expect.stringContaining("docker service ps web-abc"),
		);
		expect(log).toHaveBeenCalledWith("web-abc is running on new");
	});

	it("treats containers that keep being replaced as a crash loop", async () => {
		let n = 0;
		mocks.execAsyncRemote.mockImplementation(async () => {
			n += 1;
			return tasks(
				`a${n}|Running 1 second ago|`,
				`b${n}|Running 1 second ago|`,
			);
		});

		const wait = waitUntilHealthy(await staged(), vi.fn(), 60_000);
		const assertion = expect(wait).rejects.toThrow(
			"did not become healthy on new within 1 minutes",
		);
		await vi.advanceTimersByTimeAsync(65_000);
		await assertion;
	});

	it("fails straight away when Swarm rejects the task", async () => {
		mocks.execAsyncRemote.mockResolvedValue(
			tasks("t1|Rejected 1 second ago|no suitable node"),
		);

		await expect(waitUntilHealthy(await staged(), vi.fn())).rejects.toThrow(
			"web-abc failed to start on new: no suitable node",
		);
	});
});

describe("transferService", () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		mocks.pipeBetweenServers.mockResolvedValue(1024);
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.resolveBoatBuildTarget.mockResolvedValue(null);
	});

	it("keeps a stateless app running on the source and rolls back when the deploy fails", async () => {
		let serverId = "old";
		mocks.findApplicationById.mockImplementation(async () =>
			application(serverId),
		);
		mocks.updateApplication.mockImplementation(
			async (_id, data: { serverId?: string | null }) => {
				if (data.serverId !== undefined) serverId = data.serverId as string;
			},
		);
		mocks.deployApplication.mockRejectedValue(new Error("build failed"));

		await expect(
			transferService(
				{ ...input, serviceType: "application", serviceId: "app" },
				vi.fn(),
			),
		).rejects.toThrow("build failed");

		const commands = mocks.execAsyncRemote.mock.calls.map(
			([server, command]) => `${server}: ${command}`,
		);
		expect(commands.some((c) => c.includes("scale web-abc=0"))).toBe(false);
		expect(mocks.removeService).toHaveBeenCalledWith("web-abc", "new");
		expect(mocks.removeService).not.toHaveBeenCalledWith("web-abc", "old");
		expect(serverId).toBe("old");
		expect(mocks.updateApplication).toHaveBeenLastCalledWith("app", {
			applicationStatus: "done",
		});
	});

	it("stops a database to copy it and starts it again on the source when the deploy fails", async () => {
		let serverId = "old";
		mocks.findPostgresById.mockImplementation(async () => postgres(serverId));
		mocks.updatePostgresById.mockImplementation(
			async (_id, data: { serverId?: string | null }) => {
				if (data.serverId !== undefined) serverId = data.serverId as string;
			},
		);
		mocks.deployPostgres.mockRejectedValue(new Error("port in use"));

		await expect(
			transferService(
				{ ...input, serviceType: "postgres", serviceId: "pg" },
				vi.fn(),
			),
		).rejects.toThrow("port in use");

		const commands = mocks.execAsyncRemote.mock.calls
			.filter(([server]) => server === "old")
			.map(([, command]) => command as string);
		expect(
			commands.findIndex((c) => c.includes("scale db-abc=0")),
		).toBeLessThan(commands.findIndex((c) => c.includes("scale db-abc=1")));
		expect(mocks.pipeBetweenServers).toHaveBeenCalledTimes(1);
		expect(serverId).toBe("old");
		expect(mocks.removeService).toHaveBeenCalledWith("db-abc", "new");
		expect(mocks.removeService).not.toHaveBeenCalledWith("db-abc", "old");
	});

	it("only cleans up the source once the target is healthy", async () => {
		let serverId = "old";
		mocks.findApplicationById.mockImplementation(async () =>
			application(serverId),
		);
		mocks.updateApplication.mockImplementation(
			async (_id, data: { serverId?: string | null }) => {
				if (data.serverId !== undefined) serverId = data.serverId as string;
			},
		);
		mocks.deployApplication.mockResolvedValue(true);
		mocks.execAsyncRemote.mockImplementation(async (_server, command) =>
			String(command).includes("docker service ps")
				? tasks("t1|Running 9 seconds ago|", "t2|Running 9 seconds ago|")
				: { stdout: "", stderr: "" },
		);
		vi.useFakeTimers();

		const transfer = transferService(
			{ ...input, serviceType: "application", serviceId: "app" },
			vi.fn(),
		);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.removeService).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(20_000);
		await transfer;

		expect(mocks.removeService).toHaveBeenCalledWith("web-abc", "old");
		expect(serverId).toBe("new");
		vi.useRealTimers();
	});

	it("builds on the Boat build pool when the app is set to use it", async () => {
		let serverId = "old";
		mocks.findApplicationById.mockImplementation(async () =>
			application(serverId),
		);
		mocks.updateApplication.mockImplementation(
			async (_id, data: { serverId?: string | null }) => {
				if (data.serverId !== undefined) serverId = data.serverId as string;
			},
		);
		const boat = {
			organizationId: "org",
			serviceType: "application",
			serviceId: "app",
			deployServerId: "new",
		};
		mocks.resolveBoatBuildTarget.mockResolvedValue(boat);
		let deployedOnBoat = false;
		mocks.runOnBoatBuildMachine.mockImplementation(
			async (_target, run: () => Promise<unknown>) => {
				deployedOnBoat = true;
				return run();
			},
		);
		mocks.deployApplication.mockImplementation(async () => {
			if (!deployedOnBoat) throw new Error("built outside the pool");
			throw new Error("stop after deploy");
		});

		await expect(
			transferService(
				{ ...input, serviceType: "application", serviceId: "app" },
				vi.fn(),
			),
		).rejects.toThrow("stop after deploy");

		expect(mocks.resolveBoatBuildTarget).toHaveBeenCalledWith({
			applicationType: "application",
			applicationId: "app",
		});
		expect(mocks.runOnBoatBuildMachine).toHaveBeenCalledWith(
			boat,
			expect.any(Function),
			{ waitMs: expect.any(Number) },
		);
	});
});
