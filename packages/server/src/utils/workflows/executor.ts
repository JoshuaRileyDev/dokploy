import { findServerById } from "../../services/server";
import {
	buildActCancelScript,
	buildActCleanupScript,
	buildActRunScript,
} from "./act";
import { prepareRunInputs, RunRecorder } from "./run-recorder";
import { runRemoteScript, type SshTarget } from "./ssh";

const MAX_RUN_DURATION_MS = 6 * 60 * 60 * 1000;

/** Runs one workflow run to completion on its workflow server over SSH. */
export const executeWorkflowRun = async (
	workflowRunId: string,
	signal: AbortSignal,
) => {
	const recorder = await RunRecorder.start(workflowRunId);
	if (!recorder?.run.serverId) return;
	const { run } = recorder;

	const timeout = AbortSignal.timeout(MAX_RUN_DURATION_MS);
	const combined = AbortSignal.any([signal, timeout]);
	combined.addEventListener("abort", () => recorder.markAborting(), {
		once: true,
	});

	let exitCode = 1;
	let errorMessage: string | null = null;
	try {
		const server = await findServerById(run.serverId!);
		if (!server.sshKey?.privateKey) {
			throw new Error(`Server ${server.name} has no SSH key`);
		}
		const { scriptInput, maskValues } = await prepareRunInputs(run);
		recorder.setMaskValues(maskValues);

		const target: SshTarget = {
			ipAddress: server.ipAddress,
			port: server.port,
			username: server.username,
			privateKey: server.sshKey.privateKey,
		};
		recorder.log(
			`Running ${run.workflowPath} at ${run.sha.slice(0, 7)} on ${server.name}`,
		);

		exitCode = await runRemoteScript({
			target,
			script: buildActRunScript(scriptInput),
			signal: combined,
			onAbortScript: buildActCancelScript(workflowRunId),
			onStdout: (chunk) => recorder.pushChunk("stdout", chunk),
			onStderr: (chunk) => recorder.pushChunk("stderr", chunk),
		});
		await recorder.flush();

		await runRemoteScript({
			target,
			script: buildActCleanupScript(workflowRunId),
		}).catch((error) => recorder.log(`Cleanup failed: ${error.message}`));
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error);
	}

	if (timeout.aborted) {
		errorMessage = "The run exceeded the 6 hour limit and was stopped.";
	}
	await recorder.finish({
		exitCode,
		cancelled: signal.aborted,
		errorMessage,
	});
};
