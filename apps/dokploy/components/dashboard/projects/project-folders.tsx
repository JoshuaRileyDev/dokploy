import {
	ChevronRight,
	Folder,
	FolderInput,
	FolderPlus,
	Home,
	MoreHorizontalIcon,
	SquarePen,
	TrashIcon,
} from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";

export type ProjectFolder =
	RouterOutputs["projectFolder"]["all"]["folders"][number];

const PROJECT_DRAG_TYPE = "application/x-dokploy-project";
const FOLDER_DRAG_TYPE = "application/x-dokploy-folder";

export const setProjectDragData = (e: DragEvent, projectId: string) => {
	e.dataTransfer.setData(PROJECT_DRAG_TYPE, projectId);
	e.dataTransfer.effectAllowed = "move";
};

export const getFolderPath = (
	folders: ProjectFolder[],
	folderId: string | null,
) => {
	const byId = new Map(folders.map((f) => [f.folderId, f]));
	const path: ProjectFolder[] = [];
	let cursor = folderId ? byId.get(folderId) : undefined;
	while (cursor && !path.includes(cursor)) {
		path.unshift(cursor);
		cursor = cursor.parentFolderId
			? byId.get(cursor.parentFolderId)
			: undefined;
	}
	return path;
};

const isDescendant = (
	folders: ProjectFolder[],
	folderId: string,
	ancestorId: string,
) => getFolderPath(folders, folderId).some((f) => f.folderId === ancestorId);

const useFolderMutations = () => {
	const utils = api.useUtils();
	const moveProjects = api.projectFolder.moveProjects.useMutation();
	const moveFolder = api.projectFolder.move.useMutation();

	return {
		moveProject: async (projectId: string, folderId: string | null) => {
			await moveProjects
				.mutateAsync({ projectIds: [projectId], folderId })
				.then(() => toast.success("Project moved"))
				.catch((e) => toast.error(e.message || "Error moving project"));
			await utils.projectFolder.all.invalidate();
		},
		moveFolder: async (folderId: string, parentFolderId: string | null) => {
			await moveFolder
				.mutateAsync({ folderId, parentFolderId })
				.then(() => toast.success("Folder moved"))
				.catch((e) => toast.error(e.message || "Error moving folder"));
			await utils.projectFolder.all.invalidate();
		},
	};
};

/**
 * Accepts dropped projects and folders. `targetFolderId` null is the root.
 */
const useDropTarget = (
	folders: ProjectFolder[],
	targetFolderId: string | null,
	enabled: boolean,
) => {
	const [isOver, setIsOver] = useState(false);
	const { moveProject, moveFolder } = useFolderMutations();

	const accepts = (e: DragEvent) =>
		enabled &&
		(e.dataTransfer.types.includes(PROJECT_DRAG_TYPE) ||
			e.dataTransfer.types.includes(FOLDER_DRAG_TYPE));

	return {
		isOver,
		handlers: {
			onDragOver: (e: DragEvent) => {
				if (!accepts(e)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setIsOver(true);
			},
			onDragLeave: () => setIsOver(false),
			onDrop: async (e: DragEvent) => {
				setIsOver(false);
				if (!accepts(e)) return;
				e.preventDefault();
				const projectId = e.dataTransfer.getData(PROJECT_DRAG_TYPE);
				const folderId = e.dataTransfer.getData(FOLDER_DRAG_TYPE);
				if (projectId) {
					await moveProject(projectId, targetFolderId);
				} else if (folderId && folderId !== targetFolderId) {
					if (
						targetFolderId &&
						isDescendant(folders, targetFolderId, folderId)
					) {
						toast.error("A folder can't be moved into itself");
						return;
					}
					await moveFolder(folderId, targetFolderId);
				}
			},
		},
	};
};

interface FolderBreadcrumbsProps {
	folders: ProjectFolder[];
	currentFolderId: string | null;
	onNavigate: (folderId: string | null) => void;
	canManage: boolean;
}

export const FolderBreadcrumbs = ({
	folders,
	currentFolderId,
	onNavigate,
	canManage,
}: FolderBreadcrumbsProps) => {
	const path = getFolderPath(folders, currentFolderId);

	return (
		<nav className="flex flex-wrap items-center gap-1 text-sm">
			<BreadcrumbDropTarget
				folders={folders}
				folderId={null}
				isCurrent={currentFolderId === null}
				onNavigate={onNavigate}
				canManage={canManage}
			>
				<Home className="size-4" />
				All projects
			</BreadcrumbDropTarget>
			{path.map((folder) => (
				<span key={folder.folderId} className="flex items-center gap-1">
					<ChevronRight className="size-4 text-muted-foreground" />
					<BreadcrumbDropTarget
						folders={folders}
						folderId={folder.folderId}
						isCurrent={folder.folderId === currentFolderId}
						onNavigate={onNavigate}
						canManage={canManage}
					>
						<Folder className="size-4" />
						{folder.name}
					</BreadcrumbDropTarget>
				</span>
			))}
		</nav>
	);
};

const BreadcrumbDropTarget = ({
	folders,
	folderId,
	isCurrent,
	onNavigate,
	canManage,
	children,
}: {
	folders: ProjectFolder[];
	folderId: string | null;
	isCurrent: boolean;
	onNavigate: (folderId: string | null) => void;
	canManage: boolean;
	children: ReactNode;
}) => {
	const { isOver, handlers } = useDropTarget(
		folders,
		folderId,
		canManage && !isCurrent,
	);
	return (
		<button
			type="button"
			{...handlers}
			onClick={() => onNavigate(folderId)}
			className={cn(
				"flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors",
				isCurrent
					? "font-medium text-foreground"
					: "text-muted-foreground hover:bg-muted hover:text-foreground",
				isOver && "bg-primary/10 text-foreground ring-2 ring-primary",
			)}
		>
			{children}
		</button>
	);
};

interface FolderCardProps {
	folder: ProjectFolder;
	folders: ProjectFolder[];
	projectCount: number;
	subfolderCount: number;
	onOpen: () => void;
	canManage: boolean;
}

export const FolderCard = ({
	folder,
	folders,
	projectCount,
	subfolderCount,
	onOpen,
	canManage,
}: FolderCardProps) => {
	const { isOver, handlers } = useDropTarget(
		folders,
		folder.folderId,
		canManage,
	);

	const summary = [
		subfolderCount > 0 &&
			`${subfolderCount} ${subfolderCount === 1 ? "folder" : "folders"}`,
		`${projectCount} ${projectCount === 1 ? "project" : "projects"}`,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<div
			className="w-full lg:max-w-md"
			draggable={canManage}
			onDragStart={(e) => {
				e.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.folderId);
				e.dataTransfer.effectAllowed = "move";
			}}
			{...handlers}
		>
			<Card
				role="button"
				tabIndex={0}
				onClick={onOpen}
				onKeyDown={(e) => {
					if (e.key === "Enter") onOpen();
				}}
				className={cn(
					"group flex w-full cursor-pointer flex-row items-center gap-3 bg-transparent p-4 transition-colors hover:bg-border",
					isOver && "border-primary bg-primary/10 ring-2 ring-primary",
				)}
			>
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
					<Folder className="size-5 text-muted-foreground" />
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-base font-medium leading-none">
						{folder.name}
					</span>
					<span className="text-xs text-muted-foreground">{summary}</span>
				</div>
				{canManage && <FolderActions folder={folder} folders={folders} />}
			</Card>
		</div>
	);
};

const FolderActions = ({
	folder,
	folders,
}: {
	folder: ProjectFolder;
	folders: ProjectFolder[];
}) => {
	const utils = api.useUtils();
	const { mutateAsync: removeFolder } = api.projectFolder.remove.useMutation();
	const [renameOpen, setRenameOpen] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);
	const { moveFolder } = useFolderMutations();

	return (
		<div onClick={(e) => e.stopPropagation()} onKeyDown={() => {}}>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="px-2">
						<MoreHorizontalIcon className="size-5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent className="w-[200px]">
					<DropdownMenuItem
						className="cursor-pointer space-x-3"
						onSelect={() => setRenameOpen(true)}
					>
						<SquarePen className="size-4" />
						<span>Rename</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						className="cursor-pointer space-x-3"
						onSelect={() => setMoveOpen(true)}
					>
						<FolderInput className="size-4" />
						<span>Move to folder</span>
					</DropdownMenuItem>
					<AlertDialog>
						<AlertDialogTrigger className="w-full">
							<DropdownMenuItem
								className="w-full cursor-pointer space-x-3"
								onSelect={(e) => e.preventDefault()}
							>
								<TrashIcon className="size-4" />
								<span>Delete</span>
							</DropdownMenuItem>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Delete "{folder.name}"?</AlertDialogTitle>
								<AlertDialogDescription>
									Projects and folders inside it are not deleted. They move up
									one level.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									onClick={async () => {
										await removeFolder({ folderId: folder.folderId })
											.then(() => toast.success("Folder deleted"))
											.catch(() => toast.error("Error deleting folder"));
										await utils.projectFolder.all.invalidate();
									}}
								>
									Delete
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</DropdownMenuContent>
			</DropdownMenu>
			<HandleFolder
				folder={folder}
				open={renameOpen}
				onOpenChange={setRenameOpen}
			/>
			<MoveToFolderDialog
				title={`Move "${folder.name}"`}
				folders={folders.filter(
					(f) => !isDescendant(folders, f.folderId, folder.folderId),
				)}
				currentFolderId={folder.parentFolderId}
				open={moveOpen}
				onOpenChange={setMoveOpen}
				onMove={(target) => moveFolder(folder.folderId, target)}
			/>
		</div>
	);
};

interface HandleFolderProps {
	folder?: ProjectFolder;
	parentFolderId?: string | null;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export const HandleFolder = ({
	folder,
	parentFolderId = null,
	open,
	onOpenChange,
}: HandleFolderProps) => {
	const utils = api.useUtils();
	const [internalOpen, setInternalOpen] = useState(false);
	const isOpen = open ?? internalOpen;
	const setIsOpen = onOpenChange ?? setInternalOpen;
	const [name, setName] = useState(folder?.name ?? "");
	const create = api.projectFolder.create.useMutation();
	const rename = api.projectFolder.rename.useMutation();
	const isPending = create.isPending || rename.isPending;

	useEffect(() => {
		if (isOpen) setName(folder?.name ?? "");
	}, [isOpen, folder?.name]);

	const onSubmit = async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		const request = folder
			? rename.mutateAsync({ folderId: folder.folderId, name: trimmed })
			: create.mutateAsync({ name: trimmed, parentFolderId });
		await request
			.then(() => {
				toast.success(folder ? "Folder renamed" : "Folder created");
				setIsOpen(false);
			})
			.catch((e) => toast.error(e.message || "Error saving folder"));
		await utils.projectFolder.all.invalidate();
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{!folder && (
				<DialogTrigger asChild>
					<Button variant="outline">
						<FolderPlus className="h-4 w-4" />
						New Folder
					</Button>
				</DialogTrigger>
			)}
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{folder ? "Rename folder" : "New folder"}</DialogTitle>
					<DialogDescription>
						Folders group projects in the projects list. They don't change how
						projects are deployed.
					</DialogDescription>
				</DialogHeader>
				<form
					id="hook-form-project-folder"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmit();
					}}
				>
					<Input
						autoFocus
						placeholder="Client work"
						value={name}
						maxLength={100}
						onChange={(e) => setName(e.target.value)}
					/>
				</form>
				<DialogFooter>
					<Button
						isLoading={isPending}
						disabled={!name.trim()}
						form="hook-form-project-folder"
						type="submit"
					>
						{folder ? "Rename" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

interface MoveToFolderDialogProps {
	title: string;
	folders: ProjectFolder[];
	currentFolderId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onMove: (folderId: string | null) => Promise<void>;
}

export const MoveToFolderDialog = ({
	title,
	folders,
	currentFolderId,
	open,
	onOpenChange,
	onMove,
}: MoveToFolderDialogProps) => {
	const [selected, setSelected] = useState<string | null>(currentFolderId);
	const [isPending, setIsPending] = useState(false);

	useEffect(() => {
		if (open) setSelected(currentFolderId);
	}, [open, currentFolderId]);

	const options = folders
		.map((folder) => ({
			folderId: folder.folderId,
			path: getFolderPath(folders, folder.folderId),
		}))
		.sort((a, b) =>
			a.path
				.map((f) => f.name)
				.join("/")
				.localeCompare(b.path.map((f) => f.name).join("/")),
		);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>Choose a destination folder.</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
					<FolderOption
						isSelected={selected === null}
						onSelect={() => setSelected(null)}
						depth={0}
					>
						<Home className="size-4" />
						All projects
					</FolderOption>
					{options.map(({ folderId, path }) => (
						<FolderOption
							key={folderId}
							isSelected={selected === folderId}
							onSelect={() => setSelected(folderId)}
							depth={path.length}
						>
							<Folder className="size-4" />
							{path[path.length - 1]?.name}
						</FolderOption>
					))}
				</div>
				<DialogFooter>
					<Button
						isLoading={isPending}
						disabled={selected === currentFolderId}
						onClick={async () => {
							setIsPending(true);
							await onMove(selected);
							setIsPending(false);
							onOpenChange(false);
						}}
					>
						Move
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const FolderOption = ({
	isSelected,
	onSelect,
	depth,
	children,
}: {
	isSelected: boolean;
	onSelect: () => void;
	depth: number;
	children: ReactNode;
}) => (
	<button
		type="button"
		onClick={onSelect}
		style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
		className={cn(
			"flex items-center gap-2 rounded-md py-2 pr-3 text-left text-sm transition-colors",
			isSelected
				? "bg-primary/10 font-medium text-foreground"
				: "hover:bg-muted",
		)}
	>
		{children}
	</button>
);

export const MoveProjectMenuItem = ({ onSelect }: { onSelect: () => void }) => (
	<DropdownMenuItem
		className="w-full cursor-pointer space-x-3"
		onSelect={onSelect}
	>
		<FolderInput className="size-4" />
		<span>Move to folder</span>
	</DropdownMenuItem>
);

export const MoveProjectDialog = ({
	project,
	folders,
	currentFolderId,
	onClose,
}: {
	project: { projectId: string; name: string } | null;
	folders: ProjectFolder[];
	currentFolderId: string | null;
	onClose: () => void;
}) => {
	const { moveProject } = useFolderMutations();

	return (
		<MoveToFolderDialog
			title={`Move "${project?.name ?? ""}"`}
			folders={folders}
			currentFolderId={currentFolderId}
			open={!!project}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			onMove={async (target) => {
				if (project) await moveProject(project.projectId, target);
			}}
		/>
	);
};
