import {
	assertServerCommandAccess,
	cancelServerCommand,
	findServerCommandById,
	findServerCommandsByServerId,
	readServerCommandLog,
	removeServerCommand,
	runServerCommand,
} from "@dokploy/server";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindServerCommand,
	apiFindServerCommands,
	apiReadServerCommandLogs,
	apiRunServerCommand,
	serverCommandLogChunkSchema,
	serverCommandSchema,
} from "@/server/db/schema";

const commandProcedure = withPermission("server", "terminal");

const ACCESS_NOTE =
	"Requires access to the server and the server terminal permission.";

const findAccessibleCommand = async (
	ctx: Parameters<typeof assertServerCommandAccess>[0],
	serverCommandId: string,
) => {
	const command = await findServerCommandById(serverCommandId);
	await assertServerCommandAccess(ctx, command.serverId);
	return command;
};

// The output schemas also keep each command's logPath (a path on the Dokploy host) out of responses.
export const serverCommandRouter = createTRPCRouter({
	run: commandProcedure
		.meta({
			openapi: {
				method: "POST",
				path: "/serverCommand.run",
				tags: ["serverCommand"],
				summary: "Run a shell command on a server",
				description: `Starts the command over SSH and returns straight away with its serverCommandId; it keeps running in the background. Follow the output with GET /server-commands/{serverCommandId}/logs (server-sent events) or by polling /serverCommand.logs. The command runs under sh with stdin closed, and is stopped once timeoutSeconds (default 3600, max 86400) elapses. ${ACCESS_NOTE}`,
			},
		})
		.input(apiRunServerCommand)
		.output(serverCommandSchema)
		.mutation(async ({ input, ctx }) => {
			const target = await assertServerCommandAccess(ctx, input.serverId);
			const command = await runServerCommand({
				...input,
				organizationId: ctx.session.activeOrganizationId,
				userId: ctx.user.id,
			});
			await audit(ctx, {
				action: "run",
				resourceType: "server",
				resourceId: target.serverId,
				resourceName: target.name,
				metadata: { serverCommandId: command.serverCommandId },
			});
			return command;
		}),
	one: commandProcedure
		.meta({
			openapi: {
				method: "GET",
				path: "/serverCommand.one",
				tags: ["serverCommand"],
				summary: "Get a command's status",
				description: `Status is "running" until the command exits; exitCode is null if it never reported one (cancelled before starting, connection lost, Dokploy restarted). ${ACCESS_NOTE}`,
			},
		})
		.input(apiFindServerCommand)
		.output(serverCommandSchema)
		.query(({ input, ctx }) =>
			findAccessibleCommand(ctx, input.serverCommandId),
		),
	all: commandProcedure
		.meta({
			openapi: {
				method: "GET",
				path: "/serverCommand.all",
				tags: ["serverCommand"],
				summary: "List recent commands run on a server",
				description: `Newest first. Finished commands are deleted after 30 days. ${ACCESS_NOTE}`,
			},
		})
		.input(apiFindServerCommands)
		.output(z.array(serverCommandSchema))
		.query(async ({ input, ctx }) => {
			await assertServerCommandAccess(ctx, input.serverId);
			return findServerCommandsByServerId(input.serverId, input.limit);
		}),
	logs: commandProcedure
		.meta({
			openapi: {
				method: "GET",
				path: "/serverCommand.logs",
				tags: ["serverCommand"],
				summary: "Read a command's output",
				description: `Polling alternative to the server-sent events stream. Returns up to \`limit\` bytes of combined stdout and stderr starting at byte \`offset\`. Call again with \`nextOffset\` until status is no longer "running" and nextOffset equals size. ${ACCESS_NOTE}`,
			},
		})
		.input(apiReadServerCommandLogs)
		.output(serverCommandLogChunkSchema)
		.query(async ({ input, ctx }) => {
			const command = await findAccessibleCommand(ctx, input.serverCommandId);
			const chunk = await readServerCommandLog(
				command.logPath,
				input.offset,
				input.limit,
				{ allowPartial: command.status !== "running" },
			);
			return { ...command, ...chunk };
		}),
	cancel: commandProcedure
		.meta({
			openapi: {
				method: "POST",
				path: "/serverCommand.cancel",
				tags: ["serverCommand"],
				summary: "Cancel a running command",
				description: `Sends SIGTERM to the command's process group, then SIGKILL after 5 seconds. Returns before the command has exited; its status becomes "cancelled". ${ACCESS_NOTE}`,
			},
		})
		.input(apiFindServerCommand)
		.output(z.boolean())
		.mutation(async ({ input, ctx }) => {
			const command = await findAccessibleCommand(ctx, input.serverCommandId);
			await cancelServerCommand(command.serverCommandId);
			await audit(ctx, {
				action: "cancel",
				resourceType: "server",
				resourceId: command.serverId,
				metadata: { serverCommandId: command.serverCommandId },
			});
			return true;
		}),
	remove: commandProcedure
		.meta({
			openapi: {
				method: "POST",
				path: "/serverCommand.remove",
				tags: ["serverCommand"],
				summary: "Delete a finished command and its output",
				description: `Fails while the command is still running; cancel it first. ${ACCESS_NOTE}`,
			},
		})
		.input(apiFindServerCommand)
		.output(z.boolean())
		.mutation(async ({ input, ctx }) => {
			const command = await findAccessibleCommand(ctx, input.serverCommandId);
			await removeServerCommand(command.serverCommandId);
			return true;
		}),
});
