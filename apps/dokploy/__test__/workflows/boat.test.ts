import {
	BoatApiError,
	BoatClient,
	boatSshTarget,
} from "@dokploy/server/utils/boat/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeWorkflowRun = vi.fn(
	(_workflowRunId: string, _signal: AbortSignal) => new Promise<void>(() => {}),
);
vi.mock("@dokploy/server/utils/workflows/executor", () => ({
	executeWorkflowRun,
}));

const respond = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

describe("BoatClient", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("creates sandboxes without account secrets or Boat-side output logs", async () => {
		fetchMock.mockResolvedValue(
			respond(202, { sandbox: { id: "bx_23456789", state: "provisioning" } }),
		);
		await new BoatClient("boat_key").createSandbox(
			{ type: "large", from: "snap", name: "run", ttlSeconds: 60 },
			"run123",
		);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://boat.dev/api/v1/sandboxes");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer boat_key",
			"Idempotency-Key": "run123",
		});
		expect(JSON.parse(init.body)).toMatchObject({
			type: "large",
			from: "snap",
			noEnv: true,
			monitoring: false,
		});
	});

	it("confirms deletes with the sandbox id and ignores sandboxes that are already gone", async () => {
		fetchMock.mockResolvedValue(respond(404, { message: "not found" }));
		await new BoatClient("boat_key").deleteSandbox("bx_23456789");
		const [, init] = fetchMock.mock.calls[0]!;
		expect(init.method).toBe("DELETE");
		expect(init.headers["X-Ascii-Confirm-Delete"]).toBe("bx_23456789");
	});

	it("surfaces Boat's error message", async () => {
		fetchMock.mockResolvedValue(
			respond(402, {
				ok: false,
				code: "payment_required",
				message: "Add a card",
				error: { code: "payment_required", message: "Add a card" },
			}),
		);
		const error = await new BoatClient("boat_key")
			.savedSnapshotAllowance()
			.catch((caught) => caught);
		expect(error).toBeInstanceOf(BoatApiError);
		expect(error.message).toBe("Boat: Add a card");
		expect(error.status).toBe(402);
	});

	it("fails fast when a sandbox can't start", async () => {
		fetchMock.mockResolvedValue(
			respond(200, {
				sandbox: { id: "bx_23456789", state: "cancelled", error: "no machine" },
			}),
		);
		await expect(
			new BoatClient("boat_key").waitForSandbox("bx_23456789"),
		).rejects.toThrow("cancelled: no machine");
	});
});

describe("boatSshTarget", () => {
	const access = {
		sshUser: "user",
		hostKey: "ssh-ed25519 AAAA",
	};

	it("prefers the IPv4 endpoint when the machine has no IPv4 of its own", () => {
		expect(
			boatSshTarget(
				{ ...access, machineIp: "2a01::1", sshEndpoint: "1.2.3.4:2201" },
				"key",
			),
		).toMatchObject({ ipAddress: "1.2.3.4", port: 2201, username: "user" });
	});

	it("connects to the machine on port 22 otherwise", () => {
		expect(
			boatSshTarget(
				{ ...access, machineIp: "5.6.7.8", sshEndpoint: null },
				"key",
			),
		).toMatchObject({
			ipAddress: "5.6.7.8",
			port: 22,
			hostKey: "ssh-ed25519 AAAA",
		});
	});
});

describe("workflow queue", () => {
	beforeEach(() => {
		vi.resetModules();
		executeWorkflowRun.mockClear();
		delete (globalThis as { __dokployWorkflowQueue?: unknown })
			.__dokployWorkflowQueue;
	});

	it("runs one run at a time per server but several at once on Boat", async () => {
		const { enqueueWorkflowRun } = await import(
			"@dokploy/server/utils/workflows/queue"
		);
		enqueueWorkflowRun("s1", { key: "server", capacity: 1 });
		enqueueWorkflowRun("s2", { key: "server", capacity: 1 });
		enqueueWorkflowRun("b1", { key: "boat:org", capacity: 2 });
		enqueueWorkflowRun("b2", { key: "boat:org", capacity: 2 });
		enqueueWorkflowRun("b3", { key: "boat:org", capacity: 2 });
		expect(executeWorkflowRun.mock.calls.map(([id]) => id)).toEqual([
			"s1",
			"b1",
			"b2",
		]);
	});

	it("still serializes runs in the same concurrency group on Boat", async () => {
		const { enqueueWorkflowRun } = await import(
			"@dokploy/server/utils/workflows/queue"
		);
		enqueueWorkflowRun("b1", { key: "boat:org", capacity: 5 }, "repo:deploy");
		enqueueWorkflowRun("b2", { key: "boat:org", capacity: 5 }, "repo:deploy");
		expect(executeWorkflowRun.mock.calls.map(([id]) => id)).toEqual(["b1"]);
	});
});
