// Well-known Substrate dev accounts derived from the standard dev phrase.
// These are PUBLIC test keys — NEVER use for real funds.
//
// Accounts are created at module load time using pure-JS sr25519 — no WASM,
// no async init required. They implement the same `InjectedPolkadotAccount`
// shape as extension accounts so the wallet store accepts them unchanged.

import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_MINI_SECRET, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "@polkadot-api/signer";
import type { InjectedPolkadotAccount } from "polkadot-api/pjs-signer";

// Generic Substrate SS58 prefix (used by local dev chains).
const SS58_PREFIX = 42;

const derive = sr25519CreateDerive(DEV_MINI_SECRET);

function makeDevAccount(name: string, path: string): InjectedPolkadotAccount {
	const kp = derive(path);
	return {
		address: ss58Address(kp.publicKey, SS58_PREFIX),
		name: `${name} (dev)`,
		type: "sr25519",
		polkadotSigner: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign),
	};
}

export const DEV_ACCOUNTS: InjectedPolkadotAccount[] = [
	makeDevAccount("Alice", "//Alice"),
	makeDevAccount("Bob", "//Bob"),
	makeDevAccount("Charlie", "//Charlie"),
	makeDevAccount("Polythecnical University of Valencia", "//Dave"),
	makeDevAccount("Eve", "//Eve"),
];
