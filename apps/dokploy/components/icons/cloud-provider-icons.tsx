import { Cloud } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
	className?: string;
}

export const HetznerIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
	>
		<rect width="24" height="24" rx="4" fill="#D50C2D" />
		<path
			fill="#fff"
			d="M4.602 4.025h2.244c.509 0 .716.215.716.717v5.64h8.883v-5.64c0-.509.215-.717.717-.717h2.229c.5 0 .71.23.724.717v14.516c0 .509-.215.717-.717.717h-2.23c-.51 0-.717-.215-.717-.717v-5.735H7.562v5.735c0 .516-.215.717-.716.717H4.602c-.51 0-.717-.208-.717-.717V4.742c0-.509.207-.717.717-.717z"
		/>
	</svg>
);

const cloudProviderIcons: Record<string, (props: Props) => React.ReactElement> =
	{
		hetzner: HetznerIcon,
	};

export const CloudProviderIcon = ({
	providerType,
	className,
}: Props & { providerType: string }) => {
	const Icon = cloudProviderIcons[providerType];
	return Icon ? (
		<Icon className={className} />
	) : (
		<Cloud className={cn("text-muted-foreground", className)} />
	);
};
