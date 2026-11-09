import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	applications: vi.fn(),
	server: vi.fn(),
	selectRows: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findMany: mocks.applications },
			server: { findFirst: mocks.server },
		},
		select: () => ({
			from: () => ({ where: async () => mocks.selectRows() }),
		}),
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	checkServicesArchitecture,
	normalizeArchitecture,
	parseManifestPlatforms,
} from "@dokploy/server/services/server-architecture";

const manifestOutput = (image: string, platforms: string[]) =>
	`@@dokploy-image ${image}\n${JSON.stringify(
		platforms.map((arch) => ({
			Descriptor: { platform: { architecture: arch, os: "linux" } },
		})),
	)}`;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.applications.mockResolvedValue([]);
	mocks.selectRows.mockResolvedValue([]);
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("architecture helpers", () => {
	it("normalizes uname and docker names", () => {
		expect(normalizeArchitecture("x86_64\n")).toBe("amd64");
		expect(normalizeArchitecture("aarch64")).toBe("arm64");
		expect(normalizeArchitecture("armv7l")).toBe("arm");
		expect(normalizeArchitecture("")).toBeNull();
	});

	it("reads Linux platforms from single and multi-platform manifests", () => {
		expect(
			parseManifestPlatforms(
				JSON.stringify({
					Descriptor: { platform: { architecture: "amd64", os: "linux" } },
				}),
			),
		).toEqual(["amd64"]);
		expect(
			parseManifestPlatforms(
				JSON.stringify([
					{ Descriptor: { platform: { architecture: "amd64", os: "linux" } } },
					{ Descriptor: { platform: { architecture: "arm64", os: "linux" } } },
					{
						Descriptor: { platform: { architecture: "amd64", os: "windows" } },
					},
					{
						Descriptor: {
							platform: { architecture: "unknown", os: "unknown" },
						},
					},
				]),
			),
		).toEqual(["amd64", "arm64"]);
		expect(parseManifestPlatforms("")).toBeNull();
	});
});

describe("checkServicesArchitecture", () => {
	it("flags prebuilt images without a build for the target CPU", async () => {
		mocks.applications.mockResolvedValue([
			{
				applicationId: "img",
				sourceType: "docker",
				dockerImage: "acme/api:1",
				buildServerId: null,
			},
			{
				applicationId: "git",
				sourceType: "github",
				dockerImage: null,
				buildServerId: null,
			},
		]);
		mocks.selectRows.mockResolvedValue([
			{ id: "pg", dockerImage: "postgres:16" },
		]);
		mocks.execAsyncRemote.mockImplementation(async (_id, command: string) =>
			command.includes("manifest inspect")
				? {
						stdout: [
							manifestOutput("acme/api:1", ["amd64"]),
							manifestOutput("postgres:16", ["amd64", "arm64"]),
						].join("\n"),
						stderr: "",
					}
				: { stdout: "", stderr: "" },
		);

		const checks = await checkServicesArchitecture(
			"src",
			[
				{ id: "img", type: "application", appName: "img", stateful: false },
				{ id: "git", type: "application", appName: "git", stateful: true },
				{ id: "pg", type: "postgres", appName: "pg", stateful: true },
			],
			"arm64",
		);

		expect(checks.get("img")?.status).toBe("incompatible");
		expect(checks.get("git")).toMatchObject({
			status: "ok",
			dataWarning: expect.stringContaining("rebuilt"),
		});
		expect(checks.get("pg")).toMatchObject({
			status: "ok",
			dataWarning: expect.stringContaining("pg_dump"),
		});
	});

	it("flags apps built on a build server with a different CPU", async () => {
		mocks.applications.mockResolvedValue([
			{
				applicationId: "web",
				sourceType: "github",
				dockerImage: null,
				buildServerId: "builder",
			},
		]);
		mocks.server.mockResolvedValue({ name: "Builder" });
		mocks.execAsyncRemote.mockImplementation(async (id: string, command) =>
			id === "builder" && command === "uname -m"
				? { stdout: "x86_64\n", stderr: "" }
				: { stdout: "", stderr: "" },
		);

		const checks = await checkServicesArchitecture(
			"src",
			[{ id: "web", type: "application", appName: "web", stateful: false }],
			"arm64",
		);

		expect(checks.get("web")).toMatchObject({
			status: "incompatible",
			message: expect.stringContaining("Builder"),
		});
	});

	it("treats unreadable images as unknown and locally built compose images as fine", async () => {
		mocks.execAsyncRemote.mockImplementation(async (_id, command: string) =>
			command.startsWith("docker ps")
				? {
						stdout: "stack|| stack-web\nstack||ghcr.io/private/worker:2\n",
						stderr: "",
					}
				: { stdout: "@@dokploy-image ghcr.io/private/worker:2\n", stderr: "" },
		);

		const checks = await checkServicesArchitecture(
			"src",
			[{ id: "c", type: "compose", appName: "stack", stateful: false }],
			"arm64",
		);

		expect(checks.get("c")).toMatchObject({
			status: "unknown",
			message: expect.stringContaining("ghcr.io/private/worker:2"),
		});
	});
});
