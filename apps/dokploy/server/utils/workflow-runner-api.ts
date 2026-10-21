import { authenticateWorkflowRunner, IS_CLOUD } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import type { z } from "zod";

type Runner = NonNullable<
	Awaited<ReturnType<typeof authenticateWorkflowRunner>>
>;

/** Shared plumbing for the runner endpoints: POST only, self-hosted only, bearer-token auth and body validation. */
export const runnerEndpoint =
	<T extends z.ZodTypeAny>(
		schema: T,
		handler: (args: {
			req: NextApiRequest;
			res: NextApiResponse;
			body: z.infer<T>;
			runner: Runner;
		}) => Promise<void>,
	) =>
	async (req: NextApiRequest, res: NextApiResponse) => {
		if (IS_CLOUD) return res.status(404).json({ message: "Not found" });
		if (req.method !== "POST") {
			return res.status(405).json({ message: "Method not allowed" });
		}
		const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
		const runner = token ? await authenticateWorkflowRunner(token) : null;
		if (!runner)
			return res.status(401).json({ message: "Invalid runner token" });
		const parsed = schema.safeParse(req.body ?? {});
		if (!parsed.success) {
			return res.status(400).json({ message: parsed.error.message });
		}
		try {
			await handler({ req, res, body: parsed.data, runner });
		} catch (error) {
			const status =
				(error as { code?: string }).code === "NOT_FOUND" ? 404 : 500;
			res.status(status).json({
				message:
					error instanceof Error ? error.message : "Runner request failed",
			});
		}
	};
