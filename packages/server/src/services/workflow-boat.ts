import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type apiSaveBoatWorkflowSettings,
	boatSettings,
	workflowRuns,
} from "@dokploy/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { BoatClient } from "../utils/boat/client";
import {
	ACT_VERSION,
	buildWarmActionCacheScript,
} from "../utils/workflows/act";
import {
	BOAT_RUNNER_CLI,
	installRunnerBundleScript,
} from "../utils/workflows/runner-bundle";
import { runRemoteScript } from "../utils/workflows/ssh";
import {
	type BoatSettings,
	connectToBoatSandbox,
	findBoatSettings,
	requireBoatSettings,
	updateBoatSettings,
} from "./boat";

/** Run directories on Boat sandboxes; the SSH user there can't write to the workflow server path. */
export const BOAT_RUNS_DIR = "/home/user/dokploy-runs";
export const BOAT_RUN_LABEL = "dokploy-run";
// Outlives the 6 hour run limit, so a sandbox Dokploy loses track of still stops on its own.
export const BOAT_RUN_TTL_SECONDS = 7 * 60 * 60;

// Boat starts a sandbox's daemons from the base image before laying the snapshot's files over them,
// so the base image's containerd can keep running and fail to start the snapshot's newer runc shim
// ("shim was started through the deprecated API but was built against the new API"). Restarting
// costs seconds, so it only happens when the running daemons differ from the installed ones.
export const BOAT_PREPARE_DOCKER_SCRIPT = [
	"set -eu",
	`running_docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)`,
	`installed_docker=$(dockerd --version | sed -E 's/^Docker version ([^,]+),.*/\\1/')`,
	`running_containerd=$(sudo ctr version 2>/dev/null | awk '/^Server:/ { server = 1 } server && /Version:/ { print $2; exit }')`,
	`installed_containerd=$(containerd --version | awk '{ print $3 }')`,
	'if [ "$running_docker" != "$installed_docker" ] || [ "$running_containerd" != "$installed_containerd" ]; then',
	'  echo "Restarting Docker (running ${running_docker:-none}, installed $installed_docker)"',
	"  sudo systemctl restart containerd docker",
	"fi",
	"docker version --format '{{.Server.Version}}' >/dev/null",
].join("\n");

// Boat restores a snapshot's Docker images with `docker load` after the sandbox reports ready, about
// 16s per runner image, and starting a container there takes seconds more. So the snapshot carries no
// runner images, and trusted jobs run on the sandbox itself, which is a throwaway Ubuntu 24.04 VM like
// a GitHub-hosted runner. Untrusted runs keep a container without the Docker socket.
const SANDBOX_LABELS = ["ubuntu-latest", "ubuntu-24.04", "self-hosted"];

export const boatPlatformImages = (trusted: boolean) =>
	trusted
		? Object.fromEntries(SANDBOX_LABELS.map((label) => [label, "-self-hosted"]))
		: undefined;

const DOCKER_CHECK_IMAGE = "ubuntu:24.04";

const buildSnapshotScript = (keyComment: string) =>
	[
		"set -euo pipefail",
		`echo "Installing act ${ACT_VERSION}"`,
		`curl -fsSL "https://raw.githubusercontent.com/nektos/act/v${ACT_VERSION}/install.sh" | sudo bash -s -- -b /usr/local/bin "v${ACT_VERSION}"`,
		"act --version",
		// Boat's base image ships Docker 29.7.0, whose archive extraction rejects paths through absolute
		// symlinks such as /var/run -> /run. act copies every remote action to /var/run/act/actions, so
		// all `uses:` steps fail there. Fixed in 29.7.1 (moby/moby#53261).
		'echo "Upgrading Docker"',
		"sudo apt-get update -qq -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0",
		"sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::=--force-confold --only-upgrade docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io",
		"sudo systemctl restart docker",
		"docker version --format 'Docker {{.Server.Version}}'",
		'echo "Checking actions can be copied into job containers"',
		`check=$(docker run -d --rm ${DOCKER_CHECK_IMAGE} sleep 120)`,
		"mkdir -p /tmp/act-check/var/run/act/actions/check@v1 && echo ok > /tmp/act-check/var/run/act/actions/check@v1/ok",
		'tar -C /tmp/act-check -c var/run/act/actions/check@v1 | docker cp - "$check:/"',
		'docker exec "$check" cat /var/run/act/actions/check@v1/ok',
		'docker rm -f "$check" >/dev/null && rm -rf /tmp/act-check',
		`docker rmi -f ${DOCKER_CHECK_IMAGE} >/dev/null`,
		'echo "Caching common actions"',
		buildWarmActionCacheScript(),
		'echo "Installing the Dokploy runner"',
		installRunnerBundleScript(),
		`${BOAT_RUNNER_CLI} --version`,
		`mkdir -p ${BOAT_RUNS_DIR}`,
		// The build key would otherwise be baked into every sandbox created from the snapshot.
		`sed -i '/${keyComment}/d' ~/.ssh/authorized_keys`,
		"sync",
	].join("\n");

let snapshotName: string | undefined;

/** Changes whenever the snapshot script or the bundled runner changes, so stale snapshots get rebuilt. */
export const boatSnapshotName = () => {
	if (!snapshotName) {
		const hash = createHash("sha256")
			.update(buildSnapshotScript(""))
			.digest("hex")
			.slice(0, 8);
		snapshotName = `dokploy-act-${ACT_VERSION.replaceAll(".", "-")}-${hash}`;
	}
	return snapshotName;
};

const RUN_RUNNER_CONFIG = "/home/user/.dokploy-run/runner.json";

/** What a run's sandbox needs to start its runner: Boat writes the files and runs the script once it's ready. */
export const boatRunRunnerSetup = (config: {
	url: string;
	workflowRunnerId: string;
	name: string;
	labels: string[];
	token: string;
}) => ({
	files: [
		{
			path: RUN_RUNNER_CONFIG,
			content: JSON.stringify({ ...config, workDir: BOAT_RUNS_DIR }),
		},
	],
	setupScript: [
		`chmod 600 ${RUN_RUNNER_CONFIG}`,
		`exec ${BOAT_RUNNER_CLI} start --once --config ${RUN_RUNNER_CONFIG}`,
	].join("\n"),
});

export const isBoatEnabledForWorkflows = async (organizationId: string) =>
	!!(await findBoatSettings(organizationId))?.workflowsEnabled;

// Dev can evaluate this module more than once, so in-flight builds live on globalThis.
const globalForBoat = globalThis as unknown as {
	__dokployBoatSnapshotBuilds?: Map<string, Promise<string>>;
};
globalForBoat.__dokployBoatSnapshotBuilds ??= new Map();
const builds = globalForBoat.__dokployBoatSnapshotBuilds;

export const isBoatSnapshotBuilding = (organizationId: string) =>
	builds.has(organizationId);

const hasCurrentSnapshot = (settings: BoatSettings) =>
	settings.workflowSnapshotStatus === "ready" &&
	settings.workflowSnapshotName === boatSnapshotName();

const buildSnapshot = async (
	settings: BoatSettings,
	name: string,
	log: (line: string) => void,
) => {
	const client = new BoatClient(settings.apiKey);
	const sandbox = await client.createSandbox({
		type: settings.workflowMachineType,
		name: "Dokploy act snapshot",
		ttlSeconds: 60 * 60,
		labels: { dokploy: "snapshot-build" },
	});
	try {
		const { target, key } = await connectToBoatSandbox(client, sandbox.id);
		const tail: string[] = [];
		const collect = (chunk: string) => {
			tail.push(...chunk.split("\n").filter(Boolean));
			tail.splice(0, Math.max(0, tail.length - 20));
		};
		const exitCode = await runRemoteScript({
			target,
			script: buildSnapshotScript(key.comment),
			onStdout: (chunk) => {
				collect(chunk);
				for (const line of chunk.split("\n").filter(Boolean)) log(line);
			},
			onStderr: collect,
		});
		if (exitCode !== 0) {
			throw new Error(
				`Preparing the snapshot failed with exit code ${exitCode}:\n${tail.join("\n")}`,
			);
		}
		log("Saving the snapshot");
		await client.saveSnapshot(sandbox.id, name);
		await client.waitForSavedSnapshot(name);
	} finally {
		await client
			.deleteSandbox(sandbox.id)
			.catch((error) =>
				console.error(`Failed to delete Boat sandbox ${sandbox.id}`, error),
			);
	}
	if (settings.workflowSnapshotName && settings.workflowSnapshotName !== name) {
		await client
			.deleteSavedSnapshot(settings.workflowSnapshotName)
			.catch((error) =>
				console.error(
					`Failed to delete old Boat snapshot ${settings.workflowSnapshotName}`,
					error,
				),
			);
	}
};

/**
 * Builds the organization's act snapshot unless a current one exists (`force` rebuilds it, e.g. to
 * pick up newer runner images). Concurrent callers share one build.
 */
export const ensureBoatSnapshot = (
	organizationId: string,
	{
		force = false,
		log = () => {},
	}: { force?: boolean; log?: (line: string) => void } = {},
) => {
	const inFlight = builds.get(organizationId);
	if (inFlight) return inFlight;

	const build = (async () => {
		const settings = await findBoatSettings(organizationId);
		if (!settings)
			throw new Error("Boat isn't connected for this organization");
		const name = boatSnapshotName();
		if (!force && hasCurrentSnapshot(settings)) return name;

		// A same-name refresh replaces the snapshot only once the new one is saved, so runs keep using it meanwhile.
		const usable = hasCurrentSnapshot(settings);
		if (!usable) {
			await updateBoatSettings(organizationId, {
				workflowSnapshotStatus: "building",
				workflowSnapshotError: null,
			});
		}
		try {
			await buildSnapshot(settings, name, log);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await updateBoatSettings(organizationId, {
				workflowSnapshotStatus: usable ? "ready" : "failed",
				workflowSnapshotError: message,
			});
			throw error;
		}
		await updateBoatSettings(organizationId, {
			workflowSnapshotName: name,
			workflowSnapshotStatus: "ready",
			workflowSnapshotError: null,
			workflowSnapshotBuiltAt: new Date().toISOString(),
		});
		return name;
	})().finally(() => builds.delete(organizationId));

	builds.set(organizationId, build);
	return build;
};

export const startBoatSnapshotBuild = (
	organizationId: string,
	force = false,
) => {
	ensureBoatSnapshot(organizationId, { force }).catch((error) =>
		console.error("Failed to build the Boat snapshot", error),
	);
};

/** Weekly, so Docker, act and the cached actions don't drift far from upstream. */
export const refreshBoatSnapshots = async () => {
	const all = await db.query.boatSettings.findMany({
		where: eq(boatSettings.workflowsEnabled, true),
		columns: { organizationId: true },
	});
	for (const { organizationId } of all) {
		await ensureBoatSnapshot(organizationId, { force: true }).catch((error) =>
			console.error(
				`Failed to refresh the Boat snapshot for ${organizationId}`,
				error,
			),
		);
	}
};

export const saveBoatWorkflowSettings = async (
	input: z.infer<typeof apiSaveBoatWorkflowSettings>,
	organizationId: string,
) => {
	await requireBoatSettings(organizationId);
	await updateBoatSettings(organizationId, {
		workflowsEnabled: input.enabled,
		workflowMachineType: input.machineType,
		workflowMaxConcurrentRuns: input.maxConcurrentRuns,
	});
	if (input.enabled) startBoatSnapshotBuild(organizationId);
};

/** Deletes a run's sandbox, including one whose id was lost because Dokploy stopped mid-create. */
export const releaseBoatRunSandbox = async (
	client: BoatClient,
	workflowRunId: string,
	sandboxId: string | null,
) => {
	const ids = new Set(sandboxId ? [sandboxId] : []);
	const labelled = await client
		.listSandboxIdsByLabel(`${BOAT_RUN_LABEL}=${workflowRunId}`)
		.catch(() => []);
	for (const id of labelled) ids.add(id);
	for (const id of ids) await client.deleteSandbox(id);
};

/** Deletes the sandboxes of Boat runs that were interrupted, e.g. by a Dokploy restart. */
export const releaseInterruptedBoatRuns = async (workflowRunIds: string[]) => {
	if (workflowRunIds.length === 0) return;
	const runs = await db.query.workflowRuns.findMany({
		where: and(
			inArray(workflowRuns.workflowRunId, workflowRunIds),
			eq(workflowRuns.runsOnBoat, true),
		),
		columns: { workflowRunId: true, boatSandboxId: true },
		with: { repository: { columns: { organizationId: true } } },
	});
	for (const run of runs) {
		const settings = await findBoatSettings(run.repository.organizationId);
		if (!settings) continue;
		await releaseBoatRunSandbox(
			new BoatClient(settings.apiKey),
			run.workflowRunId,
			run.boatSandboxId,
		).catch((error) =>
			console.error(
				`Failed to delete the Boat sandbox of run ${run.workflowRunId}`,
				error,
			),
		);
	}
};
