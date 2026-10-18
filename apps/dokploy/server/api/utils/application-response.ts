import type {
	Application,
	findApplicationById,
} from "@dokploy/server/services/application";

export const omitApplicationEnvironment = <
	T extends Pick<
		Application,
		| "env"
		| "buildArgs"
		| "buildSecrets"
		| "previewEnv"
		| "previewBuildArgs"
		| "previewBuildSecrets"
	>,
>(
	application: T,
) => {
	const {
		env,
		buildArgs,
		buildSecrets,
		previewEnv,
		previewBuildArgs,
		previewBuildSecrets,
		...response
	} = application;
	return response;
};

export const applicationResponse = (
	application: Awaited<ReturnType<typeof findApplicationById>>,
) => {
	const {
		env: environmentEnv,
		project,
		...environment
	} = application.environment;
	const { env: projectEnv, ...projectResponse } = project;
	return {
		...omitApplicationEnvironment(application),
		environment: { ...environment, project: projectResponse },
	};
};
