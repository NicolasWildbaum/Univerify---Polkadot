// Sign and submit a Univerify contract call on behalf of the connected
// Polkadot wallet.
//
// Why not viem? viem needs an Ethereum-format private key (or an EIP-1193
// provider). Polkadot injected wallets only sign Substrate extrinsics, so
// we reach the contract via `pallet_revive::call` instead of eth-rpc. The
// pallet's AccountId32Mapper translates the SS58-origin into an H160 before
// entering the contract — that H160 is exactly `ss58ToEvmAddress(...)`, so
// on-chain permission checks against `msg.sender` stay consistent with the
// address we show in the UI.
//
// Reads still go through viem (`getPublicClient`), which is faster and
// doesn't require descriptors for the pallet.
//
// Performance notes:
//   - `signSubmitAndWatch` resolves on best-block inclusion (~6-12s on
//     Paseo) instead of waiting for GRANDPA finality (~30-60s).
//   - `mappedAccounts` caches the per-session result of `ensureMapped` so
//     repeated txs skip the WS storage query.

import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { Binary, FixedSizeBinary, type PolkadotClient, type PolkadotSigner } from "polkadot-api";
import { getClient } from "../hooks/useChain";

// `${wsUrl}::${evmAddress.toLowerCase()}` — set after a confirmed mapping.
// Avoids a WS round-trip per-tx once we know the account is mapped.
const mappedAccounts = new Set<string>();

// Per-call resource ceilings. A Substrate parachain block is ~2 s of
// reference compute (`WEIGHT_REF_TIME_PER_SECOND = 1e12`) with ~5 MiB of
// PoV. The transaction queue rejects extrinsics whose `weight_limit`
// exceeds the per-extrinsic cap with `Invalid.ExhaustsResources` before
// they execute, so we have to stay well under the block budget. Unused
// weight and unused storage deposit are refunded post-dispatch, so the
// signer never pays for the slack — but over-asking is fatal.
//
// The proof_size budget is the binding constraint here: every new MPT
// entry adds a few KiB of merkle proof to the PoV, and `issueCertificate`
// + cross-contract `mintFor` (ERC721Enumerable bookkeeping) writes ~10
// entries. 1 MiB comfortably covers that without bumping into the
// per-extrinsic cap. The previous value (256 KiB) was sized for the
// pre-NFT registry-only write and was the cause of the contract reverts
// we saw after wiring the soulbound NFT.
const WEIGHT_REF_TIME = 800_000_000_000n; // 0.8 s — within the per-extrinsic cap
const WEIGHT_PROOF_SIZE = 1_048_576n; // 1 MiB — ~4x the pre-NFT limit
const STORAGE_DEPOSIT_LIMIT = 100_000_000_000_000_000n; // generous, refunded

interface SubmitOptions {
	wsUrl: string;
	signer: PolkadotSigner;
	/** H160 that `pallet-revive` will see as `msg.sender`. Used to check
	 *  whether the signer is already mapped and skip the one-time
	 *  `map_account` extrinsic if so. */
	signerEvmAddress: Address;
	contractAddress: Address;
	abi: Abi;
	// `unknown[]` rather than `readonly unknown[]` to stay structural with
	// the viem ABI encoder's input surface without paying a generics tax here.
	args: unknown[];
	functionName: string;
	/** Native value to attach to the call. Defaults to 0. */
	value?: bigint;
	/** Called as soon as the tx is broadcast (before block inclusion).
	 *  Use this to transition the UI from "awaiting wallet" to "submitted". */
	onBroadcast?: (txHash: Hex) => void;
}

export interface SubmitResult {
	txHash: Hex;
	block: { hash: string; number: number; index: number };
}

export async function submitReviveCall({
	wsUrl,
	signer,
	signerEvmAddress,
	contractAddress,
	abi,
	functionName,
	args,
	value = 0n,
	onBroadcast,
}: SubmitOptions): Promise<SubmitResult> {
	const data = encodeFunctionData({
		abi,
		functionName,
		args: args as never,
	}) as Hex;

	const client: PolkadotClient = getClient(wsUrl);
	// `getUnsafeApi` is deliberately un-typed: `Revive` isn't generated into
	// the PAPI descriptors for this project, so we rely on the runtime
	// metadata and pallet-revive's stable call signature:
	// `call(dest, value, weight_limit, storage_deposit_limit, data)`.
	const api = client.getUnsafeApi();

	// One-time on-chain mapping: pallet-revive's `AccountId32Mapper` needs
	// `OriginalAccount[h160] == signer` so it can resolve `msg.sender` back
	// to the 32-byte origin during dispatch. Eth-derived accounts (pubkey
	// suffix `0xee…ee`) are implicitly mapped; everything else must call
	// `map_account` once. We check a session cache first, then storage.
	await ensureMapped(api, signer, signerEvmAddress, wsUrl);

	const tx = api.tx.Revive.call({
		dest: FixedSizeBinary.fromHex(contractAddress),
		value,
		weight_limit: {
			ref_time: WEIGHT_REF_TIME,
			proof_size: WEIGHT_PROOF_SIZE,
		},
		storage_deposit_limit: STORAGE_DEPOSIT_LIMIT,
		data: Binary.fromHex(data),
	});

	return signSubmitBestBlock(tx, signer, onBroadcast);
}

// Resolves on best-block inclusion (~6-12s on Paseo) instead of waiting for
// GRANDPA finality (~30-60s). Calls `onBroadcast` once the tx hash is known.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function signSubmitBestBlock(
	tx: any,
	signer: PolkadotSigner,
	onBroadcast?: (txHash: Hex) => void,
): Promise<SubmitResult> {
	return new Promise((resolve, reject) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sub = tx.signSubmitAndWatch(signer).subscribe({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			next(event: any) {
				if (event.type === "broadcasted") {
					onBroadcast?.(event.txHash as Hex);
				} else if (event.type === "txBestBlocksState") {
					if (!event.found) {
						if (event.isValid === false) {
							sub.unsubscribe();
							reject(new Error("Transaction was rejected from the pool."));
						}
						return;
					}
					sub.unsubscribe();
					if (!event.ok) {
						reject(new ReviveDispatchError(event.dispatchError));
					} else {
						resolve({ txHash: event.txHash as Hex, block: event.block });
					}
				}
			},
			error: reject,
		});
	});
}

// Register the signer's (AccountId32 → H160) pairing in pallet-revive if it
// isn't there yet. Costs one small Substrate extrinsic the first time; no-op
// afterwards. We treat any dispatch error here as fatal because without a
// mapping the subsequent `Revive.call` would error with `AccountUnmapped`.
async function ensureMapped(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	api: any,
	signer: PolkadotSigner,
	signerEvmAddress: Address,
	wsUrl: string,
): Promise<void> {
	const cacheKey = `${wsUrl}::${signerEvmAddress.toLowerCase()}`;
	if (mappedAccounts.has(cacheKey)) return;

	const existing = await api.query.Revive.OriginalAccount.getValue(
		FixedSizeBinary.fromHex(signerEvmAddress),
	);
	if (existing !== undefined) {
		mappedAccounts.add(cacheKey);
		return;
	}

	const mapTx = api.tx.Revive.map_account();
	await signSubmitBestBlock(mapTx, signer);
	mappedAccounts.add(cacheKey);
}

export class ReviveDispatchError extends Error {
	readonly dispatchError: { type: string; value: unknown };
	constructor(dispatchError: { type: string; value: unknown }) {
		// Try to extract a useful message, including pallet-revive's
		// `ContractReverted` variant which wraps the ABI error bytes.
		super(formatDispatchError(dispatchError));
		this.dispatchError = dispatchError;
	}
}

function formatDispatchError(err: { type: string; value: unknown }): string {
	if (!err) return "Unknown dispatch error";
	if (err.type === "Module" && err.value && typeof err.value === "object") {
		const v = err.value as { type?: string; value?: { type?: string } };
		const pallet = v.type ?? "Module";
		const variant = v.value?.type ?? "?";
		return `${pallet}.${variant}`;
	}
	return err.type;
}
