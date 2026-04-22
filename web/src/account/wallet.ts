// Single source of truth for the user's connected wallet.
//
// The app talks to Polkadot browser wallets (Polkadot.js, Talisman, SubWallet,
// PWAllet / DotSama, …) through the standard `window.injectedWeb3`
// interface. Any wallet that exposes that interface works out of the box;
// this module is wallet-agnostic.
//
// Responsibilities:
//   - discover available injected extensions,
//   - connect to one, pick an account, and expose it as the app-wide identity,
//   - persist (extension name, account address) in localStorage,
//   - restore on refresh,
//   - expose the Substrate signer and the derived H160 so downstream code
//     can sign Substrate extrinsics (incl. `Revive.call`) and read on-chain
//     permission state for that H160.

import { create } from "zustand";
import {
	connectInjectedExtension,
	getInjectedExtensions,
	type InjectedPolkadotAccount,
} from "polkadot-api/pjs-signer";
import type { PolkadotSigner } from "polkadot-api";
import { getSs58AddressInfo, Keccak256 } from "@polkadot-api/substrate-bindings";
import type { Address } from "viem";
import {
	getRuntimeContextSnapshot,
	logDiagnostic,
	serializeError,
	setDiagnosticState,
} from "../utils/diagnostics";

const STORAGE_KEY = "univerify:wallet";

// ── Derived H160 ────────────────────────────────────────────────────
// Matches `pallet_revive::AccountId32Mapper`: if the 32-byte public key
// ends in 12 bytes of 0xEE we treat it as an Ethereum-derived account and
// take the first 20 bytes; otherwise we take keccak256(pubkey)[12..].
// This is the address the contract will see as `msg.sender` when the
// account signs a `Revive.call` extrinsic.
export function ss58ToEvmAddress(ss58: string): Address {
	const info = getSs58AddressInfo(ss58);
	if (!info.isValid) {
		return "0x0000000000000000000000000000000000000000";
	}
	const pub = info.publicKey;
	const isEthDerived = pub.length === 32 && pub.slice(20).every((b) => b === 0xee);
	const bytes = isEthDerived ? pub.slice(0, 20) : Keccak256(pub).slice(-20);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as Address;
}

// ── State shape ─────────────────────────────────────────────────────

export type WalletStatus =
	| { kind: "disconnected" }
	| { kind: "connecting" }
	| { kind: "connected"; extensionName: string; account: InjectedPolkadotAccount }
	| { kind: "error"; message: string };

interface StoredWallet {
	extensionName: string;
	address: string;
}

interface WalletState {
	status: WalletStatus;
	/** Names of extensions currently advertised by `window.injectedWeb3`. */
	availableExtensions: string[];
	/** All accounts exposed by the currently connected extension, for picking. */
	extensionAccounts: InjectedPolkadotAccount[];
	refreshExtensions: () => void;
	connect: (extensionName: string, preferredAddress?: string) => Promise<void>;
	selectAccount: (address: string) => void;
	disconnect: () => void;
	/** Attempt to silently restore the previous session. */
	restore: () => Promise<void>;
}

// Keep the extension handle outside the store so we can subscribe/unsubscribe
// without bloating the state or triggering re-renders on account updates.
let currentUnsubscribe: (() => void) | null = null;
let currentExtensionName: string | null = null;

function persist(wallet: StoredWallet | null) {
	try {
		if (wallet) {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
		} else {
			localStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		// Storage quota / private mode — non-fatal.
	}
}

function loadStored(): StoredWallet | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as StoredWallet;
		if (
			parsed &&
			typeof parsed.extensionName === "string" &&
			typeof parsed.address === "string"
		) {
			return parsed;
		}
	} catch {
		// Corrupt entry — clear it.
		localStorage.removeItem(STORAGE_KEY);
	}
	return null;
}

export const useWalletStore = create<WalletState>((set, get) => ({
	status: { kind: "disconnected" },
	availableExtensions: [],
	extensionAccounts: [],

	refreshExtensions: () => {
		try {
			const availableExtensions = getInjectedExtensions();
			set({ availableExtensions });
			setDiagnosticState("wallet.discovery", {
				availableExtensions,
				runtime: getRuntimeContextSnapshot(),
			});
			logDiagnostic(
				"wallet",
				"extensions_refreshed",
				{
					availableExtensions,
					runtime: getRuntimeContextSnapshot(),
				},
				availableExtensions.length === 0 ? "warn" : "info",
			);
		} catch (error) {
			set({ availableExtensions: [] });
			logDiagnostic(
				"wallet",
				"extensions_refresh_failed",
				{
					error: serializeError(error),
					runtime: getRuntimeContextSnapshot(),
				},
				"error",
			);
		}
	},

	connect: async (extensionName, preferredAddress) => {
		set({ status: { kind: "connecting" } });
		setDiagnosticState("wallet.connection", {
			phase: "connecting",
			extensionName,
			preferredAddress: preferredAddress ?? null,
			availableExtensions: get().availableExtensions,
			runtime: getRuntimeContextSnapshot(),
		});
		logDiagnostic("wallet", "connect_requested", {
			extensionName,
			preferredAddress: preferredAddress ?? null,
			availableExtensions: get().availableExtensions,
			runtime: getRuntimeContextSnapshot(),
		});
		try {
			currentUnsubscribe?.();
			const connectionTimeout = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`Wallet connection timed out. Check that ${extensionName} is unlocked and has authorized this site's origin. If you accessed this app via an IPFS or DotNS gateway, open ${extensionName}, go to Authorized Sites, and add this page's origin manually.`,
							),
						),
					15_000,
				),
			);
			const ext = await Promise.race([
				connectInjectedExtension(extensionName),
				connectionTimeout,
			]);
			currentExtensionName = extensionName;
			logDiagnostic("wallet", "extension_connected", { extensionName });

			const accounts = ext.getAccounts();
			logDiagnostic(
				"wallet",
				"accounts_loaded",
				{
					extensionName,
					accountCount: accounts.length,
					accounts: accounts.map((account) => ({
						address: account.address,
						name: account.name ?? null,
					})),
				},
				accounts.length === 0 ? "warn" : "info",
			);
			if (accounts.length === 0) {
				ext.disconnect();
				currentExtensionName = null;
				set({
					status: {
						kind: "error",
						message: `No accounts visible in ${extensionName}. Create or import one first.`,
					},
					extensionAccounts: [],
				});
				return;
			}

			const picked =
				(preferredAddress && accounts.find((a) => a.address === preferredAddress)) ||
				accounts[0];

			currentUnsubscribe = ext.subscribe((updated) => {
				logDiagnostic(
					"wallet",
					"accounts_updated",
					{
						extensionName,
						accountCount: updated.length,
						addresses: updated.map((account) => account.address),
					},
					"debug",
				);
				set({ extensionAccounts: updated });
				const cur = get().status;
				if (cur.kind === "connected") {
					const stillThere = updated.find((a) => a.address === cur.account.address);
					if (!stillThere) {
						// User removed the account inside the extension — log out.
						logDiagnostic(
							"wallet",
							"active_account_removed",
							{
								extensionName,
								address: cur.account.address,
							},
							"warn",
						);
						get().disconnect();
					} else if (stillThere !== cur.account) {
						set({
							status: {
								kind: "connected",
								extensionName: cur.extensionName,
								account: stillThere,
							},
						});
					}
				}
			});

			set({
				status: { kind: "connected", extensionName, account: picked },
				extensionAccounts: accounts,
			});
			setDiagnosticState("wallet.connection", {
				phase: "connected",
				extensionName,
				account: {
					address: picked.address,
					name: picked.name ?? null,
				},
				evmAddress: ss58ToEvmAddress(picked.address),
				accountCount: accounts.length,
				runtime: getRuntimeContextSnapshot(),
			});
			logDiagnostic("wallet", "connected", {
				extensionName,
				account: {
					address: picked.address,
					name: picked.name ?? null,
				},
				evmAddress: ss58ToEvmAddress(picked.address),
				accountCount: accounts.length,
			});
			persist({ extensionName, address: picked.address });
		} catch (err) {
			currentUnsubscribe?.();
			currentUnsubscribe = null;
			currentExtensionName = null;
			set({
				status: {
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				},
				extensionAccounts: [],
			});
			setDiagnosticState("wallet.connection", {
				phase: "error",
				extensionName,
				preferredAddress: preferredAddress ?? null,
				error: serializeError(err),
				runtime: getRuntimeContextSnapshot(),
			});
			logDiagnostic(
				"wallet",
				"connect_failed",
				{
					extensionName,
					preferredAddress: preferredAddress ?? null,
					error: serializeError(err),
					availableExtensions: get().availableExtensions,
					runtime: getRuntimeContextSnapshot(),
				},
				"error",
			);
		}
	},

	selectAccount: (address) => {
		const { extensionAccounts, status } = get();
		if (status.kind !== "connected") return;
		const next = extensionAccounts.find((a) => a.address === address);
		if (!next) return;
		set({
			status: {
				kind: "connected",
				extensionName: status.extensionName,
				account: next,
			},
		});
		setDiagnosticState("wallet.connection", {
			phase: "connected",
			extensionName: status.extensionName,
			account: {
				address: next.address,
				name: next.name ?? null,
			},
			evmAddress: ss58ToEvmAddress(next.address),
		});
		logDiagnostic("wallet", "account_selected", {
			extensionName: status.extensionName,
			account: {
				address: next.address,
				name: next.name ?? null,
			},
			evmAddress: ss58ToEvmAddress(next.address),
		});
		persist({ extensionName: status.extensionName, address: next.address });
	},

	disconnect: () => {
		logDiagnostic("wallet", "disconnect_requested", {
			extensionName: currentExtensionName,
		});
		currentUnsubscribe?.();
		currentUnsubscribe = null;
		currentExtensionName = null;
		persist(null);
		setDiagnosticState("wallet.connection", {
			phase: "disconnected",
			runtime: getRuntimeContextSnapshot(),
		});
		set({
			status: { kind: "disconnected" },
			extensionAccounts: [],
		});
	},

	restore: async () => {
		const stored = loadStored();
		if (!stored) {
			logDiagnostic("wallet", "restore_skipped", { reason: "no_stored_wallet" }, "debug");
			return;
		}
		logDiagnostic("wallet", "restore_requested", {
			stored,
			runtime: getRuntimeContextSnapshot(),
		});
		// Best-effort: attempt to reconnect silently. If the user hasn't
		// authorized us yet the extension will throw and we stay disconnected.
		try {
			await get().connect(stored.extensionName, stored.address);
			logDiagnostic("wallet", "restore_completed", { stored });
		} catch {
			// Swallow — the error path in `connect` already set `error` status
			// if relevant.
			logDiagnostic("wallet", "restore_failed", { stored }, "warn");
		}
	},
}));

// ── Convenience selectors ───────────────────────────────────────────

/** The SS58 address of the connected account, or null. */
export function selectConnectedAddress(state: WalletState): string | null {
	return state.status.kind === "connected" ? state.status.account.address : null;
}

/** The H160 the Univerify contract will see for the connected account. */
export function selectConnectedEvmAddress(state: WalletState): Address | null {
	return state.status.kind === "connected"
		? ss58ToEvmAddress(state.status.account.address)
		: null;
}

export function selectConnectedSigner(state: WalletState): PolkadotSigner | null {
	return state.status.kind === "connected" ? state.status.account.polkadotSigner : null;
}

/** Reactive hook: the connected account's EVM address (H160), or null. */
export function useConnectedEvmAddress(): Address | null {
	return useWalletStore(selectConnectedEvmAddress);
}

export function useConnectedSigner(): PolkadotSigner | null {
	return useWalletStore(selectConnectedSigner);
}

export function useWalletStatus(): WalletStatus {
	return useWalletStore((s) => s.status);
}

export function currentExtension(): string | null {
	return currentExtensionName;
}
