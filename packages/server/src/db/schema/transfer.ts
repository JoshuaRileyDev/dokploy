import { z } from "zod";
import { cloudServerNameSchema } from "./cloud-provider";
import { serviceType } from "./mount";

export const apiTransferService = z.object({
	serviceType: z.enum(serviceType.enumValues),
	serviceId: z.string().min(1),
	targetServerId: z.string().min(1).nullable(),
	removeSourceData: z.boolean().default(false),
});

export const apiCheckTransferArchitecture = apiTransferService.pick({
	serviceType: true,
	serviceId: true,
	targetServerId: true,
});

export const apiPlanServerMigration = z.object({
	sourceServerId: z.string().min(1),
	targetServerId: z.string().min(1).nullable(),
	/** Plans against a server that will be provisioned, instead of targetServerId. */
	newServer: z
		.object({
			cloudProviderAccountId: z.string().min(1),
			serverType: z.string().min(1),
		})
		.optional(),
});

export const apiMigrateServer = apiPlanServerMigration
	.omit({ newServer: true })
	.extend({
		services: z
			.array(
				z.object({
					serviceType: z.enum(serviceType.enumValues),
					serviceId: z.string().min(1),
				}),
			)
			.min(1),
		removeSourceData: z.boolean().default(false),
		updateDns: z.boolean().default(true),
		/** Creates a deploy server on a cloud provider and migrates to it. */
		provision: z
			.object({
				cloudProviderAccountId: z.string().min(1),
				name: cloudServerNameSchema,
				location: z.string().min(1),
				serverType: z.string().min(1),
				image: z.string().min(1),
			})
			.optional(),
	});
