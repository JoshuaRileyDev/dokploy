import {
	addNewEnvironment,
	addNewProject,
	checkProjectAccess,
	checkServiceAccess,
	createApplication,
	createBackup,
	createCompose,
	createDomain,
	createLibsql,
	createMariadb,
	createMongo,
	createMount,
	createMysql,
	createPort,
	createPostgres,
	createPreviewDeployment,
	createProject,
	createRedirect,
	createRedis,
	createSecurity,
	deleteProject,
	findApplicationById,
	findComposeById,
	findEnvironmentById,
	findLibsqlById,
	findMariadbById,
	findMongoById,
	findMySqlById,
	findPostgresById,
	findProjectById,
	findRedisById,
	findUserById,
	IS_CLOUD,
	updateProjectById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	checkPermission,
	findMemberById,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { serviceColumns } from "@dokploy/server/services/project";
import { TRPCError } from "@trpc/server";
import { parse as parseDotenv } from "dotenv";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateProject,
	apiFindOneProject,
	apiRemoveProject,
	apiUpdateProject,
	applications,
	compose,
	deployments,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@/server/db/schema";

export const projectRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateProject)
		.mutation(async ({ ctx, input }) => {
			try {
				await checkProjectAccess(ctx, "create");

				const admin = await findUserById(ctx.user.ownerId);

				if (admin.serversQuantity === 0 && IS_CLOUD) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No servers available, Please subscribe to a plan",
					});
				}

				await validateProjectParent({
					organizationId: ctx.session.activeOrganizationId,
					parentProjectId: input.parentProjectId ?? null,
				});

				const project = await createProject(
					input,
					ctx.session.activeOrganizationId,
				);
				await addNewProject(ctx, project.project.projectId);

				if (project.environment?.environmentId) {
					await addNewEnvironment(ctx, project.environment.environmentId);
				}

				await audit(ctx, {
					action: "create",
					resourceType: "project",
					resourceId: project.project.projectId,
					resourceName: project.project.name,
				});
				return project;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Error creating the project: ${error instanceof Error ? error.message : error}`,
					cause: error,
				});
			}
		}),

	one: protectedProcedure
		.input(apiFindOneProject)
		.query(async ({ input, ctx }) => {
			if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
				const { accessedServices, accessedProjects } = await findMemberByUserId(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);

				if (!accessedProjects.includes(input.projectId)) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this project",
					});
				}

				const project = await db.query.projects.findFirst({
					where: and(
						eq(projects.projectId, input.projectId),
						eq(projects.organizationId, ctx.session.activeOrganizationId),
					),
					with: {
						environments: {
							with: {
								applications: {
									columns: {
										...serviceColumns,
										applicationId: true,
										icon: true,
									},
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(
										applications.applicationId,
										accessedServices,
									),
								},
								compose: {
									columns: {
										...serviceColumns,
										composeId: true,
										composeStatus: true,
									},
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(
										compose.composeId,
										accessedServices,
									),
								},
								libsql: {
									columns: { ...serviceColumns, libsqlId: true },
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(libsql.libsqlId, accessedServices),
								},
								mariadb: {
									columns: { ...serviceColumns, mariadbId: true },
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(
										mariadb.mariadbId,
										accessedServices,
									),
								},
								mongo: {
									columns: { ...serviceColumns, mongoId: true },
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(mongo.mongoId, accessedServices),
								},
								mysql: {
									columns: { ...serviceColumns, mysqlId: true },
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(mysql.mysqlId, accessedServices),
								},
								postgres: {
									columns: { ...serviceColumns, postgresId: true },
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(
										postgres.postgresId,
										accessedServices,
									),
								},
								redis: {
									columns: { ...serviceColumns, redisId: true },
									with: { server: { columns: { name: true } } },
									where: buildServiceFilter(redis.redisId, accessedServices),
								},
							},
						},
						projectTags: {
							with: {
								tag: true,
							},
						},
					},
				});

				if (!project) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Project not found",
					});
				}
				return project;
			}
			const project = await findProjectById(input.projectId);

			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this project",
				});
			}
			return project;
		}),
	all: protectedProcedure.query(async ({ ctx }) => {
		if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
			const { accessedProjects } = await findMemberByUserId(
				ctx.user.id,
				ctx.session.activeOrganizationId,
			);

			if (accessedProjects.length === 0) {
				return [];
			}

			return await db.query.projects.findMany({
				columns: {
					projectId: true,
					name: true,
					description: true,
					createdAt: true,
					organizationId: true,
					wildcardDomain: true,
					useOrganizationWildcard: true,
				},
				where: and(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((projectId) => sql`${projectId}`),
						sql`, `,
					)})`,
					eq(projects.organizationId, ctx.session.activeOrganizationId),
					eq(projects.isFolder, false),
				),
				orderBy: desc(projects.createdAt),
			});
		}

		return await db.query.projects.findMany({
			columns: {
				projectId: true,
				name: true,
				description: true,
				createdAt: true,
				organizationId: true,
				wildcardDomain: true,
				useOrganizationWildcard: true,
			},
			where: and(
				eq(projects.organizationId, ctx.session.activeOrganizationId),
				eq(projects.isFolder, false),
			),
			orderBy: desc(projects.createdAt),
		});
	}),

	allWithServices: protectedProcedure.query(async ({ ctx }) => {
		if (ctx.user.role === "member") {
			const { accessedProjects, accessedEnvironments, accessedServices } =
				await findMemberByUserId(ctx.user.id, ctx.session.activeOrganizationId);

			if (accessedProjects.length === 0) {
				return [];
			}

			const environmentFilter =
				accessedEnvironments.length === 0
					? sql`false`
					: sql`${environments.environmentId} IN (${sql.join(
							accessedEnvironments.map((envId) => sql`${envId}`),
							sql`, `,
						)})`;

			return await db.query.projects.findMany({
				where: and(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((projectId) => sql`${projectId}`),
						sql`, `,
					)})`,
					eq(projects.organizationId, ctx.session.activeOrganizationId),
					eq(projects.isFolder, false),
				),
				with: {
					environments: {
						where: environmentFilter,
						with: {
							applications: {
								where: buildServiceFilter(
									applications.applicationId,
									accessedServices,
								),
								columns: {
									applicationId: true,
									name: true,
									applicationStatus: true,
								},
							},
							libsql: {
								where: buildServiceFilter(libsql.libsqlId, accessedServices),
								columns: {
									libsqlId: true,
									name: true,
									applicationStatus: true,
								},
							},
							mariadb: {
								where: buildServiceFilter(mariadb.mariadbId, accessedServices),
								columns: {
									mariadbId: true,
									name: true,
									applicationStatus: true,
								},
							},
							mongo: {
								where: buildServiceFilter(mongo.mongoId, accessedServices),
								columns: {
									mongoId: true,
									name: true,
									applicationStatus: true,
								},
							},
							mysql: {
								where: buildServiceFilter(mysql.mysqlId, accessedServices),
								columns: {
									mysqlId: true,
									name: true,
									applicationStatus: true,
								},
							},
							postgres: {
								where: buildServiceFilter(
									postgres.postgresId,
									accessedServices,
								),
								columns: {
									postgresId: true,
									name: true,
									applicationStatus: true,
								},
							},
							redis: {
								where: buildServiceFilter(redis.redisId, accessedServices),
								columns: {
									redisId: true,
									name: true,
									applicationStatus: true,
								},
							},
							compose: {
								where: buildServiceFilter(compose.composeId, accessedServices),
								columns: {
									composeId: true,
									name: true,
									composeStatus: true,
								},
							},
						},
						columns: {
							environmentId: true,
							isDefault: true,
							name: true,
						},
					},
					projectTags: {
						with: {
							tag: true,
						},
					},
				},
				orderBy: desc(projects.createdAt),
			});
		}

		return await db.query.projects.findMany({
			with: {
				environments: {
					with: {
						applications: {
							columns: {
								applicationId: true,
								name: true,
								applicationStatus: true,
							},
						},
						mariadb: {
							columns: {
								mariadbId: true,
							},
						},
						mongo: {
							columns: {
								mongoId: true,
							},
						},
						mysql: {
							columns: {
								mysqlId: true,
							},
						},
						postgres: {
							columns: {
								postgresId: true,
							},
						},
						redis: {
							columns: {
								redisId: true,
							},
						},
						compose: {
							columns: {
								composeId: true,
								name: true,
								composeStatus: true,
							},
						},
						libsql: {
							columns: {
								libsqlId: true,
							},
						},
					},
					columns: {
						name: true,
						environmentId: true,
						isDefault: true,
					},
				},
				projectTags: {
					with: {
						tag: true,
					},
				},
			},
			where: and(
				eq(projects.organizationId, ctx.session.activeOrganizationId),
				eq(projects.isFolder, false),
			),
			orderBy: desc(projects.createdAt),
		});
	}),
	allWithServicesTree: protectedProcedure.query(async ({ ctx }) => {
		if (ctx.user.role === "member") {
			const { accessedProjects, accessedEnvironments, accessedServices } =
				await findMemberById(ctx.user.id, ctx.session.activeOrganizationId);

			if (accessedProjects.length === 0) {
				return [];
			}

			const projectList = await db.query.projects.findMany({
				where: and(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((projectId) => sql`${projectId}`),
						sql`, `,
					)})`,
					eq(projects.organizationId, ctx.session.activeOrganizationId),
					eq(projects.isFolder, false),
				),
				with: {
					environments: {
						where: buildEnvironmentFilter(accessedEnvironments),
						with: {
							applications: {
								where: buildServiceFilter(
									applications.applicationId,
									accessedServices,
								),
								with: { domains: true },
							},
							mariadb: {
								where: buildServiceFilter(mariadb.mariadbId, accessedServices),
							},
							mongo: {
								where: buildServiceFilter(mongo.mongoId, accessedServices),
							},
							mysql: {
								where: buildServiceFilter(mysql.mysqlId, accessedServices),
							},
							postgres: {
								where: buildServiceFilter(
									postgres.postgresId,
									accessedServices,
								),
							},
							redis: {
								where: buildServiceFilter(redis.redisId, accessedServices),
							},
							compose: {
								where: buildServiceFilter(compose.composeId, accessedServices),
								with: { domains: true },
							},
						},
					},
				},
				orderBy: [asc(projects.name), desc(projects.createdAt)],
			});

			return buildProjectTree(projectList);
		}

		const projectList = await db.query.projects.findMany({
			with: {
				environments: {
					with: {
						applications: {
							with: {
								domains: true,
							},
						},
						mariadb: true,
						mongo: true,
						mysql: true,
						postgres: true,
						redis: true,
						compose: {
							with: {
								domains: true,
							},
						},
					},
				},
			},
			where: and(
				eq(projects.organizationId, ctx.session.activeOrganizationId),
				eq(projects.isFolder, false),
			),
			orderBy: [asc(projects.name), desc(projects.createdAt)],
		});

		return buildProjectTree(projectList);
	}),
	summary: protectedProcedure.query(async ({ ctx }) => {
		if (ctx.user.role === "member") {
			const { accessedProjects, accessedEnvironments, accessedServices } =
				await findMemberById(ctx.user.id, ctx.session.activeOrganizationId);

			if (accessedProjects.length === 0) {
				return [];
			}

			const projectList = await db.query.projects.findMany({
				columns: {
					projectId: true,
					name: true,
					description: true,
					createdAt: true,
				},
				where: and(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((projectId) => sql`${projectId}`),
						sql`, `,
					)})`,
					eq(projects.organizationId, ctx.session.activeOrganizationId),
				),
				with: {
					environments: {
						where: buildEnvironmentFilter(accessedEnvironments),
						columns: {
							environmentId: true,
						},
						with: {
							applications: {
								where: buildServiceFilter(
									applications.applicationId,
									accessedServices,
								),
								columns: { applicationStatus: true },
							},
							compose: {
								where: buildServiceFilter(compose.composeId, accessedServices),
								columns: { composeStatus: true },
							},
							mariadb: {
								where: buildServiceFilter(mariadb.mariadbId, accessedServices),
								columns: { applicationStatus: true },
							},
							mongo: {
								where: buildServiceFilter(mongo.mongoId, accessedServices),
								columns: { applicationStatus: true },
							},
							mysql: {
								where: buildServiceFilter(mysql.mysqlId, accessedServices),
								columns: { applicationStatus: true },
							},
							postgres: {
								where: buildServiceFilter(postgres.postgresId, accessedServices),
								columns: { applicationStatus: true },
							},
							redis: {
								where: buildServiceFilter(redis.redisId, accessedServices),
								columns: { applicationStatus: true },
							},
						},
					},
				},
				orderBy: desc(projects.createdAt),
			});

			return projectList.map((project) => {
				const servicesCount = {
					applications: 0,
					compose: 0,
					mariadb: 0,
					mongo: 0,
					mysql: 0,
					postgres: 0,
					redis: 0,
					total: 0,
				};

				const statusCount: Record<string, number> = {
					idle: 0,
					running: 0,
					done: 0,
					error: 0,
					paused: 0,
				};

				for (const environment of project.environments) {
					servicesCount.applications += environment.applications.length;
					servicesCount.compose += environment.compose.length;
					servicesCount.mariadb += environment.mariadb.length;
					servicesCount.mongo += environment.mongo.length;
					servicesCount.mysql += environment.mysql.length;
					servicesCount.postgres += environment.postgres.length;
					servicesCount.redis += environment.redis.length;

					for (const app of environment.applications) {
						statusCount[app.applicationStatus] =
							(statusCount[app.applicationStatus] || 0) + 1;
					}
					for (const service of environment.compose) {
						statusCount[service.composeStatus] =
							(statusCount[service.composeStatus] || 0) + 1;
					}
					for (const service of environment.mariadb) {
						statusCount[service.applicationStatus] =
							(statusCount[service.applicationStatus] || 0) + 1;
					}
					for (const service of environment.mongo) {
						statusCount[service.applicationStatus] =
							(statusCount[service.applicationStatus] || 0) + 1;
					}
					for (const service of environment.mysql) {
						statusCount[service.applicationStatus] =
							(statusCount[service.applicationStatus] || 0) + 1;
					}
					for (const service of environment.postgres) {
						statusCount[service.applicationStatus] =
							(statusCount[service.applicationStatus] || 0) + 1;
					}
					for (const service of environment.redis) {
						statusCount[service.applicationStatus] =
							(statusCount[service.applicationStatus] || 0) + 1;
					}
				}

				servicesCount.total =
					servicesCount.applications +
					servicesCount.compose +
					servicesCount.mariadb +
					servicesCount.mongo +
					servicesCount.mysql +
					servicesCount.postgres +
					servicesCount.redis;

				return {
					projectId: project.projectId,
					name: project.name,
					description: project.description,
					createdAt: project.createdAt,
					environmentsCount: project.environments.length,
					servicesCount,
					statusCount,
				};
			});
		}

		const projectList = await db.query.projects.findMany({
			columns: {
				projectId: true,
				name: true,
				description: true,
				createdAt: true,
			},
			where: eq(projects.organizationId, ctx.session.activeOrganizationId),
			with: {
				environments: {
					columns: {
						environmentId: true,
					},
					with: {
						applications: {
							columns: { applicationStatus: true },
						},
						compose: {
							columns: { composeStatus: true },
						},
						mariadb: {
							columns: { applicationStatus: true },
						},
						mongo: {
							columns: { applicationStatus: true },
						},
						mysql: {
							columns: { applicationStatus: true },
						},
						postgres: {
							columns: { applicationStatus: true },
						},
						redis: {
							columns: { applicationStatus: true },
						},
					},
				},
			},
			orderBy: desc(projects.createdAt),
		});

		return projectList.map((project) => {
			const servicesCount = {
				applications: 0,
				compose: 0,
				mariadb: 0,
				mongo: 0,
				mysql: 0,
				postgres: 0,
				redis: 0,
				total: 0,
			};

			const statusCount: Record<string, number> = {
				idle: 0,
				running: 0,
				done: 0,
				error: 0,
				paused: 0,
			};

			for (const environment of project.environments) {
				servicesCount.applications += environment.applications.length;
				servicesCount.compose += environment.compose.length;
				servicesCount.mariadb += environment.mariadb.length;
				servicesCount.mongo += environment.mongo.length;
				servicesCount.mysql += environment.mysql.length;
				servicesCount.postgres += environment.postgres.length;
				servicesCount.redis += environment.redis.length;

				for (const app of environment.applications) {
					statusCount[app.applicationStatus] =
						(statusCount[app.applicationStatus] || 0) + 1;
				}
				for (const service of environment.compose) {
					statusCount[service.composeStatus] =
						(statusCount[service.composeStatus] || 0) + 1;
				}
				for (const service of environment.mariadb) {
					statusCount[service.applicationStatus] =
						(statusCount[service.applicationStatus] || 0) + 1;
				}
				for (const service of environment.mongo) {
					statusCount[service.applicationStatus] =
						(statusCount[service.applicationStatus] || 0) + 1;
				}
				for (const service of environment.mysql) {
					statusCount[service.applicationStatus] =
						(statusCount[service.applicationStatus] || 0) + 1;
				}
				for (const service of environment.postgres) {
					statusCount[service.applicationStatus] =
						(statusCount[service.applicationStatus] || 0) + 1;
				}
				for (const service of environment.redis) {
					statusCount[service.applicationStatus] =
						(statusCount[service.applicationStatus] || 0) + 1;
				}
			}

			servicesCount.total =
				servicesCount.applications +
				servicesCount.compose +
				servicesCount.mariadb +
				servicesCount.mongo +
				servicesCount.mysql +
				servicesCount.postgres +
				servicesCount.redis;

			return {
				projectId: project.projectId,
				name: project.name,
				description: project.description,
				createdAt: project.createdAt,
				environmentsCount: project.environments.length,
				servicesCount,
				statusCount,
			};
		});
	}),
	servicesByProjectId: protectedProcedure
		.input(apiFindOneProject)
		.query(async ({ input, ctx }) => {
			const project = await findProjectById(input.projectId);

			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this project",
				});
			}

			let accessedEnvironments: string[] | undefined = undefined;
			let accessedServices: string[] | undefined = undefined;

			if (ctx.user.role === "member") {
				await checkProjectAccess(
					ctx.user.id,
					"access",
					ctx.session.activeOrganizationId,
					input.projectId,
				);

				const memberAccess = await findMemberById(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);
				accessedEnvironments = memberAccess.accessedEnvironments;
				accessedServices = memberAccess.accessedServices;
			}

			const projectEnvironments = await db.query.environments.findMany({
				where: and(
					eq(environments.projectId, input.projectId),
					buildEnvironmentFilter(accessedEnvironments),
				),
				columns: {
					environmentId: true,
					name: true,
				},
				with: {
					applications: {
						where: accessedServices
							? buildServiceFilter(applications.applicationId, accessedServices)
							: undefined,
						columns: {
							applicationId: true,
							appName: true,
							name: true,
							description: true,
							applicationStatus: true,
							createdAt: true,
							serverId: true,
						},
					},
					compose: {
						where: accessedServices
							? buildServiceFilter(compose.composeId, accessedServices)
							: undefined,
						columns: {
							composeId: true,
							appName: true,
							name: true,
							description: true,
							composeStatus: true,
							createdAt: true,
							serverId: true,
						},
					},
					mariadb: {
						where: accessedServices
							? buildServiceFilter(mariadb.mariadbId, accessedServices)
							: undefined,
						columns: {
							mariadbId: true,
							appName: true,
							name: true,
							description: true,
							applicationStatus: true,
							createdAt: true,
							serverId: true,
						},
					},
					mongo: {
						where: accessedServices
							? buildServiceFilter(mongo.mongoId, accessedServices)
							: undefined,
						columns: {
							mongoId: true,
							appName: true,
							name: true,
							description: true,
							applicationStatus: true,
							createdAt: true,
							serverId: true,
						},
					},
					mysql: {
						where: accessedServices
							? buildServiceFilter(mysql.mysqlId, accessedServices)
							: undefined,
						columns: {
							mysqlId: true,
							appName: true,
							name: true,
							description: true,
							applicationStatus: true,
							createdAt: true,
							serverId: true,
						},
					},
					postgres: {
						where: accessedServices
							? buildServiceFilter(postgres.postgresId, accessedServices)
							: undefined,
						columns: {
							postgresId: true,
							appName: true,
							name: true,
							description: true,
							applicationStatus: true,
							createdAt: true,
							serverId: true,
						},
					},
					redis: {
						where: accessedServices
							? buildServiceFilter(redis.redisId, accessedServices)
							: undefined,
						columns: {
							redisId: true,
							appName: true,
							name: true,
							description: true,
							applicationStatus: true,
							createdAt: true,
							serverId: true,
						},
					},
				},
			});

			return projectEnvironments.flatMap((environment) => [
				...environment.applications.map((service) => ({
					id: service.applicationId,
					type: "application" as const,
					appName: service.appName,
					name: service.name,
					description: service.description,
					status: service.applicationStatus,
					createdAt: service.createdAt,
					environmentId: environment.environmentId,
					environmentName: environment.name,
					serverId: service.serverId,
				})),
				...environment.compose.map((service) => ({
					id: service.composeId,
					type: "compose" as const,
					appName: service.appName,
					name: service.name,
					description: service.description,
					status: service.composeStatus,
					createdAt: service.createdAt,
					environmentId: environment.environmentId,
					environmentName: environment.name,
					serverId: service.serverId,
				})),
				...environment.mariadb.map((service) => ({
					id: service.mariadbId,
					type: "mariadb" as const,
					appName: service.appName,
					name: service.name,
					description: service.description,
					status: service.applicationStatus,
					createdAt: service.createdAt,
					environmentId: environment.environmentId,
					environmentName: environment.name,
					serverId: service.serverId,
				})),
				...environment.mongo.map((service) => ({
					id: service.mongoId,
					type: "mongo" as const,
					appName: service.appName,
					name: service.name,
					description: service.description,
					status: service.applicationStatus,
					createdAt: service.createdAt,
					environmentId: environment.environmentId,
					environmentName: environment.name,
					serverId: service.serverId,
				})),
				...environment.mysql.map((service) => ({
					id: service.mysqlId,
					type: "mysql" as const,
					appName: service.appName,
					name: service.name,
					description: service.description,
					status: service.applicationStatus,
					createdAt: service.createdAt,
					environmentId: environment.environmentId,
					environmentName: environment.name,
					serverId: service.serverId,
				})),
				...environment.postgres.map((service) => ({
					id: service.postgresId,
					type: "postgres" as const,
					appName: service.appName,
					name: service.name,
					description: service.description,
					status: service.applicationStatus,
					createdAt: service.createdAt,
					environmentId: environment.environmentId,
					environmentName: environment.name,
					serverId: service.serverId,
				})),
				...environment.redis.map((service) => ({
					id: service.redisId,
					type: "redis" as const,
					appName: service.appName,
					name: service.name,
					description: service.description,
					status: service.applicationStatus,
					createdAt: service.createdAt,
					environmentId: environment.environmentId,
					environmentName: environment.name,
					serverId: service.serverId,
				})),
			]).sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			);
		}),
	deploymentsByProjectId: protectedProcedure
		.input(apiFindOneProject)
		.query(async ({ input, ctx }) => {
			const project = await findProjectById(input.projectId);

			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this project",
				});
			}

			let accessedEnvironments: string[] | undefined = undefined;
			let accessedServices: string[] | undefined = undefined;

			if (ctx.user.role === "member") {
				await checkProjectAccess(
					ctx.user.id,
					"access",
					ctx.session.activeOrganizationId,
					input.projectId,
				);

				const memberAccess = await findMemberById(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);
				accessedEnvironments = memberAccess.accessedEnvironments;
				accessedServices = memberAccess.accessedServices;
			}

			const projectEnvironments = await db.query.environments.findMany({
				where: and(
					eq(environments.projectId, input.projectId),
					buildEnvironmentFilter(accessedEnvironments),
				),
				columns: {
					environmentId: true,
					name: true,
				},
				with: {
					applications: {
						where: accessedServices
							? buildServiceFilter(applications.applicationId, accessedServices)
							: undefined,
						columns: {
							applicationId: true,
							name: true,
							appName: true,
						},
					},
					compose: {
						where: accessedServices
							? buildServiceFilter(compose.composeId, accessedServices)
							: undefined,
						columns: {
							composeId: true,
							name: true,
							appName: true,
						},
					},
				},
			});

			const applicationMap = new Map<
				string,
				{ serviceType: "application"; serviceName: string; appName: string; environmentId: string; environmentName: string }
			>();
			const composeMap = new Map<
				string,
				{ serviceType: "compose"; serviceName: string; appName: string; environmentId: string; environmentName: string }
			>();

			for (const environment of projectEnvironments) {
				for (const app of environment.applications) {
					applicationMap.set(app.applicationId, {
						serviceType: "application",
						serviceName: app.name,
						appName: app.appName,
						environmentId: environment.environmentId,
						environmentName: environment.name,
					});
				}
				for (const service of environment.compose) {
					composeMap.set(service.composeId, {
						serviceType: "compose",
						serviceName: service.name,
						appName: service.appName,
						environmentId: environment.environmentId,
						environmentName: environment.name,
					});
				}
			}

			const applicationIds = Array.from(applicationMap.keys());
			const composeIds = Array.from(composeMap.keys());

			if (applicationIds.length === 0 && composeIds.length === 0) {
				return [];
			}

			const whereParts = [];
			if (applicationIds.length > 0) {
				whereParts.push(
					sql`${deployments.applicationId} IN (${sql.join(
						applicationIds.map((id) => sql`${id}`),
						sql`, `,
					)})`,
				);
			}
			if (composeIds.length > 0) {
				whereParts.push(
					sql`${deployments.composeId} IN (${sql.join(
						composeIds.map((id) => sql`${id}`),
						sql`, `,
					)})`,
				);
			}

			const projectDeployments = await db.query.deployments.findMany({
				where:
					whereParts.length === 1
						? whereParts[0]
						: sql`(${whereParts[0]}) OR (${whereParts[1]})`,
				columns: {
					deploymentId: true,
					title: true,
					description: true,
					status: true,
					createdAt: true,
					startedAt: true,
					finishedAt: true,
					errorMessage: true,
					applicationId: true,
					composeId: true,
					serverId: true,
					isPreviewDeployment: true,
				},
				orderBy: desc(deployments.createdAt),
			});

			return projectDeployments.map((deployment) => {
				const serviceDetails = deployment.applicationId
					? applicationMap.get(deployment.applicationId)
					: deployment.composeId
						? composeMap.get(deployment.composeId)
						: undefined;

				return {
					...deployment,
					serviceType: serviceDetails?.serviceType || null,
					serviceId: deployment.applicationId || deployment.composeId || null,
					serviceName: serviceDetails?.serviceName || null,
					serviceAppName: serviceDetails?.appName || null,
					environmentId: serviceDetails?.environmentId || null,
					environmentName: serviceDetails?.environmentName || null,
				};
			});
		}),
	healthByProjectId: protectedProcedure
		.input(apiFindOneProject)
		.query(async ({ input, ctx }) => {
			const project = await findProjectById(input.projectId);

			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this project",
				});
			}

			let accessedEnvironments: string[] | undefined = undefined;
			let accessedServices: string[] | undefined = undefined;

			if (ctx.user.role === "member") {
				await checkProjectAccess(
					ctx.user.id,
					"access",
					ctx.session.activeOrganizationId,
					input.projectId,
				);

				const memberAccess = await findMemberById(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);
				accessedEnvironments = memberAccess.accessedEnvironments;
				accessedServices = memberAccess.accessedServices;
			}

			const projectEnvironments = await db.query.environments.findMany({
				where: and(
					eq(environments.projectId, input.projectId),
					buildEnvironmentFilter(accessedEnvironments),
				),
				columns: {
					environmentId: true,
				},
				with: {
					applications: {
						where: accessedServices
							? buildServiceFilter(applications.applicationId, accessedServices)
							: undefined,
						columns: {
							applicationId: true,
							applicationStatus: true,
						},
					},
					compose: {
						where: accessedServices
							? buildServiceFilter(compose.composeId, accessedServices)
							: undefined,
						columns: {
							composeId: true,
							composeStatus: true,
						},
					},
					mariadb: {
						where: accessedServices
							? buildServiceFilter(mariadb.mariadbId, accessedServices)
							: undefined,
						columns: {
							mariadbId: true,
							applicationStatus: true,
						},
					},
					mongo: {
						where: accessedServices
							? buildServiceFilter(mongo.mongoId, accessedServices)
							: undefined,
						columns: {
							mongoId: true,
							applicationStatus: true,
						},
					},
					mysql: {
						where: accessedServices
							? buildServiceFilter(mysql.mysqlId, accessedServices)
							: undefined,
						columns: {
							mysqlId: true,
							applicationStatus: true,
						},
					},
					postgres: {
						where: accessedServices
							? buildServiceFilter(postgres.postgresId, accessedServices)
							: undefined,
						columns: {
							postgresId: true,
							applicationStatus: true,
						},
					},
					redis: {
						where: accessedServices
							? buildServiceFilter(redis.redisId, accessedServices)
							: undefined,
						columns: {
							redisId: true,
							applicationStatus: true,
						},
					},
				},
			});

			const services = projectEnvironments.flatMap((environment) => [
				...environment.applications.map((service) => ({
					id: service.applicationId,
					status: service.applicationStatus,
				})),
				...environment.compose.map((service) => ({
					id: service.composeId,
					status: service.composeStatus,
				})),
				...environment.mariadb.map((service) => ({
					id: service.mariadbId,
					status: service.applicationStatus,
				})),
				...environment.mongo.map((service) => ({
					id: service.mongoId,
					status: service.applicationStatus,
				})),
				...environment.mysql.map((service) => ({
					id: service.mysqlId,
					status: service.applicationStatus,
				})),
				...environment.postgres.map((service) => ({
					id: service.postgresId,
					status: service.applicationStatus,
				})),
				...environment.redis.map((service) => ({
					id: service.redisId,
					status: service.applicationStatus,
				})),
			]);

			const applicationIds = projectEnvironments.flatMap((environment) =>
				environment.applications.map((service) => service.applicationId),
			);
			const composeIds = projectEnvironments.flatMap((environment) =>
				environment.compose.map((service) => service.composeId),
			);

			let deploymentsList: Array<{
				deploymentId: string;
				status: "running" | "done" | "error" | "cancelled" | null;
				createdAt: string;
			}> = [];

			if (applicationIds.length > 0 || composeIds.length > 0) {
				const whereParts = [];

				if (applicationIds.length > 0) {
					whereParts.push(
						sql`${deployments.applicationId} IN (${sql.join(
							applicationIds.map((id) => sql`${id}`),
							sql`, `,
						)})`,
					);
				}
				if (composeIds.length > 0) {
					whereParts.push(
						sql`${deployments.composeId} IN (${sql.join(
							composeIds.map((id) => sql`${id}`),
							sql`, `,
						)})`,
					);
				}

				deploymentsList = await db.query.deployments.findMany({
					where:
						whereParts.length === 1
							? whereParts[0]
							: sql`(${whereParts[0]}) OR (${whereParts[1]})`,
					columns: {
						deploymentId: true,
						status: true,
						createdAt: true,
					},
					orderBy: desc(deployments.createdAt),
				});
			}

			const statusCount: Record<string, number> = {
				idle: 0,
				running: 0,
				done: 0,
				error: 0,
				paused: 0,
			};

			for (const service of services) {
				statusCount[service.status] = (statusCount[service.status] || 0) + 1;
			}

			const failedDeployments = deploymentsList.filter(
				(item) => item.status === "error",
			);
			const runningDeployments = deploymentsList.filter(
				(item) => item.status === "running",
			);

			const lastDeploymentAt = deploymentsList[0]?.createdAt || null;
			const unhealthyServiceIds = services
				.filter((service) => service.status === "error")
				.map((service) => service.id);

			return {
				projectId: input.projectId,
				summary: {
					totalServices: services.length,
					unhealthyServices: unhealthyServiceIds.length,
					failedDeployments: failedDeployments.length,
					runningDeployments: runningDeployments.length,
					lastDeploymentAt,
					healthy:
						unhealthyServiceIds.length === 0 &&
						failedDeployments.length === 0,
				},
				statusCount,
				unhealthyServiceIds,
			};
		}),
	applicationsByProjectId: protectedProcedure
		.input(apiFindOneProject)
		.query(async ({ input, ctx }) => {
			const project = await findProjectById(input.projectId);

			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this project",
				});
			}

			let accessedEnvironments: string[] | undefined = undefined;
			let accessedServices: string[] | undefined = undefined;

			if (ctx.user.role === "member") {
				await checkProjectAccess(
					ctx.user.id,
					"access",
					ctx.session.activeOrganizationId,
					input.projectId,
				);

				const memberAccess = await findMemberById(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);
				accessedEnvironments = memberAccess.accessedEnvironments;
				accessedServices = memberAccess.accessedServices;
			}

			const environmentFilter = accessedEnvironments
				? accessedEnvironments.length === 0
					? sql`false`
					: sql`${environments.environmentId} IN (${sql.join(
							accessedEnvironments.map((envId) => sql`${envId}`),
							sql`, `,
						)})`
				: undefined;

			const projectEnvironments = await db.query.environments.findMany({
				where: and(
					eq(environments.projectId, input.projectId),
					environmentFilter,
				),
				columns: {
					environmentId: true,
					name: true,
				},
				with: {
					applications: {
						where: accessedServices
							? buildServiceFilter(applications.applicationId, accessedServices)
							: undefined,
						columns: {
							applicationId: true,
							appName: true,
							name: true,
							description: true,
							applicationStatus: true,
							createdAt: true,
							environmentId: true,
							serverId: true,
							sourceType: true,
						},
					},
				},
			});

			return projectEnvironments.flatMap((environment) =>
				environment.applications.map((application) => ({
					...application,
					environmentName: environment.name,
				})),
			);
		}),
	applicationEnvironmentVariablesMeta: protectedProcedure
		.input(
			z.object({
				applicationId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (ctx.user.role === "member") {
				await checkServiceAccess(
					ctx.user.id,
					input.applicationId,
					ctx.session.activeOrganizationId,
					"access",
				);
			}

			const application = await db.query.applications.findFirst({
				where: eq(applications.applicationId, input.applicationId),
				columns: {
					applicationId: true,
					env: true,
					previewEnv: true,
				},
				with: {
					environment: {
						with: {
							project: {
								columns: {
									organizationId: true,
								},
							},
						},
					},
				},
			});

			if (!application) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Application not found",
				});
			}

			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}

			const envMeta = extractEnvVarMetadata(application.env, "env");
			const previewEnvMeta = extractEnvVarMetadata(
				application.previewEnv,
				"previewEnv",
			);

			return {
				applicationId: application.applicationId,
				total: envMeta.length + previewEnvMeta.length,
				env: envMeta,
				previewEnv: previewEnvMeta,
			};
		}),
	applicationEnvironmentVariablesReveal: protectedProcedure
		.input(
			z.object({
				applicationId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (ctx.user.role === "member") {
				await checkServiceAccess(
					ctx.user.id,
					input.applicationId,
					ctx.session.activeOrganizationId,
					"access",
				);
			}

			const application = await db.query.applications.findFirst({
				where: eq(applications.applicationId, input.applicationId),
				columns: {
					applicationId: true,
					env: true,
					previewEnv: true,
				},
				with: {
					environment: {
						with: {
							project: {
								columns: {
									organizationId: true,
								},
							},
						},
					},
				},
			});

			if (!application) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Application not found",
				});
			}

			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}

			return {
				applicationId: application.applicationId,
				env: application.env,
				previewEnv: application.previewEnv,
			};
		}),
	applicationEnvironmentVariables: protectedProcedure
		.input(
			z.object({
				applicationId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (ctx.user.role === "member") {
				await checkServiceAccess(
					ctx.user.id,
					input.applicationId,
					ctx.session.activeOrganizationId,
					"access",
				);
			}

			const application = await getApplicationEnvById(input.applicationId);

			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}

			return {
				applicationId: application.applicationId,
				env: application.env,
				previewEnv: application.previewEnv,
			};
		}),

	allForPermissions: withPermission("member", "update").query(
		async ({ ctx }) => {
			return await db.query.projects.findMany({
				where: eq(projects.organizationId, ctx.session.activeOrganizationId),
				orderBy: desc(projects.createdAt),
				columns: {
					projectId: true,
					name: true,
				},
				with: {
					environments: {
						columns: {
							environmentId: true,
							name: true,
							isDefault: true,
						},
						with: {
							applications: {
								columns: {
									applicationId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							mariadb: {
								columns: {
									mariadbId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							postgres: {
								columns: {
									postgresId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							mysql: {
								columns: {
									mysqlId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							mongo: {
								columns: {
									mongoId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							redis: {
								columns: {
									redisId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							compose: {
								columns: {
									composeId: true,
									appName: true,
									name: true,
									createdAt: true,
									composeStatus: true,
									description: true,
									serverId: true,
								},
							},
							libsql: {
								columns: {
									libsqlId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
						},
					},
				},
			});
		},
	),

	homeStats: protectedProcedure.query(async ({ ctx }) => {
		const isPrivileged = ctx.user.role === "owner" || ctx.user.role === "admin";

		let accessedProjects: string[] = [];
		let accessedEnvironments: string[] = [];
		let accessedServices: string[] = [];

		if (!isPrivileged) {
			const member = await findMemberByUserId(
				ctx.user.id,
				ctx.session.activeOrganizationId,
			);
			accessedProjects = member.accessedProjects;
			accessedEnvironments = member.accessedEnvironments;
			accessedServices = member.accessedServices;

			if (accessedProjects.length === 0) {
				return {
					projects: 0,
					environments: 0,
					applications: 0,
					compose: 0,
					databases: 0,
					services: 0,
					status: { running: 0, error: 0, idle: 0 },
				};
			}
		}

		const projectIdFilter = isPrivileged
			? eq(projects.organizationId, ctx.session.activeOrganizationId)
			: and(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((id) => sql`${id}`),
						sql`, `,
					)})`,
					eq(projects.organizationId, ctx.session.activeOrganizationId),
				);

		const environmentFilter = isPrivileged
			? undefined
			: accessedEnvironments.length === 0
				? sql`false`
				: sql`${environments.environmentId} IN (${sql.join(
						accessedEnvironments.map((envId) => sql`${envId}`),
						sql`, `,
					)})`;

		const applyFilter = (col: AnyPgColumn) =>
			isPrivileged ? undefined : buildServiceFilter(col, accessedServices);

		const rows = await db.query.projects.findMany({
			where: projectIdFilter,
			columns: { projectId: true },
			with: {
				environments: {
					where: environmentFilter,
					columns: { environmentId: true },
					with: {
						applications: {
							where: applyFilter(applications.applicationId),
							columns: { applicationStatus: true },
						},
						compose: {
							where: applyFilter(compose.composeId),
							columns: { composeStatus: true },
						},
						libsql: {
							where: applyFilter(libsql.libsqlId),
							columns: { applicationStatus: true },
						},
						mariadb: {
							where: applyFilter(mariadb.mariadbId),
							columns: { applicationStatus: true },
						},
						mongo: {
							where: applyFilter(mongo.mongoId),
							columns: { applicationStatus: true },
						},
						mysql: {
							where: applyFilter(mysql.mysqlId),
							columns: { applicationStatus: true },
						},
						postgres: {
							where: applyFilter(postgres.postgresId),
							columns: { applicationStatus: true },
						},
						redis: {
							where: applyFilter(redis.redisId),
							columns: { applicationStatus: true },
						},
					},
				},
			},
		});

		let applicationsCount = 0;
		let composeCount = 0;
		let databasesCount = 0;
		let environmentsCount = 0;
		const status = { running: 0, error: 0, idle: 0 };
		const bump = (s?: string | null) => {
			if (s === "done") status.running++;
			else if (s === "error") status.error++;
			else status.idle++;
		};

		for (const project of rows) {
			for (const env of project.environments) {
				environmentsCount++;
				applicationsCount += env.applications.length;
				composeCount += env.compose.length;
				databasesCount +=
					env.libsql.length +
					env.mariadb.length +
					env.mongo.length +
					env.mysql.length +
					env.postgres.length +
					env.redis.length;

				for (const a of env.applications) bump(a.applicationStatus);
				for (const c of env.compose) bump(c.composeStatus);
				for (const s of env.libsql) bump(s.applicationStatus);
				for (const s of env.mariadb) bump(s.applicationStatus);
				for (const s of env.mongo) bump(s.applicationStatus);
				for (const s of env.mysql) bump(s.applicationStatus);
				for (const s of env.postgres) bump(s.applicationStatus);
				for (const s of env.redis) bump(s.applicationStatus);
			}
		}

		return {
			projects: rows.length,
			environments: environmentsCount,
			applications: applicationsCount,
			compose: composeCount,
			databases: databasesCount,
			services: applicationsCount + composeCount + databasesCount,
			status,
		};
	}),

	search: protectedProcedure
		.input(
			z.object({
				q: z.string().optional(),
				name: z.string().optional(),
				description: z.string().optional(),
				limit: z.number().min(1).max(100).default(20),
				offset: z.number().min(0).default(0),
			}),
		)
		.query(async ({ ctx, input }) => {
			const baseConditions = [
				eq(projects.organizationId, ctx.session.activeOrganizationId),
			];

			if (input.q?.trim()) {
				const term = `%${input.q.trim()}%`;
				baseConditions.push(
					or(
						ilike(projects.name, term),
						ilike(projects.description ?? "", term),
					)!,
				);
			}

			if (input.name?.trim()) {
				baseConditions.push(ilike(projects.name, `%${input.name.trim()}%`));
			}
			if (input.description?.trim()) {
				baseConditions.push(
					ilike(projects.description ?? "", `%${input.description.trim()}%`),
				);
			}

			if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
				const { accessedProjects } = await findMemberByUserId(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);
				if (accessedProjects.length === 0) return { items: [], total: 0 };
				baseConditions.push(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((id) => sql`${id}`),
						sql`, `,
					)})`,
				);
			}

			const where = and(...baseConditions);

			const [items, countResult] = await Promise.all([
				db.query.projects.findMany({
					where,
					limit: input.limit,
					offset: input.offset,
					orderBy: desc(projects.createdAt),
					columns: {
						projectId: true,
						name: true,
						description: true,
						createdAt: true,
						organizationId: true,
						env: true,
					},
				}),
				db
					.select({ count: sql<number>`count(*)::int` })
					.from(projects)
					.where(where),
			]);

			return {
				items,
				total: countResult[0]?.count ?? 0,
			};
		}),

	remove: protectedProcedure
		.input(apiRemoveProject)
		.mutation(async ({ input, ctx }) => {
			try {
				const currentProject = await findProjectById(input.projectId);
				if (
					currentProject.organizationId !== ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to delete this project",
					});
				}
				await checkProjectAccess(ctx, "delete", input.projectId);
				const deletedProject = await deleteProject(input.projectId);

				await audit(ctx, {
					action: "delete",
					resourceType: "project",
					resourceId: currentProject.projectId,
					resourceName: currentProject.name,
				});
				return deletedProject;
			} catch (error) {
				throw error;
			}
		}),
	update: protectedProcedure
		.input(apiUpdateProject)
		.mutation(async ({ input, ctx }) => {
			try {
				const currentProject = await findProjectById(input.projectId);
				if (
					currentProject.organizationId !== ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this project",
					});
				}

				if (
					typeof input.isFolder === "boolean" &&
					input.isFolder !== currentProject.isFolder
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Project type cannot be changed after creation",
					});
				}

				if (Object.prototype.hasOwnProperty.call(input, "parentProjectId")) {
					await validateProjectParent({
						organizationId: ctx.session.activeOrganizationId,
						parentProjectId: input.parentProjectId ?? null,
						projectId: input.projectId,
					});
				}

				if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
					const { accessedProjects } = await findMemberByUserId(
						ctx.user.id,
						ctx.session.activeOrganizationId,
					);
					if (!accessedProjects.includes(input.projectId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this project",
						});
					}
				}

				if (input.env !== undefined) {
					await checkPermission(ctx, { projectEnvVars: ["write"] });
				}

				const { projectId, ...projectData } = input;
				const project = await updateProjectById(projectId, {
					...projectData,
				});

				if (project) {
					await audit(ctx, {
						action: "update",
						resourceType: "project",
						resourceId: input.projectId,
						resourceName: project.name,
					});
				}
				return project;
			} catch (error) {
				throw error;
			}
		}),
	getWildcardDomainConfig: protectedProcedure
		.input(
			z.object({
				projectId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const project = await db.query.projects.findFirst({
				where: eq(projects.projectId, input.projectId),
				columns: {
					organizationId: true,
					wildcardDomain: true,
					useOrganizationWildcard: true,
				},
				with: {
					organization: {
						columns: {
							wildcardDomain: true,
						},
					},
				},
			});

			if (!project) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Project not found",
				});
			}

			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this project",
				});
			}

			return {
				projectWildcardDomain: project.wildcardDomain,
				useOrganizationWildcard: project.useOrganizationWildcard,
				organizationWildcardDomain: project.organization?.wildcardDomain || null,
			};
		}),
	updateWildcardDomain: protectedProcedure
		.input(
			z.object({
				projectId: z.string(),
				wildcardDomain: z.string().nullable(),
				useOrganizationWildcard: z.boolean(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const project = await findProjectById(input.projectId);

			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this project",
				});
			}

			const result = await db
				.update(projects)
				.set({
					wildcardDomain: input.wildcardDomain,
					useOrganizationWildcard: input.useOrganizationWildcard,
				})
				.where(eq(projects.projectId, input.projectId))
				.returning({
					wildcardDomain: projects.wildcardDomain,
					useOrganizationWildcard: projects.useOrganizationWildcard,
				});

			return result[0];
		}),
	duplicate: protectedProcedure
		.input(
			z.object({
				sourceEnvironmentId: z.string(),
				name: z.string(),
				description: z.string().optional(),
				includeServices: z.boolean().default(true),
				selectedServices: z
					.array(
						z.object({
							id: z.string(),
							type: z.enum([
								"application",
								"compose",
								"libsql",
								"mariadb",
								"mongo",
								"mysql",
								"postgres",
								"redis",
							]),
						}),
					)
					.optional(),
				duplicateInSameProject: z.boolean().default(false),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				await checkProjectAccess(ctx, "create");

				const sourceEnvironment = input.duplicateInSameProject
					? await findEnvironmentById(input.sourceEnvironmentId)
					: null;

				if (
					input.duplicateInSameProject &&
					sourceEnvironment?.project.organizationId !==
						ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this project",
					});
				}

				if (
					input.duplicateInSameProject &&
					sourceEnvironment &&
					ctx.user.role !== "owner" &&
					ctx.user.role !== "admin"
				) {
					const { accessedProjects } = await findMemberByUserId(
						ctx.user.id,
						ctx.session.activeOrganizationId,
					);
					if (!accessedProjects.includes(sourceEnvironment.project.projectId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this project",
						});
					}
				}

				const targetProject = input.duplicateInSameProject
					? sourceEnvironment
					: await createProject(
							{
								name: input.name,
								description: input.description,
								env: sourceEnvironment?.project.env,
								isFolder: false,
								parentProjectId: null,
							},
							ctx.session.activeOrganizationId,
						).then((value) => value.environment);

				if (input.includeServices) {
					const servicesToDuplicate = input.selectedServices || [];

					const duplicateService = async (id: string, type: string) => {
						switch (type) {
							case "application": {
								const {
									applicationId,
									domains,
									security,
									ports,
									registry,
									redirects,
									previewDeployments,
									mounts,
									appName,
									refreshToken,
									...application
								} = await findApplicationById(id);
								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newApplication = await createApplication({
									...application,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${application.name} (copy)`
										: application.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const domain of domains) {
									const { domainId, ...rest } = domain;
									await createDomain({
										...rest,
										applicationId: newApplication.applicationId,
										domainType: "application",
									});
								}

								for (const port of ports) {
									const { portId, ...rest } = port;
									await createPort({
										...rest,
										applicationId: newApplication.applicationId,
									});
								}

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newApplication.applicationId,
										serviceType: "application",
									});
								}

								for (const redirect of redirects) {
									const { redirectId, ...rest } = redirect;
									await createRedirect({
										...rest,
										applicationId: newApplication.applicationId,
									});
								}

								for (const secure of security) {
									const { securityId, ...rest } = secure;
									await createSecurity({
										...rest,
										applicationId: newApplication.applicationId,
									});
								}

								for (const previewDeployment of previewDeployments) {
									const { previewDeploymentId, ...rest } = previewDeployment;
									await createPreviewDeployment({
										...rest,
										applicationId: newApplication.applicationId,
										domainId: undefined,
									});
								}

								break;
							}
							case "compose": {
								const {
									composeId,
									mounts,
									domains,
									appName,
									refreshToken,
									...compose
								} = await findComposeById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newCompose = await createCompose({
									...compose,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${compose.name} (copy)`
										: compose.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newCompose.composeId,
										serviceType: "compose",
									});
								}

								for (const domain of domains) {
									const { domainId, ...rest } = domain;
									await createDomain({
										...rest,
										composeId: newCompose.composeId,
										domainType: "compose",
									});
								}

								break;
							}
							case "libsql": {
								const { libsqlId, mounts, appName, ...libsql } =
									await findLibsqlById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newLibsql = await createLibsql({
									...libsql,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${libsql.name} (copy)`
										: libsql.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newLibsql.libsqlId,
										serviceType: "libsql",
									});
								}

								break;
							}
							case "mariadb": {
								const { mariadbId, mounts, backups, appName, ...mariadb } =
									await findMariadbById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newMariadb = await createMariadb({
									...mariadb,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${mariadb.name} (copy)`
										: mariadb.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newMariadb.mariadbId,
										serviceType: "mariadb",
									});
								}

								for (const backup of backups) {
									const { backupId, appName: _appName, ...rest } = backup;
									await createBackup({
										...rest,
										mariadbId: newMariadb.mariadbId,
									});
								}
								break;
							}
							case "mongo": {
								const { mongoId, mounts, backups, appName, ...mongo } =
									await findMongoById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newMongo = await createMongo({
									...mongo,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${mongo.name} (copy)`
										: mongo.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newMongo.mongoId,
										serviceType: "mongo",
									});
								}

								for (const backup of backups) {
									const { backupId, appName: _appName, ...rest } = backup;
									await createBackup({
										...rest,
										mongoId: newMongo.mongoId,
									});
								}
								break;
							}
							case "mysql": {
								const { mysqlId, mounts, backups, appName, ...mysql } =
									await findMySqlById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newMysql = await createMysql({
									...mysql,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${mysql.name} (copy)`
										: mysql.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newMysql.mysqlId,
										serviceType: "mysql",
									});
								}

								for (const backup of backups) {
									const { backupId, appName: _appName, ...rest } = backup;
									await createBackup({
										...rest,
										mysqlId: newMysql.mysqlId,
									});
								}
								break;
							}
							case "postgres": {
								const { postgresId, mounts, backups, appName, ...postgres } =
									await findPostgresById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newPostgres = await createPostgres({
									...postgres,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${postgres.name} (copy)`
										: postgres.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newPostgres.postgresId,
										serviceType: "postgres",
									});
								}

								for (const backup of backups) {
									const { backupId, ...rest } = backup;
									await createBackup({
										...rest,
										postgresId: newPostgres.postgresId,
									});
								}
								break;
							}
							case "redis": {
								const { redisId, mounts, appName, ...redis } =
									await findRedisById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newRedis = await createRedis({
									...redis,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${redis.name} (copy)`
										: redis.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newRedis.redisId,
										serviceType: "redis",
									});
								}

								break;
							}
						}
					};

					for (const service of servicesToDuplicate) {
						await duplicateService(service.id, service.type);
					}
				}

				if (!input.duplicateInSameProject) {
					await addNewProject(ctx, targetProject?.projectId || "");
				}

				await audit(ctx, {
					action: "create",
					resourceType: "project",
					resourceId: targetProject?.projectId || "",
					resourceName: input.name,
					metadata: { duplicatedFrom: input.sourceEnvironmentId },
				});
				return targetProject;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Error duplicating the project: ${error instanceof Error ? error.message : error}`,
					cause: error,
				});
			}
	}),
});

type TreeProjectNode = Awaited<
	ReturnType<typeof db.query.projects.findMany>
>[number] & {
	children: TreeProjectNode[];
};

function buildProjectTree(
	projectList: Awaited<ReturnType<typeof db.query.projects.findMany>>,
) {
	const nodeMap = new Map<string, TreeProjectNode>();
	const roots: TreeProjectNode[] = [];

	for (const project of projectList) {
		nodeMap.set(project.projectId, {
			...project,
			children: [],
		});
	}

	for (const project of projectList) {
		const node = nodeMap.get(project.projectId);
		if (!node) continue;

		if (project.parentProjectId) {
			const parentNode = nodeMap.get(project.parentProjectId);
			if (parentNode?.isFolder) {
				parentNode.children.push(node);
				continue;
			}
		}
		roots.push(node);
	}

	return roots;
}

async function validateProjectParent(input: {
	organizationId: string;
	parentProjectId: string | null;
	projectId?: string;
}) {
	const { organizationId, parentProjectId, projectId } = input;
	if (!parentProjectId) return;

	if (projectId && parentProjectId === projectId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "A project cannot be its own parent",
		});
	}

	const parentProject = await db.query.projects.findFirst({
		where: and(
			eq(projects.projectId, parentProjectId),
			eq(projects.organizationId, organizationId),
		),
		columns: {
			projectId: true,
			isFolder: true,
			parentProjectId: true,
		},
	});

	if (!parentProject) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Parent folder not found in this organization",
		});
	}

	if (!parentProject.isFolder) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Projects can only be placed inside folders",
		});
	}

	if (!projectId) return;

	const visited = new Set<string>();
	let currentParentId: string | null = parentProject.parentProjectId;
	visited.add(parentProject.projectId);

	while (currentParentId) {
		if (currentParentId === projectId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Cannot move a folder into one of its sub-folders",
			});
		}
		if (visited.has(currentParentId)) {
			break;
		}
		visited.add(currentParentId);

		const ancestor = await db.query.projects.findFirst({
			where: and(
				eq(projects.projectId, currentParentId),
				eq(projects.organizationId, organizationId),
			),
			columns: {
				parentProjectId: true,
			},
		});
		currentParentId = ancestor?.parentProjectId ?? null;
	}
}

function buildServiceFilter(
	fieldName: AnyPgColumn,
	accessedServices: string[],
) {
	return accessedServices.length === 0
		? sql`false`
		: sql`${fieldName} IN (${sql.join(
				accessedServices.map((serviceId) => sql`${serviceId}`),
				sql`, `,
			)})`;
}

function buildEnvironmentFilter(accessedEnvironments?: string[]) {
	if (!accessedEnvironments) {
		return undefined;
	}

	return accessedEnvironments.length === 0
		? sql`false`
		: sql`${environments.environmentId} IN (${sql.join(
				accessedEnvironments.map((envId) => sql`${envId}`),
				sql`, `,
			)})`;
}

function extractEnvVarMetadata(
	envText: string | null,
	source: "env" | "previewEnv",
) {
	const parsed = parseDotenv(envText ?? "");

	return Object.keys(parsed).map((key) => ({
		key,
		source,
		isSecret:
			/(token|secret|password|key|private|credential|auth)/i.test(key),
	}));
}

async function getApplicationEnvById(applicationId: string) {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		columns: {
			applicationId: true,
			env: true,
			previewEnv: true,
		},
		with: {
			environment: {
				with: {
					project: {
						columns: {
							organizationId: true,
						},
					},
				},
			},
		},
	});

	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}

	return application;
}
