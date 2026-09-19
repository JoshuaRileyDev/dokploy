import { Boxes } from "lucide-react";
import { useState } from "react";
import { ShowNodes } from "./show-nodes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

interface Props {
	serverId: string;
}

export const ShowNodesModal = ({ serverId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="icon" className="h-9 w-9">
					<Boxes className="h-4 w-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-7xl max-h-[85vh] overflow-y-auto">
				<div className="flex gap-4 py-4 w-full">
					<ShowNodes serverId={serverId} />
				</div>
			</DialogContent>
		</Dialog>
	);
};
