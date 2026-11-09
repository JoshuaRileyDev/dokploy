import {
	checkTransferArchitecture,
	getAccessibleServerIds,
	IS_CLOUD,
	migrateServer,
	planServerMigration,
	transferService,
	waitForServerProvisioning,
} from "@dokploy/server";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCheckTransferArchitecture,
	apiMigrateServer,
	apiPlanServerMigration,
	apiTransferService,
} from "@/server/db/schema";
import { provisionCloudServer } from "@/server/utils/provision-server";

type TransferInput = z.infer<typeof apiTransferService>;

type TransferCtx = {
	user: { id: string; email: string; role: string; ownerId: string };
	session: { userId: string; activeOrganizationId: string };
};

const checkTransferAccess = async (
	ctx: TransferCtx,
	input: Pick<TransferInput, "serviceId" | "targetServerId">,
) => {
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

type ServerMigrationInput = Pick<
	z.infer<typeof apiPlanServerMigration>,
	"sourceServerId" | "targetServerId"
>;

const checkServerMigrationAccess = async (
	ctx: TransferCtx,
	input: ServerMigrationInput,
	createsServer: boolean,
) => {
	await checkPermission(ctx, { service: ["create"], deployment: ["create"] });
	const accessibleIds = await getAccessibleServerIds(ctx.session);
	if (!accessibleIds.has(input.sourceServerId)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to the source server",
		});
	}
	if (createsServer) {
		await checkPermission(ctx, { server: ["create"] });
	} else if (input.targetServerId) {
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

const accessibleServiceIds = async (ctx: TransferCtx) => {
	if (ctx.user.role === "owner" || ctx.user.role === "admin") return null;
	const { accessedServices } = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	return new Set(accessedServices);
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
					"Copies the service's volumes and bind mounts to the target server, moves its configuration and redeploys it there. A service without persistent data keeps running on the source until the new copy is healthy; one with data is stopped while it is copied. If the deploy fails or the new copy doesn't stay up, the service is rolled back to the source. Responds once the transfer has finished, with the full transfer log. Set targetServerId to null to move it onto the Dokploy server.",
			},
		})
		.input(apiTransferService)
		.mutation(async ({ input, ctx }) => {
			await checkTransferAccess(ctx, input);

			const logs: string[] = [];
			try {
				const result = await runTransfer(ctx, input, (line) => logs.push(line));
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
	checkArchitecture: protectedProcedure
		.input(apiCheckTransferArchitecture)
		.query(async ({ input, ctx }) => {
			await checkTransferAccess(ctx, input);
			return checkTransferArchitecture({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
		}),
	planServer: protectedProcedure
		.input(apiPlanServerMigration)
		.query(async ({ input, ctx }) => {
			await checkServerMigrationAccess(ctx, input, !!input.newServer);
			const allowed = await accessibleServiceIds(ctx);
			return planServerMigration(
				{ ...input, organizationId: ctx.session.activeOrganizationId },
				async (services) =>
					allowed ? services.filter((s) => allowed.has(s.id)) : services,
			);
		}),
	startServer: protectedProcedure
		.meta({
			openapi: {
				path: "/transfer/start-server",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiMigrateServer)
		.subscription(async function* ({ input, ctx, signal }) {
			await checkServerMigrationAccess(ctx, input, !!input.provision);
			for (const service of input.services) {
				await checkServicePermissionAndAccess(ctx, service.serviceId, {
					service: ["create"],
					deployment: ["create"],
				});
			}

			const queue: string[] = [];
			let done = false;
			const log = (line: string) => queue.push(line);

			const run = async () => {
				let targetServerId = input.targetServerId;
				if (input.provision) {
					const { provision } = input;
					log(
						`Creating ${provision.name} (${provision.serverType} in ${provision.location})`,
					);
					const provisioning = await provisionCloudServer(ctx, {
						...provision,
						role: "deploy",
					});
					targetServerId = await waitForServerProvisioning(
						provisioning.serverProvisioningId,
						(message) => log(`  ${message}`),
					);
					log(`${provision.name} is ready`);
					log("");
				}
				return migrateServer(
					{
						...input,
						targetServerId,
						organizationId: ctx.session.activeOrganizationId,
					},
					log,
					{
						onTransferred: (result) =>
							audit(ctx, {
								action: "move",
								resourceType: "service",
								resourceId: result.serviceId,
								resourceName: result.appName,
								metadata: {
									sourceServerId: input.sourceServerId,
									targetServerId,
								},
							}),
					},
				);
			};

			run()
				.then((result) =>
					log(
						result.failed.length === 0
							? "Migration completed successfully!"
							: `Migration finished with ${result.failed.length} failed service(s)`,
					),
				)
				.catch((error) => {
					log(
						`Migration failed ❌ ${error instanceof Error ? error.message : String(error)}`,
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
