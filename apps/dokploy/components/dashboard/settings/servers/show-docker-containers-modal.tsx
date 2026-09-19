import { Container } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ShowContainers } from "@/components/dashboard/docker/show/show-containers";

interface Props {
	serverId: string;
}

export const ShowDockerContainersModal = ({ serverId }: Props) => {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<DropdownMenuItem
					className="w-full cursor-pointer"
					onSelect={(e) => e.preventDefault()}
				>
					<Container className="mr-2 h-4 w-4" />
					Docker Containers
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="sm:max-w-7xl max-h-[85vh] overflow-y-auto">
				<ShowContainers serverId={serverId} />
			</DialogContent>
		</Dialog>
	);
};
