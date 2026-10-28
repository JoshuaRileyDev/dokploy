import { FolderSearch } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ServerFilesExplorer } from "../server-files-explorer";
import { ShowStorageActions } from "./show-storage-actions";
import { ShowTraefikActions } from "./show-traefik-actions";
import { ToggleDockerCleanup } from "./toggle-docker-cleanup";

interface Props {
	serverId: string;
	serverName?: string;
	/** Build and workflow servers don't run Traefik, so they only get the cleanup tools */
	showTraefik?: boolean;
	canBrowseFiles?: boolean;
	canViewDocker?: boolean;
	children?: React.ReactNode;
}

export const ShowServerActions = ({
	serverId,
	serverName,
	showTraefik = true,
	canBrowseFiles = false,
	canViewDocker = false,
	children,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{children ? (
				<DialogTrigger asChild>{children}</DialogTrigger>
			) : (
				<DialogTrigger asChild>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onSelect={(e) => {
							e.preventDefault();
						}}
					>
						View Actions
					</DropdownMenuItem>
				</DialogTrigger>
			)}
			<DialogContent
				className="sm:max-w-xl"
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				<div className="flex flex-col gap-1">
					<DialogTitle className="text-xl">
						{showTraefik ? "Web server settings" : "Docker cleanup"}
					</DialogTitle>
					<DialogDescription>
						{showTraefik
							? "Reload or clean the web server."
							: "Free space left behind by builds, or find what's filling the disk."}
					</DialogDescription>
				</div>

				<div className="grid grid-cols-2 w-full gap-4">
					{showTraefik && <ShowTraefikActions serverId={serverId} />}
					<ShowStorageActions serverId={serverId} />
					{canBrowseFiles && (
						<ServerFilesExplorer
							serverId={serverId}
							serverName={serverName}
							canViewDocker={canViewDocker}
						>
							<Button variant="outline">
								<FolderSearch className="size-4" />
								Browse files
							</Button>
						</ServerFilesExplorer>
					)}
					<ToggleDockerCleanup serverId={serverId} />
				</div>
			</DialogContent>
		</Dialog>
	);
};
