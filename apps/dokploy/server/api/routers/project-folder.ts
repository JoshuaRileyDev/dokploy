import { findMemberByUserId } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db";
import {
	apiCreateProjectFolder,
	apiMoveProjectFolder,
	apiMoveProjectsToFolder,
	apiRemoveProjectFolder,
	apiRenameProjectFolder,
	projectFolderItems,
	projectFolders,
	projects,
} from "@/server/db/schema";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

const findFolderInOrg = async (folderId: string, organizationId: string) => {
	const folder = await db.query.projectFolders.findFirst({
		where: and(
			eq(projectFolders.folderId, folderId),
			eq(projectFolders.organizationId, organizationId),
		),
	});
	if (!folder) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
	}
	return folder;
};

export const projectFolderRouter = createTRPCRouter({
	all: protectedProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const folders = await db.query.projectFolders.findMany({
			where: eq(projectFolders.organizationId, organizationId),
			columns: { folderId: true, name: true, parentFolderId: true },
			orderBy: (folders, { asc }) => [asc(folders.name)],
		});
		if (folders.length === 0) {
			return { folders, items: [] };
		}

		let items = await db.query.projectFolderItems.findMany({
			where: inArray(
				projectFolderItems.folderId,
				folders.map((f) => f.folderId),
			),
		});

		if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
			const { accessedProjects } = await findMemberByUserId(
				ctx.user.id,
				organizationId,
			);
			items = items.filter((item) => accessedProjects.includes(item.projectId));
		}

		return { folders, items };
	}),

	create: withPermission("project", "create")
		.input(apiCreateProjectFolder)
		.mutation(async ({ input, ctx }) => {
			const organizationId = ctx.session.activeOrganizationId;
			if (input.parentFolderId) {
				await findFolderInOrg(input.parentFolderId, organizationId);
			}
			const [folder] = await db
				.insert(projectFolders)
				.values({
					name: input.name,
					parentFolderId: input.parentFolderId,
					organizationId,
				})
				.returning();
			return folder;
		}),

	rename: withPermission("project", "create")
		.input(apiRenameProjectFolder)
		.mutation(async ({ input, ctx }) => {
			await findFolderInOrg(input.folderId, ctx.session.activeOrganizationId);
			const [folder] = await db
				.update(projectFolders)
				.set({ name: input.name })
				.where(eq(projectFolders.folderId, input.folderId))
				.returning();
			return folder;
		}),

	move: withPermission("project", "create")
		.input(apiMoveProjectFolder)
		.mutation(async ({ input, ctx }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await findFolderInOrg(input.folderId, organizationId);

			if (input.parentFolderId) {
				const all = await db.query.projectFolders.findMany({
					where: eq(projectFolders.organizationId, organizationId),
					columns: { folderId: true, parentFolderId: true },
				});
				const parentOf = new Map(
					all.map((f) => [f.folderId, f.parentFolderId]),
				);
				if (!parentOf.has(input.parentFolderId)) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Destination folder not found",
					});
				}
				let cursor: string | null | undefined = input.parentFolderId;
				while (cursor) {
					if (cursor === input.folderId) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "A folder can't be moved into itself",
						});
					}
					cursor = parentOf.get(cursor);
				}
			}

			const [folder] = await db
				.update(projectFolders)
				.set({ parentFolderId: input.parentFolderId })
				.where(eq(projectFolders.folderId, input.folderId))
				.returning();
			return folder;
		}),

	// Deleting a folder never deletes projects: its contents move up to the parent.
	remove: withPermission("project", "create")
		.input(apiRemoveProjectFolder)
		.mutation(async ({ input, ctx }) => {
			const folder = await findFolderInOrg(
				input.folderId,
				ctx.session.activeOrganizationId,
			);
			await db.transaction(async (tx) => {
				await tx
					.update(projectFolders)
					.set({ parentFolderId: folder.parentFolderId })
					.where(eq(projectFolders.parentFolderId, folder.folderId));
				if (folder.parentFolderId) {
					await tx
						.update(projectFolderItems)
						.set({ folderId: folder.parentFolderId })
						.where(eq(projectFolderItems.folderId, folder.folderId));
				}
				await tx
					.delete(projectFolders)
					.where(eq(projectFolders.folderId, folder.folderId));
			});
			return folder;
		}),

	moveProjects: withPermission("project", "create")
		.input(apiMoveProjectsToFolder)
		.mutation(async ({ input, ctx }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const owned = await db.query.projects.findMany({
				where: and(
					inArray(projects.projectId, input.projectIds),
					eq(projects.organizationId, organizationId),
				),
				columns: { projectId: true },
			});
			if (owned.length !== input.projectIds.length) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Project not found",
				});
			}

			if (input.folderId === null) {
				await db
					.delete(projectFolderItems)
					.where(inArray(projectFolderItems.projectId, input.projectIds));
				return true;
			}

			await findFolderInOrg(input.folderId, organizationId);
			const folderId = input.folderId;
			await db
				.insert(projectFolderItems)
				.values(input.projectIds.map((projectId) => ({ projectId, folderId })))
				.onConflictDoUpdate({
					target: projectFolderItems.projectId,
					set: { folderId },
				});
			return true;
		}),
});
