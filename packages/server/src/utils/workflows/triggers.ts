import type { WorkflowTrigger } from "./parser";

export type WorkflowEventName =
	| "push"
	| "pull_request"
	| "release"
	| "create"
	| "workflow_dispatch"
	| "schedule";

export type WorkflowEvent = {
	name: WorkflowEventName;
	action?: string;
	/** Full ref, e.g. refs/heads/main or refs/tags/v1.0.0. */
	ref?: string;
	/** Base branch name for pull_request events. */
	baseBranch?: string;
	changedFiles?: () => Promise<string[]>;
};

const DEFAULT_PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened"];

/**
 * Converts a GitHub Actions filter pattern to a RegExp. GitHub's syntax differs
 * from shell globs: `*` stops at `/`, `**` crosses it, and `?`/`+` quantify the
 * preceding character instead of matching any character.
 * https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#filter-pattern-cheat-sheet
 */
export const githubPatternToRegExp = (pattern: string) => {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] as string;
		if (char === "\\" && i + 1 < pattern.length) {
			source += `\\${pattern[++i]}`;
		} else if (char === "*") {
			if (pattern[i + 1] === "*") {
				source += ".*";
				i++;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?" || char === "+") {
			source += char;
		} else if (char === "[") {
			const end = pattern.indexOf("]", i + 1);
			if (end === -1) {
				source += "\\[";
			} else {
				source += pattern.slice(i, end + 1);
				i = end;
			}
		} else {
			source += char.replace(/[.^${}()|/]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
};

/** Later patterns win, and `!pattern` excludes values an earlier pattern matched. */
export const matchesFilter = (patterns: string[], value: string) => {
	let matched = false;
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			if (githubPatternToRegExp(pattern.slice(1)).test(value)) matched = false;
		} else if (githubPatternToRegExp(pattern).test(value)) {
			matched = true;
		}
	}
	return matched;
};

const matchesIncludeOrIgnore = (
	value: string,
	include: string[] | undefined,
	ignore: string[] | undefined,
) => {
	if (include) return matchesFilter(include, value);
	if (ignore) return !matchesFilter(ignore, value);
	return true;
};

const matchesPaths = async (trigger: WorkflowTrigger, event: WorkflowEvent) => {
	if (!trigger.paths && !trigger.pathsIgnore) return true;
	const files = (await event.changedFiles?.()) ?? [];
	if (trigger.paths) {
		const paths = trigger.paths;
		return files.some((file) => matchesFilter(paths, file));
	}
	const ignore = trigger.pathsIgnore ?? [];
	return files.some((file) => !matchesFilter(ignore, file));
};

const matchesPush = async (trigger: WorkflowTrigger, event: WorkflowEvent) => {
	const ref = event.ref ?? "";
	const hasBranchFilter = !!(trigger.branches || trigger.branchesIgnore);
	const hasTagFilter = !!(trigger.tags || trigger.tagsIgnore);

	if (ref.startsWith("refs/tags/")) {
		// A workflow that only filters branches never runs for tag pushes, and path filters don't apply to tags.
		if (hasBranchFilter && !hasTagFilter) return false;
		return matchesIncludeOrIgnore(
			ref.slice("refs/tags/".length),
			trigger.tags,
			trigger.tagsIgnore,
		);
	}

	if (ref.startsWith("refs/heads/")) {
		if (hasTagFilter && !hasBranchFilter) return false;
		if (
			!matchesIncludeOrIgnore(
				ref.slice("refs/heads/".length),
				trigger.branches,
				trigger.branchesIgnore,
			)
		) {
			return false;
		}
		return matchesPaths(trigger, event);
	}

	return false;
};

const matchesPullRequest = async (
	trigger: WorkflowTrigger,
	event: WorkflowEvent,
) => {
	const types = trigger.types ?? DEFAULT_PULL_REQUEST_TYPES;
	if (!event.action || !types.includes(event.action)) return false;
	if (
		!matchesIncludeOrIgnore(
			event.baseBranch ?? "",
			trigger.branches,
			trigger.branchesIgnore,
		)
	) {
		return false;
	}
	return matchesPaths(trigger, event);
};

export const matchesTrigger = async (
	trigger: WorkflowTrigger,
	event: WorkflowEvent,
): Promise<boolean> => {
	if (trigger.event !== event.name) return false;
	switch (event.name) {
		case "push":
			return matchesPush(trigger, event);
		case "pull_request":
			return matchesPullRequest(trigger, event);
		case "release":
			return (
				!trigger.types ||
				(!!event.action && trigger.types.includes(event.action))
			);
		default:
			return true;
	}
};

export const findMatchingTrigger = async (
	triggers: WorkflowTrigger[],
	event: WorkflowEvent,
) => {
	for (const trigger of triggers) {
		if (await matchesTrigger(trigger, event)) return trigger;
	}
	return undefined;
};
