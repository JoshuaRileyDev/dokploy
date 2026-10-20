#!/usr/bin/env tsx

/**
 * Generates a migration for fork-only schema changes into `drizzle-fork/`.
 *
 * `drizzle/` must stay identical to upstream Dokploy, so `drizzle-kit generate`
 * can't be pointed at it directly: its latest snapshot lacks every fork change,
 * so each run would re-emit all of them. Instead we build a baseline snapshot
 * of "upstream + fork changes already applied" with a three-way merge, and let
 * drizzle-kit diff the schema against that in a scratch folder.
 *
 * Usage: pnpm migration:generate:fork <name>
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JournalEntry = {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
	upstreamSnapshotId?: string;
};
type Journal = { version: string; dialect: string; entries: JournalEntry[] };
type Snapshot = Record<string, unknown> & { id: string; prevId: string };

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamDir = join(appDir, "drizzle");
const forkDir = join(appDir, "drizzle-fork");

const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown) =>
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const pad = (idx: number) => String(idx).padStart(4, "0");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isEqual = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/** Applies the fork's changes (base -> fork) on top of upstream's (base -> upstream). */
export const merge3 = (
	base: unknown,
	upstream: unknown,
	fork: unknown,
): unknown => {
	if (isPlainObject(upstream) && isPlainObject(fork)) {
		const baseObj = isPlainObject(base) ? base : {};
		const out: Record<string, unknown> = {};
		for (const key of new Set([
			...Object.keys(upstream),
			...Object.keys(fork),
		])) {
			const inUpstream = key in upstream;
			const inFork = key in fork;
			const inBase = key in baseObj;
			if (inUpstream && inFork) {
				out[key] = merge3(baseObj[key], upstream[key], fork[key]);
			} else if (inFork && !inBase) {
				out[key] = fork[key];
			} else if (inUpstream && !inBase) {
				out[key] = upstream[key];
			}
			// Otherwise one side deleted a key that existed in base: keep it deleted.
		}
		return out;
	}
	if (isEqual(fork, base)) return upstream;
	if (isEqual(upstream, base)) return fork;
	if (Array.isArray(upstream) && Array.isArray(fork)) {
		return [
			...upstream,
			...fork.filter((v) => !upstream.some((u) => isEqual(u, v))),
		];
	}
	return fork;
};

const readUpstreamJournal = () =>
	readJson<Journal>(join(upstreamDir, "meta", "_journal.json"));

const latestUpstreamSnapshot = () => {
	const journal = readUpstreamJournal();
	const last = journal.entries.at(-1);
	if (!last) throw new Error("Upstream journal has no entries");
	return readJson<Snapshot>(
		join(upstreamDir, "meta", `${pad(last.idx)}_snapshot.json`),
	);
};

const findUpstreamSnapshot = (id: string) => {
	const metaDir = join(upstreamDir, "meta");
	for (const file of readdirSync(metaDir)) {
		if (!file.endsWith("_snapshot.json")) continue;
		const snapshot = readJson<Snapshot>(join(metaDir, file));
		if (snapshot.id === id) return snapshot;
	}
	throw new Error(
		`Upstream snapshot ${id} not found; drizzle/ must not be edited by the fork`,
	);
};

const readForkJournal = (): Journal => {
	const path = join(forkDir, "meta", "_journal.json");
	if (existsSync(path)) return readJson<Journal>(path);
	const { version, dialect } = readUpstreamJournal();
	return { version, dialect, entries: [] };
};

const buildBaseline = (forkJournal: Journal, upstreamLatest: Snapshot) => {
	const lastFork = forkJournal.entries.at(-1);
	if (!lastFork?.upstreamSnapshotId) return upstreamLatest;
	const forkSnapshot = readJson<Snapshot>(
		join(forkDir, "meta", `${pad(lastFork.idx)}_snapshot.json`),
	);
	const upstreamAtLastFork = findUpstreamSnapshot(lastFork.upstreamSnapshotId);
	const { id: _a, prevId: _b, ...base } = upstreamAtLastFork;
	const { id: _c, prevId: _d, ...upstream } = upstreamLatest;
	const { id: _e, prevId: _f, ...fork } = forkSnapshot;
	return {
		...(merge3(base, upstream, fork) as Record<string, unknown>),
		id: upstreamLatest.id,
		prevId: upstreamLatest.prevId,
	} as Snapshot;
};

const main = () => {
	const name = process.argv[2];
	if (!name || !/^[a-z0-9_]+$/.test(name)) {
		console.error("Usage: pnpm migration:generate:fork <snake_case_name>");
		process.exit(1);
	}

	const upstreamLatest = latestUpstreamSnapshot();
	const forkJournal = readForkJournal();
	const baseline = buildBaseline(forkJournal, upstreamLatest);

	// drizzle-kit resolves --out relative to cwd, so the scratch folder must live under appDir.
	const scratch = mkdtempSync(join(appDir, ".drizzle-fork-scratch-"));
	try {
		mkdirSync(join(scratch, "meta"));
		writeJson(join(scratch, "meta", "0000_snapshot.json"), baseline);
		writeJson(join(scratch, "meta", "_journal.json"), {
			version: forkJournal.version,
			dialect: forkJournal.dialect,
			entries: [
				{
					idx: 0,
					version: "7",
					when: 0,
					tag: "0000_baseline",
					breakpoints: true,
				},
			],
		});

		const result = spawnSync(
			"pnpm",
			[
				"exec",
				"drizzle-kit",
				"generate",
				"--dialect=postgresql",
				"--schema=./server/db/schema/index.ts",
				`--out=${relative(appDir, scratch)}`,
				`--name=${name}`,
			],
			{ cwd: appDir, encoding: "utf8" },
		);
		const output = `${result.stdout}${result.stderr}`;
		process.stdout.write(output);

		const generated = readJson<Journal>(join(scratch, "meta", "_journal.json"))
			.entries[1];
		if (!generated) {
			// drizzle-kit exits 0 on some failures, so only trust its explicit no-op message.
			if (/No schema changes/i.test(output)) {
				console.log("No fork schema changes, nothing generated.");
				return;
			}
			throw new Error("drizzle-kit generate failed, see output above");
		}

		const idx = forkJournal.entries.length;
		const tag = `${pad(idx)}_${name}`;
		mkdirSync(join(forkDir, "meta"), { recursive: true });
		copyFileSync(
			join(scratch, `${generated.tag}.sql`),
			join(forkDir, `${tag}.sql`),
		);
		copyFileSync(
			join(scratch, "meta", `${pad(generated.idx)}_snapshot.json`),
			join(forkDir, "meta", `${pad(idx)}_snapshot.json`),
		);
		forkJournal.entries.push({
			idx,
			version: generated.version,
			when: generated.when,
			tag,
			breakpoints: true,
			upstreamSnapshotId: upstreamLatest.id,
		});
		writeJson(join(forkDir, "meta", "_journal.json"), forkJournal);

		console.log(`Fork migration written to drizzle-fork/${tag}.sql`);
		console.log(
			"Review it: drop anything that alters upstream tables beyond additions.",
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
