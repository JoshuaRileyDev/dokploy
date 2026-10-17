import type { WorkflowEventName } from "./triggers";

const ZERO_SHA = /^0+$/;

// GitHub skips push and pull_request workflows for these commit message keywords.
// https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs
const SKIP_CI_KEYWORDS = [
	"[skip ci]",
	"[ci skip]",
	"[no ci]",
	"[skip actions]",
	"[actions skip]",
];

export type NormalizedGithubEvent = {
	name: WorkflowEventName;
	action?: string;
	owner: string;
	repository: string;
	/** Full ref the run is for, e.g. refs/heads/main, refs/tags/v1, refs/pull/3/merge. */
	ref: string;
	/** Commit to run against; null when it has to be resolved from `resolveRef`. */
	sha: string | null;
	resolveRef?: string;
	beforeSha?: string;
	baseBranch?: string;
	branch: string | null;
	title: string;
	actor: string | null;
	pullRequestNumber?: number;
	isFork: boolean;
	skipCi: boolean;
};

const firstLine = (text: unknown) =>
	typeof text === "string" ? (text.split("\n")[0] ?? "") : "";

const hasSkipKeyword = (message: unknown) =>
	typeof message === "string" &&
	SKIP_CI_KEYWORDS.some((keyword) => message.includes(keyword));

const repositoryOf = (payload: any) => ({
	owner: (payload?.repository?.owner?.login ??
		payload?.repository?.owner?.name) as string,
	repository: payload?.repository?.name as string,
});

/** Maps a GitHub webhook delivery to the event a workflow can trigger on, or null if workflows ignore it. */
export const normalizeGithubEvent = (
	eventName: string,
	payload: any,
): NormalizedGithubEvent | null => {
	const { owner, repository } = repositoryOf(payload);
	if (!owner || !repository) return null;
	const actor = (payload?.sender?.login as string | undefined) ?? null;

	switch (eventName) {
		case "push": {
			if (payload.deleted || !payload.after || ZERO_SHA.test(payload.after)) {
				return null;
			}
			const ref = payload.ref as string;
			return {
				name: "push",
				owner,
				repository,
				ref,
				sha: payload.after,
				beforeSha: payload.before,
				branch: ref.startsWith("refs/heads/")
					? ref.slice("refs/heads/".length)
					: null,
				title: firstLine(payload.head_commit?.message) || ref,
				actor: actor ?? payload.pusher?.name ?? null,
				isFork: false,
				skipCi: hasSkipKeyword(payload.head_commit?.message),
			};
		}
		case "pull_request": {
			const pr = payload.pull_request;
			if (!pr) return null;
			return {
				name: "pull_request",
				action: payload.action,
				owner,
				repository,
				ref: `refs/pull/${pr.number}/merge`,
				sha: pr.head?.sha ?? null,
				baseBranch: pr.base?.ref,
				branch: pr.head?.ref ?? null,
				title: pr.title ?? `Pull request #${pr.number}`,
				actor: actor ?? pr.user?.login ?? null,
				pullRequestNumber: pr.number,
				isFork: pr.head?.repo?.full_name !== pr.base?.repo?.full_name,
				skipCi: false,
			};
		}
		case "release": {
			const release = payload.release;
			if (!release?.tag_name) return null;
			return {
				name: "release",
				action: payload.action,
				owner,
				repository,
				ref: `refs/tags/${release.tag_name}`,
				sha: null,
				resolveRef: `tags/${release.tag_name}`,
				branch: null,
				title: release.name || release.tag_name,
				actor,
				isFork: false,
				skipCi: false,
			};
		}
		case "create": {
			if (payload.ref_type !== "branch" && payload.ref_type !== "tag") {
				return null;
			}
			const kind = payload.ref_type === "tag" ? "tags" : "heads";
			return {
				name: "create",
				owner,
				repository,
				ref: `refs/${kind}/${payload.ref}`,
				sha: null,
				resolveRef: `${kind}/${payload.ref}`,
				branch: payload.ref_type === "branch" ? payload.ref : null,
				title: `${payload.ref_type === "tag" ? "Tag" : "Branch"} ${payload.ref} created`,
				actor,
				isFork: false,
				skipCi: false,
			};
		}
		default:
			return null;
	}
};
