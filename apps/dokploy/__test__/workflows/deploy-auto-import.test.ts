import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, record } = vi.hoisted(() => {
	const calls: string[] = [];
	const record =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push(`${name}:${JSON.stringify(args[0])}`);
		};
	return { calls, record };
});

vi.mock("@dokploy/server", () => ({
	autoImportWorkflowsForService: vi.fn(async (type: string, id: string) => {
		calls.push(`autoImport:${type}:${id}`);
	}),
	deployApplication: vi.fn(record("deployApplication")),
	deployCompose: vi.fn(record("deployCompose")),
	deployPreviewApplication: vi.fn(record("deployPreview")),
	rebuildApplication: vi.fn(record("rebuildApplication")),
	rebuildCompose: vi.fn(record("rebuildCompose")),
	rebuildPreviewApplication: vi.fn(record("rebuildPreview")),
	updateApplicationStatus: vi.fn(async () => {}),
	updateCompose: vi.fn(async () => {}),
	updatePreviewDeployment: vi.fn(async () => {}),
}));

import { processDeploymentJob } from "@/server/queues/deployments-queue";

const job = (data: Record<string, unknown>) =>
	({ data: { titleLog: "t", descriptionLog: "d", ...data } }) as never;

describe("processDeploymentJob", () => {
	beforeEach(() => {
		calls.length = 0;
	});

	it("checks for workflows before deploying an application", async () => {
		await processDeploymentJob(
			job({
				applicationType: "application",
				applicationId: "app1",
				type: "deploy",
			}),
		);
		expect(calls[0]).toBe("autoImport:application:app1");
		expect(calls[1]).toMatch(/^deployApplication:/);
	});

	it("checks for workflows before redeploying a compose service", async () => {
		await processDeploymentJob(
			job({ applicationType: "compose", composeId: "c1", type: "redeploy" }),
		);
		expect(calls[0]).toBe("autoImport:compose:c1");
		expect(calls[1]).toMatch(/^rebuildCompose:/);
	});

	it("doesn't check preview deployments", async () => {
		await processDeploymentJob(
			job({
				applicationType: "application-preview",
				applicationId: "app1",
				previewDeploymentId: "p1",
				type: "deploy",
			}),
		);
		expect(calls.some((call) => call.startsWith("autoImport"))).toBe(false);
	});
});
