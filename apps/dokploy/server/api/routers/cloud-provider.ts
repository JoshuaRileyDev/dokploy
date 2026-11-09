import {
	compareCloudOffers,
	createCloudProviderAccount,
	destroyProvisionedServer,
	dismissServerProvisioning,
	findCloudProviderAccountInOrganization,
	findCloudProviderAccountsByOrganizationId,
	findProvisioningByServerId,
	findServerById,
	findServerProvisioningInOrganization,
	findServerProvisionings,
	getCloudCatalog,
	getCloudProviderDefinition,
	getServerCosts,
	listCloudProviderDefinitions,
	redactCloudProviderAccount,
	removeCloudProviderAccount,
	resolveTestCredentials,
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
import { provisionCloudServer } from "@/server/utils/provision-server";

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

	compare: withPermission("server", "create").query(({ ctx }) =>
		compareCloudOffers(ctx.session.activeOrganizationId),
	),

	provision: withPermission("server", "create")
		.input(apiProvisionCloudServer)
		.mutation(({ ctx, input }) => provisionCloudServer(ctx, input)),

	costs: withPermission("server", "read").query(({ ctx }) =>
		getServerCosts(ctx.session.activeOrganizationId),
	),

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
			if (
				!provisioning.serverId &&
				provisioning.providerServerId &&
				!provisioning.providerServerDeletedAt
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"This server still exists on the provider. Delete it before dismissing the job.",
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
