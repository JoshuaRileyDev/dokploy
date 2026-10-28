import { ApiError } from "./api";

/** The signed session token, sent as a bearer token and as the session cookie. */
export interface SessionCredentials {
	token: string;
	cookieName: string;
}

export type SignInResult =
	| { status: "signedIn"; credentials: SessionCredentials }
	| { status: "twoFactor"; challengeCookie: string };

const MESSAGES: Record<string, string> = {
	INVALID_EMAIL_OR_PASSWORD: "Incorrect email or password.",
	INVALID_CODE: "That code isn't right. Check it and try again.",
	INVALID_TWO_FACTOR_COOKIE: "The sign-in attempt expired. Start again.",
	EMAIL_NOT_VERIFIED: "Verify your email address before signing in.",
	TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
		"Too many attempts. Wait a moment, then sign in again.",
};

/** Splits a combined Set-Cookie header (iOS joins repeated headers with ", "). */
function readCookies(setCookie: string | null) {
	const cookies = new Map<string, string>();
	if (!setCookie) return cookies;
	for (const part of setCookie.split(/,(?=\s*[^;,=\s]+=)/)) {
		const [pair] = part.trim().split(";");
		const eq = pair?.indexOf("=") ?? -1;
		if (pair && eq > 0)
			cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
	return cookies;
}

function sessionFrom(res: Response): SessionCredentials | null {
	const cookies = readCookies(res.headers.get("set-cookie"));
	const cookieName =
		[...cookies.keys()].find((k) => k.endsWith("session_token")) ??
		"better-auth.session_token";
	// Bearer-enabled servers return the token directly; older ones only set the cookie.
	const token = res.headers.get("set-auth-token") ?? cookies.get(cookieName);
	return token ? { token, cookieName } : null;
}

async function authRequest(
	baseUrl: string,
	path: string,
	body: Record<string, unknown>,
	cookie?: string,
) {
	const res = await fetch(`${baseUrl}/api/auth/${path}`, {
		method: "POST",
		// Cookies are handled by hand so the iOS cookie jar never holds a session.
		credentials: "omit",
		headers: {
			"content-type": "application/json",
			// better-auth rejects cookie-bearing POSTs without a trusted Origin; the
			// instance always trusts its own.
			origin: baseUrl,
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => null)) as {
		code?: string;
		message?: string;
		twoFactorRedirect?: boolean;
	} | null;
	if (!res.ok) {
		const message =
			(data?.code && MESSAGES[data.code]) ||
			data?.message ||
			`Sign-in failed (${res.status})`;
		throw new ApiError(message, res.status);
	}
	return { res, data };
}

export async function signIn(
	baseUrl: string,
	email: string,
	password: string,
): Promise<SignInResult> {
	const { res, data } = await authRequest(baseUrl, "sign-in/email", {
		email,
		password,
		rememberMe: true,
	});
	if (data?.twoFactorRedirect) {
		const cookies = readCookies(res.headers.get("set-cookie"));
		const challenge = [...cookies.entries()].find(([k]) =>
			k.endsWith("two_factor"),
		);
		if (!challenge)
			throw new ApiError("The server didn't start two-factor sign-in.", 500);
		return {
			status: "twoFactor",
			challengeCookie: `${challenge[0]}=${challenge[1]}`,
		};
	}
	const credentials = sessionFrom(res);
	if (!credentials)
		throw new ApiError("The server didn't return a session.", 500);
	return { status: "signedIn", credentials };
}

export async function verifyTwoFactor(
	baseUrl: string,
	challengeCookie: string,
	code: string,
	method: "totp" | "backup",
): Promise<SessionCredentials> {
	const { res } = await authRequest(
		baseUrl,
		method === "totp"
			? "two-factor/verify-totp"
			: "two-factor/verify-backup-code",
		{ code: code.replace(/\s/g, ""), trustDevice: true },
		challengeCookie,
	);
	const credentials = sessionFrom(res);
	if (!credentials)
		throw new ApiError("The server didn't return a session.", 500);
	return credentials;
}

function sessionCookie(c: SessionCredentials) {
	return `${c.cookieName}=${c.token}`;
}

export async function signOut(baseUrl: string, c: SessionCredentials) {
	await authRequest(baseUrl, "sign-out", {}, sessionCookie(c)).catch(() => {});
}

export async function setActiveOrganization(
	baseUrl: string,
	c: SessionCredentials,
	organizationId: string,
) {
	await authRequest(
		baseUrl,
		"organization/set-active",
		{ organizationId },
		sessionCookie(c),
	);
}

export function sessionHeaders(c: SessionCredentials): Record<string, string> {
	return { authorization: `Bearer ${c.token}`, cookie: sessionCookie(c) };
}
