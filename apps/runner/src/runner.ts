import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type ClaimedRun, createApi } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { createMasker, LineBuffer, OutputSender } from "./output.js";

const FLUSH_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 5000;
const KILL_GRACE_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

const log = (message: string) =>
	console.log(`${new Date().toISOString()} ${message}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Api = ReturnType<typeof createApi>;

/** Kills the whole process group, so act and the containers or tools it started stop too. */
const killGroup = (pid: number, signal: NodeJS.Signals) => {
	try {
		process.kill(-pid, signal);
	} catch {
		// Already exited.
	}
};

const executeRun = async (
	api: Api,
	config: RunnerConfig,
	run: ClaimedRun,
	options: { verbose: boolean; stopSignal: AbortSignal },
) => {
	const label = `${run.workflowName} #${run.runNumber} (${run.repository})`;
	log(`Starting ${label}`);
	mkdirSync(config.workDir, { recursive: true });

	const mask = createMasker(run.maskValues);
	const eventsPath = `/api/workflow-runner/runs/${run.workflowRunId}/events`;
	let cancelRequested = false;
	const sender = new OutputSender(async (lines) => {
		const response = await api.post<{ cancel: boolean }>(eventsPath, { lines });
		if (response.cancel) cancelRequested = true;
	});

	// Its own process group, so cancelling can stop everything the run started.
	const child = spawn("bash", ["-s"], {
		cwd: config.workDir,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
	});
	child.stdin.end(run.script);

	const buffers = { stdout: new LineBuffer(), stderr: new LineBuffer() };
	const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
		const lines = buffers[stream].push(chunk.toString());
		sender.add(lines.map((line) => ({ stream, line: mask(line) })));
		if (options.verbose) for (const line of lines) console.log(mask(line));
	};
	child.stdout.on("data", collect("stdout"));
	child.stderr.on("data", collect("stderr"));

	let killTimer: NodeJS.Timeout | undefined;
	const stop = (reason: string) => {
		if (killTimer || child.pid === undefined) return;
		log(`Stopping ${label}: ${reason}`);
		killGroup(child.pid, "SIGTERM");
		killTimer = setTimeout(() => {
			if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
		}, KILL_GRACE_MS);
	};
	options.stopSignal.addEventListener(
		"abort",
		() => stop("runner shutting down"),
		{
			once: true,
		},
	);

	let lastSent = Date.now();
	const ticker = setInterval(() => {
		if (sender.size === 0 && Date.now() - lastSent < HEARTBEAT_INTERVAL_MS)
			return;
		lastSent = Date.now();
		// An empty batch is still useful: it's the heartbeat that carries the cancel signal back.
		sender
			.flush()
			.then(() => {
				if (cancelRequested) stop("cancelled in Dokploy");
			})
			.catch((error) =>
				log(`Couldn't send output, will retry: ${error.message}`),
			);
	}, FLUSH_INTERVAL_MS);

	const exitCode = await new Promise<number>((resolve) => {
		child.on("close", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
		child.on("error", (error) => {
			sender.add([
				{ stream: "stderr", line: `Failed to start bash: ${error.message}` },
			]);
			resolve(1);
		});
	});
	clearInterval(ticker);
	clearTimeout(killTimer);

	for (const stream of ["stdout", "stderr"] as const) {
		sender.add(
			buffers[stream].flush().map((line) => ({ stream, line: mask(line) })),
		);
	}

	// The run isn't finished in Dokploy until its output and result arrive, so keep retrying.
	for (let attempt = 1; ; attempt++) {
		try {
			await sender.flush();
			await api.post(
				`/api/workflow-runner/runs/${run.workflowRunId}/complete`,
				{
					exitCode,
					errorMessage: options.stopSignal.aborted
						? "The runner was stopped."
						: null,
				},
			);
			break;
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) break;
			const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
			log(
				`Couldn't report the result, retrying in ${delay / 1000}s: ${(error as Error).message}`,
			);
			await sleep(delay);
		}
	}
	rmSync(join(config.workDir, run.workflowRunId), {
		recursive: true,
		force: true,
	});
	log(`Finished ${label} with exit code ${exitCode}`);
};

/** Polls Dokploy for runs and executes them one at a time until stopped. */
export const startRunner = async (
	config: RunnerConfig,
	options: { once: boolean; verbose: boolean },
) => {
	const api = createApi(config.url, config.token);
	const stopController = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			if (stopController.signal.aborted) process.exit(1);
			log("Shutting down after the current run (press Ctrl+C again to force)");
			stopController.abort();
		});
	}

	log(
		`Runner "${config.name}" polling ${config.url} for: ${config.labels.join(", ")}`,
	);
	let failures = 0;
	while (!stopController.signal.aborted) {
		try {
			const { run } = await api.post<{ run: ClaimedRun | null }>(
				"/api/workflow-runner/claim",
				{ workDir: config.workDir, waitSeconds: 20 },
				35_000,
			);
			failures = 0;
			if (!run) continue;
			await executeRun(api, config, run, {
				verbose: options.verbose,
				stopSignal: stopController.signal,
			});
			if (options.once) return;
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) {
				throw new Error(
					'Dokploy rejected this runner\'s credential. It may have been removed or re-registered elsewhere; run "dokploy-runner register" again.',
				);
			}
			failures++;
			const delay = Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS);
			log(
				`Can't reach Dokploy (${(error as Error).message}), retrying in ${delay / 1000}s`,
			);
			await sleep(delay);
		}
	}
};
