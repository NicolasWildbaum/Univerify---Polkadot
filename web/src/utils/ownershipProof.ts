// Off-chain ownership proof for Univerify certificates.
//
// Security property added:
//   Proves that the presenter controls the wallet that currently holds the
//   soulbound NFT. The certificate validity check (issuer, revocation) is
//   separate and does not require this proof — it works for any verifier with
//   a link. This layer additionally binds the human holding the credential to
//   the on-chain identity.
//
// What it does NOT prove:
//   - That the holder is the person named in the certificate claims.
//   - That the holder will still own the wallet tomorrow (they could transfer
//     the SS58 key; the NFT itself is soulbound and cannot be transferred).
//
// Challenge structure (UTF-8 text, newline-separated):
//   Univerify Ownership Proof
//   Certificate: 0x<certificateId>
//   Owner: 0x<h160>
//   Nonce: 0x<16 random bytes>
//   Expires: <unix timestamp seconds>
//   Domain: univerify.app
//
// Signing: polkadotSigner.signBytes(TextEncoder(message)) returns a raw
// Uint8Array. Polkadot.js-compatible extensions wrap the bytes in
// "<Bytes>…</Bytes>" before signing, which signatureVerify handles by
// trying both forms automatically.
//
// Encoding: the SignedPresentation JSON is base64url-encoded and attached
// as a ?presentation= query parameter on the public verify URL.
//
// Verification uses @polkadot/util-crypto's signatureVerify, which auto-
// detects sr25519 / ed25519 / ecdsa and handles the PJS byte-wrapping.

import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { Keccak256 } from "@polkadot-api/substrate-bindings";
import type { PolkadotSigner } from "polkadot-api";
import type { Address } from "viem";

export const PROOF_VALIDITY_SECONDS = 3600; // 1 hour

export interface OwnershipChallenge {
	certificateId: string; // 0x-prefixed bytes32
	ownerH160: string; // 0x-prefixed H160 — current NFT holder at signing time
	nonce: string; // 0x-prefixed 16-byte random hex
	expiresAt: number; // unix timestamp seconds
}

export interface SignedPresentation {
	challenge: OwnershipChallenge;
	signature: string; // 0x-prefixed hex — raw output of signBytes (65 bytes with type prefix)
	publicKey: string; // 0x-prefixed hex — 32-byte raw SS58 public key
}

export type OwnershipVerdict =
	| { ok: true; signerH160: Address }
	| { ok: false; reason: string };

// ── Internal helpers ───────────────────────────────────────────────────

function hexEncode(bytes: Uint8Array): string {
	return (
		"0x" +
		Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
	);
}

function hexDecode(hex: string): Uint8Array {
	const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
	if (clean.length % 2 !== 0) throw new Error("Odd-length hex string");
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

// Same mapping as ss58ToEvmAddress in wallet.ts, but operating on the raw
// 32-byte public key instead of an SS58 string.
export function pubkeyToH160(pubkey: Uint8Array): Address {
	const isEthDerived =
		pubkey.length === 32 && pubkey.slice(20).every((b) => b === 0xee);
	const addrBytes: Uint8Array = isEthDerived
		? pubkey.slice(0, 20)
		: Keccak256(pubkey).slice(-20);
	return hexEncode(addrBytes) as Address;
}

// ── Public API ─────────────────────────────────────────────────────────

export function buildChallenge(
	certificateId: string,
	ownerH160: string,
): OwnershipChallenge {
	const nonce = hexEncode(crypto.getRandomValues(new Uint8Array(16)));
	const expiresAt = Math.floor(Date.now() / 1000) + PROOF_VALIDITY_SECONDS;
	return { certificateId, ownerH160, nonce, expiresAt };
}

export function buildChallengeMessage(c: OwnershipChallenge): string {
	return [
		"Univerify Ownership Proof",
		`Certificate: ${c.certificateId}`,
		`Owner: ${c.ownerH160}`,
		`Nonce: ${c.nonce}`,
		`Expires: ${c.expiresAt}`,
		"Domain: univerify.app",
	].join("\n");
}

// Sign a challenge and return the encoded presentation ready to embed in a URL.
export async function createPresentation(
	challenge: OwnershipChallenge,
	signer: PolkadotSigner,
): Promise<SignedPresentation> {
	const msgBytes = new TextEncoder().encode(buildChallengeMessage(challenge));
	const sigBytes = await signer.signBytes(msgBytes);
	return {
		challenge,
		signature: hexEncode(sigBytes),
		publicKey: hexEncode(signer.publicKey),
	};
}

export function encodePresentation(p: SignedPresentation): string {
	return btoa(JSON.stringify(p))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

export function decodePresentation(encoded: string): SignedPresentation | null {
	try {
		const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
		const p = JSON.parse(json) as Partial<SignedPresentation>;
		if (
			typeof p.challenge?.certificateId !== "string" ||
			typeof p.challenge?.ownerH160 !== "string" ||
			typeof p.challenge?.nonce !== "string" ||
			typeof p.challenge?.expiresAt !== "number" ||
			typeof p.signature !== "string" ||
			typeof p.publicKey !== "string"
		)
			return null;
		return p as SignedPresentation;
	} catch {
		return null;
	}
}

// Verify a decoded presentation against the current on-chain NFT owner.
// Checks expiry, key-to-H160 binding, and cryptographic signature.
export async function verifyOwnershipPresentation(
	p: SignedPresentation,
	expectedOwnerH160: string,
): Promise<OwnershipVerdict> {
	if (p.challenge.expiresAt < Date.now() / 1000) {
		return { ok: false, reason: "Presentation has expired." };
	}

	let pubkeyBytes: Uint8Array;
	try {
		pubkeyBytes = hexDecode(p.publicKey);
	} catch {
		return { ok: false, reason: "Invalid public key encoding in presentation." };
	}
	if (pubkeyBytes.length !== 32) {
		return {
			ok: false,
			reason: `Invalid public key length: expected 32 bytes, got ${pubkeyBytes.length}.`,
		};
	}

	// Derive H160 from the presented public key and confirm it matches the
	// current on-chain NFT owner. This binds the signature to chain state.
	const signerH160 = pubkeyToH160(pubkeyBytes);
	if (signerH160.toLowerCase() !== expectedOwnerH160.toLowerCase()) {
		return {
			ok: false,
			reason: `Presenter key maps to ${signerH160}, but the current NFT owner is ${expectedOwnerH160}.`,
		};
	}

	const msgBytes = new TextEncoder().encode(
		buildChallengeMessage(p.challenge),
	);

	try {
		await cryptoWaitReady();
		// signatureVerify auto-detects sr25519/ed25519/ecdsa and internally
		// retries with the PJS "<Bytes>…</Bytes>" wrapping if the first attempt
		// fails, so we pass the raw message bytes.
		const result = signatureVerify(msgBytes, p.signature, pubkeyBytes);
		if (!result.isValid) {
			return { ok: false, reason: "Signature verification failed." };
		}
		return { ok: true, signerH160 };
	} catch (e) {
		return {
			ok: false,
			reason: `Verification error: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
