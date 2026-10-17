export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export const createApi = (baseUrl: string, token?: string) => {
	const post = async <T>(
		path: string,
		body: unknown,
		timeoutMs = 30_000,
	): Promise<T> => {
		const response = await fetch(new URL(path, baseUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		const data = text ? JSON.parse(text) : {};
		if (!response.ok) {
			throw new ApiError(
				data.message ?? `HTTP ${response.status}`,
				response.status,
			);
		}
		return data as T;
	};
	return { post };
};

export type ClaimedRun = {
	workflowRunId: string;
	workflowName: string;
	runNumber: number;
	repository: string;
	script: string;
	maskValues: string[];
};
