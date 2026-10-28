import * as SecureStore from "expo-secure-store";
import {
	createContext,
	type ReactNode,
	use,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";

import { createHttpTransport, normalizeBaseUrl, type Transport } from "./api";
import {
	type SessionCredentials,
	sessionHeaders,
	setActiveOrganization,
	signOut,
} from "./auth";
import { demoTransport } from "./mock";

export type Connection =
	| ({ mode: "session"; baseUrl: string; email: string } & SessionCredentials)
	| { mode: "apiKey"; baseUrl: string; apiKey: string }
	| { mode: "demo" };

const STORAGE_KEY = "dokploy.connection";
const LAST_LOGIN_KEY = "dokploy.lastLogin";

export interface LastLogin {
	baseUrl: string;
	email?: string;
}

interface SessionValue {
	ready: boolean;
	connection: Connection | null;
	transport: Transport | null;
	/** Set when the server rejected the saved session, so sign-in can say why. */
	expired: boolean;
	lastLogin: LastLogin | null;
	connect: (connection: Connection) => Promise<void>;
	disconnect: () => Promise<void>;
	switchOrganization: (organizationId: string) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

function migrate(raw: string): Connection | null {
	const stored = JSON.parse(raw) as
		| Connection
		| { mode: "live"; baseUrl: string; apiKey: string };
	// Builds before sign-in support stored API-key connections as "live".
	if (stored.mode === "live")
		return { mode: "apiKey", baseUrl: stored.baseUrl, apiKey: stored.apiKey };
	return stored;
}

export function SessionProvider({ children }: { children: ReactNode }) {
	const [ready, setReady] = useState(false);
	const [connection, setConnection] = useState<Connection | null>(null);
	const [expired, setExpired] = useState(false);
	const [lastLogin, setLastLogin] = useState<LastLogin | null>(null);

	useEffect(() => {
		Promise.all([
			SecureStore.getItemAsync(STORAGE_KEY),
			SecureStore.getItemAsync(LAST_LOGIN_KEY),
		])
			.then(([raw, last]) => {
				if (raw) setConnection(migrate(raw));
				if (last) setLastLogin(JSON.parse(last));
			})
			.catch(() => {})
			.finally(() => setReady(true));
	}, []);

	const clear = useCallback(async () => {
		await SecureStore.deleteItemAsync(STORAGE_KEY);
		setConnection(null);
	}, []);

	const value = useMemo<SessionValue>(() => {
		const onUnauthorized = () => {
			setExpired(true);
			clear();
		};
		const transport =
			connection?.mode === "session"
				? createHttpTransport(
						connection.baseUrl,
						sessionHeaders(connection),
						onUnauthorized,
					)
				: connection?.mode === "apiKey"
					? createHttpTransport(
							connection.baseUrl,
							{ "x-api-key": connection.apiKey },
							onUnauthorized,
						)
					: connection?.mode === "demo"
						? demoTransport
						: null;

		return {
			ready,
			connection,
			transport,
			expired,
			lastLogin,
			async connect(next) {
				const stored =
					next.mode === "demo"
						? next
						: { ...next, baseUrl: normalizeBaseUrl(next.baseUrl) };
				await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(stored));
				if (stored.mode !== "demo") {
					const last: LastLogin = {
						baseUrl: stored.baseUrl,
						email: stored.mode === "session" ? stored.email : lastLogin?.email,
					};
					await SecureStore.setItemAsync(LAST_LOGIN_KEY, JSON.stringify(last));
					setLastLogin(last);
				}
				setExpired(false);
				setConnection(stored);
			},
			async disconnect() {
				if (connection?.mode === "session")
					await signOut(connection.baseUrl, connection);
				await clear();
			},
			async switchOrganization(organizationId) {
				if (connection?.mode === "demo") {
					await demoTransport.request("POST", "organization.setActive", {
						organizationId,
					});
					return;
				}
				if (connection?.mode !== "session") return;
				await setActiveOrganization(
					connection.baseUrl,
					connection,
					organizationId,
				);
			},
		};
	}, [ready, connection, expired, lastLogin, clear]);

	return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession() {
	const value = use(SessionContext);
	if (!value) throw new Error("useSession must be used inside SessionProvider");
	return value;
}

export function useTransport() {
	const { transport } = useSession();
	if (!transport) throw new Error("Not connected");
	return transport;
}
