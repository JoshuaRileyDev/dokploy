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

/**
 * Queues output lines and sends them in order, one request at a time. Lines from a failed
 * request go back to the front of the queue so nothing is lost or reordered.
 */
export class OutputSender {
	private queue: OutputLine[] = [];
	private sending: Promise<void> = Promise.resolve();

	constructor(
		private readonly send: (lines: OutputLine[]) => Promise<void>,
		private readonly maxBatch = 500,
	) {}

	get size() {
		return this.queue.length;
	}

	add(lines: OutputLine[]) {
		this.queue.push(...lines);
	}

	/** Sends everything queued so far; resolves once it was accepted or rejects with the request error. */
	flush() {
		this.sending = this.sending.then(async () => {
			do {
				const batch = this.queue.splice(0, this.maxBatch);
				try {
					await this.send(batch);
				} catch (error) {
					this.queue.unshift(...batch);
					throw error;
				}
			} while (this.queue.length > 0);
		});
		const current = this.sending;
		// Keep the chain usable after a failure; callers still see this flush's error.
		this.sending = this.sending.catch(() => {});
		return current;
	}
}
