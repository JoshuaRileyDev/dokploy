import { beforeEach, describe, expect, test, vi } from "vitest";

const remote = vi.hoisted(() => ({
	runRemote: vi.fn<(serverId: string, command: string) => Promise<string>>(),
}));

vi.mock("@dokploy/server/services/server-storage", () => remote);

const { deleteBlockReason, deleteServerPath, parseListOutput } = await import(
	"@dokploy/server/services/server-files"
);

const records = (...items: string[]) => `${items.join("\0")}\0`;

// Captured from Ubuntu 24.04 with a volume mounted at "/data dir/vol".
const DATA_DIR = records(
	"docker-root\t/var/lib/docker",
	"real\t/data dir",
	"count\t6",
	"du-exit\t0",
	"sizes",
	"5226496\t.",
	"5005312\t./big folder",
	"200704\t./small.bin",
	"4096\t./tab\tname",
	"4096\t./new\nline",
	"0\t./link-to-etc",
	"types",
	"d\t.",
	"d\t./big folder",
	"f\t./small.bin",
	"f\t./tab\tname",
	"f\t./new\nline",
	"l\t./link-to-etc",
	"mounts",
	"overlay 10073358336 /",
	"proc 0 /proc",
	"tmpfs 0 /data\\x20dir/scratch",
	"ext4 10078584832 /data\\x20dir/vol",
	"ext4 500 /data\\x20dir/vol/nested",
);

describe("parseListOutput", () => {
	test("reads sizes, types and awkward names", () => {
		const listing = parseListOutput("/data dir", DATA_DIR, 1);
		expect(listing.totalBytes).toBe(5226496);
		expect(listing.partial).toBe(false);
		expect(listing.truncated).toBe(false);
		const byName = new Map(listing.entries.map((e) => [e.name, e]));
		expect(byName.get("big folder")).toMatchObject({
			path: "/data dir/big folder",
			type: "directory",
			sizeBytes: 5005312,
			mountPoint: false,
			protectedReason: null,
		});
		expect(byName.get("tab\tname")?.type).toBe("file");
		expect(byName.get("new\nline")?.type).toBe("file");
		expect(byName.get("link-to-etc")?.type).toBe("symlink");
	});

	test("lists disks mounted directly inside the folder, skipping RAM and nested mounts", () => {
		const listing = parseListOutput("/data dir", DATA_DIR, 1);
		const mounts = listing.entries.filter((e) => e.mountPoint);
		expect(mounts.map((e) => e.name)).toEqual(["vol"]);
		expect(mounts[0]).toMatchObject({
			type: "directory",
			sizeBytes: 10078584832,
		});
		expect(mounts[0]?.protectedReason).toMatch(/mounted/);
		expect(listing.entries[0]?.name).toBe("vol");
	});

	test("flags a folder that's gone and a scan that ran out of time", () => {
		expect(
			parseListOutput("/x", records("docker-root\t/d", "missing"), 1).exists,
		).toBe(false);
		const partial = parseListOutput(
			"/x",
			records("real\t/x", "du-exit\t124", "sizes", "10\t./a"),
			1,
		);
		expect(partial.partial).toBe(true);
		expect(partial.totalBytes).toBeNull();
	});
});

describe("deleteBlockReason", () => {
	const docker = "/var/lib/docker";

	test.each([
		"/",
		"/var",
		"/home",
		"/var/lib",
		"/var/lib/docker",
		"/var/lib/docker/overlay2/abc",
		"/var/lib/containerd/io",
		"/etc/passwd",
		"/usr/local/bin",
		"/etc/dokploy",
		"/etc/dokploy/applications",
		"/etc/dokploy/traefik/dynamic/app.yml",
		"/root/.ssh",
		"/home/deploy",
		"/var/lib/postgresql",
	])("refuses %s", (target) => {
		expect(deleteBlockReason(target, docker)).not.toBeNull();
	});

	test.each([
		"/etc/dokploy/applications/my-app-x1y2z3",
		"/etc/dokploy/logs/my-app",
		"/root/.cache",
		"/home/deploy/builds",
		"/var/log/syslog.1",
		"/tmp/act-cache",
		"/opt/old-release",
	])("allows %s", (target) => {
		expect(deleteBlockReason(target, docker)).toBeNull();
	});

	test("follows a relocated Docker root", () => {
		expect(
			deleteBlockReason("/mnt/data/docker/volumes", "/mnt/data/docker"),
		).toMatch(/Docker/);
		expect(deleteBlockReason("/mnt/data", "/mnt/data/docker")).not.toBeNull();
	});
});

describe("deleteServerPath", () => {
	beforeEach(() => remote.runRemote.mockReset());

	test("rejects relative paths before touching the server", async () => {
		await expect(deleteServerPath("s1", "tmp/x")).rejects.toThrow(/absolute/);
		expect(remote.runRemote).not.toHaveBeenCalled();
	});

	test("refuses a path that resolves into Docker through a symlink", async () => {
		remote.runRemote.mockResolvedValueOnce(
			records(
				"docker-root\t/var/lib/docker",
				"resolved\t/var/lib/docker/overlay2",
			),
		);
		await expect(deleteServerPath("s1", "/srv/link/overlay2")).rejects.toThrow(
			/Docker/,
		);
		expect(remote.runRemote).toHaveBeenCalledTimes(1);
	});

	test("refuses mount points", async () => {
		remote.runRemote.mockResolvedValueOnce(
			records("resolved\t/mnt/vol/data", "mountpoint"),
		);
		await expect(deleteServerPath("s1", "/mnt/vol/data")).rejects.toThrow(
			/mounted/,
		);
	});

	test("deletes the resolved path and reports rm failures", async () => {
		remote.runRemote
			.mockResolvedValueOnce(records("resolved\t/srv/builds/old"))
			.mockResolvedValueOnce(records("", "exit\t0"));
		await expect(deleteServerPath("s1", "/srv/builds/old/")).resolves.toEqual({
			path: "/srv/builds/old",
			resolvedPath: "/srv/builds/old",
		});
		expect(remote.runRemote.mock.calls[1]?.[1]).toContain(
			"rm -rf --one-file-system -- /srv/builds/old",
		);

		remote.runRemote
			.mockResolvedValueOnce(records("resolved\t/srv/ro"))
			.mockResolvedValueOnce(
				records("rm: cannot remove '/srv/ro/f': Permission denied", "exit\t1"),
			);
		await expect(deleteServerPath("s1", "/srv/ro")).rejects.toThrow(
			/Permission denied/,
		);
	});
});
