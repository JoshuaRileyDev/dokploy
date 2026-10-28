import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";

import { KINDS, type ServiceAction } from "./services";
import { useSession, useTransport } from "./session";
import type {
	Container,
	Deployment,
	Organization,
	Project,
	Server,
	ServerCommand,
	ServerStorage,
	ServiceDetail,
	ServiceKind,
	User,
	WorkflowLogs,
	WorkflowRepository,
	WorkflowRun,
} from "./types";

function useGet<T>(
	path: string,
	input?: Record<string, unknown>,
	options?: {
		enabled?: boolean;
		refetchInterval?:
			| number
			| false
			| ((data: T | undefined) => number | false);
	},
) {
	const transport = useTransport();
	const { connection } = useSession();
	return useQuery<T>({
		queryKey: [connection?.mode, path, input ?? {}],
		queryFn: () => transport.request<T>("GET", path, input),
		enabled: options?.enabled,
		refetchInterval: options?.refetchInterval
			? typeof options.refetchInterval === "function"
				? (q) =>
						(options.refetchInterval as (d: T | undefined) => number | false)(
							q.state.data,
						)
				: options.refetchInterval
			: undefined,
	});
}

export const useMe = () => useGet<User>("user.get");
export const useVersion = () => useGet<string>("settings.getDokployVersion");
export const useOrganizations = () =>
	useGet<Organization[]>("organization.all");
export const useActiveOrganization = () =>
	useGet<Organization | null>("organization.active");
export const useProjects = () =>
	useGet<Project[]>("project.all", undefined, { refetchInterval: 15_000 });
export const useRecentDeployments = () =>
	useGet<Deployment[]>("deployment.allCentralized", undefined, {
		refetchInterval: (d) =>
			d?.some((x) => x.status === "running") ? 2_000 : 15_000,
	});

export function useService(kind: ServiceKind, id: string) {
	return useGet<ServiceDetail>(
		`${kind}.one`,
		{ [KINDS[kind].idKey]: id },
		{
			refetchInterval: (d) =>
				d && (d.applicationStatus ?? d.composeStatus) === "running"
					? 1_500
					: 10_000,
		},
	);
}

export function useDeployments(
	kind: ServiceKind,
	id: string,
	running: boolean,
) {
	const path =
		kind === "compose" ? "deployment.allByCompose" : "deployment.all";
	return useGet<Deployment[]>(
		path,
		{ [KINDS[kind].idKey]: id },
		{
			enabled: KINDS[kind].hasDeployments,
			refetchInterval: running ? 1_500 : 15_000,
		},
	);
}

export const useRuntimeLogs = (
	kind: ServiceKind,
	id: string,
	enabled: boolean,
) =>
	useGet<string>(
		`${kind}.readLogs`,
		{ [KINDS[kind].idKey]: id },
		{ enabled, refetchInterval: 5_000 },
	);

export const useDeploymentLog = (deploymentId: string) =>
	useGet<string>("deployment.readLogs", { deploymentId });

export const useServers = () => useGet<Server[]>("server.all");
export const useServer = (serverId: string) =>
	useGet<Server>("server.one", { serverId });
export const useServerStorage = (serverId: string) =>
	useGet<ServerStorage>(
		"server.storage",
		{ serverId },
		{ refetchInterval: 30_000 },
	);
export const useContainers = (serverId: string) =>
	useGet<Container[]>(
		"docker.getContainers",
		{ serverId },
		{ refetchInterval: 10_000 },
	);
export const useServerCommands = (serverId: string) =>
	useGet<ServerCommand[]>("serverCommand.all", { serverId });

export const useWorkflowRepos = () =>
	useGet<WorkflowRepository[]>("workflow.allRepositories");
export const useWorkflowRepo = (workflowRepositoryId: string) =>
	useGet<WorkflowRepository>("workflow.oneRepository", {
		workflowRepositoryId,
	});
export const useWorkflowRuns = (workflowRepositoryId?: string) =>
	useGet<WorkflowRun[]>(
		"workflow.runs",
		workflowRepositoryId ? { workflowRepositoryId } : undefined,
		{
			refetchInterval: (d) =>
				d?.some((r) => r.status === "in_progress" || r.status === "queued")
					? 3_000
					: 20_000,
		},
	);
export const useWorkflowRun = (workflowRunId: string) =>
	useGet<WorkflowRun>(
		"workflow.oneRun",
		{ workflowRunId },
		{
			refetchInterval: (d) =>
				d && (d.status === "in_progress" || d.status === "queued")
					? 2_000
					: false,
		},
	);
export const useWorkflowLogs = (workflowRunId: string) =>
	useGet<WorkflowLogs>("workflow.readLogs", { workflowRunId });

export function usePost<I extends Record<string, unknown>, O = unknown>(
	path: string,
	opts?: { invalidate?: boolean },
) {
	const transport = useTransport();
	const queryClient = useQueryClient();
	return useMutation<O, Error, I>({
		mutationFn: (input) => transport.request<O>("POST", path, input),
		onSuccess: () => {
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			if (opts?.invalidate !== false) queryClient.invalidateQueries();
		},
		onError: () =>
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
	});
}

/** A POST whose endpoint is chosen per call, for menus of related actions. */
export function useAction() {
	const transport = useTransport();
	const queryClient = useQueryClient();
	return useMutation<
		unknown,
		Error,
		{ path: string; input: Record<string, unknown> }
	>({
		mutationFn: ({ path, input }) => transport.request("POST", path, input),
		onSuccess: () => {
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			queryClient.invalidateQueries();
		},
		onError: () =>
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
	});
}

export function useServiceAction(
	kind: ServiceKind,
	detail: ServiceDetail | undefined,
	id: string,
) {
	const transport = useTransport();
	const queryClient = useQueryClient();
	return useMutation<unknown, Error, ServiceAction>({
		mutationFn: (action) => {
			const input: Record<string, unknown> = { [KINDS[kind].idKey]: id };
			if (action === "reload") input.appName = detail?.appName;
			if (action === "deploy" || action === "redeploy") {
				if (!KINDS[kind].isDatabase)
					input.title =
						action === "redeploy"
							? "Redeploy from mobile"
							: "Deploy from mobile";
			}
			return transport.request("POST", `${kind}.${action}`, input);
		},
		onSuccess: () => {
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			queryClient.invalidateQueries();
		},
		onError: () =>
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
	});
}
