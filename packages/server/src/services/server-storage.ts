import { db } from "@dokploy/server/db";
import { server } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { Client } from "ssh2";

export interface StorageVolume {
	mount: string;
	filesystem: string;
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
	/** Same formula as df's Use%: blocks reserved for root count as neither used nor available */
	usedPercent: number;
	inodesTotal: number | null;
	inodesUsed: number | null;
	inodesUsedPercent: number | null;
	holdsRoot: boolean;
	holdsDocker: boolean;
	/** Set when this filesystem lives on an attached Hetzner volume */
	attachedVolumeId: string | null;
}

export interface AttachedVolumeUsage {
	filesystem: string;
	mount: string;
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
	usedPercent: number;
	inodesTotal: number | null;
	inodesUsed: number | null;
	inodesUsedPercent: number | null;
}

/** A Hetzner Cloud volume as the server sees it, mounted or not. */
export interface AttachedVolume {
	/** Hetzner's volume id; partitions keep the parent's id */
	volumeId: string;
	partition: number | null;
	device: string;
	sizeBytes: number;
	usage: AttachedVolumeUsage | null;
	/** The volume also holds "/" or Docker's data, so it is already listed in `volumes` */
	alsoListed: boolean;
}

export interface StorageSample {
	checkedAt: number;
	dockerRoot: string;
	volumes: StorageVolume[];
	attachedVolumes: AttachedVolume[];
}

export interface StorageHistoryPoint {
	t: number;
	usedBytes: number;
	totalBytes: number;
}

export interface ServerStorageResult {
	status: "ok" | "stale" | "error";
	sample: StorageSample | null;
	/** Primary volume usage over time, kept in memory while the server is being watched */
	history: StorageHistoryPoint[];
	error: string | null;
	errorAt: number | null;
}

const FRESH_MS = 10_000;
const MIN_FORCED_REFRESH_MS = 2_000;
const MAX_ERROR_BACKOFF_MS = 60_000;
const HISTORY_WINDOW_MS = 60 * 60_000;
const HISTORY_MAX_POINTS = 360;
const SSH_READY_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// `docker info` resolves a relocated data-root; `timeout` keeps a wedged daemon from stalling the poll.
export const STORAGE_COMMAND = [
	"LC_ALL=C; export LC_ALL",
	`root=$(timeout 3 docker info --format '{{.DockerRootDir}}' 2>/dev/null)`,
	`{ [ -n "$root" ] && [ -d "$root" ]; } || root=/var/lib/docker`,
	`[ -d "$root" ] || root=/`,
	`echo "docker-root $root"`,
	`df -kP / "$root" 2>/dev/null | sed 's/^/blocks /'`,
	`df -iP / "$root" 2>/dev/null | sed 's/^/inodes /'`,
	// Hetzner exposes each attached volume (and its partitions) under a stable by-id link.
	"for link in /dev/disk/by-id/scsi-0HC_Volume_*; do",
	`  [ -e "$link" ] || continue`,
	`  dev=$(readlink -f "$link")`,
	"  name=${link##*/scsi-0HC_Volume_}",
	`  sectors=$(cat "/sys/class/block/\${dev##*/}/size" 2>/dev/null || echo 0)`,
	`  mnt=$(findmnt -n -o TARGET --source "$dev" 2>/dev/null | head -n 1)`,
	`  echo "hcvol $name $dev $sectors $mnt"`,
	`  [ -n "$mnt" ] || continue`,
	`  df -kP "$mnt" 2>/dev/null | tail -n +2 | sed "s|^|hcblocks $name |"`,
	`  df -iP "$mnt" 2>/dev/null | tail -n +2 | sed "s|^|hcinodes $name |"`,
	"done",
	"exit 0",
].join("\n");

const toNumber = (value: string | undefined) => {
	if (value === undefined || !/^\d+$/.test(value)) return null;
	return Number(value);
};

const percent = (used: number, total: number) =>
	total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

export const parseStorageOutput = (
	stdout: string,
	checkedAt = Date.now(),
): StorageSample => {
	let dockerRoot = "/var/lib/docker";
	const blocks = new Map<
		string,
		{ filesystem: string; used: number; available: number }
	>();
	const inodes = new Map<string, { total: number; used: number }>();
	const pathOrder: string[] = [];
	const attached = new Map<
		string,
		{ device: string; sizeBytes: number; mounted: boolean }
	>();
	const attachedBlocks = new Map<
		string,
		{ filesystem: string; mount: string; used: number; available: number }
	>();
	const attachedInodes = new Map<string, { total: number; used: number }>();

	for (const line of stdout.split("\n")) {
		const [kind, ...rest] = line.trim().split(/\s+/);
		if (kind === "docker-root" && rest.length > 0) {
			dockerRoot = rest.join(" ");
			continue;
		}
		if (kind === "hcvol") {
			const [name, device, sectors, ...mountParts] = rest;
			if (!name || !device) continue;
			attached.set(name, {
				device,
				sizeBytes: (toNumber(sectors) ?? 0) * 512,
				mounted: mountParts.join(" ").length > 0,
			});
			continue;
		}
		if (kind === "hcblocks" || kind === "hcinodes") {
			const [
				name,
				filesystem = "",
				sizeRaw,
				usedRaw,
				availRaw,
				,
				...mountParts
			] = rest;
			const size = toNumber(sizeRaw);
			const used = toNumber(usedRaw);
			const available = toNumber(availRaw);
			if (!name || size === null || used === null || available === null) {
				continue;
			}
			if (kind === "hcblocks") {
				attachedBlocks.set(name, {
					filesystem,
					mount: mountParts.join(" "),
					used: used * 1024,
					available: available * 1024,
				});
			} else {
				attachedInodes.set(name, { total: size, used });
			}
			continue;
		}
		if (kind !== "blocks" && kind !== "inodes") continue;

		// POSIX df columns: filesystem, size, used, available, capacity, mount (may contain spaces)
		const [filesystem = "", sizeRaw, usedRaw, availRaw, , ...mountParts] = rest;
		const size = toNumber(sizeRaw);
		const used = toNumber(usedRaw);
		const available = toNumber(availRaw);
		const mount = mountParts.join(" ");
		if (size === null || used === null || available === null || !mount) {
			continue;
		}

		if (kind === "blocks") {
			if (!blocks.has(mount)) {
				pathOrder.push(mount);
				blocks.set(mount, {
					filesystem,
					used: used * 1024,
					available: available * 1024,
				});
			}
		} else {
			inodes.set(mount, { total: size, used });
		}
	}

	if (blocks.size === 0) {
		throw new Error("Could not read disk usage from df");
	}

	// df prints rows in argument order: "/" first, then the Docker root's filesystem.
	const rootMount = pathOrder[0];
	const dockerMount = pathOrder[pathOrder.length - 1];

	const attachedVolumes: AttachedVolume[] = [];
	const volumeIdByMount = new Map<string, string>();
	for (const [name, entry] of attached) {
		const match = /^(\d+)(?:-part(\d+))?$/.exec(name);
		if (!match?.[1]) continue;
		const volumeId = match[1];
		const partition = match[2] ? Number(match[2]) : null;
		// A partitioned volume's whole-disk link is never mounted itself; its partitions are listed instead.
		if (
			partition === null &&
			!entry.mounted &&
			[...attached.keys()].some((key) => key.startsWith(`${volumeId}-part`))
		) {
			continue;
		}
		const block = attachedBlocks.get(name);
		const inode = attachedInodes.get(name);
		const hasInodes = !!inode && inode.total > 0;
		const usage: AttachedVolumeUsage | null = block
			? {
					filesystem: block.filesystem,
					mount: block.mount,
					totalBytes: block.used + block.available,
					usedBytes: block.used,
					availableBytes: block.available,
					usedPercent: percent(block.used, block.used + block.available),
					inodesTotal: hasInodes ? inode.total : null,
					inodesUsed: hasInodes ? inode.used : null,
					inodesUsedPercent: hasInodes
						? percent(inode.used, inode.total)
						: null,
				}
			: null;
		if (usage) volumeIdByMount.set(usage.mount, volumeId);
		attachedVolumes.push({
			volumeId,
			partition,
			device: entry.device,
			sizeBytes: entry.sizeBytes,
			usage,
			alsoListed: !!usage && blocks.has(usage.mount),
		});
	}
	attachedVolumes.sort(
		(a, b) =>
			a.volumeId.localeCompare(b.volumeId) ||
			(a.partition ?? 0) - (b.partition ?? 0),
	);

	const volumes = pathOrder.map((mount): StorageVolume => {
		const entry = blocks.get(mount)!;
		const inode = inodes.get(mount);
		const hasInodes = !!inode && inode.total > 0;
		const totalBytes = entry.used + entry.available;
		return {
			mount,
			filesystem: entry.filesystem,
			totalBytes,
			usedBytes: entry.used,
			availableBytes: entry.available,
			usedPercent: percent(entry.used, totalBytes),
			inodesTotal: hasInodes ? inode.total : null,
			inodesUsed: hasInodes ? inode.used : null,
			inodesUsedPercent: hasInodes ? percent(inode.used, inode.total) : null,
			holdsRoot: mount === rootMount,
			holdsDocker: mount === dockerMount,
			attachedVolumeId: volumeIdByMount.get(mount) ?? null,
		};
	});

	// The Docker volume is what fills up on a deploy server, so it leads.
	volumes.sort((a, b) => Number(b.holdsDocker) - Number(a.holdsDocker));

	return { checkedAt, dockerRoot, volumes, attachedVolumes };
};

const findServerConnection = async (serverId: string) => {
	const result = await db.query.server.findFirst({
		where: eq(server.serverId, serverId),
		columns: { ipAddress: true, port: true, username: true },
		with: { sshKey: { columns: { privateKey: true } } },
	});
	if (!result?.sshKey) {
		throw new Error("No SSH key available for this server");
	}
	return result;
};

// execAsyncRemote waits up to ~100s on an unreachable host and has no command timeout,
// which would leave live polls hanging, so storage uses its own bounded runner.
const runRemote = async (serverId: string, command: string) => {
	const target = await findServerConnection(serverId);

	return new Promise<string>((resolve, reject) => {
		const conn = new Client();
		let output = "";
		let settled = false;

		const finish = (error: Error | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			conn.end();
			if (error) reject(error);
			else resolve(output);
		};

		const timer = setTimeout(
			() => finish(new Error("Timed out reading disk usage")),
			COMMAND_TIMEOUT_MS,
		);

		conn
			.once("ready", () => {
				conn.exec(command, (err, stream) => {
					if (err) {
						finish(err);
						return;
					}
					stream
						.on("data", (data: Buffer) => {
							if (output.length < MAX_OUTPUT_BYTES) output += data.toString();
						})
						.on("close", () => finish(null));
					stream.stderr.resume();
				});
			})
			.on("error", (err) => {
				finish(
					new Error(
						err.level === "client-authentication"
							? "SSH key was not accepted"
							: `SSH connection failed: ${err.message}`,
					),
				);
			})
			.connect({
				host: target.ipAddress,
				port: target.port,
				username: target.username,
				privateKey: target.sshKey!.privateKey,
				readyTimeout: SSH_READY_TIMEOUT_MS,
			});
	});
};

interface CacheEntry {
	sample: StorageSample | null;
	history: StorageHistoryPoint[];
	error: string | null;
	errorAt: number | null;
	failures: number;
	inflight: Promise<void> | null;
}

const cache = new Map<string, CacheEntry>();

const getEntry = (serverId: string) => {
	let entry = cache.get(serverId);
	if (!entry) {
		entry = {
			sample: null,
			history: [],
			error: null,
			errorAt: null,
			failures: 0,
			inflight: null,
		};
		cache.set(serverId, entry);
	}
	return entry;
};

const errorBackoffMs = (failures: number) =>
	Math.min(MAX_ERROR_BACKOFF_MS, FRESH_MS * 2 ** Math.max(0, failures - 1));

const recordHistory = (entry: CacheEntry, sample: StorageSample) => {
	const primary = sample.volumes[0];
	if (!primary) return;
	entry.history.push({
		t: sample.checkedAt,
		usedBytes: primary.usedBytes,
		totalBytes: primary.totalBytes,
	});
	const cutoff = sample.checkedAt - HISTORY_WINDOW_MS;
	const firstKept = entry.history.findIndex((point) => point.t >= cutoff);
	entry.history.splice(
		0,
		Math.max(firstKept, entry.history.length - HISTORY_MAX_POINTS),
	);
};

const refresh = (serverId: string, entry: CacheEntry) => {
	entry.inflight ??= runRemote(serverId, STORAGE_COMMAND)
		.then((stdout) => {
			const sample = parseStorageOutput(stdout);
			entry.sample = sample;
			entry.error = null;
			entry.errorAt = null;
			entry.failures = 0;
			recordHistory(entry, sample);
		})
		.catch((error: unknown) => {
			entry.error =
				error instanceof Error ? error.message : "Failed to read disk usage";
			entry.errorAt = Date.now();
			entry.failures += 1;
		})
		.finally(() => {
			entry.inflight = null;
		});
	return entry.inflight;
};

const toResult = (entry: CacheEntry): ServerStorageResult => ({
	status: entry.error ? (entry.sample ? "stale" : "error") : "ok",
	sample: entry.sample,
	history: entry.history,
	error: entry.error,
	errorAt: entry.errorAt,
});

/**
 * Cached, de-duplicated disk usage for a remote server. Concurrent viewers share one SSH
 * round trip per FRESH_MS, and unreachable servers are retried with exponential backoff.
 */
export const getServerStorage = async (
	serverId: string,
	{ force = false }: { force?: boolean } = {},
): Promise<ServerStorageResult> => {
	const entry = getEntry(serverId);
	const now = Date.now();
	const sampleAge = entry.sample
		? now - entry.sample.checkedAt
		: Number.POSITIVE_INFINITY;
	const inErrorBackoff =
		entry.errorAt !== null &&
		now - entry.errorAt < errorBackoffMs(entry.failures);

	const shouldRefresh = force
		? sampleAge >= MIN_FORCED_REFRESH_MS &&
			(entry.errorAt === null || now - entry.errorAt >= MIN_FORCED_REFRESH_MS)
		: sampleAge >= FRESH_MS && !inErrorBackoff;

	if (shouldRefresh || entry.inflight) {
		await refresh(serverId, entry);
	}
	return toResult(entry);
};

export const forgetServerStorage = (serverId: string) => {
	cache.delete(serverId);
};
