import { open } from "node:fs/promises";

// Reading only the end of a log keeps a six-hour run's log from being loaded whole to return its last lines.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** The last `lines` lines of `text`, without a trailing empty line. */
export const lastLines = (text: string, lines: number) => {
	const all = text.split("\n");
	if (all.at(-1) === "") all.pop();
	return all.slice(-lines).join("\n");
};

/** The last `lines` lines of a log file, or "" when it doesn't exist (a job that never started has no log yet). */
export const readLogTail = async (logPath: string, lines: number) => {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(logPath, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
	try {
		const { size } = await file.stat();
		const length = Math.min(size, MAX_TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, size - length);
		let text = buffer.toString("utf8");
		// A cut-off read starts mid-line, so drop the partial first line.
		if (length < size) text = text.slice(text.indexOf("\n") + 1);
		return lastLines(text, lines);
	} finally {
		await file.close();
	}
};
