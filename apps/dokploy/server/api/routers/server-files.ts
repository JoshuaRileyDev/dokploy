import {
	assertServerCommandAccess,
	deleteServerPath,
	listServerDirectory,
} from "@dokploy/server";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";

const pathSchema = z.string().min(1).max(4096);

// Browsing and deleting files is as powerful as the terminal, so it needs the same permission.
const filesProcedure = withPermission("server", "terminal");

export const serverFilesRouter = createTRPCRouter({
	list: filesProcedure
		.input(
			z.object({
				serverId: z.string().min(1),
				path: pathSchema,
				force: z.boolean().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertServerCommandAccess(ctx, input.serverId);
			return listServerDirectory(input.serverId, input.path, {
				force: input.force,
			});
		}),
	remove: filesProcedure
		.input(z.object({ serverId: z.string().min(1), path: pathSchema }))
		.mutation(async ({ input, ctx }) => {
			const target = await assertServerCommandAccess(ctx, input.serverId);
			const result = await deleteServerPath(input.serverId, input.path);
			await audit(ctx, {
				action: "delete",
				resourceType: "server",
				resourceId: target.serverId,
				resourceName: target.name,
				metadata: { path: result.resolvedPath },
			});
			return result;
		}),
});
