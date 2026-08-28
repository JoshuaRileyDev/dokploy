import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import type { NextApiRequest, NextApiResponse } from "next";
import { appRouter } from "@/server/api/root";

const OPENAPI_TAGS = [
	"admin",
	"docker",
	"compose",
	"registry",
	"cluster",
	"user",
	"domain",
	"destination",
	"backup",
	"deployment",
	"mounts",
	"certificates",
	"settings",
	"security",
	"redirects",
	"port",
	"project",
	"application",
	"mysql",
	"postgres",
	"redis",
	"mongo",
	"mariadb",
	"sshRouter",
	"gitProvider",
	"bitbucket",
	"github",
	"gitlab",
	"gitea",
];

export default function handler(req: NextApiRequest, res: NextApiResponse) {
	const protocol =
		(req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
	const host = req.headers.host;
	const baseUrl = `${protocol}://${host}/api`;

	const openApiDocument = generateOpenApiDocument(appRouter, {
		title: "tRPC OpenAPI",
		version: "1.0.0",
		baseUrl,
		docsUrl: `${baseUrl}/openapi.json`,
		tags: OPENAPI_TAGS,
	});

	openApiDocument.info = {
		title: "Dokploy API",
		description: "Endpoints for dokploy",
		version: "1.0.0",
	};

	openApiDocument.components = {
		...openApiDocument.components,
		securitySchemes: {
			apiKey: {
				type: "apiKey",
				in: "header",
				name: "x-api-key",
				description: "API key authentication",
			},
		},
	};

	openApiDocument.security = [{ apiKey: [] }];

	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
	res.status(200).json(openApiDocument);
}
