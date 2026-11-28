import {
	adoptCloudServer,
	countInProgressProvisionings,
	findServersByUserId,
	findUserById,
	IS_CLOUD,
	startCloudServerProvisioning,
} from "@dokploy/server";
import type {
	apiAdoptCloudServer,
	apiProvisionCloudServer,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { applyDockerCleanupSchedule } from "@/server/utils/docker-cleanup";

interface ProvisionCtx {
	user: { id: string; email: string; role: string; ownerId: string };
	session: { activeOrganizationId: string };
}

// Jobs only register their server minutes later, so count them now or
// back-to-back requests could all pass the check.
const checkServerQuota = async (ctx: ProvisionCtx) => {
	if (!IS_CLOUD) return;
	const owner = await findUserById(ctx.user.ownerId);
	const servers = await findServersByUserId(owner.id);
	const pending = await countInProgressProvisionings(
		ctx.session.activeOrganizationId,
	);
	if (servers.length + pending >= owner.serversQuantity) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "You cannot create more servers",
		});
	}
};

const afterServerCreated =
	(ctx: ProvisionCtx, name: string, metadata: Record<string, string>) =>
	async (serverId: string) => {
		await applyDockerCleanupSchedule(
			serverId,
			ctx.session.activeOrganizationId,
			true,
		);
		await audit(ctx, {
			action: "create",
			resourceType: "server",
			resourceId: serverId,
			resourceName: name,
			metadata,
		});
	};

/** Starts provisioning after the cloud plan's server quota check. */
export const provisionCloudServer = async (
	ctx: ProvisionCtx,
	input: z.infer<typeof apiProvisionCloudServer>,
) => {
	await checkServerQuota(ctx);
	return startCloudServerProvisioning(
		input,
		ctx.session.activeOrganizationId,
		afterServerCreated(ctx, input.name, { location: input.location }),
	);
};

/** Adds a server already on a provider account, after the quota check. */
export const adoptExistingCloudServer = async (
	ctx: ProvisionCtx,
	input: z.infer<typeof apiAdoptCloudServer>,
) => {
	await checkServerQuota(ctx);
	return adoptCloudServer(
		input,
		ctx.session.activeOrganizationId,
		afterServerCreated(ctx, input.name, {
			providerServerId: input.providerServerId,
			access: input.access,
		}),
	);
};
