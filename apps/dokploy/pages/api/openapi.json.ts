import type { NextApiRequest, NextApiResponse } from "next";
import { buildOpenApiDocument } from "@/server/api/openapi";
import { appRouter } from "@/server/api/root";

// Public on purpose: the spec is derived from code (the same document is in
// the repo), and every route it describes still requires an API key or
// session at /api/[...trpc]. It is generated once per process so anonymous
// requests can't repeatedly trigger the expensive generation.
let cachedDocument: string | undefined;

const buildDocument = () => {
	const document = buildOpenApiDocument({
		title: "Dokploy API",
		// The exact version is left out so the spec can't fingerprint an instance.
		version: "1.0.0",
		// Relative, so a spoofed Host header can't point clients (and their API
		// keys) at another server.
		baseUrl: "/api",
		tags: Object.keys(appRouter._def.record),
	});

	document.info = {
		title: "Dokploy API",
		description:
			"API for this Dokploy instance. Every endpoint requires an API key in the x-api-key header; generate one under Settings > Profile > API Keys.",
		version: "1.0.0",
	};
	document.security = [{ apiKey: [] }];

	return JSON.stringify(document);
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.setHeader("Allow", "GET, HEAD");
		return res.status(405).json({ message: "Method not allowed" });
	}

	cachedDocument ??= buildDocument();

	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "public, max-age=300");
	res.setHeader("Access-Control-Allow-Origin", "*");
	return res.status(200).send(cachedDocument);
}
