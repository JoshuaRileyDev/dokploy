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

export const OvhCloudIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
	>
		<rect width="24" height="24" rx="4" fill="#000E9C" />
		<text
			x="12"
			y="15.5"
			textAnchor="middle"
			fontFamily="Arial, Helvetica, sans-serif"
			fontSize="9"
			fontWeight="700"
			fill="#fff"
		>
			OVH
		</text>
	</svg>
);

export const ContaboIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
	>
		<rect width="24" height="24" rx="4" fill="#1C3D5A" />
		<text
			x="12"
			y="16.5"
			textAnchor="middle"
			fontFamily="Arial, Helvetica, sans-serif"
			fontSize="13"
			fontWeight="700"
			fill="#fff"
		>
			C
		</text>
	</svg>
);

export const DigitalOceanIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
	>
		<rect width="24" height="24" rx="4" fill="#0069FF" />
		<path
			fill="#fff"
			d="M12 18.5v-2.6a3.9 3.9 0 1 0-3.9-3.9H5.5A6.5 6.5 0 1 1 12 18.5Zm0-2.6H9.4v-2.6H12Zm-2.6 2H7.4v-2h2Zm-2-2H5.8v-1.6h1.6Z"
		/>
	</svg>
);

export const VultrIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
	>
		<rect width="24" height="24" rx="4" fill="#007BFC" />
		<path fill="#51B9FF" d="M5 6h3.2l4 7-1.6 2.8Z" />
		<path fill="#fff" d="M9.6 6h3.2l4 7-1.6 2.8Z" />
		<path fill="#fff" d="M15.8 6H19l-5.6 10h-3.2Z" />
	</svg>
);

const cloudProviderIcons: Record<string, (props: Props) => React.ReactElement> =
	{
		hetzner: HetznerIcon,
		ovhcloud: OvhCloudIcon,
		digitalocean: DigitalOceanIcon,
		vultr: VultrIcon,
		contabo: ContaboIcon,
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
