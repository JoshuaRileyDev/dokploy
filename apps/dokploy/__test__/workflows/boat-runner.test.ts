import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boatRunnerSetupScript } from "@dokploy/server/services/workflow-boat-runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("boatRunnerSetupScript", () => {
	let bundle: string;
	let work: string;

	beforeAll(() => {
		bundle = mkdtempSync(path.join(tmpdir(), "runner-bundle-"));
		mkdirSync(path.join(bundle, "dist"));
		writeFileSync(
			path.join(bundle, "package.json"),
			'{"type":"module","version":"9.9.9"}',
		);
		writeFileSync(
			path.join(bundle, "dist", "cli.js"),
			"console.log('it\\'s the runner')\n",
		);
		writeFileSync(path.join(bundle, "dist", "cli.d.ts"), "export {};");
		process.env.DOKPLOY_RUNNER_DIR = bundle;
		work = mkdtempSync(path.join(tmpdir(), "runner-install-"));
	});

	afterAll(() => {
		delete process.env.DOKPLOY_RUNNER_DIR;
		rmSync(bundle, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	it("registers before installing the service, with lingering so it survives reboots", () => {
		const script = boatRunnerSetupScript(
			"https://dokploy.example.com",
			"dkr_reg_abc",
		);
		const register = script.indexOf(
			"register --url 'https://dokploy.example.com' --token 'dkr_reg_abc'",
		);
		const linger = script.indexOf("loginctl enable-linger");
		const install = script.indexOf("install-service");
		expect(register).toBeGreaterThan(-1);
		expect(linger).toBeGreaterThan(register);
		expect(install).toBeGreaterThan(linger);
	});

	it("writes the runner's package.json and JavaScript files byte for byte", () => {
		const script = boatRunnerSetupScript("https://dokploy.example.com", "t");
		const writes = script
			.split("\n")
			.filter((line) => line.includes("| base64 -d >"))
			.map((line) => line.replace("/home/user/dokploy-runner", work));
		expect(writes).toHaveLength(2);
		mkdirSync(path.join(work, "dist"), { recursive: true });
		execFileSync("bash", ["-c", writes.join("\n")]);
		expect(
			execFileSync("cat", [path.join(work, "dist", "cli.js")], {
				encoding: "utf8",
			}),
		).toBe("console.log('it\\'s the runner')\n");
		expect(
			execFileSync("cat", [path.join(work, "package.json")], {
				encoding: "utf8",
			}),
		).toContain('"version":"9.9.9"');
	});
});
