/**
 * Canonical credential construction and hashing for Univerify.
 *
 * Frontend copy of `contracts/evm/src/credential.ts`. Kept verbatim so the
 * frontend reproduces exactly the same `claimsHash`, `certificateId`, and
 * `recipientCommitment` as the deploy scripts and tests. Any schema or
 * encoding change MUST be mirrored in both files until a shared package is
 * introduced.
 *
 * Hashing uses Solidity-compatible keccak256(abi.encode(...)) via viem.
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

// ── Validation helpers (frontend-only) ──────────────────────────────

/**
 * Minimal runtime check that an unknown value has the shape of a
 * `VerifiableCredential`. Used when parsing pasted / uploaded JSON.
 * Returns a typed object on success, or an error message string.
 */
export function parseVerifiableCredential(
	value: unknown,
): { ok: true; credential: VerifiableCredential } | { ok: false; error: string } {
	if (!value || typeof value !== "object") {
		return { ok: false, error: "Credential must be a JSON object." };
	}
	const v = value as Record<string, unknown>;

	if (typeof v.certificateId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.certificateId)) {
		return { ok: false, error: "Missing or invalid `certificateId` (expected 0x-prefixed bytes32)." };
	}
	if (typeof v.issuer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v.issuer)) {
		return { ok: false, error: "Missing or invalid `issuer` (expected 0x-prefixed address)." };
	}
	if (
		typeof v.recipientCommitment !== "string" ||
		!/^0x[0-9a-fA-F]{64}$/.test(v.recipientCommitment)
	) {
		return {
			ok: false,
			error: "Missing or invalid `recipientCommitment` (expected 0x-prefixed bytes32).",
		};
	}
	if (!v.claims || typeof v.claims !== "object") {
		return { ok: false, error: "Missing `claims` object." };
	}
	const c = v.claims as Record<string, unknown>;
	for (const key of ["degreeTitle", "holderName", "institutionName", "issuanceDate"] as const) {
		if (typeof c[key] !== "string" || (c[key] as string).length === 0) {
			return { ok: false, error: `Missing or empty claim \`${key}\`.` };
		}
	}

	return {
		ok: true,
		credential: {
			certificateId: v.certificateId as Hex,
			issuer: v.issuer as Hex,
			recipientCommitment: v.recipientCommitment as Hex,
			claims: {
				degreeTitle: c.degreeTitle as string,
				holderName: c.holderName as string,
				institutionName: c.institutionName as string,
				issuanceDate: c.issuanceDate as string,
			},
		},
	};
}
