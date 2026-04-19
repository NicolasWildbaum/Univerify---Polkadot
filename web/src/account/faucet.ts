// Dev-only faucet.
//
// Signs a `Balances.transfer_keep_alive` from the well-known `//Alice` seed
// into any address, so a freshly-connected wallet can afford its first few
// extrinsic fees on the local chain (map_account, issue, etc).
//
// This is strictly for the local dev chain. The caller guards the UI with
// `isLocalChain(wsUrl)`, and in production (Paseo) the button that calls
// this helper is never rendered — the tree-shaker drops the whole module
// from the production bundle because nothing reaches it.

import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { getClient } from "../hooks/useChain";
import { LOCAL_WS_URL } from "../config/network";

// 0.01 UNIT. Enough to cover dozens of extrinsics at the current fee schedule
// but far from depleting Alice's `1 << 60` balance even after hundreds of
// top-ups. If fees ever spike, just bump this number.
const FAUCET_AMOUNT = 10_000_000_000_000_000n;

/** True when the given WS endpoint is the local dev chain. */
export function isLocalChain(wsUrl: string): boolean {
	if (wsUrl === LOCAL_WS_URL) return true;
	return /localhost|127\.0\.0\.1/.test(wsUrl);
}

let aliceSigner: ReturnType<typeof getPolkadotSigner> | null = null;

function getAliceSigner() {
	if (aliceSigner) return aliceSigner;
	const entropy = mnemonicToEntropy(DEV_PHRASE);
	const miniSecret = entropyToMiniSecret(entropy);
	const derive = sr25519CreateDerive(miniSecret);
	const kp = derive("//Alice");
	aliceSigner = getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);
	return aliceSigner;
}

export interface FaucetResult {
	txHash: string;
	amount: bigint;
}

/**
 * Send `FAUCET_AMOUNT` from `//Alice` to `recipientSs58`. Resolves once the
 * transfer is included in a block; throws on dispatch error.
 */
export async function requestDevFunds(
	wsUrl: string,
	recipientSs58: string,
): Promise<FaucetResult> {
	if (!isLocalChain(wsUrl)) {
		throw new Error("Dev faucet is only available on the local chain.");
	}
	const client = getClient(wsUrl);
	const api = client.getUnsafeApi();

	// Alice endowment at genesis is `1 << 60`. `transfer_keep_alive` refuses to
	// drop her below the existential deposit, so we won't brick the preset
	// even under sustained use.
	const tx = api.tx.Balances.transfer_keep_alive({
		dest: MultiAddress(recipientSs58),
		value: FAUCET_AMOUNT,
	});
	const result = await tx.signAndSubmit(getAliceSigner());
	if (!result.ok) {
		throw new Error(`Faucet transfer failed: ${JSON.stringify(result.dispatchError)}`);
	}
	return { txHash: result.txHash, amount: FAUCET_AMOUNT };
}

// `Balances.transfer_keep_alive` expects a `MultiAddress::Id(AccountId32)`
// enum variant. PAPI's unsafe-api accepts the canonical enum shape below.
function MultiAddress(ss58: string) {
	return { type: "Id", value: ss58 };
}
