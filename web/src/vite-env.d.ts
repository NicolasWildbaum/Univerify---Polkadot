/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_WS_URL?: string;
	readonly VITE_ETH_RPC_URL?: string;
	readonly VITE_LOCAL_WS_URL?: string;
	readonly VITE_LOCAL_ETH_RPC_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

interface Window {
	injectedWeb3?: Record<string, unknown>;
	__UNIVERIFY_DEBUG__?: {
		sessionId: string;
		startedAt: string;
		lastUpdatedAt: string;
		events: Array<{
			timestamp: string;
			scope: string;
			event: string;
			level: "debug" | "info" | "warn" | "error";
			details?: unknown;
		}>;
		state: Record<string, unknown>;
	};
}
