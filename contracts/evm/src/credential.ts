/**
 * Canonical credential construction and hashing for Univerify.
 *
 * This module is the single source of truth for how `claimsHash`,
 * `certificateId`, and `recipientCommitment` are computed. It is
 * imported by deploy scripts, tests, and (via the web copy) the frontend.
 *
 * Hashing uses Solidity-compatible keccak256(abi.encode(...)) so the
 * same result can be reproduced on-chain or in any EVM-compatible tool.
 */

import { encodeAbiParameters, keccak256, type Hex } from "viem";

// ── Credential Claims ───────────────────────────────────────────────

/**
 * The canonical set of claims that constitute an academic credential.
 * Fields are sorted alphabetically by key when hashed.
 */
export interface CredentialClaims {
	/** Name of the degree or certificate (e.g. "Bachelor of Computer Science") */
	degreeTitle: string;
	/** Name of the recipient (never stored on-chain — only used for hashing) */
	holderName: string;
	/** Issuing institution name (e.g. "Universidad de Buenos Aires") */
	institutionName: string;
	/** ISO 8601 date string of academic issuance (e.g. "2026-03-15") */
	issuanceDate: string;
}

/**
 * Compute the canonical `claimsHash` from credential claims.
 *
 * The encoding mirrors `abi.encode(string, string, string, string)` with
 * fields sorted alphabetically by key name:
 *   degreeTitle, holderName, institutionName, issuanceDate
 *
 * This order is fixed and MUST NOT change — any change invalidates all
 * previously issued credentials.
 */
export function computeClaimsHash(claims: CredentialClaims): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "string", name: "degreeTitle" },
				{ type: "string", name: "holderName" },
				{ type: "string", name: "institutionName" },
				{ type: "string", name: "issuanceDate" },
			],
			[
				claims.degreeTitle,
				claims.holderName,
				claims.institutionName,
				claims.issuanceDate,
			],
		),
	);
}

// ── Certificate ID ──────────────────────────────────────────────────

/**
 * Derive a deterministic `certificateId` from issuer address + an
 * institution-internal unique reference (e.g. diploma number).
 *
 * `certificateId = keccak256(abi.encode(issuer, internalRef))`
 */
export function deriveCertificateId(issuer: Hex, internalRef: string): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "address", name: "issuer" },
				{ type: "string", name: "internalRef" },
			],
			[issuer, internalRef],
		),
	);
}

// ── Recipient Commitment ────────────────────────────────────────────

/**
 * Compute the `recipientCommitment` — a privacy-preserving binding of
 * the credential to its holder.
 *
 * `recipientCommitment = keccak256(abi.encode(secret, holderIdentifier))`
 *
 * - `secret`: a random value known only to the issuer and the holder.
 * - `holderIdentifier`: any stable identifier for the holder (email,
 *    student ID, national ID hash, etc.).
 *
 * The holder proves ownership by revealing the preimage to a verifier.
 */
export function computeRecipientCommitment(secret: Hex, holderIdentifier: string): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "bytes32", name: "secret" },
				{ type: "string", name: "holderIdentifier" },
			],
			[secret, holderIdentifier],
		),
	);
}

// ── Full Credential Envelope ────────────────────────────────────────

/**
 * A complete off-chain credential — everything the holder receives
 * and later presents to a verifier.
 */
export interface VerifiableCredential {
	certificateId: Hex;
	issuer: Hex;
	claims: CredentialClaims;
	recipientCommitment: Hex;
}

/**
 * Build a complete credential envelope ready for issuance.
 * Returns all values needed for the on-chain `issueCertificate` call
 * plus the full off-chain credential for the holder.
 */
export function buildCredential(params: {
	issuer: Hex;
	internalRef: string;
	claims: CredentialClaims;
	secret: Hex;
	holderIdentifier: string;
}): {
	credential: VerifiableCredential;
	claimsHash: Hex;
	certificateId: Hex;
	recipientCommitment: Hex;
} {
	const certificateId = deriveCertificateId(params.issuer, params.internalRef);
	const claimsHash = computeClaimsHash(params.claims);
	const recipientCommitment = computeRecipientCommitment(
		params.secret,
		params.holderIdentifier,
	);

	return {
		credential: {
			certificateId,
			issuer: params.issuer,
			claims: params.claims,
			recipientCommitment,
		},
		claimsHash,
		certificateId,
		recipientCommitment,
	};
}
