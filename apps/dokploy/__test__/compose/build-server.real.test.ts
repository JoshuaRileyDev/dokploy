import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Registry } from "@dokploy/server/services/registry";
import {
	type ComposeNested,
	getBuildComposeCommand,
	getComposeConfigCommand,
	getComposeRemoteBuildCommand,
	getPushImagesCommand,
	getRemoteImageRef,
	resolveBuiltImages,
} from "@dokploy/server/utils/builders/compose";
import { execAsync } from "@dokploy/server/utils/process/execAsync";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Build and deploy "servers" are both the local Docker daemon here, so remote
// paths and remote exec are redirected to their local equivalents.
vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return { ...actual, paths: () => actual.paths(false) };
});

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsyncRemote: (_serverId: string | null, command: string) =>
			actual.execAsync(command),
	};
});

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: async <T>(entity: T) => entity,
}));

const dockerAvailable = (() => {
	try {
		execSync("docker info", { stdio: "ignore" });
		execSync("docker compose version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const appName = `cbs-real-${Date.now()}`;
const registryName = `${appName}-registry`;
const registryPort = 55055;
const codePath = join(paths(false).COMPOSE_PATH, appName, "code");

const registry = {
	registryId: "reg-1",
	registryName: "local",
	registryUrl: `localhost:${registryPort}`,
	username: "test",
	password: "test",
	imagePrefix: "dokploy",
	registryType: "cloud",
	organizationId: "org-1",
	createdAt: new Date().toISOString(),
} as Registry;

const compose = {
	composeId: "compose-1",
	name: appName,
	appName,
	sourceType: "raw",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	command: "",
	composeFile: `
services:
  api:
    build: ./api
    command: ["sleep", "300"]
  web:
    build:
      context: ./web
    image: \${WEB_IMAGE}
    command: ["sleep", "300"]
  cache:
    image: alpine:3.20
    command: ["sleep", "300"]
`,
	env: `WEB_IMAGE=${appName}-custom-web:dev`,
	createEnvFile: true,
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
	randomize: false,
	suffix: "",
	pullImages: false,
	serverId: null,
	buildServerId: "build-server",
	buildRegistryId: "reg-1",
	mounts: [],
	domains: [],
	environment: {
		environmentId: "env-1",
		name: "production",
		projectId: "project-1",
		env: "",
		project: {
			projectId: "project-1",
			name: "real-test",
			organizationId: "org-1",
			env: "",
		},
	},
} as unknown as ComposeNested;

const run = (command: string) => execAsync(command, { shell: "/bin/bash" });

describe.skipIf(!dockerAvailable)("compose build server (real docker)", () => {
	beforeAll(async () => {
		mkdirSync(join(codePath, "api"), { recursive: true });
		mkdirSync(join(codePath, "web"), { recursive: true });
		writeFileSync(
			join(codePath, "api", "Dockerfile"),
			"FROM alpine:3.20\nRUN echo api > /built.txt\n",
		);
		writeFileSync(
			join(codePath, "web", "Dockerfile"),
			"FROM alpine:3.20\nRUN echo web > /built.txt\n",
		);
		execSync(
			`docker run -d --rm --name ${registryName} -p ${registryPort}:5000 registry:2`,
			{ stdio: "ignore" },
		);
		for (let i = 0; i < 30; i++) {
			try {
				execSync(`curl -sf http://localhost:${registryPort}/v2/`, {
					stdio: "ignore",
				});
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
	}, 120_000);

	afterAll(() => {
		const quiet = { stdio: "ignore" as const };
		try {
			execSync(`docker compose -p ${appName} down -t 0 --rmi all`, quiet);
		} catch {}
		try {
			execSync(`docker rm -f ${registryName}`, quiet);
		} catch {}
		try {
			execSync(
				`docker images --format '{{.Repository}}:{{.Tag}}' | grep ${appName} | xargs -r docker rmi -f`,
				quiet,
			);
		} catch {}
		rmSync(join(paths(false).COMPOSE_PATH, appName), {
			recursive: true,
			force: true,
		});
	}, 60_000);

	it("builds and pushes on the build side, then deploys only by pulling", async () => {
		const buildCommand = await getComposeRemoteBuildCommand(
			compose,
			"build-server",
			registry,
		);
		expect(buildCommand).not.toBeNull();
		await run(buildCommand as string);

		const { stdout } = await run(getComposeConfigCommand(compose));
		const built = resolveBuiltImages(stdout);
		expect(built).toEqual([
			{ service: "api", localImage: `${appName}-api` },
			{ service: "web", localImage: `${appName}-custom-web:dev` },
		]);

		const images = built.map(({ service, localImage }) => ({
			service,
			localImage,
			remoteImage: getRemoteImageRef(registry, appName, service, "abc123"),
		}));
		await run(getPushImagesCommand(registry, images));

		// Prove the deploy side gets the images from the registry, not the
		// build side's local cache.
		await run(
			`docker rmi -f ${built.map((b) => b.localImage).join(" ")} >/dev/null`,
		);

		const deployCommand = await getBuildComposeCommand(compose, {
			targetServerId: null,
			prebuilt: {
				registry,
				images: Object.fromEntries(
					images.map(({ service, remoteImage }) => [service, remoteImage]),
				),
			},
		});
		const deployOutput = await run(deployCommand);
		expect(deployOutput.stdout).toContain("Docker Compose Deployed");

		const { stdout: running } = await run(
			`docker compose -p ${appName} ps --format '{{.Service}} {{.Image}}'`,
		);
		const byService = Object.fromEntries(
			running
				.trim()
				.split("\n")
				.map((line) => line.split(" ")),
		);
		expect(byService.api).toBe(
			`localhost:${registryPort}/dokploy/${appName}-api:abc123`,
		);
		expect(byService.web).toBe(
			`localhost:${registryPort}/dokploy/${appName}-web:abc123`,
		);
		expect(byService.cache).toBe("alpine:3.20");

		const { stdout: builtFile } = await run(
			`docker compose -p ${appName} exec -T api cat /built.txt`,
		);
		expect(builtFile.trim()).toBe("api");
	}, 300_000);
});
