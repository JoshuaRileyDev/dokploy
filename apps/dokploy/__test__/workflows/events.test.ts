import { normalizeGithubEvent } from "@dokploy/server/utils/workflows/events";
import { describe, expect, it } from "vitest";

const repository = {
	name: "widgets",
	full_name: "acme/widgets",
	owner: { login: "acme", name: "acme" },
};

describe("normalizeGithubEvent", () => {
	it("normalizes pushes to a branch", () => {
		const event = normalizeGithubEvent("push", {
			ref: "refs/heads/main",
			before: "a".repeat(40),
			after: "b".repeat(40),
			repository,
			sender: { login: "octocat" },
			head_commit: { message: "Fix the thing\n\nLonger body" },
		});
		expect(event).toMatchObject({
			name: "push",
			owner: "acme",
			repository: "widgets",
			ref: "refs/heads/main",
			sha: "b".repeat(40),
			beforeSha: "a".repeat(40),
			branch: "main",
			title: "Fix the thing",
			actor: "octocat",
			isFork: false,
			skipCi: false,
		});
	});

	it("ignores branch deletions", () => {
		expect(
			normalizeGithubEvent("push", {
				ref: "refs/heads/old",
				after: "0".repeat(40),
				deleted: true,
				repository,
			}),
		).toBeNull();
	});

	it("honours skip-ci keywords on pushes", () => {
		const event = normalizeGithubEvent("push", {
			ref: "refs/heads/main",
			after: "b".repeat(40),
			repository,
			head_commit: { message: "docs: typo [skip ci]" },
		});
		expect(event?.skipCi).toBe(true);
	});

	it("normalizes pull requests and detects forks", () => {
		const payload = (headRepo: string | null) => ({
			action: "opened",
			repository,
			sender: { login: "contributor" },
			pull_request: {
				number: 7,
				title: "Add feature",
				head: {
					sha: "c".repeat(40),
					ref: "feature",
					repo: headRepo ? { full_name: headRepo } : null,
				},
				base: { ref: "main", repo: { full_name: "acme/widgets" } },
			},
		});

		expect(
			normalizeGithubEvent("pull_request", payload("acme/widgets")),
		).toMatchObject({
			name: "pull_request",
			action: "opened",
			ref: "refs/pull/7/merge",
			sha: "c".repeat(40),
			baseBranch: "main",
			branch: "feature",
			title: "Add feature",
			pullRequestNumber: 7,
			isFork: false,
		});
		expect(
			normalizeGithubEvent("pull_request", payload("someone/widgets"))?.isFork,
		).toBe(true);
		expect(normalizeGithubEvent("pull_request", payload(null))?.isFork).toBe(
			true,
		);
	});

	it("resolves releases and created refs from the tag or branch", () => {
		expect(
			normalizeGithubEvent("release", {
				action: "published",
				repository,
				release: { tag_name: "v1.2.0", name: "Version 1.2" },
			}),
		).toMatchObject({
			name: "release",
			action: "published",
			ref: "refs/tags/v1.2.0",
			sha: null,
			resolveRef: "tags/v1.2.0",
			title: "Version 1.2",
		});
		expect(
			normalizeGithubEvent("create", {
				ref: "release/2",
				ref_type: "branch",
				repository,
			}),
		).toMatchObject({
			name: "create",
			ref: "refs/heads/release/2",
			resolveRef: "heads/release/2",
			branch: "release/2",
		});
	});

	it("ignores events workflows don't trigger on", () => {
		expect(normalizeGithubEvent("issues", { repository })).toBeNull();
		expect(normalizeGithubEvent("push", { ref: "x", after: "b" })).toBeNull();
	});
});
