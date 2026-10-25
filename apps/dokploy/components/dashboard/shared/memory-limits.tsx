import { formatDistanceToNow } from "date-fns";
import { AlertBlock } from "@/components/shared/alert-block";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

export type MemoryServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

const MB = 1024 * 1024;

export const formatMemory = (bytes: number) => {
	if (bytes >= 1024 * MB) {
		const gb = bytes / (1024 * MB);
		return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
	}
	return `${Math.round(bytes / MB)} MB`;
};

interface Props {
	id: string;
	type: MemoryServiceType;
}

export const ShowOomKills = ({ id, type }: Props) => {
	const { data: kills } = api.memoryPolicy.oomKills.useQuery(
		{ id, type },
		{ enabled: !!id, refetchInterval: 60_000 },
	);
	if (!kills?.length) return null;

	const latest = kills[0];
	const limit = latest?.memoryLimit ? formatMemory(latest.memoryLimit) : null;

	return (
		<AlertBlock type="error">
			<div className="flex flex-col gap-1">
				<span className="font-medium">
					{kills.length === 1
						? "A container was"
						: `${kills.length} containers were`}{" "}
					killed for running out of memory
				</span>
				<span>
					{latest?.service ? `Service "${latest.service}" ` : "The service "}
					hit its {limit ? `${limit} ` : ""}memory limit
					{latest?.finishedAt
						? ` ${formatDistanceToNow(new Date(latest.finishedAt), { addSuffix: true })}`
						: ""}{" "}
					and was restarted. Raise the limit, or check the app for a memory
					leak. Older containers are kept by Docker for a limited time, so this
					only shows recent restarts.
				</span>
			</div>
		</AlertBlock>
	);
};

export const ServerDefaultMemoryHint = ({ id, type }: Props) => {
	const { data } = api.memoryPolicy.serviceDefault.useQuery(
		{ id, type },
		{ enabled: !!id },
	);
	if (!data?.defaultMemoryLimit) return null;
	return (
		<p className="text-xs text-muted-foreground">
			Leave empty to use the server default of{" "}
			{formatMemory(data.defaultMemoryLimit)}.
		</p>
	);
};

export const ComposeMemoryLimits = ({ composeId }: { composeId: string }) => {
	const { data } = api.memoryPolicy.serviceDefault.useQuery(
		{ id: composeId, type: "compose" },
		{ enabled: !!composeId },
	);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Memory Limits</CardTitle>
				<CardDescription>
					Cap how much memory each service can use, so one service running out
					of control can't take memory from everything else on the server.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<ShowOomKills id={composeId} type="compose" />
				{data?.defaultMemoryLimit ? (
					<AlertBlock type="info">
						Services without their own limit get the server default of{" "}
						{formatMemory(data.defaultMemoryLimit)} on deploy. To set a
						different limit for a service, add{" "}
						<code>deploy.resources.limits.memory</code> (or{" "}
						<code>mem_limit</code>) to it in the compose file.
					</AlertBlock>
				) : (
					<AlertBlock type="warning">
						This server has no default memory limit, so services without{" "}
						<code>deploy.resources.limits.memory</code> or{" "}
						<code>mem_limit</code> can use all of its memory. Set a default
						under Settings → Deployments.
					</AlertBlock>
				)}
			</CardContent>
		</Card>
	);
};
