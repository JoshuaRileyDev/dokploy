import { createHash } from "node:crypto";

export const OVH_API_ENDPOINTS = {
	"ovh-eu": "https://eu.api.ovh.com/1.0",
	"ovh-ca": "https://ca.api.ovh.com/1.0",
	"ovh-us": "https://api.us.ovhcloud.com/1.0",
	"kimsufi-eu": "https://eu.api.kimsufi.com/1.0",
	"kimsufi-ca": "https://ca.api.kimsufi.com/1.0",
	"soyoustart-eu": "https://eu.api.soyoustart.com/1.0",
	"soyoustart-ca": "https://ca.api.soyoustart.com/1.0",
} as const;

export type OvhApiEndpoint = keyof typeof OVH_API_ENDPOINTS;

export interface OvhApiCredentials {
	applicationKey: string;
	applicationSecret: string;
	consumerKey: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// Requests are signed with the API's own clock: a local clock more than a few
// seconds off would get every call rejected. The drift is re-measured
// periodically in case the host clock is corrected under us.
const CLOCK_SKEW_TTL_MS = 60 * 60 * 1000;

const clockSkews = new Map<
	string,
	{ deltaSeconds: number; measuredAt: number }
>();

const localTimestamp = () => Math.floor(Date.now() / 1000);

const getTimestamp = async (baseUrl: string, fetchFn: Fetch) => {
	const cached = clockSkews.get(baseUrl);
	if (cached && Date.now() - cached.measuredAt < CLOCK_SKEW_TTL_MS) {
		return localTimestamp() + cached.deltaSeconds;
	}

	const response = await fetchFn(`${baseUrl}/auth/time`);
	const serverTime = Number(await response.text());
	if (!response.ok || !Number.isFinite(serverTime)) {
		throw new Error(
			`OVH: could not read the API server time (status ${response.status})`,
		);
	}

	const deltaSeconds = serverTime - localTimestamp();
	clockSkews.set(baseUrl, { deltaSeconds, measuredAt: Date.now() });
	return localTimestamp() + deltaSeconds;
};

/** Sends a request signed with OVH's application/consumer key scheme. */
export const signedOvhRequest = async (
	baseUrl: string,
	credentials: OvhApiCredentials,
	path: string,
	init: { method?: string; body?: unknown },
	fetchFn: Fetch,
) => {
	const url = `${baseUrl}${path}`;
	const method = init.method ?? "GET";
	const body = init.body === undefined ? "" : JSON.stringify(init.body);
	const timestamp = await getTimestamp(baseUrl, fetchFn);
	const digest = createHash("sha1")
		.update(
			[
				credentials.applicationSecret,
				credentials.consumerKey,
				method,
				url,
				body,
				timestamp,
			].join("+"),
		)
		.digest("hex");

	return fetchFn(url, {
		method,
		...(body ? { body } : {}),
		headers: {
			"Content-Type": "application/json",
			"X-Ovh-Application": credentials.applicationKey,
			"X-Ovh-Consumer": credentials.consumerKey,
			"X-Ovh-Timestamp": String(timestamp),
			"X-Ovh-Signature": `$1$${digest}`,
		},
	});
};
