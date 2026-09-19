import { Boxes } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ShowSwarmContainers } from "@/components/dashboard/swarm/containers/show-swarm-containers";

interface Props {
	serverId: string;
}

export const ShowSwarmOverviewModal = ({ serverId }: Props) => {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<DropdownMenuItem
					className="w-full cursor-pointer"
					onSelect={(e) => e.preventDefault()}
				>
					<Boxes className="mr-2 h-4 w-4" />
					Swarm Overview
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="sm:max-w-7xl max-h-[85vh] overflow-y-auto">
				<ShowSwarmContainers serverId={serverId} />
			</DialogContent>
		</Dialog>
	);
};
