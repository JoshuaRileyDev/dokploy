export type OutputLine = { stream: "stdout" | "stderr"; line: string };

/** Splits a stream of chunks into complete lines, keeping any trailing partial line for the next chunk. */
export class LineBuffer {
	private pending = "";

	push(chunk: string): string[] {
		const parts = (this.pending + chunk).split("\n");
		this.pending = parts.pop() ?? "";
		return parts.map((part) => part.replace(/\r$/, ""));
	}

	flush(): string[] {
		const rest = this.pending;
		this.pending = "";
		return rest ? [rest] : [];
	}
}

export const createMasker = (secrets: string[]) => {
	const values = secrets
		.filter((secret) => secret.length >= 4)
		.sort((a, b) => b.length - a.length);
	return (line: string) =>
		values.reduce((masked, secret) => masked.split(secret).join("***"), line);
};

const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_LINES = 5_000;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_BATCH_LINES = 200;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

const truncateLine = (line: string): string => {
	if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
	const suffix = "… [line truncated]";
	let low = 0;
	let high = line.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(line.slice(0, middle) + suffix) <= MAX_LINE_BYTES)
			low = middle;
		else high = middle - 1;
	}
	return line.slice(0, low) + suffix;
};

/** Queues output with bounded memory and retries failed batches with backoff. */
export class OutputSender {
	private queue: OutputLine[] = [];
	private queueBytes = 0;
	private droppedLines = 0;
	private inFlight: Promise<void> | null = null;
	private retryAt = 0;
	private retryDelayMs = INITIAL_RETRY_MS;

	constructor(
		private readonly send: (lines: OutputLine[]) => Promise<void>,
		private readonly maxBatch = MAX_BATCH_LINES,
	) {}

	get size() {
		return this.queue.length;
	}

	add(lines: OutputLine[]) {
		for (const line of lines) {
			const boundedLine = { ...line, line: truncateLine(line.line) };
			this.queue.push(boundedLine);
			this.queueBytes += Buffer.byteLength(boundedLine.line) + 32;
		}
		this.trimQueue();
	}

	private trimQueue() {
		while (
			this.queue.length > MAX_QUEUE_LINES ||
			this.queueBytes > MAX_QUEUE_BYTES
		) {
			const removed = this.queue.shift();
			if (!removed) break;
			this.queueBytes -= Buffer.byteLength(removed.line) + 32;
			this.droppedLines++;
		}
	}

	/** Sends queued output once; concurrent callers share the same request sequence. */
	flush(forceRetry = false): Promise<void> {
		if (this.inFlight) return this.inFlight;
		if (!forceRetry && Date.now() < this.retryAt) return Promise.resolve();
		if (this.droppedLines > 0) {
			const count = this.droppedLines;
			this.droppedLines = 0;
			this.add([
				{
					stream: "stderr",
					line: `[runner] Dropped ${count} older output lines because Dokploy was unreachable and the ${Math.round(MAX_QUEUE_BYTES / 1024 / 1024)} MiB output queue filled.`,
				},
			]);
		}

		const sending = this.drain();
		this.inFlight = sending.finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async drain() {
		do {
			const batch = this.queue.splice(0, this.maxBatch);
			for (const line of batch)
				this.queueBytes -= Buffer.byteLength(line.line) + 32;
			try {
				await this.send(batch);
				this.retryAt = 0;
				this.retryDelayMs = INITIAL_RETRY_MS;
			} catch (error) {
				this.queue.unshift(...batch);
				for (const line of batch)
					this.queueBytes += Buffer.byteLength(line.line) + 32;
				this.trimQueue();
				this.retryAt = Date.now() + this.retryDelayMs;
				this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
				throw error;
			}
		} while (this.queue.length > 0);
	}
}
