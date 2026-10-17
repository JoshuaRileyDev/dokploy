import { db } from "@dokploy/server/db";
import { applications, compose } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
} from "../utils/docker/utils";
import { withResolvedVaultRefs } from "../utils/vault";
import {
	findWorkflowEnv,
	setWorkflowEnv,
	type WorkflowRepository,
} from "./workflow";

export type LinkedServiceType = "application" | "compose";
export type ImportableEnvSource = "env" | "buildArgs" | "buildSecrets";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const workflowEnvNameProblem = (name: string) => {
	if (!ENV_NAME.test(name)) return "Not a valid secret name";
	if (/^GITHUB_/i.test(name)) return "Names can't start with GITHUB_";
	return null;
};

const linkedTo = <T extends typeof applications | typeof compose>(
	table: T,
	repository: Pick<WorkflowRepository, "githubId" | "owner" | "repository">,
) =>
	and(
		eq(table.sourceType, "github"),
		eq(table.githubId, repository.githubId ?? ""),
		eq(table.owner, repository.owner),
		eq(table.repository, repository.repository),
	);

const withProject = {
	environment: { with: { project: true } },
} as const;

/** Applications and compose services in the repository's organization that deploy the same GitHub repository. */
export const findServicesLinkedToRepository = async (
	repository: Pick<
		WorkflowRepository,
		"githubId" | "owner" | "repository" | "organizationId"
	>,
) => {
	if (!repository.githubId) return [];
	const [apps, composes] = await Promise.all([
		db.query.applications.findMany({
			where: linkedTo(applications, repository),
			columns: { applicationId: true, name: true },
			with: withProject,
		}),
		db.query.compose.findMany({
			where: linkedTo(compose, repository),
			columns: { composeId: true, name: true },
			with: withProject,
		}),
	]);
	return [
		...apps.map((app) => ({
			serviceId: app.applicationId,
			serviceType: "application" as const,
			name: app.name,
			project: app.environment.project,
			environmentName: app.environment.name,
		})),
		...composes.map((service) => ({
			serviceId: service.composeId,
			serviceType: "compose" as const,
			name: service.name,
			project: service.environment.project,
			environmentName: service.environment.name,
		})),
	]
		.filter(
			(service) => service.project.organizationId === repository.organizationId,
		)
		.map(({ project, ...service }) => ({
			...service,
			projectName: project.name,
		}));
};

const loadService = async (
	serviceType: LinkedServiceType,
	serviceId: string,
) => {
	if (serviceType === "application") {
		return db.query.applications.findFirst({
			where: eq(applications.applicationId, serviceId),
			with: withProject,
		});
	}
	const service = await db.query.compose.findFirst({
		where: eq(compose.composeId, serviceId),
		with: withProject,
	});
	return (
		service && { ...service, buildArgs: undefined, buildSecrets: undefined }
	);
};

/**
 * Reads a linked service's variables exactly as a deployment would see them: project,
 * environment and vault references resolved. Throws unless the service deploys this repository.
 */
export const readLinkedServiceEnv = async (
	repository: Pick<
		WorkflowRepository,
		"githubId" | "owner" | "repository" | "organizationId"
	>,
	serviceType: LinkedServiceType,
	serviceId: string,
) => {
	const linked = await findServicesLinkedToRepository(repository);
	if (
		!linked.some(
			(s) => s.serviceId === serviceId && s.serviceType === serviceType,
		)
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "That service doesn't deploy this repository",
		});
	}
	const raw = await loadService(serviceType, serviceId);
	if (!raw)
		throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });

	try {
		const service = await withResolvedVaultRefs(raw);
		const projectEnv = service.environment.project.env;
		const environmentEnv = service.environment.env;
		const entries: {
			name: string;
			value: string;
			source: ImportableEnvSource;
		}[] = [];
		const sources: [ImportableEnvSource, string | null][] = [
			["env", service.env],
			["buildArgs", service.buildArgs ?? null],
			["buildSecrets", service.buildSecrets ?? null],
		];
		for (const [source, content] of sources) {
			if (!content) continue;
			for (const pair of prepareEnvironmentVariables(
				content,
				projectEnv,
				environmentEnv,
			)) {
				const [name, value] = parseEnvironmentKeyValuePair(pair);
				entries.push({ name, value, source });
			}
		}
		return entries;
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Couldn't read the service's variables: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
};

/** Copies selected variables into the repository's workflow secrets or variables. Later sources win for duplicate names. */
export const importLinkedServiceEnv = async ({
	repository,
	serviceType,
	serviceId,
	names,
	kind,
	overwrite,
}: {
	repository: Pick<
		WorkflowRepository,
		| "workflowRepositoryId"
		| "githubId"
		| "owner"
		| "repository"
		| "organizationId"
	>;
	serviceType: LinkedServiceType;
	serviceId: string;
	names: string[];
	kind: "secret" | "variable";
	overwrite: boolean;
}) => {
	const entries = await readLinkedServiceEnv(
		repository,
		serviceType,
		serviceId,
	);
	const existingNames = new Set(
		(
			await findWorkflowEnv(
				repository.organizationId,
				repository.workflowRepositoryId,
			)
		)
			.filter((entry) => entry.kind === kind)
			.map((entry) => entry.name),
	);
	const values = new Map(entries.map((entry) => [entry.name, entry.value]));
	const imported: string[] = [];
	const skipped: { name: string; reason: string }[] = [];

	for (const name of new Set(names)) {
		const value = values.get(name);
		const problem = workflowEnvNameProblem(name);
		if (value === undefined) {
			skipped.push({ name, reason: "Not set on the service" });
		} else if (problem) {
			skipped.push({ name, reason: problem });
		} else if (!overwrite && existingNames.has(name)) {
			skipped.push({ name, reason: "Already exists" });
		} else {
			await setWorkflowEnv(
				{
					workflowRepositoryId: repository.workflowRepositoryId,
					kind,
					name,
					value,
				},
				repository.organizationId,
			);
			imported.push(name);
		}
	}
	return { imported, skipped };
};
