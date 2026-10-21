import { recordRunnerEvents } from "@dokploy/server";
import { z } from "zod";
import { runnerEndpoint } from "@/server/utils/workflow-runner-api";

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

const schema = z.object({
	lines: z
		.array(
			z.object({
				stream: z.enum(["stdout", "stderr"]),
				line: z.string(),
			}),
		)
		.max(5000),
});

/** Receives a batch of act output; the response doubles as the runner's heartbeat and cancel signal. */
export default runnerEndpoint(schema, async ({ req, res, body, runner }) => {
	const result = await recordRunnerEvents(
		runner,
		String(req.query.workflowRunId),
		body.lines,
	);
	res.status(200).json(result);
});
