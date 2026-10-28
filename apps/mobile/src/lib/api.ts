export type Method = "GET" | "POST";

export interface Transport {
	request<T>(
		method: Method,
		path: string,
		input?: Record<string, unknown>,
	): Promise<T>;
	/** Streams a deployment's log file; returns a disposer. */
	streamDeploymentLog(
		deployment: { logPath: string; serverId: string | null },
		onLine: (line: string) => void,
		onClose: () => void,
	): () => void;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export function normalizeBaseUrl(raw: string) {
	const trimmed = raw
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/api$/, "");
	return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * `authHeaders` is either `{ "x-api-key": … }` or a session's bearer token and
 * cookie. `onUnauthorized` fires on a 401 so an expired session can sign out.
 */
export function createHttpTransport(
	baseUrl: string,
	authHeaders: Record<string, string>,
	onUnauthorized?: () => void,
): Transport {
	return {
		async request<T>(
			method: Method,
			path: string,
			input?: Record<string, unknown>,
		) {
			let url = `${baseUrl}/api/${path}`;
			const init: RequestInit = {
				method,
				// Credentials are explicit headers; keep the iOS cookie jar out of it.
				credentials: "omit",
				headers: { ...authHeaders, accept: "application/json" },
			};
			if (method === "GET" && input) {
				const qs = Object.entries(input)
					.filter(([, v]) => v !== undefined && v !== null)
					.map(
						([k, v]) =>
							`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
					)
					.join("&");
				if (qs) url += `?${qs}`;
			} else if (method === "POST") {
				init.headers = { ...init.headers, "content-type": "application/json" };
				init.body = JSON.stringify(input ?? {});
			}

			const res = await fetch(url, init);
			const text = await res.text();
			let body: unknown = null;
			try {
				body = text ? JSON.parse(text) : null;
			} catch {
				body = text;
			}
			if (res.status === 401) onUnauthorized?.();
			if (!res.ok) {
				const message =
					body && typeof body === "object" && "message" in body
						? String(body.message)
						: "";
				throw new ApiError(
					message || `Request failed (${res.status})`,
					res.status,
				);
			}
			return body as T;
		},

		streamDeploymentLog(deployment, onLine, onClose) {
			const wsBase = baseUrl.replace(/^http/, "ws");
			const params = new URLSearchParams({ logPath: deployment.logPath });
			if (deployment.serverId) params.set("serverId", deployment.serverId);
			// React Native's WebSocket accepts headers as a third argument, which the
			// browser API does not; sockets authenticate with the same headers as REST.
			const WS = WebSocket as unknown as new (
				url: string,
				protocols: string[] | null,
				options: { headers: Record<string, string> },
			) => WebSocket;
			const ws = new WS(`${wsBase}/listen-deployment?${params}`, null, {
				headers: authHeaders,
			});
			ws.onmessage = (e) => {
				for (const line of String(e.data).split("\n")) if (line) onLine(line);
			};
			ws.onclose = onClose;
			ws.onerror = onClose;
			return () => ws.close();
		},
	};
}
