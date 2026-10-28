import { beforeEach, describe, expect, test, vi } from "vitest";

const sshState = vi.hoisted(() => ({
	connects: 0,
	behaviour: "ok" as "ok" | "error" | "hang",
	stdout: "",
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			server: {
				findFirst: vi.fn(async () => ({
					ipAddress: "10.0.0.1",
					port: 22,
					username: "root",
					sshKey: { privateKey: "key" },
				})),
			},
		},
	},
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");
	class Client extends EventEmitter {
		connect() {
			sshState.connects++;
			setTimeout(() => {
				if (sshState.behaviour === "error") {
					this.emit("error", Object.assign(new Error("ECONNREFUSED"), {}));
				} else if (sshState.behaviour === "ok") {
					this.emit("ready");
				}
			}, 0);
			return this;
		}
		exec(_cmd: string, cb: (err: Error | null, stream: unknown) => void) {
			type Emitter = InstanceType<typeof EventEmitter>;
			const stream = new EventEmitter() as Emitter & {
				stderr: Emitter & { resume: () => void };
			};
			stream.stderr = Object.assign(new EventEmitter(), { resume: () => {} });
			cb(null, stream);
			setTimeout(() => {
				stream.emit("data", Buffer.from(sshState.stdout));
				stream.emit("close", 0);
			}, 0);
		}
		end() {}
	}
	return { Client };
});

const { forgetServerStorage, getServerStorage, parseStorageOutput } =
	await import("@dokploy/server/services/server-storage");

const SAME_DISK = `docker-root /var/lib/docker
blocks Filesystem     1024-blocks     Used Available Capacity Mounted on
blocks /dev/sda1        81106868 38000000  39000000      50% /
blocks /dev/sda1        81106868 38000000  39000000      50% /
inodes Filesystem      Inodes  IUsed   IFree IUse% Mounted on
inodes /dev/sda1      5160960 900000 4260960   18% /
inodes /dev/sda1      5160960 900000 4260960   18% /
`;

const SEPARATE_DISK = `docker-root /mnt/data/docker
blocks Filesystem     1024-blocks     Used Available Capacity Mounted on
blocks /dev/sda1        20000000 10000000  10000000      50% /
blocks /dev/sdb1       100000000 95000000   5000000      95% /mnt/data
inodes Filesystem      Inodes  IUsed   IFree IUse% Mounted on
inodes /dev/sda1      1000 100 900   10% /
inodes /dev/sdb1         0      0     0      - /mnt/data
`;

describe("parseStorageOutput", () => {
	test("collapses root and Docker on the same filesystem into one volume", () => {
		const sample = parseStorageOutput(SAME_DISK, 1);
		expect(sample.dockerRoot).toBe("/var/lib/docker");
		expect(sample.volumes).toHaveLength(1);
		expect(sample.volumes[0]).toMatchObject({
			mount: "/",
			filesystem: "/dev/sda1",
			usedBytes: 38000000 * 1024,
			availableBytes: 39000000 * 1024,
			totalBytes: 77000000 * 1024,
			usedPercent: 49.4,
			inodesTotal: 5160960,
			inodesUsedPercent: 17.4,
			holdsRoot: true,
			holdsDocker: true,
		});
	});

	test("puts a separate Docker volume first and tolerates missing inode counts", () => {
		const sample = parseStorageOutput(SEPARATE_DISK, 1);
		expect(sample.volumes.map((v) => v.mount)).toEqual(["/mnt/data", "/"]);
		expect(sample.volumes[0]).toMatchObject({
			holdsDocker: true,
			holdsRoot: false,
			usedPercent: 95,
			inodesTotal: null,
			inodesUsedPercent: null,
		});
		expect(sample.volumes[1]).toMatchObject({
			holdsDocker: false,
			holdsRoot: true,
			inodesUsedPercent: 10,
		});
	});

	test("keeps mount points that contain spaces", () => {
		const sample = parseStorageOutput(
			"blocks /dev/sdc1 1000 400 600 40% /mnt/my disk\n",
		);
		expect(sample.volumes[0]?.mount).toBe("/mnt/my disk");
	});

	test("reads attached Hetzner volumes, mounted or not", () => {
		const sample = parseStorageOutput(
			`${SAME_DISK}hcvol 100200300 /dev/sdb 41943040 /mnt/HC_Volume_100200300
hcblocks 100200300 /dev/sdb 20511312 16409049 3037739 85% /mnt/HC_Volume_100200300
hcinodes 100200300 /dev/sdb 1310720 120000 1190720 10% /mnt/HC_Volume_100200300
hcvol 100200400 /dev/sdc 20971520
`,
			1,
		);
		expect(sample.attachedVolumes).toEqual([
			{
				volumeId: "100200300",
				partition: null,
				device: "/dev/sdb",
				sizeBytes: 41943040 * 512,
				alsoListed: false,
				usage: {
					filesystem: "/dev/sdb",
					mount: "/mnt/HC_Volume_100200300",
					usedBytes: 16409049 * 1024,
					availableBytes: 3037739 * 1024,
					totalBytes: (16409049 + 3037739) * 1024,
					usedPercent: 84.4,
					inodesTotal: 1310720,
					inodesUsed: 120000,
					inodesUsedPercent: 9.2,
				},
			},
			{
				volumeId: "100200400",
				partition: null,
				device: "/dev/sdc",
				sizeBytes: 20971520 * 512,
				alsoListed: false,
				usage: null,
			},
		]);
		expect(sample.volumes[0]?.attachedVolumeId).toBeNull();
	});

	test("lists a partitioned volume by its partitions", () => {
		const sample = parseStorageOutput(
			`${SAME_DISK}hcvol 7 /dev/sdb 2097152
hcvol 7-part1 /dev/sdb1 2095104 /data
hcblocks 7-part1 /dev/sdb1 1000 100 900 10% /data
`,
		);
		expect(
			sample.attachedVolumes.map((v) => [
				v.volumeId,
				v.partition,
				v.usage?.mount,
			]),
		).toEqual([["7", 1, "/data"]]);
	});

	test("links a volume that also holds Docker's data to that filesystem", () => {
		const sample = parseStorageOutput(
			`${SEPARATE_DISK}hcvol 55 /dev/sdb1 200000000 /mnt/data
hcblocks 55 /dev/sdb1 100000000 95000000 5000000 95% /mnt/data
`,
		);
		expect(sample.volumes[0]).toMatchObject({
			mount: "/mnt/data",
			attachedVolumeId: "55",
		});
		expect(sample.attachedVolumes[0]?.alsoListed).toBe(true);
	});

	test("throws when df produced nothing usable", () => {
		expect(() => parseStorageOutput("")).toThrow();
		expect(() =>
			parseStorageOutput("blocks Filesystem 1024-blocks Used Available"),
		).toThrow();
	});
});

describe("getServerStorage", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000_000);
		sshState.connects = 0;
		sshState.behaviour = "ok";
		sshState.stdout = SAME_DISK;
		forgetServerStorage("srv");
	});

	test("shares one SSH round trip between concurrent and recent callers", async () => {
		const [a, b] = await Promise.all([
			getServerStorage("srv"),
			getServerStorage("srv"),
		]);
		expect(sshState.connects).toBe(1);
		expect(a.status).toBe("ok");
		expect(b.sample).toBe(a.sample);

		vi.setSystemTime(1_005_000);
		await getServerStorage("srv");
		expect(sshState.connects).toBe(1);

		vi.setSystemTime(1_011_000);
		const later = await getServerStorage("srv");
		expect(sshState.connects).toBe(2);
		expect(later.history).toHaveLength(2);
	});

	test("keeps the last reading when the server becomes unreachable, then backs off", async () => {
		await getServerStorage("srv");

		sshState.behaviour = "error";
		vi.setSystemTime(1_011_000);
		const stale = await getServerStorage("srv");
		expect(stale.status).toBe("stale");
		expect(stale.sample).not.toBeNull();
		expect(stale.error).toMatch(/SSH connection failed/);
		expect(sshState.connects).toBe(2);

		vi.setSystemTime(1_015_000);
		await getServerStorage("srv");
		expect(sshState.connects).toBe(2);

		sshState.behaviour = "ok";
		vi.setSystemTime(1_022_000);
		const recovered = await getServerStorage("srv");
		expect(recovered.status).toBe("ok");
		expect(recovered.error).toBeNull();
	});

	test("reports an error with no sample when the first read fails", async () => {
		sshState.behaviour = "error";
		const result = await getServerStorage("srv");
		expect(result.status).toBe("error");
		expect(result.sample).toBeNull();
	});

	test("force refresh bypasses the cache but not a sub-2s repeat", async () => {
		await getServerStorage("srv");
		await getServerStorage("srv", { force: true });
		expect(sshState.connects).toBe(1);

		vi.setSystemTime(1_003_000);
		await getServerStorage("srv", { force: true });
		expect(sshState.connects).toBe(2);
	});
});
