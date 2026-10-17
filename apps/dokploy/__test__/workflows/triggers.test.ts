import type { WorkflowTrigger } from "@dokploy/server/utils/workflows/parser";
import {
	githubPatternToRegExp,
	matchesFilter,
	matchesTrigger,
	type WorkflowEvent,
} from "@dokploy/server/utils/workflows/triggers";
import { describe, expect, it } from "vitest";

describe("githubPatternToRegExp", () => {
	// Examples from GitHub's filter pattern cheat sheet.
	it.each([
		["feature/*", "feature/my-branch", true],
		["feature/*", "feature/your/branch", false],
		["feature/**", "feature/beta-a/my-branch", true],
		["main", "main", true],
		["main", "mainline", false],
		["*", "releases", true],
		["*", "releases/10", false],
		["**", "all/the/branches", true],
		["v2*", "v2", true],
		["v2*", "v2.0", true],
		["v2*", "v2.9", true],
		["v[12].[0-9]+.[0-9]+", "v1.10.1", true],
		["v[12].[0-9]+.[0-9]+", "v2.0.0", true],
		["v[12].[0-9]+.[0-9]+", "v3.0.0", false],
		["*.js", "app.js", true],
		["*.js", "js/index.js", false],
		["**.js", "js/index.js", true],
		["docs/*", "docs/README.md", true],
		["docs/*", "docs/mona/octocat.txt", false],
		["docs/**", "docs/mona/octocat.txt", true],
		["**/README.md", "src/README.md", true],
		["**/*src/**", "a/src/app.js", true],
		["*-post.md", "my-post.md", true],
		["*-post.md", "path/their-post.md", false],
		["colou?r", "color", true],
		["colou?r", "colour", true],
		["releases/v1.0", "releases/v1x0", false],
	])("%s against %s -> %s", (pattern, value, expected) => {
		expect(githubPatternToRegExp(pattern).test(value)).toBe(expected);
	});
});

describe("matchesFilter", () => {
	it("applies negations in order", () => {
		const patterns = ["releases/**", "!releases/**-alpha"];
		expect(matchesFilter(patterns, "releases/10")).toBe(true);
		expect(matchesFilter(patterns, "releases/beta/3-alpha")).toBe(false);
	});

	it("lets a later positive pattern re-include", () => {
		const patterns = ["**", "!docs/**", "docs/important.md"];
		expect(matchesFilter(patterns, "docs/important.md")).toBe(true);
		expect(matchesFilter(patterns, "docs/other.md")).toBe(false);
	});
});

const push = (ref: string, files: string[] = []): WorkflowEvent => ({
	name: "push",
	ref,
	changedFiles: async () => files,
});

const check = (trigger: Omit<WorkflowTrigger, "event">, event: WorkflowEvent) =>
	matchesTrigger({ event: event.name, ...trigger }, event);

describe("matchesTrigger: push", () => {
	it("runs on any push without filters", async () => {
		expect(await check({}, push("refs/heads/dev"))).toBe(true);
		expect(await check({}, push("refs/tags/v1"))).toBe(true);
	});

	it("filters branches and ignores tags when only branches are set", async () => {
		const trigger = { branches: ["main", "releases/**"] };
		expect(await check(trigger, push("refs/heads/main"))).toBe(true);
		expect(await check(trigger, push("refs/heads/releases/1.0"))).toBe(true);
		expect(await check(trigger, push("refs/heads/dev"))).toBe(false);
		expect(await check(trigger, push("refs/tags/v1"))).toBe(false);
	});

	it("filters tags and ignores branches when only tags are set", async () => {
		const trigger = { tags: ["v*"] };
		expect(await check(trigger, push("refs/tags/v1.2.0"))).toBe(true);
		expect(await check(trigger, push("refs/tags/nightly"))).toBe(false);
		expect(await check(trigger, push("refs/heads/main"))).toBe(false);
	});

	it("supports branches-ignore", async () => {
		const trigger = { branchesIgnore: ["dependabot/**"] };
		expect(await check(trigger, push("refs/heads/main"))).toBe(true);
		expect(await check(trigger, push("refs/heads/dependabot/npm/x"))).toBe(
			false,
		);
	});

	it("requires both branch and path filters to match", async () => {
		const trigger = { branches: ["main"], paths: ["src/**"] };
		expect(await check(trigger, push("refs/heads/main", ["src/a.ts"]))).toBe(
			true,
		);
		expect(await check(trigger, push("refs/heads/main", ["README.md"]))).toBe(
			false,
		);
		expect(await check(trigger, push("refs/heads/dev", ["src/a.ts"]))).toBe(
			false,
		);
	});

	it("skips only when every changed file is ignored", async () => {
		const trigger = { pathsIgnore: ["docs/**"] };
		expect(await check(trigger, push("refs/heads/main", ["docs/a.md"]))).toBe(
			false,
		);
		expect(
			await check(trigger, push("refs/heads/main", ["docs/a.md", "src/b.ts"])),
		).toBe(true);
	});

	it("honours negated path patterns", async () => {
		const trigger = { paths: ["sub-project/**", "!sub-project/docs/**"] };
		expect(
			await check(trigger, push("refs/heads/main", ["sub-project/docs/x.md"])),
		).toBe(false);
		expect(
			await check(trigger, push("refs/heads/main", ["sub-project/src/x.ts"])),
		).toBe(true);
	});

	it("doesn't evaluate paths for tag pushes", async () => {
		let asked = false;
		const event: WorkflowEvent = {
			name: "push",
			ref: "refs/tags/v1",
			changedFiles: async () => {
				asked = true;
				return [];
			},
		};
		expect(await check({ tags: ["v*"], paths: ["src/**"] }, event)).toBe(true);
		expect(asked).toBe(false);
	});

	it("only fetches changed files when a path filter needs them", async () => {
		let asked = false;
		const event: WorkflowEvent = {
			name: "push",
			ref: "refs/heads/main",
			changedFiles: async () => {
				asked = true;
				return [];
			},
		};
		await check({ branches: ["main"] }, event);
		expect(asked).toBe(false);
	});
});

describe("matchesTrigger: pull_request", () => {
	const pr = (action: string, baseBranch = "main"): WorkflowEvent => ({
		name: "pull_request",
		action,
		baseBranch,
		changedFiles: async () => ["src/a.ts"],
	});

	it("defaults to opened, synchronize and reopened", async () => {
		expect(await check({}, pr("opened"))).toBe(true);
		expect(await check({}, pr("synchronize"))).toBe(true);
		expect(await check({}, pr("reopened"))).toBe(true);
		expect(await check({}, pr("closed"))).toBe(false);
		expect(await check({}, pr("labeled"))).toBe(false);
	});

	it("respects explicit types and the base branch filter", async () => {
		const trigger = { types: ["closed"], branches: ["main"] };
		expect(await check(trigger, pr("closed"))).toBe(true);
		expect(await check(trigger, pr("closed", "dev"))).toBe(false);
		expect(await check(trigger, pr("opened"))).toBe(false);
	});
});

describe("matchesTrigger: other events", () => {
	it("filters release activity types", async () => {
		const event: WorkflowEvent = { name: "release", action: "published" };
		expect(await check({}, event)).toBe(true);
		expect(await check({ types: ["published"] }, event)).toBe(true);
		expect(await check({ types: ["created"] }, event)).toBe(false);
	});

	it("never matches a different event", async () => {
		expect(
			await matchesTrigger(
				{ event: "push" },
				{ name: "release", action: "published" },
			),
		).toBe(false);
	});
});
