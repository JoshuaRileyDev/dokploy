import {
	hashRunnerToken,
	isRunnerOnline,
	runnerPlatformImages,
} from "@dokploy/server/services/workflow-runner";
import { describe, expect, it } from "vitest";
import {
	createMasker,
	LineBuffer,
	type OutputLine,
	OutputSender,
} from "../../../runner/src/output";
import { launchdPlist } from "../../../runner/src/service";

describe("runnerPlatformImages", () => {
	it("runs non-Linux labels directly on the runner's machine", () => {
		expect(
			runnerPlatformImages([
				"macos-latest",
				"macos-15",
				"ubuntu-latest",
				"self-hosted",
			]),
		).toEqual({
			"macos-latest": "-self-hosted",
			"macos-15": "-self-hosted",
			"self-hosted": "-self-hosted",
		});
	});
});

describe("runner tokens", () => {
	it("hashes deterministically without storing the token", () => {
		expect(hashRunnerToken("dkr_abc")).toBe(hashRunnerToken("dkr_abc"));
		expect(hashRunnerToken("dkr_abc")).not.toContain("dkr_abc");
		expect(hashRunnerToken("dkr_abc")).toHaveLength(64);
	});

	it("treats runners that polled in the last minute as online", () => {
		expect(isRunnerOnline({ lastSeenAt: new Date().toISOString() })).toBe(true);
		expect(
			isRunnerOnline({
				lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
			}),
		).toBe(false);
		expect(isRunnerOnline({ lastSeenAt: null })).toBe(false);
	});
});

describe("runner CLI output", () => {
	it("splits chunks into lines", () => {
		const buffer = new LineBuffer();
		expect(buffer.push("a\nb")).toEqual(["a"]);
		expect(buffer.push("c\r\n")).toEqual(["bc"]);
		expect(buffer.flush()).toEqual([]);
	});

	it("masks secrets before they leave the machine", () => {
		expect(createMasker(["s3cret-value"])("token=s3cret-value")).toBe(
			"token=***",
		);
	});

	it("sends lines in order and retries failed batches without losing them", async () => {
		const received: string[] = [];
		let failNext = true;
		const sender = new OutputSender(async (lines) => {
			if (failNext) {
				failNext = false;
				throw new Error("offline");
			}
			received.push(...lines.map((l) => l.line));
		}, 2);
		const lines = (...texts: string[]): OutputLine[] =>
			texts.map((line) => ({ stream: "stdout", line }));

		sender.add(lines("1", "2", "3"));
		await expect(sender.flush()).rejects.toThrow("offline");
		sender.add(lines("4"));
		await sender.flush();
		expect(received).toEqual(["1", "2", "3", "4"]);
		expect(sender.size).toBe(0);
	});
});

describe("launchdPlist", () => {
	it("runs the CLI at login with the config and a usable PATH", () => {
		const plist = launchdPlist({
			nodePath: "/opt/homebrew/bin/node",
			cliPath: "/usr/local/lib/node_modules/runner/dist/cli.js",
			configPath: "/Users/me/.config/dokploy-runner/config.json",
			logPath: "/Users/me/Library/Logs/dokploy-runner.log",
			path: "/opt/homebrew/bin:/usr/bin",
		});
		expect(plist).toContain("<string>start</string>");
		expect(plist).toContain(
			"<string>/Users/me/.config/dokploy-runner/config.json</string>",
		);
		expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
	});
});
