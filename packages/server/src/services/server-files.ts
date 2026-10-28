import path from "node:path";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { runRemote } from "./server-storage";

export type ServerFileType = "directory" | "file" | "symlink" | "other";

export interface ServerFileEntry {
	name: string;
	path: string;
	type: ServerFileType;
	/** Space allocated on disk, so sparse files count only what they really use */
	sizeBytes: number;
	/** A separate filesystem is mounted here; its size is that filesystem's used space */
	mountPoint: boolean;
	/** Why deleting this entry from the explorer is refused, or null when it is allowed */
	protectedReason: string | null;
}

export interface ServerDirectoryListing {
	path: string;
	exists: boolean;
	entries: ServerFileEntry[];
	/** Null when measuring was cut short before the folder total came in */
	totalBytes: number | null;
	entryCount: number;
	/** Only the largest entries were sent back */
	truncated: boolean;
	/** Measuring hit the time limit, so the largest entries may be missing */
	partial: boolean;
	dockerRoot: string;
	checkedAt: number;
}

const LIST_LIMIT = 500;
const DU_TIMEOUT_SECONDS = 90;
const LIST_TIMEOUT_MS = (DU_TIMEOUT_SECONDS + 20) * 1000;
const DELETE_TIMEOUT_SECONDS = 600;
const CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_DOCKER_ROOT = "/var/lib/docker";

const SYSTEM_TREES = [
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/proc",
	"/run",
	"/sbin",
	"/snap",
	"/sys",
	"/usr",
	"/var/lib/apt",
	"/var/lib/dpkg",
	"/var/lib/systemd",
];

const DOCKER_TREES = ["/var/lib/containerd"];

// Deleting these would break routing, SSH access or Dokploy's own bookkeeping on the server.
const DOKPLOY_TREES = [
	"/etc/dokploy/traefik",
	"/etc/dokploy/ssh",
	"/etc/dokploy/registry",
	"/etc/dokploy/monitoring",
];

const isWithin = (target: string, tree: string) =>
	target === tree || target.startsWith(`${tree}/`);

export const normalizeServerPath = (input: string) => {
	if (!input.startsWith("/") || /[\0\n]/.test(input)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path must be an absolute path",
		});
	}
	const normalized = path.posix.normalize(input);
	return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
};

export const deleteBlockReason = (
	target: string,
	dockerRoot: string,
): string | null => {
	const depth = target.split("/").filter(Boolean).length;
	if (depth <= 1) return "Top-level system path";
	const guarded = [
		dockerRoot,
		...DOCKER_TREES,
		"/etc/dokploy",
		...SYSTEM_TREES,
	];
	if (guarded.some((tree) => tree.startsWith(`${target}/`))) {
		return "Contains system, Docker or Dokploy data";
	}
	if (
		isWithin(target, dockerRoot) ||
		DOCKER_TREES.some((t) => isWithin(target, t))
	) {
		return "Managed by Docker. Use Docker cleanup to free this space safely";
	}
	if (DOKPLOY_TREES.some((tree) => isWithin(target, tree))) {
		return "Dokploy needs this folder to run the server";
	}
	if (target.split("/").includes(".ssh")) {
		return "SSH keys. Deleting them could lock Dokploy out of the server";
	}
	if (isWithin(target, "/etc/dokploy")) {
		return depth <= 3 ? "Dokploy needs this folder to run the server" : null;
	}
	if (SYSTEM_TREES.some((tree) => isWithin(target, tree))) {
		return "Part of the operating system";
	}
	if (depth === 2 && target.startsWith("/home/")) return "User home folder";
	if (depth === 3 && target.startsWith("/var/lib/")) {
		return "System service data";
	}
	return null;
};

const DOCKER_ROOT_SCRIPT = [
	`root=$(timeout 3 docker info --format '{{.DockerRootDir}}' 2>/dev/null)`,
	`[ -n "$root" ] || root=${DEFAULT_DOCKER_ROOT}`,
	`root=$(readlink -f -- "$root" 2>/dev/null || printf '%s' "$root")`,
	`printf 'docker-root\\t%s\\0' "$root"`,
];

// Filesystems that hold no disk data (or, for overlay and squashfs, only repeat data stored elsewhere).
const NON_DISK_FILESYSTEMS = new Set([
	"autofs",
	"binfmt_misc",
	"bpf",
	"cgroup",
	"cgroup2",
	"configfs",
	"debugfs",
	"devpts",
	"devtmpfs",
	"efivarfs",
	"fusectl",
	"hugetlbfs",
	"mqueue",
	"nsfs",
	"overlay",
	"proc",
	"pstore",
	"securityfs",
	"squashfs",
	"sysfs",
	"tmpfs",
	"tracefs",
]);

// du -x keeps the scan on this folder's filesystem, so "/" adds up like df; disks mounted
// inside the folder come from findmnt instead and are measured when opened.
export const listDirectoryCommand = (dir: string) =>
	[
		"LC_ALL=C; export LC_ALL",
		...DOCKER_ROOT_SCRIPT,
		`cd -- ${quote([dir])} 2>/dev/null || { printf 'missing\\0'; exit 0; }`,
		`printf 'real\\t%s\\0' "$(pwd -P)"`,
		`printf 'count\\t%s\\0' "$(find . -mindepth 1 -maxdepth 1 -printf . 2>/dev/null | wc -c)"`,
		"t=$(mktemp) || exit 1",
		`timeout ${DU_TIMEOUT_SECONDS} du -0 -a -x -B1 -d1 . 2>/dev/null > "$t"`,
		`printf 'du-exit\\t%s\\0' "$?"`,
		`sort -z -rn "$t" | head -z -n ${LIST_LIMIT + 1} > "$t.top"`,
		`printf 'sizes\\0'`,
		`cat "$t.top"`,
		`printf 'types\\0'`,
		`cut -z -f2- "$t.top" | xargs -0 -r sh -c 'find "$@" -maxdepth 0 -printf "%y\\t%p\\0"' sh 2>/dev/null`,
		`printf 'mounts\\0'`,
		`findmnt -rnb -o FSTYPE,USED,TARGET 2>/dev/null | tr '\\n' '\\0'`,
		`rm -f "$t" "$t.top"`,
		"exit 0",
	].join("\n");

const toType = (code: string): ServerFileType => {
	if (code === "d") return "directory";
	if (code === "f") return "file";
	if (code === "l") return "symlink";
	return "other";
};

const relativeName = (raw: string) => raw.replace(/^\.\//, "");

// findmnt's raw output escapes spaces and other unsafe bytes as \xHH.
const unescapeFindmnt = (value: string) =>
	value.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);

export const parseListOutput = (
	dir: string,
	stdout: string,
	checkedAt = Date.now(),
): ServerDirectoryListing => {
	let dockerRoot = DEFAULT_DOCKER_ROOT;
	let exists = true;
	let realDir = dir;
	let entryCount = 0;
	let partial = false;
	let totalBytes: number | null = null;
	let section: "head" | "sizes" | "types" | "mounts" = "head";
	const sizes = new Map<string, number>();
	const types = new Map<string, ServerFileType>();
	const mounts = new Map<string, number>();

	for (const record of stdout.split("\0")) {
		if (!record) continue;
		if (record === "sizes" || record === "types" || record === "mounts") {
			section = record;
			continue;
		}
		if (section === "mounts") {
			const [fstype = "", usedRaw = "", ...targetParts] = record.split(" ");
			const target = unescapeFindmnt(targetParts.join(" "));
			if (NON_DISK_FILESYSTEMS.has(fstype) || target === realDir) continue;
			if (path.posix.dirname(target) !== realDir) continue;
			mounts.set(path.posix.basename(target), Number(usedRaw) || 0);
			continue;
		}

		const tab = record.indexOf("\t");
		const head = tab === -1 ? record : record.slice(0, tab);
		const rest = tab === -1 ? "" : record.slice(tab + 1);

		if (section === "head") {
			if (head === "missing") exists = false;
			else if (head === "docker-root" && rest) dockerRoot = rest;
			else if (head === "real" && rest) realDir = rest;
			else if (head === "count") entryCount = Number(rest) || 0;
			// timeout exits 124 when it had to stop du; other non-zero codes are unreadable files.
			else if (head === "du-exit") partial = rest === "124" || rest === "137";
		} else if (section === "sizes") {
			const bytes = Number(head);
			if (!Number.isFinite(bytes)) continue;
			if (rest === ".") totalBytes = bytes;
			else sizes.set(relativeName(rest), bytes);
		} else {
			types.set(relativeName(rest), toType(head));
		}
	}

	const entryPath = (name: string) =>
		dir === "/" ? `/${name}` : `${dir}/${name}`;
	const entries: ServerFileEntry[] = [
		...[...sizes.entries()]
			.filter(([name]) => !mounts.has(name))
			.map(([name, sizeBytes]) => ({
				name,
				type: types.get(name) ?? ("other" as const),
				sizeBytes,
				mountPoint: false,
			})),
		...[...mounts.entries()].map(([name, sizeBytes]) => ({
			name,
			type: "directory" as const,
			sizeBytes,
			mountPoint: true,
		})),
	]
		.map((entry) => ({
			...entry,
			path: entryPath(entry.name),
			protectedReason:
				deleteBlockReason(entryPath(entry.name), dockerRoot) ??
				(entry.mountPoint
					? "A separate disk is mounted here. Open it to delete what's inside"
					: null),
		}))
		.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));

	return {
		path: dir,
		exists,
		entries,
		totalBytes,
		entryCount,
		truncated: sizes.size >= LIST_LIMIT,
		partial,
		dockerRoot,
		checkedAt,
	};
};

interface CacheEntry {
	listing: ServerDirectoryListing | null;
	inflight: Promise<ServerDirectoryListing> | null;
}

const cache = new Map<string, Map<string, CacheEntry>>();

const cacheFor = (serverId: string) => {
	let byPath = cache.get(serverId);
	if (!byPath) {
		byPath = new Map();
		cache.set(serverId, byPath);
	}
	return byPath;
};

/**
 * Measures a folder on a remote server. du over a large tree can take a minute, so results are
 * cached briefly and concurrent requests for the same folder share one scan.
 */
export const listServerDirectory = async (
	serverId: string,
	input: string,
	{ force = false }: { force?: boolean } = {},
): Promise<ServerDirectoryListing> => {
	const dir = normalizeServerPath(input);
	const byPath = cacheFor(serverId);
	let entry = byPath.get(dir);
	if (!entry) {
		entry = { listing: null, inflight: null };
		byPath.set(dir, entry);
	}
	if (entry.inflight) return entry.inflight;
	if (
		!force &&
		entry.listing &&
		Date.now() - entry.listing.checkedAt < CACHE_TTL_MS
	) {
		return entry.listing;
	}

	const current = entry;
	current.inflight = runRemote(serverId, listDirectoryCommand(dir), {
		timeoutMs: LIST_TIMEOUT_MS,
		maxOutputBytes: 1024 * 1024,
		timeoutMessage: "Timed out measuring the folder",
	})
		.then((stdout) => {
			const listing = parseListOutput(dir, stdout);
			current.listing = listing;
			return listing;
		})
		.finally(() => {
			current.inflight = null;
		});
	return current.inflight;
};

export const resolvePathCommand = (target: string) =>
	[
		"LC_ALL=C; export LC_ALL",
		...DOCKER_ROOT_SCRIPT,
		`p=${quote([target])}`,
		`{ [ -e "$p" ] || [ -L "$p" ]; } || { printf 'missing\\0'; exit 0; }`,
		`parent=$(cd -- "$(dirname -- "$p")" && pwd -P) || exit 1`,
		`printf 'resolved\\t%s\\0' "\${parent%/}/$(basename -- "$p")"`,
		`mountpoint -q -- "$p" 2>/dev/null && printf 'mountpoint\\0'`,
		"exit 0",
	].join("\n");

export const deletePathCommand = (resolved: string) =>
	[
		`out=$(timeout ${DELETE_TIMEOUT_SECONDS} rm -rf --one-file-system -- ${quote([resolved])} 2>&1)`,
		"status=$?",
		`printf '%s\\0exit\\t%s\\0' "$(printf '%s' "$out" | tail -n 5)" "$status"`,
	].join("\n");

/**
 * Deletes a file or folder on a remote server. The path is re-resolved on the server first so a
 * symlinked parent can't be used to reach a protected location.
 */
export const deleteServerPath = async (serverId: string, input: string) => {
	const target = normalizeServerPath(input);
	const stdout = await runRemote(serverId, resolvePathCommand(target), {
		timeoutMessage: "Timed out checking the path",
	});

	let dockerRoot = DEFAULT_DOCKER_ROOT;
	let resolved: string | null = null;
	let missing = false;
	let mountPoint = false;
	for (const record of stdout.split("\0")) {
		const tab = record.indexOf("\t");
		const head = tab === -1 ? record : record.slice(0, tab);
		const rest = tab === -1 ? "" : record.slice(tab + 1);
		if (head === "docker-root" && rest) dockerRoot = rest;
		else if (head === "resolved") resolved = rest;
		else if (head === "missing") missing = true;
		else if (head === "mountpoint") mountPoint = true;
	}

	if (missing) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "That path no longer exists",
		});
	}
	if (!resolved) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Couldn't resolve the path on the server",
		});
	}
	if (mountPoint) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "A filesystem is mounted here. Delete what's inside it instead",
		});
	}
	const reason =
		deleteBlockReason(target, dockerRoot) ??
		deleteBlockReason(normalizeServerPath(resolved), dockerRoot);
	if (reason) {
		throw new TRPCError({ code: "FORBIDDEN", message: reason });
	}

	const result = await runRemote(serverId, deletePathCommand(resolved), {
		timeoutMs: (DELETE_TIMEOUT_SECONDS + 20) * 1000,
		timeoutMessage: "Timed out deleting the path",
	});

	// Whatever happened, sizes up the tree are now out of date.
	cache.delete(serverId);

	const [output = "", exitRecord = ""] = result.split("\0");
	const status = exitRecord.replace(/^exit\t/, "");
	if (status !== "0") {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message:
				status === "124"
					? "Deleting took too long and was stopped part way through"
					: output.trim() || `rm exited with status ${status}`,
		});
	}
	return { path: target, resolvedPath: resolved };
};
