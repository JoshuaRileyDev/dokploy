import { formatDistanceToNow } from "date-fns";
import { Cloud, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { HandleCloudProvider } from "./handle-cloud-provider";

export const ShowCloudProviders = () => {
	const [removingId, setRemovingId] = useState<string | null>(null);
	const { mutateAsync } = api.cloudProvider.remove.useMutation();
	const { data, isPending, refetch } = api.cloudProvider.all.useQuery();
	const { data: providers } = api.cloudProvider.providers.useQuery();
	const labelFor = (type: string) =>
		providers?.find((p) => p.type === type)?.label ?? type;
	const { data: permissions } = api.user.getPermissions.useQuery();

	return (
		<div className="w-full max-w-5xl mx-auto">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl">
				<div className="rounded-xl bg-background shadow-md">
					<div className="flex flex-wrap items-center justify-between gap-4 p-6">
						<CardHeader className="flex-1 p-0">
							<CardTitle className="text-xl flex flex-row gap-2">
								<Cloud className="size-6 text-muted-foreground self-center" />
								Cloud Providers
							</CardTitle>
							<CardDescription>
								Connect a cloud provider account to create ready-to-deploy
								servers from the Servers page.
							</CardDescription>
						</CardHeader>
						{permissions?.server.create && <HandleCloudProvider />}
					</div>

					<CardContent className="flex min-h-[60vh] flex-col gap-4 border-t py-8">
						{isPending ? (
							<div className="flex flex-1 flex-row items-center justify-center gap-2 text-sm text-muted-foreground">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : data?.length === 0 ? (
							<div className="flex min-h-[50vh] flex-col items-center justify-center gap-3">
								<Cloud className="size-8 text-muted-foreground" />
								<span className="font-medium text-muted-foreground">
									No cloud providers connected
								</span>
								<span className="max-w-sm text-center text-sm text-muted-foreground">
									Connect an account and Dokploy will create, set up and
									register new servers for you in about two minutes.
								</span>
							</div>
						) : (
							<ul className="flex flex-col gap-2">
								{data?.map((account) => (
									<li
										key={account.cloudProviderAccountId}
										className="flex items-center gap-3 rounded-lg border bg-background px-4 py-3 transition-colors duration-150 ease-out hover:border-foreground/20 hover:bg-muted/50"
									>
										<CloudProviderIcon
											providerType={account.providerType}
											className="size-7 shrink-0"
										/>
										<div className="flex min-w-0 flex-col gap-0.5">
											<span className="truncate text-sm font-medium">
												{account.name}
											</span>
											<span className="text-xs text-muted-foreground">
												{labelFor(account.providerType)} · added{" "}
												{formatDistanceToNow(new Date(account.createdAt), {
													addSuffix: true,
												})}
											</span>
										</div>

										<div className="ml-auto flex flex-row items-center gap-1">
											{permissions?.server.create && (
												<HandleCloudProvider
													cloudProviderAccountId={
														account.cloudProviderAccountId
													}
												/>
											)}
											{permissions?.server.delete && (
												<Tooltip>
													<DialogAction
														title="Disconnect cloud provider"
														description={`Servers already created stay in ${labelFor(account.providerType)} and in Dokploy, but Dokploy will no longer be able to delete them for you. Continue?`}
														type="destructive"
														onClick={async () => {
															setRemovingId(account.cloudProviderAccountId);
															await mutateAsync({
																cloudProviderAccountId:
																	account.cloudProviderAccountId,
															})
																.then(() => {
																	toast.success("Account disconnected");
																	refetch();
																})
																.catch(() => {
																	toast.error(
																		"Error disconnecting the account",
																	);
																})
																.finally(() => setRemovingId(null));
														}}
													>
														<TooltipTrigger asChild>
															<Button
																variant="ghost"
																size="icon"
																className="text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
																isLoading={
																	removingId === account.cloudProviderAccountId
																}
															>
																<Trash2 className="size-4" />
																<span className="sr-only">Disconnect</span>
															</Button>
														</TooltipTrigger>
													</DialogAction>
													<TooltipContent>Disconnect</TooltipContent>
												</Tooltip>
											)}
										</div>
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
