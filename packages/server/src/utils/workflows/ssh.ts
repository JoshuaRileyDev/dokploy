import { Client } from "ssh2";

export type SshTarget = {
	ipAddress: string;
	port: number;
	username: string;
	privateKey: string;
};

const connect = (target: SshTarget) =>
	new Promise<Client>((resolve, reject) => {
		const client = new Client();
		client
			.once("ready", () => resolve(client))
			.once("error", reject)
			.connect({
				host: target.ipAddress,
				port: target.port,
				username: target.username,
				privateKey: target.privateKey,
				readyTimeout: 30_000,
				keepaliveInterval: 15_000,
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

/** Runs a script on the server and resolves with its exit code; `onAbort` runs on the same connection when `signal` fires. */
export const runRemoteScript = async ({
	target,
	script,
	onStdout,
	onStderr,
	signal,
	onAbortScript,
}: {
	target: SshTarget;
	script: string;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	signal?: AbortSignal;
	onAbortScript?: string;
}) => {
	const client = await connect(target);
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
		client.end();
	}
};
