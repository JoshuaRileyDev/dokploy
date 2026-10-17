import { Bell, Loader2, PlusIcon, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

const ALL_REPOSITORIES = "all";

const AddNotificationRule = () => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [notificationId, setNotificationId] = useState("");
	const [repositoryId, setRepositoryId] = useState(ALL_REPOSITORIES);
	const [branches, setBranches] = useState("");
	const [onFailure, setOnFailure] = useState(true);
	const [onSuccess, setOnSuccess] = useState(false);
	const { data: channels } = api.workflow.notificationChannels.useQuery(
		undefined,
		{ enabled: open },
	);
	const { data: repositories } = api.workflow.allRepositories.useQuery(
		undefined,
		{ enabled: open },
	);
	const create = api.workflow.createNotificationRule.useMutation();

	const submit = () =>
		create
			.mutateAsync({
				notificationId,
				workflowRepositoryId:
					repositoryId === ALL_REPOSITORIES ? null : repositoryId,
				branches: branches
					.split(",")
					.map((branch) => branch.trim())
					.filter(Boolean),
				onFailure,
				onSuccess,
			})
			.then(() => {
				toast.success("Notification added");
				setOpen(false);
				setNotificationId("");
				setBranches("");
				return utils.workflow.notificationRules.invalidate();
			})
			.catch((error) => toast.error(error.message));

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<PlusIcon className="size-4" />
					Add Notification
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Workflow notification</DialogTitle>
					<DialogDescription>
						Send workflow results to one of your notification channels. Use a
						Custom (webhook) channel to POST a JSON payload to any URL.
					</DialogDescription>
				</DialogHeader>
				{channels?.length === 0 && (
					<AlertBlock type="info">
						Create a channel first in{" "}
						<Link
							href="/dashboard/settings/notifications"
							className="underline"
						>
							Notifications
						</Link>
						.
					</AlertBlock>
				)}
				<div className="grid gap-4">
					<div className="space-y-2">
						<Label>Channel</Label>
						<Select value={notificationId} onValueChange={setNotificationId}>
							<SelectTrigger>
								<SelectValue placeholder="Select a channel" />
							</SelectTrigger>
							<SelectContent>
								{channels?.map((channel) => (
									<SelectItem
										key={channel.notificationId}
										value={channel.notificationId}
									>
										{channel.name} ({channel.notificationType})
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2">
						<Label>Repository</Label>
						<Select value={repositoryId} onValueChange={setRepositoryId}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_REPOSITORIES}>
									All repositories
								</SelectItem>
								{repositories?.map((repository) => (
									<SelectItem
										key={repository.workflowRepositoryId}
										value={repository.workflowRepositoryId}
									>
										{repository.owner}/{repository.repository}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2">
						<Label htmlFor="notification-branches">Branches</Label>
						<Input
							id="notification-branches"
							placeholder="main, release/**"
							value={branches}
							onChange={(e) => setBranches(e.target.value)}
						/>
						<p className="text-sm text-muted-foreground">
							Comma-separated GitHub branch patterns. Leave empty for every
							branch.
						</p>
					</div>
					<div className="flex items-center justify-between rounded-lg border p-3">
						<Label htmlFor="notify-failure">When a run fails</Label>
						<Switch
							id="notify-failure"
							checked={onFailure}
							onCheckedChange={setOnFailure}
						/>
					</div>
					<div className="flex items-center justify-between rounded-lg border p-3">
						<Label htmlFor="notify-success">When a run succeeds</Label>
						<Switch
							id="notify-success"
							checked={onSuccess}
							onCheckedChange={setOnSuccess}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						onClick={submit}
						disabled={!notificationId}
						isLoading={create.isPending}
					>
						Add
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const ShowWorkflowNotifications = () => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: rules, isPending } = api.workflow.notificationRules.useQuery();
	const remove = api.workflow.removeNotificationRule.useMutation();
	const canEdit = !!permissions?.workflow.create;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">
					Choose which notification channels hear about workflow failures and
					successes.
				</p>
				{canEdit && <AddNotificationRule />}
			</div>
			{isPending ? (
				<div className="flex min-h-[20vh] items-center justify-center gap-2 text-sm text-muted-foreground">
					<span>Loading...</span>
					<Loader2 className="size-4 animate-spin" />
				</div>
			) : !rules?.length ? (
				<div className="flex min-h-[20vh] flex-col items-center justify-center gap-2 text-center">
					<Bell className="size-8 text-muted-foreground" />
					<span className="text-base text-muted-foreground">
						No workflow notifications yet.
					</span>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Channel</TableHead>
							<TableHead>Repository</TableHead>
							<TableHead>Branches</TableHead>
							<TableHead>Sends on</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{rules.map((rule) => (
							<TableRow key={rule.workflowNotificationId}>
								<TableCell>
									{rule.notification.name}{" "}
									<span className="text-muted-foreground">
										({rule.notification.notificationType})
									</span>
								</TableCell>
								<TableCell>
									{rule.repository
										? `${rule.repository.owner}/${rule.repository.repository}`
										: "All repositories"}
								</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{rule.branches.length
										? rule.branches.join(", ")
										: "All branches"}
								</TableCell>
								<TableCell>
									<div className="flex gap-1">
										{rule.onFailure && (
											<Badge variant="destructive">Failure</Badge>
										)}
										{rule.onSuccess && (
											<Badge variant="secondary">Success</Badge>
										)}
									</div>
								</TableCell>
								<TableCell className="text-right">
									{canEdit && (
										<DialogAction
											title="Remove notification"
											description="Stop sending workflow results to this channel?"
											type="destructive"
											onClick={() =>
												remove
													.mutateAsync({
														workflowNotificationId: rule.workflowNotificationId,
													})
													.then(() =>
														utils.workflow.notificationRules.invalidate(),
													)
													.catch((error) => toast.error(error.message))
											}
										>
											<Button
												variant="ghost"
												size="icon"
												className="text-destructive hover:text-destructive"
											>
												<Trash2 className="size-4" />
											</Button>
										</DialogAction>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
};
