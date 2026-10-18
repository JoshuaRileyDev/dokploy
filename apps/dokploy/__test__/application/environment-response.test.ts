import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findApplication, checkAccess, createApplication, returning } =
	vi.hoisted(() => ({
		findApplication: vi.fn(),
		checkAccess: vi.fn(),
		createApplication: vi.fn(),
		returning: vi.fn(),
	}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServiceAccess: vi.fn(),
	addNewService: vi.fn(),
	checkServicePermissionAndAccess: checkAccess,
}));
vi.mock("@dokploy/server/index", () => ({
	IS_CLOUD: true,
	createApplication,
	findEnvironmentById: vi.fn(async () => ({ projectId: "project-1" })),
	findProjectById: vi.fn(async () => ({
		projectId: "project-1",
		organizationId: "org-1",
	})),
	getWebServerSettings: vi.fn(),
	getAccessibleServerIds: vi.fn(async () => new Set(["server-1"])),
	findPreviewDeploymentsByApplicationId: vi.fn(async () => []),
	hasValidLicense: vi.fn(async () => false),
	findApplicationById: findApplication,
}));
vi.mock("@dokploy/server/db", () => {
	const mutation = () => ({
		set: () => ({ where: () => ({ returning }) }),
		where: () => ({ returning }),
	});
	return { db: { update: mutation, delete: mutation } };
});
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

const { applicationRouter } = await import("@/server/api/routers/application");
const caller = applicationRouter.createCaller({
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", role: "owner" },
} as Parameters<typeof applicationRouter.createCaller>[0]);

const application = {
	applicationId: "app-1",
	name: "Example",
	sourceType: "docker",
	env: "TOKEN=runtime-secret",
	buildArgs: "TOKEN=build-arg-secret",
	buildSecrets: "TOKEN=build-secret",
	previewEnv: "TOKEN=preview-secret",
	previewBuildArgs: "TOKEN=preview-arg-secret",
	previewBuildSecrets: "TOKEN=preview-build-secret",
	createEnvFile: true,
	buildType: "dockerfile",
	environment: {
		environmentId: "env-1",
		projectId: "project-1",
		env: "TOKEN=environment-secret",
		project: {
			projectId: "project-1",
			organizationId: "org-1",
			env: "TOKEN=project-secret",
		},
	},
};

describe("application environment responses", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findApplication.mockResolvedValue(structuredClone(application));
		const { environment, ...row } = application;
		createApplication.mockResolvedValue(row);
		returning.mockResolvedValue([row]);
	});

	it("omits runtime, build, preview, and inherited variables from application.one", async () => {
		const response = await caller.one({ applicationId: "app-1" });
		expect(response.applicationId).toBe("app-1");
		expect(JSON.stringify(response)).not.toContain("secret");
		for (const field of [
			"env",
			"buildArgs",
			"buildSecrets",
			"previewEnv",
			"previewBuildArgs",
			"previewBuildSecrets",
		]) {
			expect(response).not.toHaveProperty(field);
		}
		expect(response.environment).not.toHaveProperty("env");
		expect(response.environment.project).not.toHaveProperty("env");
	});

	it.each([
		[
			"create",
			() =>
				caller.create({
					name: "Example",
					environmentId: "env-1",
					serverId: "server-1",
				}),
		],
		[
			"move",
			() =>
				caller.move({ applicationId: "app-1", targetEnvironmentId: "env-2" }),
		],
		["delete", () => caller.delete({ applicationId: "app-1" })],
	] as const)("omits variables from application.%s", async (_name, invoke) => {
		const response = await invoke();
		expect(response.applicationId).toBe("app-1");
		expect(JSON.stringify(response)).not.toContain("secret");
	});

	it("returns variables through the dedicated endpoint with envVars.read access", async () => {
		const response = await caller.readEnvironment({ applicationId: "app-1" });
		expect(response).toEqual({
			env: application.env,
			buildArgs: application.buildArgs,
			buildSecrets: application.buildSecrets,
			previewEnv: application.previewEnv,
			previewBuildArgs: application.previewBuildArgs,
			previewBuildSecrets: application.previewBuildSecrets,
			createEnvFile: true,
			buildType: "dockerfile",
			environment: application.environment,
		});
		expect(checkAccess).toHaveBeenCalledWith(expect.anything(), "app-1", {
			envVars: ["read"],
		});
	});

	it("rejects environment reads without permission", async () => {
		checkAccess.mockRejectedValueOnce(new TRPCError({ code: "FORBIDDEN" }));
		await expect(
			caller.readEnvironment({ applicationId: "app-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(findApplication).not.toHaveBeenCalled();
	});

	it("rejects environment reads across organizations", async () => {
		findApplication.mockResolvedValueOnce({
			...application,
			environment: {
				...application.environment,
				project: {
					...application.environment.project,
					organizationId: "other-org",
				},
			},
		});
		await expect(
			caller.readEnvironment({ applicationId: "app-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
