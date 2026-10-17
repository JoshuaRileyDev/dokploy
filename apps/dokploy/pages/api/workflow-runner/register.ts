import { IS_CLOUD, registerWorkflowRunner } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const schema = z.object({
	registrationToken: z.string().min(1),
	os: z.string().max(50).optional(),
	arch: z.string().max(50).optional(),
	version: z.string().max(50).optional(),
});

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (IS_CLOUD) return res.status(404).json({ message: "Not found" });
	if (req.method !== "POST") {
		return res.status(405).json({ message: "Method not allowed" });
	}
	const parsed = schema.safeParse(req.body ?? {});
	if (!parsed.success) {
		return res.status(400).json({ message: parsed.error.message });
	}
	const registered = await registerWorkflowRunner(parsed.data);
	if (!registered) {
		return res
			.status(401)
			.json({ message: "Registration token is invalid or has expired" });
	}
	return res.status(200).json(registered);
}
