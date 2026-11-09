import { db } from "@dokploy/server/db";
import {
	applications,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
	type ServiceType,
	server,
} from "@dokploy/server/db/schema";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { eq, inArray } from "drizzle-orm";
import { quote } from "shell-quote";

/** Docker's names: amd64, arm64, arm, … */
export type CpuArchitecture = string;

export const normalizeArchitecture = (
	raw: string | null | undefined,
): CpuArchitecture | null => {
	const value = raw?.trim().toLowerCase();
	if (!value) return null;
	if (["x86_64", "amd64", "x64"].includes(value)) return "amd64";
	if (["aarch64", "arm64", "armv8l"].includes(value)) return "arm64";
	if (value.startsWith("armv7") || value.startsWith("armv6")) return "arm";
	return value;
};

/** Cloud catalogs only distinguish x86 from 64-bit Arm. */
export const catalogArchitecture = (value: "x86" | "arm"): CpuArchitecture =>
	value === "arm" ? "arm64" : "amd64";

const runOn = async (serverId: string | null, command: string) =>
	serverId
		? (await execAsyncRemote(serverId, command)).stdout
		: // The Dokploy container shares the host kernel, so it reports the host's CPU.
			(await execAsync(command)).stdout;

export const detectServerArchitecture = async (serverId: string | null) => {
	try {
		return normalizeArchitecture(await runOn(serverId, "uname -m"));
	} catch {
		return null;
	}
};

interface ManifestDescriptor {
	Descriptor?: { platform?: { architecture?: string; os?: string } };
}

/**
 * Reads the Linux architectures from `docker manifest inspect -v`, which
 * prints one descriptor for a single-platform image and an array for a
 * multi-platform one. Attestation manifests report "unknown" and are skipped.
 */
export const parseManifestPlatforms = (output: string) => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	const descriptors = (
		Array.isArray(parsed) ? parsed : [parsed]
	) as ManifestDescriptor[];
	const architectures = new Set<CpuArchitecture>();
	for (const entry of descriptors) {
		const platform = entry?.Descriptor?.platform;
		if (platform?.os !== "linux") continue;
		const arch = normalizeArchitecture(platform.architecture);
		if (arch && arch !== "unknown") architectures.add(arch);
	}
	return architectures.size > 0 ? [...architectures] : null;
};

const IMAGE_MARKER = "@@dokploy-image ";
const MAX_IMAGES = 40;

/**
 * Asks the registry which platforms each image is published for. It runs on
 * the source server, which is already logged in to any private registry its
 * images came from. Images it can't read map to null.
 */
export const inspectImagePlatforms = async (
	serverId: string | null,
	images: string[],
) => {
	const unique = [...new Set(images.filter(Boolean))].slice(0, MAX_IMAGES);
	const result = new Map<string, CpuArchitecture[] | null>();
	if (unique.length === 0) return result;
	const script = unique
		.map(
			(image) =>
				`printf '%s\\n' ${quote([`${IMAGE_MARKER}${image}`])}; timeout 30 docker manifest inspect -v ${quote([image])} 2>/dev/null || true`,
		)
		.join("; ");
	let stdout = "";
	try {
		stdout = await runOn(serverId, script);
	} catch {}
	let current: string | null = null;
	const outputs = new Map<string, string[]>();
	for (const line of stdout.split("\n")) {
		if (line.startsWith(IMAGE_MARKER)) {
			current = line.slice(IMAGE_MARKER.length).trim();
			outputs.set(current, []);
		} else if (current) {
			outputs.get(current)?.push(line);
		}
	}
	for (const image of unique) {
		const output = outputs.get(image)?.join("\n").trim();
		result.set(image, output ? parseManifestPlatforms(output) : null);
	}
	return result;
};

export type ArchitectureStatus =
	/** Runs on the target as is, or is rebuilt there. */
	"ok" | "incompatible" | "unknown";

export interface ServiceArchitectureCheck {
	status: ArchitectureStatus;
	message: string;
	/** Persistent data that may not carry over between architectures. */
	dataWarning?: string;
}

export interface ArchitectureCheckService {
	id: string;
	type: ServiceType;
	appName: string;
	stateful: boolean;
}

const POSTGRES_IMAGE =
	/(^|\/)(postgres|postgis|timescaledb[\w-]*|pgvector)(:|@|$)/;

const POSTGRES_DATA_WARNING =
	"PostgreSQL data files are copied as is. Most x86↔Arm moves read fine, but text indexes (e.g. pg_trgm) can silently break because the CPUs treat char differently. Take a pg_dump first and REINDEX after the move.";

const VOLUME_DATA_WARNING =
	"Its volumes are copied as is. Anything compiled kept in them (node_modules, virtualenvs, plugins, binaries) was built for the old CPU and must be rebuilt.";

const imageVerdict = (
	image: string,
	platforms: CpuArchitecture[] | null | undefined,
	target: CpuArchitecture,
): ServiceArchitectureCheck => {
	if (!platforms) {
		return {
			status: "unknown",
			message: `Could not read the platforms of ${image} (private registry or not found). Check it is published for ${target}.`,
		};
	}
	if (platforms.includes(target)) {
		return { status: "ok", message: `${image} is published for ${target}` };
	}
	return {
		status: "incompatible",
		message: `${image} is only published for ${platforms.join(", ")}, not ${target}, so it won't start on the target`,
	};
};

const worst = (checks: ServiceArchitectureCheck[]) =>
	checks.find((c) => c.status === "incompatible") ??
	checks.find((c) => c.status === "unknown") ??
	checks[0];

const findComposeImages = async (
	serverId: string | null,
	appNames: string[],
) => {
	const byProject = new Map<string, string[]>();
	if (appNames.length === 0) return byProject;
	let stdout = "";
	try {
		stdout = await runOn(
			serverId,
			`docker ps -a --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.stack.namespace"}}|{{.Image}}'`,
		);
	} catch {}
	const wanted = new Set(appNames);
	for (const line of stdout.split("\n")) {
		const [compose, stack, image] = line.split("|").map((part) => part.trim());
		const project = wanted.has(compose ?? "")
			? compose
			: wanted.has(stack ?? "")
				? stack
				: undefined;
		if (!project || !image) continue;
		// Swarm pins the digest it resolved, which manifest inspect can't follow.
		const name = image.split("@")[0] as string;
		const list = byProject.get(project) ?? [];
		if (!list.includes(name)) list.push(name);
		byProject.set(project, list);
	}
	return byProject;
};

const DATABASE_TABLES = {
	postgres: { table: postgres, id: postgres.postgresId },
	mysql: { table: mysql, id: mysql.mysqlId },
	mariadb: { table: mariadb, id: mariadb.mariadbId },
	mongo: { table: mongo, id: mongo.mongoId },
	redis: { table: redis, id: redis.redisId },
	libsql: { table: libsql, id: libsql.libsqlId },
} as const;

const findDatabaseImages = async (services: ArchitectureCheckService[]) => {
	const images = new Map<string, string>();
	for (const [type, { table, id }] of Object.entries(DATABASE_TABLES)) {
		const ids = services.filter((s) => s.type === type).map((s) => s.id);
		if (ids.length === 0) continue;
		const rows = await db
			.select({ id, dockerImage: table.dockerImage })
			.from(table)
			.where(inArray(id, ids));
		for (const row of rows) images.set(row.id, row.dockerImage);
	}
	return images;
};

/**
 * Says, for each service, whether it can run on a target with a different CPU
 * architecture: apps built from source are rebuilt there, but prebuilt images
 * need a build for the target's platform, and some data doesn't carry over.
 */
export const checkServicesArchitecture = async (
	sourceServerId: string | null,
	services: ArchitectureCheckService[],
	target: CpuArchitecture,
) => {
	const result = new Map<string, ServiceArchitectureCheck>();
	if (services.length === 0) return result;

	const applicationIds = services
		.filter((s) => s.type === "application")
		.map((s) => s.id);
	const [apps, databaseImages, composeImages] = await Promise.all([
		applicationIds.length > 0
			? db.query.applications.findMany({
					where: inArray(applications.applicationId, applicationIds),
					columns: {
						applicationId: true,
						sourceType: true,
						dockerImage: true,
						buildServerId: true,
					},
				})
			: [],
		findDatabaseImages(services),
		findComposeImages(
			sourceServerId,
			services.filter((s) => s.type === "compose").map((s) => s.appName),
		),
	]);
	const appById = new Map(apps.map((app) => [app.applicationId, app]));

	const buildServerIds = [
		...new Set(apps.map((app) => app.buildServerId).filter(Boolean)),
	] as string[];
	const buildServers = new Map(
		await Promise.all(
			buildServerIds.map(async (id) => {
				const row = await db.query.server.findFirst({
					where: eq(server.serverId, id),
					columns: { name: true },
				});
				return [
					id,
					{
						name: row?.name ?? "the build server",
						arch: await detectServerArchitecture(id),
					},
				] as const;
			}),
		),
	);

	const externalImages: string[] = [];
	for (const service of services) {
		if (service.type === "application") {
			const app = appById.get(service.id);
			if (app?.sourceType === "docker" && app.dockerImage) {
				externalImages.push(app.dockerImage);
			}
		} else if (service.type === "compose") {
			externalImages.push(
				...(composeImages.get(service.appName) ?? []).filter(
					(image) => !image.startsWith(`${service.appName}-`),
				),
			);
		} else {
			const image = databaseImages.get(service.id);
			if (image) externalImages.push(image);
		}
	}
	const platforms = await inspectImagePlatforms(sourceServerId, externalImages);

	for (const service of services) {
		let check: ServiceArchitectureCheck;
		let isPostgres = service.type === "postgres";

		if (service.type === "application") {
			const app = appById.get(service.id);
			const build = app?.buildServerId
				? buildServers.get(app.buildServerId)
				: undefined;
			if (app?.sourceType === "docker" && app.dockerImage) {
				check = imageVerdict(
					app.dockerImage,
					platforms.get(app.dockerImage),
					target,
				);
			} else if (build && build.arch && build.arch !== target) {
				check = {
					status: "incompatible",
					message: `Built on ${build.name}, which is ${build.arch}, so its images won't run on the ${target} target. Pick a build server with the same CPU or build on the target.`,
				};
			} else if (build && !build.arch) {
				check = {
					status: "unknown",
					message: `Built on ${build.name}, whose CPU architecture could not be read. Its images must be built for ${target}.`,
				};
			} else {
				check = {
					status: "ok",
					message: `Rebuilt from source for ${target}${build ? ` on ${build.name}` : " on the target"}. Its Dockerfile's base images must support ${target}.`,
				};
			}
		} else if (service.type === "compose") {
			const images = composeImages.get(service.appName) ?? [];
			const external = images.filter(
				(image) => !image.startsWith(`${service.appName}-`),
			);
			isPostgres = images.some((image) => POSTGRES_IMAGE.test(image));
			if (images.length === 0) {
				check = {
					status: "unknown",
					message: `No containers found for it, so its images couldn't be checked. Every image it uses must be published for ${target}.`,
				};
			} else {
				const checks = external.map((image) =>
					imageVerdict(image, platforms.get(image), target),
				);
				check = worst(checks) ?? {
					status: "ok",
					message: `All of its images are built from source on the target for ${target}`,
				};
				if (check.status === "ok") {
					check = {
						status: "ok",
						message: `Its images are published for ${target} or built on the target`,
					};
				}
			}
		} else {
			const image = databaseImages.get(service.id);
			check = image
				? imageVerdict(image, platforms.get(image), target)
				: { status: "unknown", message: "Could not find its image" };
		}

		if (service.stateful) {
			if (isPostgres) {
				check = { ...check, dataWarning: POSTGRES_DATA_WARNING };
			} else if (service.type === "application" || service.type === "compose") {
				check = { ...check, dataWarning: VOLUME_DATA_WARNING };
			}
		}
		result.set(service.id, check);
	}
	return result;
};
