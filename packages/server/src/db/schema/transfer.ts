import { z } from "zod";
import { serviceType } from "./mount";

export const apiTransferService = z.object({
	serviceType: z.enum(serviceType.enumValues),
	serviceId: z.string().min(1),
	targetServerId: z.string().min(1).nullable(),
	removeSourceData: z.boolean().default(false),
});

export const apiPlanServerMigration = z.object({
	sourceServerId: z.string().min(1),
	targetServerId: z.string().min(1).nullable(),
});

export const apiMigrateServer = apiPlanServerMigration.extend({
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
});
