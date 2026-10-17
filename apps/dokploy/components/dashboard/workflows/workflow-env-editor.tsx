import { KeyRound, Loader2, Pencil, PlusIcon, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

type Kind = "secret" | "variable";

interface EditProps {
	workflowRepositoryId: string | null;
	existing?: { kind: Kind; name: string; value: string | null };
}

const EditEnvDialog = ({ workflowRepositoryId, existing }: EditProps) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<Kind>(existing?.kind ?? "secret");
	const [name, setName] = useState(existing?.name ?? "");
	const [value, setValue] = useState(existing?.value ?? "");
	const save = api.workflow.setEnv.useMutation();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					setKind(existing?.kind ?? "secret");
					setName(existing?.name ?? "");
					setValue(existing?.value ?? "");
				}
			}}
		>
			<DialogTrigger asChild>
				{existing ? (
					<Button variant="ghost" size="icon" title="Edit">
						<Pencil className="size-4" />
					</Button>
				) : (
					<Button variant="outline">
						<PlusIcon className="size-4" />
						Add
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{existing ? `Update ${existing.name}` : "Add secret or variable"}
					</DialogTitle>
					<DialogDescription>
						Secrets are encrypted and available as{" "}
						<code>{"${{ secrets.NAME }}"}</code>; their values are hidden after
						saving and masked in logs. Variables are available as{" "}
						<code>{"${{ vars.NAME }}"}</code>.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					{!existing && (
						<div className="grid grid-cols-2 gap-4">
							<div className="space-y-2">
								<Label>Type</Label>
								<Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="secret">Secret</SelectItem>
										<SelectItem value="variable">Variable</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="env-name">Name</Label>
								<Input
									id="env-name"
									placeholder="API_KEY"
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							</div>
						</div>
					)}
					<div className="space-y-2">
						<Label htmlFor="env-value">Value</Label>
						<Textarea
							id="env-value"
							className="font-mono"
							placeholder={
								existing?.kind === "secret" ? "Enter a new value" : undefined
							}
							value={value}
							onChange={(e) => setValue(e.target.value)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						disabled={!name || !value}
						isLoading={save.isPending}
						onClick={() =>
							save
								.mutateAsync({ workflowRepositoryId, kind, name, value })
								.then(() => {
									toast.success(`${name} saved`);
									setOpen(false);
									return utils.workflow.env.invalidate();
								})
								.catch((error) => toast.error(error.message))
						}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

interface Props {
	workflowRepositoryId: string | null;
}

export const WorkflowEnvEditor = ({ workflowRepositoryId }: Props) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: entries, isPending } = api.workflow.env.useQuery({
		workflowRepositoryId,
	});
	const remove = api.workflow.removeEnv.useMutation();
	const canEdit = !!permissions?.workflow.create;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">
					{workflowRepositoryId
						? "Only this repository's runs get these. They override organization values with the same name."
						: "Every repository's runs get these. Fork pull requests never receive secrets."}
				</p>
				{canEdit && (
					<EditEnvDialog workflowRepositoryId={workflowRepositoryId} />
				)}
			</div>
			{isPending ? (
				<div className="flex min-h-[10vh] items-center justify-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
				</div>
			) : !entries?.length ? (
				<div className="flex min-h-[10vh] flex-col items-center justify-center gap-2 text-center">
					<KeyRound className="size-6 text-muted-foreground" />
					<span className="text-sm text-muted-foreground">
						No secrets or variables yet.
					</span>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Type</TableHead>
							<TableHead>Value</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{entries.map((entry) => (
							<TableRow key={entry.workflowEnvId}>
								<TableCell className="font-mono">{entry.name}</TableCell>
								<TableCell>
									<Badge
										variant={entry.kind === "secret" ? "default" : "secondary"}
									>
										{entry.kind}
									</Badge>
								</TableCell>
								<TableCell className="max-w-xs truncate font-mono text-sm text-muted-foreground">
									{entry.kind === "secret" ? "••••••••" : entry.value}
								</TableCell>
								<TableCell>
									{canEdit && (
										<div className="flex justify-end gap-1">
											<EditEnvDialog
												workflowRepositoryId={workflowRepositoryId}
												existing={{
													kind: entry.kind,
													name: entry.name,
													value: entry.kind === "variable" ? entry.value : "",
												}}
											/>
											<DialogAction
												title={`Delete ${entry.name}`}
												description="Workflows that use it will see an empty value."
												type="destructive"
												onClick={() =>
													remove
														.mutateAsync({ workflowEnvId: entry.workflowEnvId })
														.then(() => utils.workflow.env.invalidate())
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
										</div>
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
