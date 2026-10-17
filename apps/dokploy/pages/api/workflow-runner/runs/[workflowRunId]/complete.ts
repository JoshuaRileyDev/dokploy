import { completeRunnerRun } from "@dokploy/server";
import { z } from "zod";
import { runnerEndpoint } from "@/server/utils/workflow-runner-api";

const schema = z.object({
	exitCode: z.number().int(),
	errorMessage: z.string().max(10_000).nullable().optional(),
});

export default runnerEndpoint(schema, async ({ req, res, body, runner }) => {
	await completeRunnerRun(runner, String(req.query.workflowRunId), body);
	res.status(200).json({ ok: true });
});
