import {
	fetchWorkflowFiles,
	loadWorkflow,
} from "@dokploy/server/utils/workflows/github";
import type { Octokit } from "octokit";
import { describe, expect, it } from "vitest";

const VALID = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{run: echo}]
`;

const fakeOctokit = (tree: Record<string, string>, failWith?: number) => {
	const calls: { path: string; ref: string }[] = [];
	const getContent = async ({ path, ref }: { path: string; ref: string }) => {
		calls.push({ path, ref });
		if (failWith) throw Object.assign(new Error("boom"), { status: failWith });
		if (path in tree) {
			return {
				data: {
					type: "file",
					content: Buffer.from(tree[path] ?? "").toString("base64"),
				},
			};
		}
		const prefix = `${path}/`;
		const children = Object.keys(tree).filter(
			(file) =>
				file.startsWith(prefix) && !file.slice(prefix.length).includes("/"),
		);
		if (children.length === 0) {
			throw Object.assign(new Error("Not Found"), { status: 404 });
		}
		return {
			data: children.map((file) => ({
				type: "file",
				name: file.slice(prefix.length),
				path: file,
				sha: `sha-${file}`,
			})),
		};
	};
	return {
		octokit: { rest: { repos: { getContent } } } as unknown as Octokit,
		calls,
	};
};

describe("fetchWorkflowFiles", () => {
	it("reads yaml files from both workflow folders at the given ref", async () => {
		const { octokit, calls } = fakeOctokit({
			".github/workflows/ci.yml": VALID,
			".github/workflows/README.md": "docs",
			".dokploy/workflows/deploy.yaml": VALID,
		});

		const files = await fetchWorkflowFiles({
			octokit,
			owner: "acme",
			repo: "widgets",
			ref: "abc123",
			sources: ["github", "dokploy"],
		});

		expect(files).toEqual([
			{
				path: ".github/workflows/ci.yml",
				source: "github",
				sha: "sha-.github/workflows/ci.yml",
				content: VALID,
			},
			{
				path: ".dokploy/workflows/deploy.yaml",
				source: "dokploy",
				sha: "sha-.dokploy/workflows/deploy.yaml",
				content: VALID,
			},
		]);
		expect(calls.every((call) => call.ref === "abc123")).toBe(true);
	});

	it("treats a missing folder as no workflows", async () => {
		const { octokit } = fakeOctokit({});
		await expect(
			fetchWorkflowFiles({
				octokit,
				owner: "acme",
				repo: "widgets",
				ref: "main",
				sources: ["github", "dokploy"],
			}),
		).resolves.toEqual([]);
	});

	it("propagates errors other than not found", async () => {
		const { octokit } = fakeOctokit({}, 403);
		await expect(
			fetchWorkflowFiles({
				octokit,
				owner: "acme",
				repo: "widgets",
				ref: "main",
				sources: ["dokploy"],
			}),
		).rejects.toThrow("boom");
	});
});

describe("loadWorkflow", () => {
	it("keeps the parse error instead of throwing", () => {
		const loaded = loadWorkflow({
			path: ".dokploy/workflows/broken.yml",
			source: "dokploy",
			sha: "s",
			content: "on: push",
		});
		expect(loaded.parsed).toBeNull();
		expect(loaded.parseError).toBe('Missing or empty "jobs"');
	});

	it("falls back to the file name for unnamed workflows", () => {
		const loaded = loadWorkflow({
			path: ".dokploy/workflows/deploy.yaml",
			source: "dokploy",
			sha: "s",
			content: VALID,
		});
		expect(loaded.parsed?.name).toBe("deploy");
	});
});
