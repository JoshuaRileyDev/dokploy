const BOAT_API_BASE = "https://boat.dev/api/v1";

export type BoatMachineType = "small" | "default" | "large" | "xlarge";

export type BoatSandbox = {
	id: string;
	name: string;
	state: string;
	error?: string | null;
};

export type BoatSavedSnapshot = {
	name: string;
	status: "saving" | "ready" | "failed";
	error?: string;
	sizeBytes?: number;
};

export type BoatSshAccess = {
	machineIp: string | null;
	sshUser: string;
	/** `host:port` on IPv4, set only when the machine has no public IPv4 of its own. */
	sshEndpoint: string | null;
	hostKey: string;
};

export class BoatApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
	}
}

const READY_STATES = new Set(["ready", "idle", "running"]);
const FAILED_STATES = new Set(["error", "cancelled", "archived", "archiving"]);

const delay = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("Aborted"));
			},
			{ once: true },
		);
	});

export class BoatClient {
	constructor(private readonly apiKey: string) {}

	private async request<T>(
		method: string,
		path: string,
		{
			body,
			headers,
			signal,
		}: {
			body?: unknown;
			headers?: Record<string, string>;
			signal?: AbortSignal;
		} = {},
	): Promise<T> {
		const response = await fetch(`${BOAT_API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
		const data = (await response.json().catch(() => ({}))) as {
			message?: string;
			code?: string;
			error?: { message?: string; code?: string };
		};
		if (!response.ok) {
			throw new BoatApiError(
				`Boat: ${data.message ?? data.error?.message ?? `${method} ${path} failed with ${response.status}`}`,
				response.status,
				data.code ?? data.error?.code,
			);
		}
		return data as T;
	}

	/** Also serves as the check that an API key works. */
	async savedSnapshotAllowance() {
		const { allowance } = await this.request<{
			allowance?: { included: number; used: number };
		}>("GET", "/saved-snapshots");
		return allowance ?? null;
	}

	async createSandbox(
		options: {
			type: BoatMachineType;
			from?: string;
			name: string;
			ttlSeconds: number;
			labels?: Record<string, string>;
			/** `false` erases the disk on stop and skips background captures. */
			snapshots?: boolean;
		},
		idempotencyKey?: string,
		signal?: AbortSignal,
	) {
		const { sandbox } = await this.request<{ sandbox: BoatSandbox }>(
			"POST",
			"/sandboxes",
			{
				body: {
					...options,
					// CI machines must not receive the Boat account's own secrets, and Boat must not keep
					// command output, since it can contain workflow secrets.
					noEnv: true,
					monitoring: false,
				},
				headers: idempotencyKey
					? { "Idempotency-Key": idempotencyKey }
					: undefined,
				signal,
			},
		);
		return sandbox;
	}

	async getSandbox(sandboxId: string, signal?: AbortSignal) {
		const { sandbox } = await this.request<{ sandbox: BoatSandbox }>(
			"GET",
			`/sandboxes/${encodeURIComponent(sandboxId)}`,
			{ signal },
		);
		return sandbox;
	}

	async waitForSandbox(
		sandboxId: string,
		signal?: AbortSignal,
		timeoutMs = 5 * 60 * 1000,
	) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const sandbox = await this.getSandbox(sandboxId, signal);
			if (READY_STATES.has(sandbox.state)) return sandbox;
			if (FAILED_STATES.has(sandbox.state)) {
				throw new Error(
					`Boat sandbox ${sandboxId} is ${sandbox.state}${sandbox.error ? `: ${sandbox.error}` : ""}`,
				);
			}
			await delay(2000, signal);
		}
		throw new Error(`Boat sandbox ${sandboxId} wasn't ready after 5 minutes`);
	}

	addSshKey(sandboxId: string, publicKey: string, signal?: AbortSignal) {
		return this.request<BoatSshAccess>(
			"POST",
			`/sandboxes/${encodeURIComponent(sandboxId)}/sshkey`,
			{ body: { key: publicKey }, signal },
		);
	}

	async deleteSandbox(sandboxId: string) {
		try {
			await this.request(
				"DELETE",
				`/sandboxes/${encodeURIComponent(sandboxId)}`,
				{
					headers: { "X-Ascii-Confirm-Delete": sandboxId },
				},
			);
		} catch (error) {
			if (error instanceof BoatApiError && error.status === 404) return;
			throw error;
		}
	}

	async listSandboxIdsByLabel(label: string) {
		const { sandboxes } = await this.request<{ sandboxes?: BoatSandbox[] }>(
			"GET",
			`/sandboxes?label=${encodeURIComponent(label)}`,
		);
		return (sandboxes ?? []).map((sandbox) => sandbox.id);
	}

	async saveSnapshot(sandboxId: string, name: string) {
		await this.request("POST", "/saved-snapshots", {
			body: { sandboxId, name },
		});
	}

	async getSavedSnapshot(name: string) {
		try {
			const { snapshot } = await this.request<{ snapshot: BoatSavedSnapshot }>(
				"GET",
				`/saved-snapshots/${encodeURIComponent(name)}`,
			);
			return snapshot;
		} catch (error) {
			if (error instanceof BoatApiError && error.status === 404) return null;
			throw error;
		}
	}

	async waitForSavedSnapshot(name: string, timeoutMs = 30 * 60 * 1000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const snapshot = await this.getSavedSnapshot(name);
			if (snapshot?.status === "ready") return snapshot;
			if (snapshot?.status === "failed") {
				throw new Error(
					`Saving the Boat snapshot failed${snapshot.error ? `: ${snapshot.error}` : ""}`,
				);
			}
			await delay(5000);
		}
		throw new Error("The Boat snapshot wasn't saved after 30 minutes");
	}

	async deleteSavedSnapshot(name: string) {
		try {
			await this.request(
				"DELETE",
				`/saved-snapshots/${encodeURIComponent(name)}`,
				{ headers: { "X-Ascii-Confirm-Delete": name } },
			);
		} catch (error) {
			if (error instanceof BoatApiError && error.status === 404) return;
			throw error;
		}
	}
}

export const boatSshTarget = (access: BoatSshAccess, privateKey: string) => {
	if (access.sshEndpoint) {
		const separator = access.sshEndpoint.lastIndexOf(":");
		return {
			ipAddress: access.sshEndpoint.slice(0, separator),
			port: Number(access.sshEndpoint.slice(separator + 1)),
			username: access.sshUser,
			privateKey,
			hostKey: access.hostKey,
		};
	}
	if (!access.machineIp) {
		throw new Error("Boat didn't return an address for the sandbox");
	}
	return {
		ipAddress: access.machineIp,
		port: 22,
		username: access.sshUser,
		privateKey,
		hostKey: access.hostKey,
	};
};
