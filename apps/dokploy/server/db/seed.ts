import bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import {
	account,
	applications,
	environments,
	member,
	organization,
	projects,
	server,
	user,
} from "@dokploy/server/db/schema";

const now = new Date();

const seedAdminEmail = (
	process.env.SEED_ADMIN_EMAIL ?? "admin@dokploy.local"
)
	.trim()
	.toLowerCase();
const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";
const seedAdminFirstName = process.env.SEED_ADMIN_FIRST_NAME ?? "Admin";
const seedAdminLastName = process.env.SEED_ADMIN_LAST_NAME ?? "User";

const seedServerName = process.env.SEED_SERVER_NAME ?? "Local Development Server";
const seedServerDescription =
	process.env.SEED_SERVER_DESCRIPTION ?? "Seeded local development server";
const seedServerIpAddress = process.env.SEED_SERVER_IP ?? "127.0.0.1";
const seedServerPort = Number(process.env.SEED_SERVER_PORT ?? "22");
const seedServerUsername = process.env.SEED_SERVER_USERNAME ?? "root";

const seedProjectName = process.env.SEED_PROJECT_NAME ?? "Starter Project";
const seedProjectDescription =
	process.env.SEED_PROJECT_DESCRIPTION ??
	"A default project created by the local seed script";

const seedEnvironmentName = process.env.SEED_ENVIRONMENT_NAME ?? "production";
const seedEnvironmentDescription =
	process.env.SEED_ENVIRONMENT_DESCRIPTION ?? "Production environment";

const seedApplicationName =
	process.env.SEED_APPLICATION_NAME ?? "Starter Application";
const seedApplicationAppName =
	process.env.SEED_APPLICATION_APP_NAME ?? "starter-application";
const seedApplicationDescription =
	process.env.SEED_APPLICATION_DESCRIPTION ??
	"A default application created by the local seed script";
const seedApplicationImage =
	process.env.SEED_APPLICATION_IMAGE ?? "nginx:alpine";

const logCreated = (label: string, created: boolean) => {
	console.log(`${created ? "Created" : "Updated"} ${label}`);
};

const seed = async () => {
	if (!Number.isFinite(seedServerPort) || seedServerPort < 1) {
		throw new Error(`Invalid SEED_SERVER_PORT value: ${seedServerPort}`);
	}

	await db.transaction(async (tx) => {
		let adminUser = await tx.query.user.findFirst({
			where: eq(user.email, seedAdminEmail),
		});
		let createdAdminUser = false;

		if (!adminUser) {
			const [createdAdminUserRow] = await tx
				.insert(user)
				.values({
					email: seedAdminEmail,
					emailVerified: true,
					firstName: seedAdminFirstName,
					lastName: seedAdminLastName,
					updatedAt: now,
					isRegistered: true,
				})
				.returning();
			adminUser = createdAdminUserRow;
			createdAdminUser = true;
		} else {
			await tx
				.update(user)
				.set({
					firstName: seedAdminFirstName,
					lastName: seedAdminLastName,
					emailVerified: true,
					updatedAt: now,
					isRegistered: true,
				})
				.where(eq(user.id, adminUser.id));
		}

		if (!adminUser) {
			throw new Error("Failed to create or load the seed admin user");
		}

		const passwordHash = await bcrypt.hash(seedAdminPassword, 10);
		const existingCredentialAccount = await tx.query.account.findFirst({
			where: and(
				eq(account.userId, adminUser.id),
				eq(account.providerId, "credential"),
			),
		});

		if (!existingCredentialAccount) {
			await tx.insert(account).values({
				userId: adminUser.id,
				providerId: "credential",
				password: passwordHash,
				createdAt: now,
				updatedAt: now,
			});
		} else {
			await tx
				.update(account)
				.set({
					password: passwordHash,
					updatedAt: now,
				})
				.where(
					and(
						eq(account.userId, adminUser.id),
						eq(account.providerId, "credential"),
					),
				);
		}

		let adminOrganization = await tx.query.organization.findFirst({
			where: eq(organization.ownerId, adminUser.id),
		});
		let createdOrganization = false;

		if (!adminOrganization) {
			const [createdOrganizationRow] = await tx
				.insert(organization)
				.values({
					name: "My Organization",
					ownerId: adminUser.id,
					createdAt: now,
				})
				.returning();
			adminOrganization = createdOrganizationRow;
			createdOrganization = true;
		} else if (adminOrganization.ownerId !== adminUser.id) {
			await tx
				.update(organization)
				.set({
					name: "My Organization",
					ownerId: adminUser.id,
				})
				.where(eq(organization.id, adminOrganization.id));
		}

		if (!adminOrganization) {
			throw new Error("Failed to create or load the seed organization");
		}

		const existingMembership = await tx.query.member.findFirst({
			where: and(
				eq(member.organizationId, adminOrganization.id),
				eq(member.userId, adminUser.id),
			),
		});

		if (!existingMembership) {
			await tx.insert(member).values({
				organizationId: adminOrganization.id,
				userId: adminUser.id,
				role: "owner",
				createdAt: now,
				isDefault: true,
			});
		} else {
			await tx
				.update(member)
				.set({
					userId: adminUser.id,
					role: "owner",
					isDefault: true,
				})
				.where(eq(member.id, existingMembership.id));
		}

		let seededServer = await tx.query.server.findFirst({
			where: and(
				eq(server.organizationId, adminOrganization.id),
				eq(server.name, seedServerName),
			),
		});
		let createdServer = false;

		if (!seededServer) {
			const [createdServerRow] = await tx
				.insert(server)
				.values({
					name: seedServerName,
					description: seedServerDescription,
					ipAddress: seedServerIpAddress,
					port: seedServerPort,
					username: seedServerUsername,
					organizationId: adminOrganization.id,
					createdAt: now.toISOString(),
				})
				.returning();
			seededServer = createdServerRow;
			createdServer = true;
		} else {
			await tx
				.update(server)
				.set({
					description: seedServerDescription,
					ipAddress: seedServerIpAddress,
					port: seedServerPort,
					username: seedServerUsername,
					organizationId: adminOrganization.id,
				})
				.where(eq(server.serverId, seededServer.serverId));
		}

		if (!seededServer) {
			throw new Error("Failed to create or load the seed server");
		}

		let seededProject = await tx.query.projects.findFirst({
			where: and(
				eq(projects.organizationId, adminOrganization.id),
				eq(projects.name, seedProjectName),
			),
		});
		let createdProject = false;

		if (!seededProject) {
			const [createdProjectRow] = await tx
				.insert(projects)
				.values({
					name: seedProjectName,
					description: seedProjectDescription,
					organizationId: adminOrganization.id,
					createdAt: now.toISOString(),
				})
				.returning();
			seededProject = createdProjectRow;
			createdProject = true;
		} else {
			await tx
				.update(projects)
				.set({
					description: seedProjectDescription,
					organizationId: adminOrganization.id,
				})
				.where(eq(projects.projectId, seededProject.projectId));
		}

		if (!seededProject) {
			throw new Error("Failed to create or load the seed project");
		}

		let seededEnvironment = await tx.query.environments.findFirst({
			where: and(
				eq(environments.projectId, seededProject.projectId),
				eq(environments.name, seedEnvironmentName),
			),
		});
		let createdEnvironment = false;

		if (!seededEnvironment) {
			const [createdEnvironmentRow] = await tx
				.insert(environments)
				.values({
					name: seedEnvironmentName,
					description: seedEnvironmentDescription,
					projectId: seededProject.projectId,
					isDefault: true,
					createdAt: now.toISOString(),
				})
				.returning();
			seededEnvironment = createdEnvironmentRow;
			createdEnvironment = true;
		} else {
			await tx
				.update(environments)
				.set({
					name: seedEnvironmentName,
					description: seedEnvironmentDescription,
					isDefault: true,
				})
				.where(eq(environments.environmentId, seededEnvironment.environmentId));
		}

		if (!seededEnvironment) {
			throw new Error("Failed to create or load the seed environment");
		}

		const existingApplication = await tx.query.applications.findFirst({
			where: eq(applications.appName, seedApplicationAppName),
		});
		let createdApplication = false;

		if (!existingApplication) {
			await tx.insert(applications).values({
				name: seedApplicationName,
				appName: seedApplicationAppName,
				description: seedApplicationDescription,
				environmentId: seededEnvironment.environmentId,
				serverId: seededServer.serverId,
				sourceType: "docker",
				dockerImage: seedApplicationImage,
				applicationStatus: "idle",
				createdAt: now.toISOString(),
			});
			createdApplication = true;
		} else {
			await tx
				.update(applications)
				.set({
					name: seedApplicationName,
					description: seedApplicationDescription,
					environmentId: seededEnvironment.environmentId,
					serverId: seededServer.serverId,
					sourceType: "docker",
					dockerImage: seedApplicationImage,
					applicationStatus: "idle",
				})
				.where(eq(applications.applicationId, existingApplication.applicationId));
		}

		logCreated("admin user", createdAdminUser);
		logCreated("organization", createdOrganization);
		logCreated("server", createdServer);
		logCreated("project", createdProject);
		logCreated("environment", createdEnvironment);
		logCreated("application", createdApplication);
	});

	console.log("");
	console.log("Seeded local admin credentials:");
	console.log(`Email: ${seedAdminEmail}`);
	console.log(`Password: ${seedAdminPassword}`);
};

seed().catch((error) => {
	console.error("Database seed failed");
	console.error(error);
	process.exitCode = 1;
});
