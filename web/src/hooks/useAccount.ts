import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
	DEV_PHRASE,
	entropyToMiniSecret,
	mnemonicToEntropy,
	ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { type PolkadotSigner } from "polkadot-api";

// Dev accounts derived from the well-known dev seed phrase
const entropy = mnemonicToEntropy(DEV_PHRASE);
const miniSecret = entropyToMiniSecret(entropy);
const derive = sr25519CreateDerive(miniSecret);

export type DevAccount = {
	name: string;
	address: string;
	signer: PolkadotSigner;
};

function createDevAccount(name: string, path: string): DevAccount {
	const keypair = derive(path);
	return {
		name,
		address: ss58Address(keypair.publicKey),
		signer: getPolkadotSigner(keypair.publicKey, "Sr25519", keypair.sign),
	};
}

export const devAccounts: DevAccount[] = [
	createDevAccount("Alice", "//Alice"),
	createDevAccount("Bob", "//Bob"),
	createDevAccount("Charlie", "//Charlie"),
];

const devPaths = ["//Alice", "//Bob", "//Charlie"];

/**
 * Get the raw sr25519 keypair for a dev account by index.
 * Returns publicKey and sign function for use outside of PAPI transactions
 * for app-specific wallet signing flows.
 */
export function getDevKeypair(index: number): {
	publicKey: Uint8Array;
	sign: (message: Uint8Array) => Uint8Array;
} {
	const keypair = derive(devPaths[index]);
	return { publicKey: keypair.publicKey, sign: keypair.sign };
}
