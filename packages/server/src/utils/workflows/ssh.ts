import { Client } from "ssh2";

export type SshTarget = {
	ipAddress: string;
	port: number;
	username: string;
	privateKey: string;
	/** OpenSSH public host key (`type base64`) to pin instead of trusting the first key offered. */
	hostKey?: string;
};

const hostKeyBlob = (hostKey: string) =>
	Buffer.from(hostKey.trim().split(/\s+/)[1] ?? "", "base64");

const connect = (target: SshTarget) =>
	new Promise<Client>((resolve, reject) => {
		const client = new Client();
		client
			.once("ready", () => resolve(client))
			.once("error", (error) => {
				client.end();
				reject(error);
			})
			.connect({
				host: target.ipAddress,
				port: target.port,
				username: target.username,
				privateKey: target.privateKey,
				readyTimeout: 30_000,
				keepaliveInterval: 15_000,
				...(target.hostKey
					? {
							hostVerifier: (key: Buffer) =>
								key.equals(hostKeyBlob(target.hostKey!)),
						}
					: {}),
			});
	});

const execOnClient = (
	client: Client,
	script: string,
	onStdout?: (chunk: string) => void,
	onStderr?: (chunk: string) => void,
) =>
	new Promise<number>((resolve, reject) => {
		// The script goes over stdin so large payloads don't hit the remote ARG_MAX.
		client.exec("bash -s", (err, stream) => {
			if (err) {
				reject(err);
				return;
			}
			stream
				.on("close", (code: number | null) => resolve(code ?? 1))
				.on("data", (data: Buffer) => onStdout?.(data.toString()));
			stream.stderr.on("data", (data: Buffer) => onStderr?.(data.toString()));
			stream.end(script);
		});
	});

const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		signal?.throwIfAborted();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

/** Keeps retrying for `retryForMs`, for machines whose sshd may still be starting. */
const connectWithRetry = async (
	target: SshTarget,
	retryForMs: number,
	signal?: AbortSignal,
) => {
	const deadline = Date.now() + retryForMs;
	for (let delay = 250; ; delay = Math.min(delay * 2, 2000)) {
		signal?.throwIfAborted();
		try {
			return await connect(target);
		} catch (error) {
			if (Date.now() + delay >= deadline) throw error;
			await wait(delay, signal);
		}
	}
};

export type SshSession = {
	/** Runs a script and resolves with its exit code; `onAbortScript` runs on the same connection when `signal` fires. */
	run: (options: {
		script: string;
		onStdout?: (chunk: string) => void;
		onStderr?: (chunk: string) => void;
		signal?: AbortSignal;
		onAbortScript?: string;
	}) => Promise<number>;
	close: () => void;
};

/** Opens one connection that several scripts can run over, saving a handshake per script. */
export const openSshSession = async (
	target: SshTarget,
	{
		retryForMs = 0,
		signal,
	}: { retryForMs?: number; signal?: AbortSignal } = {},
): Promise<SshSession> => {
	const client = await connectWithRetry(target, retryForMs, signal);
	return {
		run: async ({ script, onStdout, onStderr, signal, onAbortScript }) => {
			const abort = () => {
				if (onAbortScript) {
					execOnClient(client, onAbortScript).catch(() => {});
				}
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				return await execOnClient(client, script, onStdout, onStderr);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		},
		close: () => client.end(),
	};
};

/** Runs a script on the server over its own connection and resolves with its exit code. */
export const runRemoteScript = async ({
	target,
	...options
}: Parameters<SshSession["run"]>[0] & { target: SshTarget }) => {
	const session = await openSshSession(target);
	try {
		return await session.run(options);
	} finally {
		session.close();
	}
};
