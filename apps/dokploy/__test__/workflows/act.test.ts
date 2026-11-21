import { execFileSync } from "node:child_process";
import {
	type ActRunScriptInput,
	buildActArgs,
	buildActCancelScript,
	buildActRunScript,
	buildRefreshRunnerCacheScript,
	buildSeedActionsScript,
	buildWarmActionCacheScript,
	toDotenv,
} from "@dokploy/server/utils/workflows/act";
import { createSecretMasker } from "@dokploy/server/utils/workflows/run-recorder";
import { describe, expect, it } from "vitest";

const input: ActRunScriptInput = {
	runId: "run123",
	cloneUrl: "https://x-access-token:ghs_secret@github.com/acme/widgets.git",
	remoteUrl: "https://github.com/acme/widgets.git",
	sha: "b".repeat(40),
	ref: "refs/tags/v1.0.0",
	event: "push",
	workflowPath: ".dokploy/workflows/ci.yml",
	defaultBranch: "main",
	actor: "octocat",
	eventPayload: { ref: "refs/heads/main", note: "it's $(rm -rf /)" },
	secrets: { GITHUB_TOKEN: "ghs_secret", MULTI: 'a\n"b"' },
	variables: {},
	inputs: {},
	trusted: true,
};

const decodeWrittenFiles = (script: string) =>
	Object.fromEntries(
		[
			...script.matchAll(
				/printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d > (\S+)/g,
			),
		].map(([, b64, file]) => [
			file?.split("/").pop(),
			Buffer.from(b64 ?? "", "base64").toString("utf8"),
		]),
	);

describe("job controls", () => {
	it("runs a single job with -j", () => {
		const args = buildActArgs({ ...input, targetJob: "build" }, "/d");
		expect(args.slice(args.indexOf("-j"), args.indexOf("-j") + 2)).toEqual([
			"-j",
			"build",
		]);
		expect(buildActArgs(input, "/d")).not.toContain("-j");
	});

	it("overwrites the checked-out workflow file after checkout", () => {
		const script = buildActRunScript({
			...input,
			workflowOverride: "jobs: {}\n",
		});
		const files = decodeWrittenFiles(script);
		expect(files["ci.yml"]).toBe("jobs: {}\n");
		expect(script.indexOf("ci.yml")).toBeGreaterThan(
			script.indexOf("git checkout -q FETCH_HEAD"),
		);
	});
});

describe("buildActRunScript", () => {
	const script = buildActRunScript(input);

	it("passes user-controlled data only through base64 files", () => {
		expect(script).not.toContain("rm -rf /)");
		const files = decodeWrittenFiles(script);
		expect(JSON.parse(files["event.json"] ?? "")).toEqual(input.eventPayload);
		expect(files["secrets.env"]).toBe(
			'GITHUB_TOKEN="ghs_secret"\nMULTI="a\\n\\"b\\""',
		);
	});

	it("checks out the exact commit and strips the token from the remote", () => {
		expect(script).toContain(`git fetch -q --depth 1 origin ${input.sha}`);
		expect(script).toMatch(
			/git remote set-url origin https\\?:\/\/github\.com\/acme\/widgets\.git\n/,
		);
		expect(script).not.toMatch(/set-url origin .*ghs_secret/);
	});

	// act's copy into the job container drops empty directories, and git needs .git/refs.
	it("leaves a ref file so the checkout is still a repository in the job container", () => {
		expect(script).toContain(
			"git update-ref refs/tags/v1.0.0 FETCH_HEAD\ngit checkout -q FETCH_HEAD",
		);
		const onBranch = buildActRunScript({
			...input,
			ref: "refs/heads/feature/x",
			branch: "feature/x",
		});
		expect(onBranch).toContain("git checkout -q -B feature/x FETCH_HEAD");
		expect(onBranch).not.toContain("update-ref");
	});

	it("records the act pid for cancellation and removes secrets afterwards", () => {
		expect(script).toContain("/etc/dokploy/workflows/runs/run123/act.pid");
		expect(script).toContain(
			"rm -f /etc/dokploy/workflows/runs/run123/secrets.env",
		);
	});
});

describe("buildActArgs", () => {
	const dir = "/runs/x";

	it("maps runner labels to images and enables JSON logs", () => {
		const args = buildActArgs(input, dir);
		expect(args.slice(0, 4)).toEqual([
			"act",
			"push",
			"-W",
			".dokploy/workflows/ci.yml",
		]);
		expect(args).toContain("--json");
		expect(args.join(" ")).toContain(
			"-P ubuntu-latest=catthehacker/ubuntu:act-latest",
		);
		expect(args).not.toContain("--container-daemon-socket");
	});

	it("doesn't expose the Docker socket to untrusted runs", () => {
		const args = buildActArgs({ ...input, trusted: false }, dir);
		expect(args.join(" ")).toContain("--container-daemon-socket -");
	});

	it("targets GitHub Enterprise instances", () => {
		const args = buildActArgs(
			{ ...input, githubInstance: "ghe.acme.com" },
			dir,
		);
		expect(args.join(" ")).toContain("--github-instance ghe.acme.com");
	});
});

describe("toDotenv", () => {
	it("quotes values", () => {
		expect(toDotenv({ A: "1", B: "two words" })).toBe('A="1"\nB="two words"');
	});
});

describe("createSecretMasker", () => {
	it("masks secrets, longest first, and ignores very short values", () => {
		const mask = createSecretMasker(["ghs_secret", "ghs_secret_long", "ab"]);
		expect(mask("token ghs_secret_long and ghs_secret, ab")).toBe(
			"token *** and ***, ab",
		);
	});
});

describe("managed caches", () => {
	it("skips act's image and action freshness checks only on managed machines", () => {
		const managed = buildActArgs({ ...input, managedCache: true }, "/d");
		expect(managed).toContain("--pull=false");
		expect(managed).toContain("--action-offline-mode");
		const unmanaged = buildActArgs(input, "/d");
		expect(unmanaged).not.toContain("--pull=false");
		expect(unmanaged).not.toContain("--action-offline-mode");
	});

	it("prepares the machine while fetching and waits for it before act starts", () => {
		const script = buildActRunScript({
			...input,
			prepareScript: "sudo systemctl restart docker",
		});
		const prepare = script.indexOf("sudo systemctl restart docker");
		const fetch = script.indexOf("git fetch");
		const waitForPrepare = script.indexOf("wait $BACKGROUND_0");
		const act = script.indexOf("act push");
		expect(prepare).toBeLessThan(fetch);
		expect(fetch).toBeLessThan(waitForPrepare);
		expect(waitForPrepare).toBeLessThan(act);
		expect(() => execFileSync("bash", ["-n"], { input: script })).not.toThrow();
	});

	it("reports setup milestones in order, with machine preparation only when there is some", () => {
		const prepared = buildActRunScript({ ...input, prepareScript: "true" });
		const order = [
			"git fetch",
			"::dokploy-setup-timing::repository_ready",
			"wait $BACKGROUND_0",
			"::dokploy-setup-timing::machine_prepared",
			"::dokploy-setup-timing::act_started",
			"act push",
		].map((text) => prepared.indexOf(text));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(buildActRunScript(input)).not.toContain("machine_prepared");
	});

	it("seeds each action into the directory act names after the full `uses:`", () => {
		const script = buildSeedActionsScript([
			"github/codeql-action/init@v3",
			"actions/setup-node@v6",
			"actions/setup-node@v6",
		]);
		expect(script).toContain(
			"seed_action github-codeql-action-init\\@v3 v3 https\\://github.com/github/codeql-action github/codeql-action/init\\@v3 keep &",
		);
		expect(script.match(/seed_action actions-setup-node/g)).toHaveLength(1);
		expect(() => execFileSync("bash", ["-n"], { input: script })).not.toThrow();
		expect(() =>
			execFileSync("bash", ["-n"], { input: buildWarmActionCacheScript() }),
		).not.toThrow();
		expect(() =>
			execFileSync("bash", ["-n"], { input: buildRefreshRunnerCacheScript() }),
		).not.toThrow();
	});

	it("re-clones actions that follow a branch on every run, and keeps tags and commits", () => {
		const script = buildSeedActionsScript([
			"acme/deploy@main",
			"acme/build@v2.1",
			`acme/test@${"a".repeat(40)}`,
		]);
		expect(script).toMatch(/seed_action acme-deploy\\@main .* refresh &/);
		expect(script).toMatch(/seed_action acme-build\\@v2\.1 .* keep &/);
		expect(script).toMatch(/seed_action acme-test\\@a{40} .* keep &/);
	});

	it("lets act fetch GitHub Enterprise actions, which aren't seeded", () => {
		const args = buildActArgs(
			{ ...input, managedCache: true, githubInstance: "github.example.com" },
			"/d",
		);
		expect(args).toContain("--pull=false");
		expect(args).not.toContain("--action-offline-mode");
	});

	it("doesn't start act once the run was cancelled while preparing", () => {
		const script = buildActRunScript({ ...input, prepareScript: "true" });
		expect(script.indexOf("/cancelled ]")).toBeGreaterThan(
			script.indexOf("wait $BACKGROUND_0"),
		);
		expect(script.indexOf("/cancelled ]")).toBeLessThan(
			script.indexOf("act push"),
		);
		expect(buildActCancelScript(input.runId)).toContain("/cancelled");
	});

	it("seeds the workflow's actions only on managed machines", () => {
		const seeded = { ...input, seedActions: ["actions/cache@v5"] };
		expect(buildActRunScript({ ...seeded, managedCache: true })).toContain(
			"seed_action actions-cache",
		);
		expect(buildActRunScript(seeded)).not.toContain("seed_action");
		expect(
			buildActRunScript({
				...seeded,
				managedCache: true,
				githubInstance: "github.example.com",
			}),
		).not.toContain("seed_action");
	});
});
