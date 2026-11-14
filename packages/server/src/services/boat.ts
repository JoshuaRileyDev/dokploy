import { randomBytes } from "node:crypto";
import { db } from "@dokploy/server/db";
import { boatSettings } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import ssh2 from "ssh2";
import { BoatApiError, BoatClient, boatSshTarget } from "../utils/boat/client";

export type BoatSettings = typeof boatSettings.$inferSelect;

export const findBoatSettings = async (organizationId: string) =>
	(await db.query.boatSettings.findFirst({
		where: eq(boatSettings.organizationId, organizationId),
	})) ?? null;

/**
 * The deployment queue silently builds a pool service elsewhere when the pool
 * can't take it, so the deploy log says why instead.
 */
export const boatBuildPoolFallbackReason = async (service: {
	boatBuildPool: boolean;
	buildServerId: string | null;
	buildRegistryId: string | null;
	environment: { project: { organizationId: string } };
}) => {
	if (!service.boatBuildPool || service.buildServerId) return null;
	if (!service.buildRegistryId) return "no build registry is set";
	const settings = await findBoatSettings(
		service.environment.project.organizationId,
	);
	if (!settings?.buildsEnabled) return "Boat builds are off in Settings → Boat";
	return "this deployment didn't go through the deployment queue";
};

export const updateBoatSettings = (
	organizationId: string,
	values: Partial<BoatSettings>,
) =>
	db
		.update(boatSettings)
		.set(values)
		.where(eq(boatSettings.organizationId, organizationId));

export const requireBoatSettings = async (organizationId: string) => {
	const settings = await findBoatSettings(organizationId);
	if (!settings) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Connect Boat first",
		});
	}
	return settings;
};

/** Saves the API key; a different key may be another Boat account, so snapshots made with the old one are forgotten. */
export const saveBoatConnection = async (
	apiKey: string,
	organizationId: string,
) => {
	try {
		await new BoatClient(apiKey).savedSnapshotAllowance();
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof BoatApiError && error.status === 401
					? "Boat rejected this API key"
					: error instanceof Error
						? error.message
						: "Couldn't reach Boat",
		});
	}
	const existing = await findBoatSettings(organizationId);
	if (!existing) {
		await db.insert(boatSettings).values({ organizationId, apiKey });
		return { created: true };
	}
	if (existing.apiKey !== apiKey) {
		await updateBoatSettings(organizationId, {
			apiKey,
			workflowSnapshotName: null,
			workflowSnapshotStatus: "none",
			workflowSnapshotError: null,
			workflowSnapshotBuiltAt: null,
		});
	}
	return { created: false };
};

export const removeBoatConnection = async (organizationId: string) => {
	const settings = await findBoatSettings(organizationId);
	if (!settings) return;
	if (settings.workflowSnapshotName) {
		await new BoatClient(settings.apiKey)
			.deleteSavedSnapshot(settings.workflowSnapshotName)
			.catch((error) =>
				console.error("Failed to delete the Boat workflow snapshot", error),
			);
	}
	await db
		.delete(boatSettings)
		.where(eq(boatSettings.organizationId, organizationId));
};

export const getBoatSummary = async (organizationId: string) => {
	const settings = await findBoatSettings(organizationId);
	if (!settings) return null;
	const { apiKey, ...rest } = settings;
	const snapshotAllowance = await new BoatClient(apiKey)
		.savedSnapshotAllowance()
		.catch(() => null);
	return {
		...rest,
		apiKeyHint: `…${apiKey.slice(-4)}`,
		snapshotAllowance,
	};
};

const generateSandboxKey = () => {
	const comment = `dokploy-boat-${randomBytes(6).toString("hex")}`;
	const keys = ssh2.utils.generateKeyPairSync("ed25519", { comment });
	return { comment, privateKey: keys.private, publicKey: keys.public };
};

/** Waits for a sandbox, authorizes a fresh key on it, and returns how to reach it over SSH. */
export const connectToBoatSandbox = async (
	client: BoatClient,
	sandboxId: string,
	signal?: AbortSignal,
) => {
	await client.waitForSandbox(sandboxId, signal);
	const key = generateSandboxKey();
	const access = await client.addSshKey(sandboxId, key.publicKey, signal);
	return { target: boatSshTarget(access, key.privateKey), key };
};
