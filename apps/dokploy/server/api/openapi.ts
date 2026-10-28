import {
	type GenerateOpenApiDocumentOptions,
	generateOpenApiDocument,
} from "@dokploy/trpc-openapi";
import { z } from "zod";
import { appRouter } from "@/server/api/root";

// Operations reference these schemes by name, so they have to be passed to the
// generator rather than swapped into `components` afterwards.
const securitySchemes: GenerateOpenApiDocumentOptions["securitySchemes"] = {
	apiKey: {
		type: "apiKey",
		in: "header",
		name: "x-api-key",
		description:
			"API key authentication. Generate one under Settings > Profile > API Keys.",
	},
};

const errorResponse = (description: string) => ({
	description,
	content: {
		"application/json": { schema: z.object({ message: z.string() }) },
	},
});

// Endpoints served by plain Next API routes rather than tRPC, which the
// generator can't see.
const paths: GenerateOpenApiDocumentOptions["paths"] = {
	"/server-commands/{serverCommandId}/logs": {
		get: {
			operationId: "serverCommand-streamLogs",
			tags: ["serverCommand"],
			summary: "Stream a command's output",
			description: [
				"Server-sent events with the command's combined stdout and stderr, from the start or from a byte offset, until it exits.",
				"",
				"- `log` events: `data` is a JSON-encoded string of output; `id` is the byte offset to resume from.",
				"- `end` event: `data` is `{ status, exitCode, errorMessage }`; the stream then closes.",
				"- `error` event: `data` is `{ message }`; the stream then closes.",
				"- A `: ping` comment is sent every 15 seconds.",
				"",
				"To resume after a dropped connection, send the last received `id` as the `Last-Event-ID` header (EventSource does this automatically) or as `offset`.",
				"Requires access to the server and the server terminal permission.",
			].join("\n"),
			security: [{ apiKey: [] }],
			requestParams: {
				path: z.object({ serverCommandId: z.string().min(1) }),
				query: z.object({
					offset: z
						.number()
						.int()
						.min(0)
						.optional()
						.meta({ description: "Byte offset to start from." }),
				}),
				header: z.object({
					"last-event-id": z.string().optional().meta({
						description: "Byte offset to resume from; overrides `offset`.",
					}),
				}),
			},
			responses: {
				200: {
					description: "Event stream",
					content: {
						"text/event-stream": {
							schema: z.string(),
							example:
								'id: 6\nevent: log\ndata: "tick1\\n"\n\nevent: end\ndata: {"status":"success","exitCode":0,"errorMessage":null}\n\n',
						},
					},
				},
				401: errorResponse("Authorization not provided"),
				403: errorResponse("Insufficient access"),
				404: errorResponse("Server command not found"),
			},
		},
	},
};

export const buildOpenApiDocument = (
	options: Pick<
		GenerateOpenApiDocumentOptions,
		"title" | "version" | "baseUrl" | "docsUrl" | "tags"
	>,
) => generateOpenApiDocument(appRouter, { ...options, securitySchemes, paths });
