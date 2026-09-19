import { FileIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ShowTraefikSystem } from "@/components/dashboard/file-system/show-traefik-system";

interface Props {
	serverId: string;
}

export const ShowTraefikFileSystemModal = ({ serverId }: Props) => {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<DropdownMenuItem
					className="w-full cursor-pointer"
					onSelect={(e) => e.preventDefault()}
				>
					<FileIcon className="mr-2 h-4 w-4" />
					Traefik File System
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="sm:max-w-7xl max-h-[85vh] overflow-y-auto">
				<ShowTraefikSystem serverId={serverId} />
			</DialogContent>
		</Dialog>
	);
};
