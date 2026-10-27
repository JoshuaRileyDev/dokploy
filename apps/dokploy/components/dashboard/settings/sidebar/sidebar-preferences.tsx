import { Loader2, PanelLeft } from "lucide-react";
import { toast } from "sonner";
import {
	createMenuForAuthUser,
	getNavItemKey,
	type NavItem,
} from "@/components/layouts/side";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

export const SidebarPreferences = () => {
	const utils = api.useUtils();
	const { data: auth, isPending } = api.user.get.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { mutateAsync } = api.user.updateHiddenSidebarItems.useMutation();

	const { home, settings } = createMenuForAuthUser({
		auth,
		permissions,
		isCloud: !!isCloud,
	});
	const hidden = auth?.user?.hiddenSidebarItems ?? [];

	const setVisible = async (key: string, visible: boolean) => {
		const previous = utils.user.get.getData();
		const next = visible
			? hidden.filter((item) => item !== key)
			: [...hidden, key];

		utils.user.get.setData(undefined, (data) =>
			data
				? { ...data, user: { ...data.user, hiddenSidebarItems: next } }
				: data,
		);
		await mutateAsync({ hiddenSidebarItems: next })
			.catch((error) => {
				utils.user.get.setData(undefined, previous);
				toast.error(error?.message || "Error updating sidebar");
			})
			.finally(() => utils.user.get.invalidate());
	};

	const renderGroup = (title: string, items: NavItem[]) => (
		<div className="flex flex-col gap-2">
			<h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
			<div className="flex flex-col divide-y rounded-lg border">
				{items.map((item) => {
					const key = getNavItemKey(item);
					const Icon = item.icon;
					return (
						<label
							key={key}
							htmlFor={`sidebar-${key}`}
							className="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer"
						>
							<span className="flex items-center gap-2 text-sm">
								{Icon && <Icon className="size-4 text-muted-foreground" />}
								{item.title}
							</span>
							<Switch
								id={`sidebar-${key}`}
								checked={!hidden.includes(key)}
								onCheckedChange={(checked) => setVisible(key, checked)}
							/>
						</label>
					);
				})}
			</div>
		</div>
	);

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<PanelLeft className="size-6 text-muted-foreground self-center" />
							Sidebar
						</CardTitle>
						<CardDescription>
							Choose which items appear in your sidebar. Hidden pages are still
							reachable by URL.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-6 py-8 border-t">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : (
							<>
								{renderGroup("Home", home)}
								{renderGroup("Settings", settings)}
							</>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
