#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ApiError, createApi } from "./api.js";
import {
	defaultConfigPath,
	defaultWorkDir,
	loadConfig,
	saveConfig,
} from "./config.js";
import { startRunner } from "./runner.js";
import { installService, uninstallService } from "./service.js";

const VERSION = (
	JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { version: string }
).version;

const HELP = `dokploy-runner ${VERSION}

Runs Dokploy workflow jobs on this machine, for example iOS builds on a Mac.

Usage:
  dokploy-runner register --url <dokploy-url> --token <registration-token> [--work-dir <dir>]
  dokploy-runner start [--once] [--verbose]
  dokploy-runner status
  dokploy-runner install-service
  dokploy-runner uninstall-service

Options:
  --config <path>   Config file (default: ${defaultConfigPath()})
  --help, -h        Show this help
  --version, -v     Show the version
`;

const actVersion = () => {
	const result = spawnSync("act", ["--version"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : null;
};

const main = async () => {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			url: { type: "string" },
			token: { type: "string" },
			"work-dir": { type: "string" },
			config: { type: "string" },
			once: { type: "boolean", default: false },
			verbose: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
			version: { type: "boolean", short: "v", default: false },
		},
	});
	const configPath = resolve(values.config ?? defaultConfigPath());
	const command = positionals[0];

	if (values.version) return console.log(VERSION);
	if (values.help || !command) return console.log(HELP);

	switch (command) {
		case "register": {
			if (!values.url || !values.token) {
				throw new Error(
					"register needs --url and --token (from Dokploy → Workflows → Runners).",
				);
			}
			const url = values.url.replace(/\/+$/, "");
			const registered = await createApi(url).post<{
				workflowRunnerId: string;
				name: string;
				labels: string[];
				token: string;
			}>("/api/workflow-runner/register", {
				registrationToken: values.token,
				os: platform(),
				arch: arch(),
				version: VERSION,
			});
			saveConfig(configPath, {
				url,
				workflowRunnerId: registered.workflowRunnerId,
				name: registered.name,
				labels: registered.labels,
				token: registered.token,
				workDir: resolve(values["work-dir"] ?? defaultWorkDir()),
			});
			console.log(
				`Registered "${registered.name}" (${registered.labels.join(", ")}).`,
			);
			console.log(
				`Saved to ${configPath}. Start it with: dokploy-runner start`,
			);
			if (!actVersion()) {
				console.log(
					"act isn't installed yet; install it before starting (macOS: brew install act).",
				);
			}
			return;
		}
		case "start": {
			const config = loadConfig(configPath);
			const act = actVersion();
			if (!act) {
				throw new Error(
					"act isn't installed or isn't on PATH (macOS: brew install act).",
				);
			}
			console.log(`Using ${act}`);
			await startRunner(config, { once: values.once, verbose: values.verbose });
			return;
		}
		case "status": {
			const config = loadConfig(configPath);
			console.log(`Runner:   ${config.name} (${config.workflowRunnerId})`);
			console.log(`Dokploy:  ${config.url}`);
			console.log(`Labels:   ${config.labels.join(", ")}`);
			console.log(`Work dir: ${config.workDir}`);
			console.log(`act:      ${actVersion() ?? "not installed"}`);
			return;
		}
		case "install-service":
			loadConfig(configPath);
			installService(fileURLToPath(import.meta.url), configPath);
			return;
		case "uninstall-service":
			uninstallService();
			return;
		default:
			throw new Error(
				`Unknown command "${command}". Run dokploy-runner --help.`,
			);
	}
};

main().catch((error) => {
	console.error(
		error instanceof ApiError ? `Dokploy: ${error.message}` : error.message,
	);
	process.exit(1);
});
