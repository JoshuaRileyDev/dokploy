import { Clock } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ShowSchedules } from "@/components/dashboard/application/schedules/show-schedules";

interface Props {
	serverId: string;
}

export const ShowSchedulesModal = ({ serverId }: Props) => {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<DropdownMenuItem
					className="w-full cursor-pointer"
					onSelect={(e) => e.preventDefault()}
				>
					<Clock className="mr-2 h-4 w-4" />
					Schedules
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="sm:max-w-7xl max-h-[85vh] overflow-y-auto">
				<ShowSchedules id={serverId} scheduleType="server" />
			</DialogContent>
		</Dialog>
	);
};
