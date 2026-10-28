import { useEffect, useState } from "react";

import { useTransport } from "./session";

interface Target {
	deploymentId: string;
	logPath: string;
	serverId: string | null;
	running: boolean;
}

/**
 * Lines of a deployment log. Running deployments stream over the
 * /listen-deployment socket; finished ones (or a socket that drops) fall back
 * to polling deployment.readLogs.
 */
export function useLiveLog(target: Target | null) {
	const transport = useTransport();
	const [lines, setLines] = useState<string[]>([]);
	const [streaming, setStreaming] = useState(false);

	const key = target ? `${target.deploymentId}:${target.running}` : null;

	useEffect(() => {
		if (!target) return;
		let cancelled = false;
		let poll: ReturnType<typeof setInterval> | undefined;
		let dispose = () => {};

		const fetchOnce = () =>
			transport
				.request<string>("GET", "deployment.readLogs", {
					deploymentId: target.deploymentId,
				})
				.then((text) => !cancelled && setLines(String(text ?? "").split("\n")))
				.catch(() => {});

		const startPolling = () => {
			fetchOnce();
			if (target.running) poll = setInterval(fetchOnce, 2000);
		};

		if (target.running) {
			let received = false;
			setLines([]);
			setStreaming(true);
			dispose = transport.streamDeploymentLog(
				target,
				(line) => {
					received = true;
					if (!cancelled) setLines((prev) => [...prev, line]);
				},
				() => {
					if (cancelled) return;
					setStreaming(false);
					if (!received) startPolling();
				},
			);
		} else {
			setStreaming(false);
			startPolling();
		}

		return () => {
			cancelled = true;
			dispose();
			if (poll) clearInterval(poll);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, transport]);

	return { lines, streaming };
}
