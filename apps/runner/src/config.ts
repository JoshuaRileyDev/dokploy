import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunnerConfig = {
	url: string;
	workflowRunnerId: string;
	name: string;
	labels: string[];
	token: string;
	workDir: string;
};

export const defaultConfigPath = () =>
	process.env.DOKPLOY_RUNNER_CONFIG ??
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"dokploy-runner",
		"config.json",
	);

export const defaultWorkDir = () => join(homedir(), ".dokploy-runner", "runs");

export const loadConfig = (path: string): RunnerConfig => {
	if (!existsSync(path)) {
		throw new Error(
			`No runner configuration at ${path}. Run "dokploy-runner register" first.`,
		);
	}
	return JSON.parse(readFileSync(path, "utf8")) as RunnerConfig;
};

/** Saved with owner-only permissions because it holds the runner's credential. */
export const saveConfig = (path: string, config: RunnerConfig) => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
};
