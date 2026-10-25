import {
	getAccessibleServerIds,
	IS_CLOUD,
	transferService,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { apiTransferService } from "@/server/db/schema";

type TransferInput = z.infer<typeof apiTransferService>;

type TransferCtx = {
	user: { id: string; email: string; role: string };
	session: { userId: string; activeOrganizationId: string };
};

const checkTransferAccess = async (ctx: TransferCtx, input: TransferInput) => {
	await checkServicePermissionAndAccess(ctx, input.serviceId, {
		service: ["create"],
		deployment: ["create"],
	});
	if (input.targetServerId) {
		const accessibleIds = await getAccessibleServerIds(ctx.session);
		if (!accessibleIds.has(input.targetServerId)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to the target server",
			});
		}
	} else if (IS_CLOUD) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The Dokploy server is not available as a target",
		});
	}
};

const runTransfer = async (
	ctx: TransferCtx,
	input: TransferInput,
	log: (line: string) => void,
) => {
	const result = await transferService(
		{ ...input, organizationId: ctx.session.activeOrganizationId },
		log,
	);
	await audit(ctx, {
		action: "move",
		resourceType: "service",
		resourceId: input.serviceId,
		resourceName: result.appName,
		metadata: { targetServerId: input.targetServerId },
	});
	return result;
};

export const transferRouter = createTRPCRouter({
	service: protectedProcedure
		.meta({
			openapi: {
				path: "/transfer.service",
				method: "POST",
				summary: "Transfer a service to another server",
				description:
					"Stops the service, copies its volumes and bind mounts to the target server, moves its configuration and redeploys it there. Responds once the transfer and deployment have finished, with the full transfer log. Set targetServerId to null to move it onto the Dokploy server.",
			},
		})
		.input(apiTransferService)
		.mutation(async ({ input, ctx }) => {
			await checkTransferAccess(ctx, input);

			const logs: string[] = [];
			try {
				const result = await runTransfer(ctx, input, (line) =>
					logs.push(line),
				);
				return { ...result, logs };
			} catch (error) {
				// The log says how far the transfer got (e.g. data moved but the
				// deploy failed), which the bare error message doesn't.
				throw new TRPCError({
					code:
						error instanceof TRPCError ? error.code : "INTERNAL_SERVER_ERROR",
					message: [
						`Transfer failed: ${error instanceof Error ? error.message : String(error)}`,
						...logs,
					].join("\n"),
					cause: error,
				});
			}
		}),
	start: protectedProcedure
		.meta({
			openapi: {
				path: "/transfer/start",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiTransferService)
		.subscription(async function* ({ input, ctx, signal }) {
			await checkTransferAccess(ctx, input);

			const queue: string[] = [];
			let done = false;
			const log = (line: string) => queue.push(line);

			runTransfer(ctx, input, log)
				.then(() => log("Transfer completed successfully!"))
				.catch((error) => {
					log(
						`Transfer failed ❌ ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(() => {
					done = true;
				});

			while (!done || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise((r) => setTimeout(r, 50));
				}

				if (signal?.aborted) {
					return;
				}
			}
		}),
});
