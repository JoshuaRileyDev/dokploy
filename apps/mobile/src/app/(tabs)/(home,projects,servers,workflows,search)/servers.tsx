import { ServerRow } from "@/components/rows";
import { Screen } from "@/components/screen";
import {
	EmptyState,
	ErrorState,
	ICON_INSET,
	ListSection,
	Loading,
} from "@/components/ui";
import { useServers } from "@/lib/hooks";

export default function Servers() {
	const servers = useServers();
	if (servers.isPending)
		return (
			<Screen readable>
				<Loading />
			</Screen>
		);
	if (servers.error)
		return (
			<Screen readable>
				<ErrorState error={servers.error} onRetry={servers.refetch} />
			</Screen>
		);
	if (servers.data.length === 0) {
		return (
			<Screen readable>
				<EmptyState
					symbol="server.rack"
					title="No Remote Servers"
					message="Everything runs on the Dokploy host. Add servers from the dashboard."
				/>
			</Screen>
		);
	}
	const active = servers.data.filter((s) => s.serverStatus === "active");
	const inactive = servers.data.filter((s) => s.serverStatus !== "active");
	return (
		<Screen readable>
			<ListSection inset={ICON_INSET}>
				{active.map((s) => (
					<ServerRow key={s.serverId} server={s} />
				))}
			</ListSection>
			{inactive.length > 0 && (
				<ListSection title="Offline" inset={ICON_INSET}>
					{inactive.map((s) => (
						<ServerRow key={s.serverId} server={s} />
					))}
				</ListSection>
			)}
		</Screen>
	);
}
