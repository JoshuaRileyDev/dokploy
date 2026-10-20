import type { Registry } from "@dokploy/server/services/registry";
import {
	applyDefaultBuildImageNames,
	createCommand,
	getPushImagesCommand,
	getRemoteImageRef,
	resolveBuiltImages,
	sanitizeImageTag,
} from "@dokploy/server/utils/builders/compose";
import {
	applyBuildPlatform,
	applyPrebuiltImages,
	hasBuildableServices,
	writeDomainsToCompose,
} from "@dokploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { quote } from "shell-quote";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const registry = {
	registryId: "reg-1",
	registryName: "Test Registry",
	registryUrl: "registry.example.com",
	username: "user",
	password: "pa$$'word",
	imagePrefix: "myorg",
	registryType: "cloud" as const,
	organizationId: "org-1",
	createdAt: new Date().toISOString(),
} as Registry;

describe("applyPrebuiltImages", () => {
	const spec: ComposeSpecification = {
		services: {
			api: { build: "./api", pull_policy: "build" },
			worker: { build: { context: "." }, image: "custom/worker" },
			db: { image: "postgres:16" },
		},
	};

	it("swaps build for the pushed image on the deploy side", () => {
		const result = applyPrebuiltImages(spec, {
			api: "registry.example.com/myorg/app-api:abc",
			worker: "registry.example.com/myorg/app-worker:abc",
		});

		expect(result.services?.api).toEqual({
			image: "registry.example.com/myorg/app-api:abc",
		});
		expect(result.services?.worker).toEqual({
			image: "registry.example.com/myorg/app-worker:abc",
		});
		expect(result.services?.db).toEqual({ image: "postgres:16" });
	});

	it("does not mutate the input and ignores unknown services", () => {
		const result = applyPrebuiltImages(spec, { missing: "x:1" });
		expect(result).toEqual(spec);
		expect(spec.services?.api?.build).toBe("./api");
	});
});

describe("applyDefaultBuildImageNames", () => {
	it("pins compose's default name and keeps user image names", () => {
		const result = applyDefaultBuildImageNames(
			{
				services: {
					Base: { build: "./base" },
					web: { build: "./web", image: "my-base-consumer" },
					db: { image: "postgres:16" },
				},
			},
			"App-Name",
		);

		expect(result.services?.Base?.image).toBe("app-name-base");
		expect(result.services?.web?.image).toBe("my-base-consumer");
		expect(result.services?.db?.image).toBe("postgres:16");
	});
});

describe("applyBuildPlatform", () => {
	it("sets the platform only on buildable services without one", () => {
		const result = applyBuildPlatform(
			{
				services: {
					api: { build: "." },
					arm: { build: ".", platform: "linux/arm64" },
					db: { image: "postgres:16" },
				},
			},
			"linux/amd64",
		);

		expect(result.services?.api?.platform).toBe("linux/amd64");
		expect(result.services?.arm?.platform).toBe("linux/arm64");
		expect(result.services?.db?.platform).toBeUndefined();
	});
});

describe("hasBuildableServices", () => {
	it("detects services with build:", () => {
		expect(
			hasBuildableServices({
				services: { web: { image: "nginx" }, api: { build: "." } },
			}),
		).toBe(true);
		expect(
			hasBuildableServices({ services: { db: { image: "postgres:16" } } }),
		).toBe(false);
		expect(hasBuildableServices(null)).toBe(false);
	});
});

describe("resolveBuiltImages", () => {
	it("returns the interpolated image of each buildable service", () => {
		const config = JSON.stringify({
			name: "app",
			services: {
				api: { build: { context: "/code/api" }, image: "app-api" },
				web: {
					build: { context: "/code/web" },
					image: "ghcr.io/me/web:1.2",
				},
				db: { image: "postgres:16" },
			},
		});

		expect(resolveBuiltImages(config)).toEqual([
			{ service: "api", localImage: "app-api" },
			{ service: "web", localImage: "ghcr.io/me/web:1.2" },
		]);
	});

	it("throws on invalid JSON", () => {
		expect(() => resolveBuiltImages("WARN something")).toThrow();
	});
});

describe("image refs", () => {
	it("builds a per-service registry ref with the deployment tag", () => {
		expect(getRemoteImageRef(registry, "my-app", "Api_1", "abc123")).toBe(
			"registry.example.com/myorg/my-app-api_1:abc123",
		);
	});

	it("sanitizes tags", () => {
		expect(sanitizeImageTag("-abc/def")).toBe("abc-def");
		expect(sanitizeImageTag("a".repeat(200))).toHaveLength(128);
	});
});

describe("getPushImagesCommand", () => {
	it("logs in safely, tags, pushes and untags each image", () => {
		const command = getPushImagesCommand(registry, [
			{
				localImage: "my-app-api",
				remoteImage: "registry.example.com/myorg/my-app-api:abc",
			},
		]);

		expect(command).toContain("--password-stdin");
		expect(command).not.toContain('"pa$$');
		const remote = quote(["registry.example.com/myorg/my-app-api:abc"]);
		expect(command).toContain(`docker tag my-app-api ${remote}`);
		expect(command).toContain(`docker push ${remote}`);
		expect(command).toContain(`docker rmi ${remote}`);
	});
});

describe("createCommand with prebuilt images", () => {
	const base = {
		composeType: "docker-compose" as const,
		appName: "my-app",
		sourceType: "raw" as const,
		command: "",
		composePath: "docker-compose.yml",
	} as unknown as Parameters<typeof createCommand>[0];

	it("uses --build when not prebuilt", () => {
		expect(createCommand(base)).toContain("up -d --build --remove-orphans");
	});

	it("uses --no-build and does not chain commands when prebuilt", () => {
		const command = createCommand(base, { prebuilt: true });
		expect(command).toBe(
			"compose -p my-app -f docker-compose.yml up -d --no-build --remove-orphans",
		);
	});

	it("keeps stack deploy with registry auth when prebuilt", () => {
		const command = createCommand(
			{ ...base, composeType: "stack" },
			{ prebuilt: true },
		);
		expect(command).toContain("stack deploy");
		expect(command).toContain("--with-registry-auth");
	});
});

describe("writeDomainsToCompose transform", () => {
	it("writes the deploy-side file with build replaced by the pushed image", async () => {
		const compose = {
			appName: "raw-app",
			composeFile: `
services:
  api:
    build: ./api
  db:
    image: postgres:16
`,
			composeId: "compose-1",
			name: "raw-app",
			composePath: "./docker-compose.yml",
			composeType: "docker-compose",
			isolatedDeployment: false,
			isolatedDeploymentsVolume: false,
			randomize: false,
			serverId: null,
			sourceType: "raw",
		} as unknown as Parameters<typeof writeDomainsToCompose>[0];

		const command = await writeDomainsToCompose(compose, [], {
			transform: (spec) =>
				applyPrebuiltImages(spec, { api: "registry.example.com/a:1" }),
		});
		const encoded = command.match(/echo "([^"]+)" \| base64 -d/)?.[1];
		const written = parse(Buffer.from(encoded ?? "", "base64").toString());

		expect(written.services.api).toEqual({
			image: "registry.example.com/a:1",
		});
		expect(written.services.db.image).toBe("postgres:16");
	});
});
