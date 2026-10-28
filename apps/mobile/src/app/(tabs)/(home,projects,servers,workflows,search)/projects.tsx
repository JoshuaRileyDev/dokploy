import { Link } from "expo-router";

import { Screen } from "@/components/screen";
import {
	EmptyState,
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
	Row,
	StatusText,
} from "@/components/ui";
import { useProjects } from "@/lib/hooks";
import { flattenEnvironment } from "@/lib/services";
import type { Project } from "@/lib/types";
import { status } from "@/theme";

function projectHealth(project: Project) {
	const services = project.environments.flatMap(flattenEnvironment);
	const failing = services.filter((s) => s.status === "error").length;
	const deploying = services.filter((s) => s.status === "running").length;
	if (failing) return { color: status.error, label: `${failing} failing` };
	if (deploying) return { color: status.warn, label: "Deploying" };
	return null;
}

function ProjectRow({ project }: { project: Project }) {
	const count = project.environments.flatMap(flattenEnvironment).length;
	const health = projectHealth(project);
	return (
		<Link
			href={{
				pathname: "/project/[projectId]",
				params: { projectId: project.projectId },
			}}
			asChild
		>
			<Link.Trigger>
				<Row
					icon={{ symbol: "folder.fill", color: "#0A84FF" }}
					title={project.name}
					subtitle={`${count} ${count === 1 ? "service" : "services"}`}
					trailing={health ? <StatusText {...health} /> : undefined}
					accessibilityValue={health?.label}
				/>
			</Link.Trigger>
			<Link.Preview />
		</Link>
	);
}

export default function Projects() {
	const projects = useProjects();
	return (
		<Screen readable>
			{projects.isPending ? (
				<Loading />
			) : projects.error ? (
				<ErrorState error={projects.error} onRetry={projects.refetch} />
			) : projects.data.length === 0 ? (
				<EmptyState
					symbol="folder"
					title="No Projects"
					message="Projects you create in the Dokploy dashboard appear here."
				/>
			) : (
				<ListSection inset={ICON_INSET}>
					{projects.data.map((p) => (
						<ProjectRow key={p.projectId} project={p} />
					))}
				</ListSection>
			)}
		</Screen>
	);
}
