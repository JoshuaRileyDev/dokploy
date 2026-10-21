import {
	Check,
	Folder,
	FolderInput,
	FolderPlus,
	MoreHorizontal,
	Pencil,
	Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

export const ALL_FOLDERS = "all";
export const UNFILED = "unfiled";

export interface ServerFolder {
	folderId: string;
	name: string;
}

export const useServerFolders = () => {
	const { data, isPending } = api.serverFolder.all.useQuery();
	const folderByServer = useMemo(
		() =>
			new Map(
				(data?.items ?? []).map((item) => [item.serverId, item.folderId]),
			),
		[data?.items],
	);
	return { folders: data?.folders ?? [], folderByServer, isPending };
};

export const useMoveServersToFolder = () => {
	const utils = api.useUtils();
	return api.serverFolder.moveServers.useMutation({
		onSuccess: () => utils.serverFolder.all.invalidate(),
		onError: (error) => toast.error(error.message),
	});
};

export const FolderNameDialog = ({
	open,
	onOpenChange,
	folder,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	folder?: ServerFolder;
	onSaved?: (folder: ServerFolder) => void;
}) => {
	const utils = api.useUtils();
	const [name, setName] = useState("");
	const create = api.serverFolder.create.useMutation();
	const rename = api.serverFolder.rename.useMutation();
	const isPending = create.isPending || rename.isPending;

	useEffect(() => {
		if (open) setName(folder?.name ?? "");
	}, [open, folder?.name]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		try {
			const saved = folder
				? await rename.mutateAsync({ folderId: folder.folderId, name: trimmed })
				: await create.mutateAsync({ name: trimmed });
			await utils.serverFolder.all.invalidate();
			onSaved?.(saved);
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Couldn't save folder",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{folder ? "Rename folder" : "New folder"}</DialogTitle>
						<DialogDescription>
							Folders group servers on this page. They don't change how servers
							are deployed to.
						</DialogDescription>
					</DialogHeader>
					<Input
						autoFocus
						value={name}
						maxLength={64}
						placeholder="e.g. Production"
						onChange={(event) => setName(event.target.value)}
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" isLoading={isPending} disabled={!name.trim()}>
							{folder ? "Save" : "Create folder"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};

const FolderChip = ({
	label,
	count,
	active,
	onClick,
	icon = false,
	menu,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
	icon?: boolean;
	menu?: React.ReactNode;
}) => (
	<div
		className={cn(
			"group/chip flex h-8 shrink-0 items-center rounded-md border text-sm transition-colors",
			active
				? "border-primary bg-primary text-primary-foreground"
				: "bg-background hover:bg-muted",
		)}
	>
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"flex h-full items-center gap-1.5 rounded-md px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				menu && "pr-1",
			)}
		>
			{icon && <Folder className="size-3.5 opacity-70" />}
			<span className="max-w-40 truncate">{label}</span>
			<span
				className={cn(
					"tabular-nums text-xs",
					active ? "text-primary-foreground/70" : "text-muted-foreground",
				)}
			>
				{count}
			</span>
		</button>
		{menu}
	</div>
);

export const ServerFolderBar = ({
	folders,
	counts,
	selected,
	onSelect,
	canManage,
}: {
	folders: ServerFolder[];
	counts: { all: number; unfiled: number; byFolder: Map<string, number> };
	selected: string;
	onSelect: (folder: string) => void;
	canManage: boolean;
}) => {
	const utils = api.useUtils();
	const [dialog, setDialog] = useState<
		{ mode: "create" } | { mode: "rename"; folder: ServerFolder } | null
	>(null);
	const remove = api.serverFolder.remove.useMutation({
		onSuccess: async (_, { folderId }) => {
			await utils.serverFolder.all.invalidate();
			if (selected === folderId) onSelect(ALL_FOLDERS);
			toast.success("Folder deleted");
		},
		onError: (error) => toast.error(error.message),
	});

	return (
		<>
			<div className="flex items-center gap-1.5 overflow-x-auto pb-1">
				<FolderChip
					label="All servers"
					count={counts.all}
					active={selected === ALL_FOLDERS}
					onClick={() => onSelect(ALL_FOLDERS)}
				/>
				{folders.map((folder) => (
					<FolderChip
						key={folder.folderId}
						icon
						label={folder.name}
						count={counts.byFolder.get(folder.folderId) ?? 0}
						active={selected === folder.folderId}
						onClick={() => onSelect(folder.folderId)}
						menu={
							canManage && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											className="mr-1 rounded p-0.5 opacity-60 hover:opacity-100 focus-visible:opacity-100"
											aria-label={`${folder.name} folder options`}
										>
											<MoreHorizontal className="size-3.5" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start">
										<DropdownMenuItem
											onSelect={() => setDialog({ mode: "rename", folder })}
										>
											<Pencil className="size-4" />
											Rename
										</DropdownMenuItem>
										<DialogAction
											title={`Delete "${folder.name}"?`}
											description="The servers in it stay where they are and become unfiled."
											onClick={() =>
												remove.mutate({ folderId: folder.folderId })
											}
										>
											<DropdownMenuItem
												className="text-destructive focus:text-destructive"
												onSelect={(event) => event.preventDefault()}
											>
												<Trash2 className="size-4" />
												Delete folder
											</DropdownMenuItem>
										</DialogAction>
									</DropdownMenuContent>
								</DropdownMenu>
							)
						}
					/>
				))}
				{folders.length > 0 && counts.unfiled > 0 && (
					<FolderChip
						label="Unfiled"
						count={counts.unfiled}
						active={selected === UNFILED}
						onClick={() => onSelect(UNFILED)}
					/>
				)}
				{canManage && (
					<Button
						variant="ghost"
						size="sm"
						className="h-8 shrink-0 text-muted-foreground"
						onClick={() => setDialog({ mode: "create" })}
					>
						<FolderPlus className="size-4" />
						New folder
					</Button>
				)}
			</div>
			<FolderNameDialog
				open={dialog !== null}
				onOpenChange={(open) => !open && setDialog(null)}
				folder={dialog?.mode === "rename" ? dialog.folder : undefined}
				onSaved={(folder) => {
					if (dialog?.mode === "create") onSelect(folder.folderId);
				}}
			/>
		</>
	);
};

export const MoveToFolderMenu = ({
	serverIds,
	folders,
	currentFolderId,
	onNewFolder,
}: {
	serverIds: string[];
	folders: ServerFolder[];
	currentFolderId: string | null;
	onNewFolder: () => void;
}) => {
	const move = useMoveServersToFolder();
	const moveTo = (folderId: string | null, name: string) =>
		move.mutate(
			{ serverIds, folderId },
			{
				onSuccess: () =>
					toast.success(
						folderId
							? `Moved to ${name}`
							: serverIds.length > 1
								? "Servers removed from folder"
								: "Removed from folder",
					),
			},
		);

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<FolderInput className="size-4" />
				Move to folder
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-72 overflow-y-auto">
				{folders.map((folder) => (
					<DropdownMenuItem
						key={folder.folderId}
						onSelect={() => moveTo(folder.folderId, folder.name)}
					>
						<Folder className="size-4" />
						<span className="truncate">{folder.name}</span>
						{currentFolderId === folder.folderId && (
							<Check className="ml-auto size-4" />
						)}
					</DropdownMenuItem>
				))}
				{currentFolderId && (
					<DropdownMenuItem onSelect={() => moveTo(null, "")}>
						Remove from folder
					</DropdownMenuItem>
				)}
				{folders.length > 0 && <DropdownMenuSeparator />}
				<DropdownMenuItem onSelect={onNewFolder}>
					<FolderPlus className="size-4" />
					New folder…
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
};
