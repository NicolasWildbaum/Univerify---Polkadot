const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export const LOCAL_WS_URL = import.meta.env.VITE_LOCAL_WS_URL || "ws://localhost:9944";
export const LOCAL_ETH_RPC_URL = import.meta.env.VITE_LOCAL_ETH_RPC_URL || "http://localhost:8545";

/** Substrate RPC (PAPI / wallet extrinsics). */
export const TESTNET_WS_URL = "wss://asset-hub-paseo.dotters.network";
/**
 * Ethereum JSON-RPC for viem reads (pallet-revive). Must not be the Substrate
 * HTTP URL - use Eth Asset Hub. See https://paseo.site/developers
 */
export const TESTNET_ETH_RPC_URL = "https://eth-asset-hub-paseo.dotters.network";

/**
 * HTTP(S) host for Paseo Asset Hub Substrate JSON-RPC only. Using it as
 * `VITE_ETH_RPC_URL` or viem transport causes nginx 405 on `eth_call`.
 */
const PASEO_SUBSTRATE_HTTP_HOST = "asset-hub-paseo.dotters.network";

function isDeprecatedSubstrateHttpEthUrl(url: string): boolean {
	try {
		return new URL(url.trim()).hostname === PASEO_SUBSTRATE_HTTP_HOST;
	} catch {
		return false;
	}
}

export type NetworkPreset = "local" | "testnet";

function isLocalHost() {
	if (typeof window === "undefined") {
		return true;
	}

	return LOCAL_HOSTS.has(window.location.hostname);
}

export function getDefaultWsUrl() {
	return import.meta.env.VITE_WS_URL || (isLocalHost() ? LOCAL_WS_URL : TESTNET_WS_URL);
}

export function getDefaultEthRpcUrl() {
	let url =
		import.meta.env.VITE_ETH_RPC_URL ||
		(isLocalHost() ? LOCAL_ETH_RPC_URL : TESTNET_ETH_RPC_URL);
	url = url.trim();
	// Build-time misconfig or old docs pointed viem at the Substrate endpoint.
	if (!isLocalHost() && isDeprecatedSubstrateHttpEthUrl(url)) {
		url = TESTNET_ETH_RPC_URL;
	}
	return url;
}

export function getNetworkPresetEndpoints(preset: NetworkPreset) {
	return preset === "local"
		? {
				wsUrl: LOCAL_WS_URL,
				ethRpcUrl: LOCAL_ETH_RPC_URL,
			}
		: {
				wsUrl: TESTNET_WS_URL,
				ethRpcUrl: TESTNET_ETH_RPC_URL,
			};
}

function getStoredUrl(storageKey: string, defaultKey: string, defaultValue: string) {
	const storedValue = localStorage.getItem(storageKey);
	const previousDefault = localStorage.getItem(defaultKey);
	localStorage.setItem(defaultKey, defaultValue);

	if (!storedValue || storedValue === previousDefault) {
		return defaultValue;
	}

	return storedValue;
}

export function getStoredWsUrl() {
	return getStoredUrl("ws-url", "default-ws-url", getDefaultWsUrl());
}

export function getStoredEthRpcUrl() {
	let url = getStoredUrl("eth-rpc-url", "default-eth-rpc-url", getDefaultEthRpcUrl());
	url = url.trim();
	// localStorage kept the pre-fix Substrate URL after we changed the default.
	if (!isLocalHost() && isDeprecatedSubstrateHttpEthUrl(url)) {
		const fixed = getDefaultEthRpcUrl();
		try {
			localStorage.setItem("eth-rpc-url", fixed);
			localStorage.setItem("default-eth-rpc-url", fixed);
		} catch {
			// non-fatal (private mode)
		}
		return fixed;
	}
	return url;
}
