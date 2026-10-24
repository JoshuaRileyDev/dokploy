import {
	findApplicationById,
	findComposeById,
	findLibsqlById,
	findMariadbById,
	findMongoById,
	findMySqlById,
	findPostgresById,
	findRedisById,
	findServerById,
	getMemoryBudget,
	getMemoryPolicy,
	getOomKills,
	IS_CLOUD,
	type OomServiceType,
	updateServerById,
	updateWebServerSettings,
} from "@dokploy/server";
import {
	checkPermission,
	checkServiceAccess,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { MemoryPolicySchema } from "@/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

type Ctx = PermissionCtx & { user: { role: string } };

const serverInput = z.object({ serverId: z.string().min(1).optional() });

/**
 * Remote servers follow the `server` permission. The local host is shared by
 * every organization, so only owners and admins may change its policy.
 */
const assertServerAccess = async (
	ctx: Ctx,
	serverId: string | undefined,
	action: "read" | "create",
) => {
	if (IS_CLOUD && !serverId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The Dokploy host isn't configurable on cloud",
		});
	}
	if (!serverId) {
		if (
			action === "create" &&
			ctx.user.role !== "owner" &&
			ctx.user.role !== "admin"
		) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
		return null;
	}
	await checkPermission(ctx, { server: [action] });
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this server",
		});
	}
	return server;
};

const serviceTypes = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
] as const;

const findService = async (id: string, type: (typeof serviceTypes)[number]) => {
	switch (type) {
		case "application": {
			const service = await findApplicationById(id);
			return { service, oomType: "application" as OomServiceType };
		}
		case "compose": {
			const service = await findComposeById(id);
			return {
				service,
				oomType: service.composeType as OomServiceType,
			};
		}
		case "postgres":
			return {
				service: await findPostgresById(id),
				oomType: "application" as const,
			};
		case "mysql":
			return {
				service: await findMySqlById(id),
				oomType: "application" as const,
			};
		case "mariadb":
			return {
				service: await findMariadbById(id),
				oomType: "application" as const,
			};
		case "mongo":
			return {
				service: await findMongoById(id),
				oomType: "application" as const,
			};
		case "redis":
			return {
				service: await findRedisById(id),
				oomType: "application" as const,
			};
		case "libsql":
			return {
				service: await findLibsqlById(id),
				oomType: "application" as const,
			};
	}
};

export const memoryPolicyRouter = createTRPCRouter({
	get: protectedProcedure.input(serverInput).query(async ({ input, ctx }) => {
		await assertServerAccess(ctx, input.serverId, "read");
		return getMemoryPolicy(input.serverId);
	}),

	update: protectedProcedure
		.input(MemoryPolicySchema.extend(serverInput.shape))
		.mutation(async ({ input, ctx }) => {
			const server = await assertServerAccess(ctx, input.serverId, "create");
			const { serverId, ...policy } = input;
			if (serverId) {
				await updateServerById(serverId, { forkMemoryPolicy: policy });
			} else {
				await updateWebServerSettings({ forkMemoryPolicy: policy });
			}
			await audit(ctx, {
				action: "update",
				resourceType: serverId ? "server" : "settings",
				resourceId: serverId,
				resourceName: server?.name ?? "memory-policy",
			});
			return policy;
		}),

	budget: protectedProcedure
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			await assertServerAccess(ctx, input.serverId, "read");
			try {
				return await getMemoryBudget(
					input.serverId,
					ctx.session.activeOrganizationId,
				);
			} catch (error) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Couldn't read memory usage from the server: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			}
		}),

	/** Server default that applies to a service when it has no limit of its own. */
	serviceDefault: protectedProcedure
		.input(z.object({ id: z.string().min(1), type: z.enum(serviceTypes) }))
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.id, "read");
			const { service } = await findService(input.id, input.type);
			if (
				service.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
			const policy = await getMemoryPolicy(service.serverId);
			return { defaultMemoryLimit: policy.defaultMemoryLimit };
		}),

	oomKills: protectedProcedure
		.input(z.object({ id: z.string().min(1), type: z.enum(serviceTypes) }))
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.id, "read");
			const { service, oomType } = await findService(input.id, input.type);
			if (
				service.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
			try {
				return await getOomKills(service.appName, oomType, service.serverId);
			} catch {
				return [];
			}
		}),
});
