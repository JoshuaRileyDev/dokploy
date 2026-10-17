import { claimRunForRunner } from "@dokploy/server";
import { z } from "zod";
import { runnerEndpoint } from "@/server/utils/workflow-runner-api";

const POLL_INTERVAL_MS = 2000;

const schema = z.object({
	workDir: z.string().min(1).max(500),
	waitSeconds: z.number().int().min(0).max(25).default(20),
});

/** Long-polls for a run: holds the request open up to waitSeconds so idle runners don't hammer Dokploy. */
export default runnerEndpoint(schema, async ({ req, res, body, runner }) => {
	const deadline = Date.now() + body.waitSeconds * 1000;
	let closed = false;
	req.on("close", () => {
		closed = true;
	});
	while (!closed) {
		const claimed = await claimRunForRunner(runner, body.workDir);
		if (claimed) return res.status(200).json({ run: claimed });
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	if (!closed) res.status(200).json({ run: null });
});
