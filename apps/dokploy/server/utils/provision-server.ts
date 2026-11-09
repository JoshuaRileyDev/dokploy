import {
	countInProgressProvisionings,
	findServersByUserId,
	findUserById,
	IS_CLOUD,
	startCloudServerProvisioning,
} from "@dokploy/server";
import type { apiProvisionCloudServer } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { applyDockerCleanupSchedule } from "@/server/utils/docker-cleanup";

interface ProvisionCtx {
	user: { id: string; email: string; role: string; ownerId: string };
	session: { activeOrganizationId: string };
}

/** Starts provisioning after the cloud plan's server quota check. */
export const provisionCloudServer = async (
	ctx: ProvisionCtx,
	input: z.infer<typeof apiProvisionCloudServer>,
) => {
	if (IS_CLOUD) {
		const owner = await findUserById(ctx.user.ownerId);
		const servers = await findServersByUserId(owner.id);
		// Jobs only register their server minutes later, so count them now
		// or back-to-back requests could all pass the check.
		const pending = await countInProgressProvisionings(
			ctx.session.activeOrganizationId,
		);
		if (servers.length + pending >= owner.serversQuantity) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "You cannot create more servers",
			});
		}
	}
	const organizationId = ctx.session.activeOrganizationId;
	return startCloudServerProvisioning(
		input,
		organizationId,
		async (serverId) => {
			await applyDockerCleanupSchedule(serverId, organizationId, true);
			await audit(ctx, {
				action: "create",
				resourceType: "server",
				resourceId: serverId,
				resourceName: input.name,
				metadata: { location: input.location },
			});
		},
	);
};
