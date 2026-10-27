import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

interface Props {
	total: number;
	page: number;
	pageSize: number;
	pageSizes: number[];
	noun: [singular: string, plural: string];
	onPageChange: (page: number) => void;
	onPageSizeChange: (pageSize: number) => void;
}

export const TablePagination = ({
	total,
	page,
	pageSize,
	pageSizes,
	noun,
	onPageChange,
	onPageSizeChange,
}: Props) => {
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	const first = total === 0 ? 0 : page * pageSize + 1;
	const last = Math.min(total, (page + 1) * pageSize);

	return (
		<div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
			<span>
				{total === 0
					? `No ${noun[1]}`
					: `${first}–${last} of ${total} ${total === 1 ? noun[0] : noun[1]}`}
			</span>
			<div className="flex items-center gap-3">
				<div className="flex items-center gap-2">
					<span className="whitespace-nowrap">Per page</span>
					<Select
						value={String(pageSize)}
						onValueChange={(value) => onPageSizeChange(Number(value))}
					>
						<SelectTrigger className="h-8 w-[72px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{pageSizes.map((size) => (
								<SelectItem key={size} value={String(size)}>
									{size}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<span className="whitespace-nowrap">
					Page {page + 1} of {pageCount}
				</span>
				<div className="flex gap-1">
					<Button
						variant="outline"
						size="icon"
						className="size-8"
						title="Previous page"
						disabled={page === 0}
						onClick={() => onPageChange(page - 1)}
					>
						<ChevronLeft className="size-4" />
					</Button>
					<Button
						variant="outline"
						size="icon"
						className="size-8"
						title="Next page"
						disabled={page + 1 >= pageCount}
						onClick={() => onPageChange(page + 1)}
					>
						<ChevronRight className="size-4" />
					</Button>
				</div>
			</div>
		</div>
	);
};
