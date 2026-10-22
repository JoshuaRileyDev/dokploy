import type { Octokit } from "octokit";
import {
	type ParsedWorkflow,
	parseWorkflow,
	WorkflowParseError,
} from "./parser";

export type WorkflowSourceType = "github" | "dokploy";

export const WORKFLOW_DIRECTORIES: Record<WorkflowSourceType, string> = {
	github: ".github/workflows",
	dokploy: ".dokploy/workflows",
};

export type WorkflowFile = {
	path: string;
	source: WorkflowSourceType;
	sha: string;
	content: string;
};

export type LoadedWorkflow = WorkflowFile & {
	parsed: ParsedWorkflow | null;
	parseError: string | null;
};

const isNotFound = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"status" in error &&
	(error as { status: number }).status === 404;

const isWorkflowFile = (name: string) =>
	name.endsWith(".yml") || name.endsWith(".yaml");

const listDirectory = async (
	octokit: Octokit,
	owner: string,
	repo: string,
	path: string,
	ref: string,
) => {
	try {
		const { data } = await octokit.rest.repos.getContent({
			owner,
			repo,
			path,
			ref,
		});
		return Array.isArray(data)
			? data.filter(
					(entry) => entry.type === "file" && isWorkflowFile(entry.name),
				)
			: [];
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
};

export const readWorkflowFile = async (
	octokit: Octokit,
	owner: string,
	repo: string,
	path: string,
	ref: string,
) => {
	const { data } = await octokit.rest.repos.getContent({
		owner,
		repo,
		path,
		ref,
	});
	if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
		throw new Error(`${path} is not a file`);
	}
	return Buffer.from(data.content, "base64").toString("utf8");
};

export const fetchWorkflowFiles = async ({
	octokit,
	owner,
	repo,
	ref,
	sources,
}: {
	octokit: Octokit;
	owner: string;
	repo: string;
	ref: string;
	sources: WorkflowSourceType[];
}): Promise<WorkflowFile[]> => {
	const perSource = await Promise.all(
		sources.map(async (source) => {
			const entries = await listDirectory(
				octokit,
				owner,
				repo,
				WORKFLOW_DIRECTORIES[source],
				ref,
			);
			return Promise.all(
				entries.map(async (entry) => ({
					path: entry.path,
					source,
					sha: entry.sha,
					content: await readWorkflowFile(
						octokit,
						owner,
						repo,
						entry.path,
						ref,
					),
				})),
			);
		}),
	);
	return perSource.flat();
};

const fileStem = (path: string) =>
	path
		.split("/")
		.pop()
		?.replace(/\.ya?ml$/, "") ?? path;

export const loadWorkflow = (file: WorkflowFile): LoadedWorkflow => {
	try {
		return {
			...file,
			parsed: parseWorkflow(file.content, fileStem(file.path)),
			parseError: null,
		};
	} catch (error) {
		if (error instanceof WorkflowParseError) {
			return { ...file, parsed: null, parseError: error.message };
		}
		throw error;
	}
};
