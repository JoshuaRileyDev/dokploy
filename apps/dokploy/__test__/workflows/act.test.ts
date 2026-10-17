import {
	type ActRunScriptInput,
	buildActArgs,
	buildActRunScript,
	toDotenv,
} from "@dokploy/server/utils/workflows/act";
import { createSecretMasker } from "@dokploy/server/utils/workflows/executor";
import { describe, expect, it } from "vitest";

const input: ActRunScriptInput = {
	runId: "run123",
	cloneUrl: "https://x-access-token:ghs_secret@github.com/acme/widgets.git",
	remoteUrl: "https://github.com/acme/widgets.git",
	sha: "b".repeat(40),
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
