import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const LAUNCHD_LABEL = "dev.joshuariley.dokploy-runner";

const escapeXml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// launchd starts jobs with a minimal PATH, so include Homebrew where act usually lives.
const servicePath = () =>
	[
		...new Set([
			"/opt/homebrew/bin",
			"/usr/local/bin",
			...(process.env.PATH ?? "").split(":"),
		]),
	]
		.filter(Boolean)
		.join(":");

export const launchdPlist = ({
	nodePath,
	cliPath,
	configPath,
	logPath,
	path,
}: {
	nodePath: string;
	cliPath: string;
	configPath: string;
	logPath: string;
	path: string;
}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(nodePath)}</string>
		<string>${escapeXml(cliPath)}</string>
		<string>start</string>
		<string>--config</string>
		<string>${escapeXml(configPath)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${escapeXml(path)}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${escapeXml(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;

const launchdPaths = () => ({
	plistPath: join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${LAUNCHD_LABEL}.plist`,
	),
	logPath: join(homedir(), "Library", "Logs", "dokploy-runner.log"),
});

const systemdUnitPath = () =>
	join(homedir(), ".config", "systemd", "user", "dokploy-runner.service");

const run = (command: string, args: string[]) => {
	try {
		execFileSync(command, args, { stdio: "inherit" });
		return true;
	} catch {
		return false;
	}
};

export const installService = (cliPath: string, configPath: string) => {
	if (platform() === "darwin") {
		const { plistPath, logPath } = launchdPaths();
		mkdirSync(dirname(plistPath), { recursive: true });
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(
			plistPath,
			launchdPlist({
				nodePath: process.execPath,
				cliPath,
				configPath,
				logPath,
				path: servicePath(),
			}),
		);
		const domain = `gui/${process.getuid?.()}`;
		run("launchctl", ["bootout", domain, plistPath]);
		if (!run("launchctl", ["bootstrap", domain, plistPath])) {
			throw new Error(
				`Couldn't load ${plistPath}. Try: launchctl bootstrap ${domain} ${plistPath}`,
			);
		}
		console.log(`Installed and started. Logs: ${logPath}`);
		return;
	}
	if (platform() === "linux") {
		const unitPath = systemdUnitPath();
		mkdirSync(dirname(unitPath), { recursive: true });
		writeFileSync(
			unitPath,
			`[Unit]
Description=Dokploy workflow runner
After=network-online.target

[Service]
ExecStart=${process.execPath} ${cliPath} start --config ${configPath}
Restart=always
RestartSec=5
Environment=PATH=${servicePath()}

[Install]
WantedBy=default.target
`,
		);
		if (
			!run("systemctl", ["--user", "daemon-reload"]) ||
			!run("systemctl", ["--user", "enable", "--now", "dokploy-runner"])
		) {
			throw new Error(
				`Wrote ${unitPath}, but couldn't start it with systemctl --user.`,
			);
		}
		console.log(
			"Installed and started. Logs: journalctl --user -u dokploy-runner -f",
		);
		return;
	}
	throw new Error(
		"install-service supports macOS (launchd) and Linux (systemd).",
	);
};

export const uninstallService = () => {
	if (platform() === "darwin") {
		const { plistPath } = launchdPaths();
		run("launchctl", ["bootout", `gui/${process.getuid?.()}`, plistPath]);
		rmSync(plistPath, { force: true });
		console.log("Service removed.");
		return;
	}
	if (platform() === "linux") {
		run("systemctl", ["--user", "disable", "--now", "dokploy-runner"]);
		rmSync(systemdUnitPath(), { force: true });
		console.log("Service removed.");
		return;
	}
	throw new Error(
		"uninstall-service supports macOS (launchd) and Linux (systemd).",
	);
};
