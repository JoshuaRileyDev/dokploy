import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const ALL = "__all__";

export const SearchInput = ({
	value,
	onChange,
	placeholder,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	className?: string;
}) => (
	<div className={cn("relative min-w-[220px] flex-1", className)}>
		<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
		<Input
			value={value}
			onChange={(event) => onChange(event.target.value)}
			placeholder={placeholder}
			className="pr-8 pl-8"
		/>
		{value && (
			<button
				type="button"
				title="Clear search"
				onClick={() => onChange("")}
				className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
			>
				<X className="size-4" />
			</button>
		)}
	</div>
);

/** A select whose empty value means "no filter". */
export const FilterSelect = ({
	value,
	onChange,
	allLabel,
	options,
	className,
}: {
	value: string | undefined;
	onChange: (value: string | undefined) => void;
	allLabel: string;
	options: { value: string; label: string }[];
	className?: string;
}) => (
	<Select
		value={value ?? ALL}
		onValueChange={(next) => onChange(next === ALL ? undefined : next)}
	>
		<SelectTrigger className={cn("w-40", className)}>
			<SelectValue />
		</SelectTrigger>
		<SelectContent>
			<SelectItem value={ALL}>{allLabel}</SelectItem>
			{options.map((option) => (
				<SelectItem key={option.value} value={option.value}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
);

export const ClearFiltersButton = ({ onClick }: { onClick: () => void }) => (
	<Button variant="ghost" size="sm" onClick={onClick}>
		<X className="size-4" />
		Clear filters
	</Button>
);
