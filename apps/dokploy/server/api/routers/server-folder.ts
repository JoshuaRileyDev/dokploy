import { getAccessibleServerIds } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { audit } from "@/server/api/utils/audit";
import { db } from "@/server/db";
import {
	apiCreateServerFolder,
	apiMoveServersToFolder,
	apiRemoveServerFolder,
	apiRenameServerFolder,
	serverFolderItems,
	serverFolders,
} from "@/server/db/schema";
import { createTRPCRouter, withPermission } from "../trpc";

const findFolderInOrg = async (folderId: string, organizationId: string) => {
	const folder = await db.query.serverFolders.findFirst({
		where: and(
			eq(serverFolders.folderId, folderId),
			eq(serverFolders.organizationId, organizationId),
		),
	});
	if (!folder) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
	}
	return folder;
};

const isUniqueViolation = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	(error as { code?: string }).code === "23505";

const rethrowDuplicateName = (error: unknown): never => {
	if (isUniqueViolation(error) || isUniqueViolation((error as Error)?.cause)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "A folder with that name already exists",
		});
	}
	throw error;
};

export const serverFolderRouter = createTRPCRouter({
	all: withPermission("server", "read").query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const folders = await db.query.serverFolders.findMany({
			where: eq(serverFolders.organizationId, organizationId),
			columns: { folderId: true, name: true },
			orderBy: (folders, { asc }) => [asc(folders.name)],
		});
		if (folders.length === 0) {
			return { folders, items: [] };
		}

		const [items, accessibleIds] = await Promise.all([
			db.query.serverFolderItems.findMany({
				where: inArray(
					serverFolderItems.folderId,
					folders.map((f) => f.folderId),
				),
			}),
			getAccessibleServerIds(ctx.session),
		]);

		return {
			folders,
			items: items.filter((item) => accessibleIds.has(item.serverId)),
		};
	}),

	create: withPermission("server", "create")
		.input(apiCreateServerFolder)
		.mutation(async ({ input, ctx }) => {
			const [folder] = await db
				.insert(serverFolders)
				.values({
					name: input.name,
					organizationId: ctx.session.activeOrganizationId,
				})
				.returning()
				.catch(rethrowDuplicateName);
			await audit(ctx, {
				action: "create",
				resourceType: "server",
				resourceId: folder!.folderId,
				resourceName: `Folder ${folder!.name}`,
			});
			return folder!;
		}),

	rename: withPermission("server", "create")
		.input(apiRenameServerFolder)
		.mutation(async ({ input, ctx }) => {
			await findFolderInOrg(input.folderId, ctx.session.activeOrganizationId);
			const [folder] = await db
				.update(serverFolders)
				.set({ name: input.name })
				.where(eq(serverFolders.folderId, input.folderId))
				.returning()
				.catch(rethrowDuplicateName);
			return folder!;
		}),

	remove: withPermission("server", "create")
		.input(apiRemoveServerFolder)
		.mutation(async ({ input, ctx }) => {
			const folder = await findFolderInOrg(
				input.folderId,
				ctx.session.activeOrganizationId,
			);
			// Servers in the folder become unfiled through the item table's cascade.
			await db
				.delete(serverFolders)
				.where(eq(serverFolders.folderId, input.folderId));
			await audit(ctx, {
				action: "delete",
				resourceType: "server",
				resourceId: folder.folderId,
				resourceName: `Folder ${folder.name}`,
			});
		}),

	moveServers: withPermission("server", "create")
		.input(apiMoveServersToFolder)
		.mutation(async ({ input, ctx }) => {
			const accessibleIds = await getAccessibleServerIds(ctx.session);
			if (input.serverIds.some((id) => !accessibleIds.has(id))) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this server",
				});
			}

			const folderId = input.folderId;
			if (folderId) {
				await findFolderInOrg(folderId, ctx.session.activeOrganizationId);
			}

			await db.transaction(async (tx) => {
				await tx
					.delete(serverFolderItems)
					.where(inArray(serverFolderItems.serverId, input.serverIds));
				if (folderId) {
					await tx
						.insert(serverFolderItems)
						.values(
							input.serverIds.map((serverId) => ({ serverId, folderId })),
						);
				}
			});
		}),
});
