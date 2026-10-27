import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lastLines, readLogTail } from "@dokploy/server/utils/workflows/logs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("lastLines", () => {
	it("keeps the last lines without the trailing newline", () => {
		expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
		expect(lastLines("a\nb", 5)).toBe("a\nb");
		expect(lastLines("", 5)).toBe("");
	});
});

describe("readLogTail", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "workflow-logs-"));
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("reads the end of a log", async () => {
		const file = path.join(dir, "job-0.log");
		await writeFile(
			file,
			`${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}\n`,
		);
		expect(await readLogTail(file, 3)).toBe("line 997\nline 998\nline 999");
	});

	it("drops the partial first line of a log bigger than it reads", async () => {
		const file = path.join(dir, "big.log");
		const line = "x".repeat(1023);
		await writeFile(file, `${`${line}\n`.repeat(5 * 1024)}last`);
		const tail = await readLogTail(file, 10000);
		expect(tail.split("\n").every((l) => l === line || l === "last")).toBe(
			true,
		);
		expect(tail.endsWith("last")).toBe(true);
	});

	it("returns nothing for a job that never wrote a log", async () => {
		expect(await readLogTail(path.join(dir, "missing.log"), 10)).toBe("");
	});
});
