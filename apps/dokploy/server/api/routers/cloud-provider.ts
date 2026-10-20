import {
	createCloudProviderAccount,
	destroyProvisionedServer,
	dismissServerProvisioning,
	findCloudProviderAccountInOrganization,
	findCloudProviderAccountsByOrganizationId,
	findProvisioningByServerId,
	findServerById,
	findServerProvisioningInOrganization,
	findServerProvisionings,
	findServersByUserId,
	findUserById,
	getCloudCatalog,
	getCloudProviderDefinition,
	IS_CLOUD,
	listCloudProviderDefinitions,
	redactCloudProviderAccount,
	removeCloudProviderAccount,
	resolveTestCredentials,
	startCloudServerProvisioning,
	testCloudProviderCredentials,
	updateCloudProviderAccount,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateCloudProviderAccount,
	apiFindOneCloudProviderAccount,
	apiFindProvisioningByServer,
	apiFindServerProvisioning,
	apiProvisionCloudServer,
	apiTestCloudProviderAccount,
	apiUpdateCloudProviderAccount,
} from "@/server/db/schema";
import { applyDockerCleanupSchedule } from "@/server/utils/docker-cleanup";

const accountLabel = (account: { providerType: string; name: string }) =>
	`${getCloudProviderDefinition(account.providerType).label} account ${account.name}`;

export const cloudProviderRouter = createTRPCRouter({
	providers: withPermission("server", "read").query(() =>
		listCloudProviderDefinitions(),
	),

	all: withPermission("server", "read").query(async ({ ctx }) => {
		const accounts = await findCloudProviderAccountsByOrganizationId(
			ctx.session.activeOrganizationId,
		);
		return accounts.map(redactCloudProviderAccount);
	}),

	one: withPermission("server", "read")
		.input(apiFindOneCloudProviderAccount)
		.query(async ({ ctx, input }) => {
			const account = await findCloudProviderAccountInOrganization(
				input.cloudProviderAccountId,
				ctx.session.activeOrganizationId,
			);
			return redactCloudProviderAccount(account);
		}),

	create: withPermission("server", "create")
		.input(apiCreateCloudProviderAccount)
		.mutation(async ({ ctx, input }) => {
			const account = await createCloudProviderAccount(
				input,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "server",
				resourceId: account.cloudProviderAccountId,
				resourceName: accountLabel(account),
			});
			return redactCloudProviderAccount(account);
		}),

	update: withPermission("server", "create")
		.input(apiUpdateCloudProviderAccount)
		.mutation(async ({ ctx, input }) => {
			const existing = await findCloudProviderAccountInOrganization(
				input.cloudProviderAccountId,
				ctx.session.activeOrganizationId,
			);
			const account = await updateCloudProviderAccount(existing, input);
			await audit(ctx, {
				action: "update",
				resourceType: "server",
				resourceId: account.cloudProviderAccountId,
				resourceName: accountLabel(account),
			});
			return redactCloudProviderAccount(account);
		}),

	remove: withPermission("server", "delete")
		.input(apiFindOneCloudProviderAccount)
		.mutation(async ({ ctx, input }) => {
			const account = await findCloudProviderAccountInOrganization(
				input.cloudProviderAccountId,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "server",
				resourceId: account.cloudProviderAccountId,
				resourceName: accountLabel(account),
			});
			await removeCloudProviderAccount(input.cloudProviderAccountId);
			return true;
		}),

	testConnection: withPermission("server", "create")
		.input(apiTestCloudProviderAccount)
		.mutation(async ({ ctx, input }) => {
			const credentials = await resolveTestCredentials(
				input,
				ctx.session.activeOrganizationId,
			);
			await testCloudProviderCredentials(input.providerType, credentials);
			return true;
		}),

	catalog: withPermission("server", "create")
		.input(apiFindOneCloudProviderAccount)
		.query(async ({ ctx, input }) => {
			const account = await findCloudProviderAccountInOrganization(
				input.cloudProviderAccountId,
				ctx.session.activeOrganizationId,
			);
			return getCloudCatalog(account);
		}),

	provision: withPermission("server", "create")
		.input(apiProvisionCloudServer)
		.mutation(async ({ ctx, input }) => {
			if (IS_CLOUD) {
				const owner = await findUserById(ctx.user.ownerId);
				const servers = await findServersByUserId(owner.id);
				if (servers.length >= owner.serversQuantity) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "You cannot create more servers",
					});
				}
			}
			const organizationId = ctx.session.activeOrganizationId;
			const provisioning = await startCloudServerProvisioning(
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
			return provisioning;
		}),

	provisionings: withPermission("server", "read").query(({ ctx }) =>
		findServerProvisionings(ctx.session.activeOrganizationId),
	),

	provisioningForServer: withPermission("server", "read")
		.input(apiFindProvisioningByServer)
		.query(async ({ ctx, input }) => {
			const currentServer = await findServerById(input.serverId);
			if (currentServer.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
			return findProvisioningByServerId(input.serverId);
		}),

	dismissProvisioning: withPermission("server", "create")
		.input(apiFindServerProvisioning)
		.mutation(async ({ ctx, input }) => {
			const provisioning = await findServerProvisioningInOrganization(
				input.serverProvisioningId,
				ctx.session.activeOrganizationId,
			);
			if (
				provisioning.status !== "completed" &&
				provisioning.status !== "failed"
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Provisioning is still running",
				});
			}
			await dismissServerProvisioning(input.serverProvisioningId);
			return true;
		}),

	destroyServer: withPermission("server", "delete")
		.input(apiFindServerProvisioning)
		.mutation(async ({ ctx, input }) => {
			const provisioning = await findServerProvisioningInOrganization(
				input.serverProvisioningId,
				ctx.session.activeOrganizationId,
			);
			await destroyProvisionedServer(provisioning);
			await audit(ctx, {
				action: "delete",
				resourceType: "server",
				resourceId: provisioning.providerServerId ?? undefined,
				resourceName: `${getCloudProviderDefinition(provisioning.providerType).label} server ${provisioning.config.name}`,
			});
			return true;
		}),
});
