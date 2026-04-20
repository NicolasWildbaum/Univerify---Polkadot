/**
 * Canonical credential construction and hashing for Univerify.
 *
 * Frontend copy of `contracts/evm/src/credential.ts`. Kept verbatim so the
 * frontend reproduces exactly the same `claimsHash` and `certificateId` as
 * the deploy scripts and tests. Any schema or encoding change MUST be
 * mirrored in both files until a shared package is introduced.
 *
 * Holder-to-credential binding is handled entirely by the soulbound NFT
 * minted to the student's wallet by `CertificateNft`; there is no
 * separate holder commitment in the credential envelope.
 *
 * Hashing uses Solidity-compatible keccak256(abi.encode(...)) via viem.
 */

import { encodeAbiParameters, keccak256, type Hex } from "viem";

// ── Credential Claims ───────────────────────────────────────────────

/**
 * The canonical set of claims that constitute an academic credential.
 * Fields are sorted alphabetically by key when hashed.
 *
 * Schema v2: strings are normalized (NFC + trim + collapse whitespace +
 * UPPERCASE) and `issuanceDate` is reduced to `YYYY-MM` before hashing,
 * so the verifier reproduces the same `claimsHash` regardless of casing
 * or accidental whitespace differences. Use `normalizeClaims` to inspect
 * the canonical form that will actually be hashed.
 */
export interface CredentialClaims {
	/** Name of the degree or certificate (e.g. "Bachelor of Computer Science") */
	degreeTitle: string;
	/** Name of the recipient (never stored on-chain — only used for hashing) */
	holderName: string;
	/** Issuing institution name (e.g. "Universidad de Buenos Aires") */
	institutionName: string;
	/** Year-month of academic issuance as `YYYY-MM` (e.g. "2026-03"). Legacy
	 *  `YYYY-MM-DD` inputs are accepted and reduced to `YYYY-MM` by
	 *  `normalizeClaims`; any other shape throws. */
	issuanceDate: string;
}

// ── Normalization (Schema v2) ───────────────────────────────────────

/**
 * Normalize a free-form claim string so issuer and verifier always feed
 * the exact same bytes into `keccak256`:
 *   1. Unicode NFC (avoids visually-identical but binary-different code points).
 *   2. Trim leading/trailing whitespace.
 *   3. Collapse internal runs of whitespace to a single space.
 *   4. Uppercase (default locale; intentional: we don't want Turkish dotless-i
 *      handling to depend on the verifier's locale).
 */
function normalizeText(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Canonicalize an issuance date input to `YYYY-MM`.
 *
 * Accepts:
 *   - `YYYY-MM` (canonical form, returned unchanged after validation)
 *   - `YYYY-MM-DD` (legacy ISO date — day component is dropped)
 *
 * Throws on any other shape, on out-of-range months (01-12), or on a
 * non-4-digit year.
 */
function normalizeIssuanceDate(value: string): string {
	const trimmed = value.trim();
	const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(trimmed);
	if (!match) {
		throw new Error(
			`Invalid issuanceDate "${value}": expected "YYYY-MM" (or legacy "YYYY-MM-DD").`,
		);
	}
	const year = match[1];
	const month = Number(match[2]);
	if (month < 1 || month > 12) {
		throw new Error(`Invalid issuanceDate "${value}": month must be between 01 and 12.`);
	}
	return `${year}-${match[2]}`;
}

/**
 * Return a fully canonicalized copy of the claims — the exact values that
 * `computeClaimsHash` will feed into `keccak256(abi.encode(...))`. UI
 * surfaces (issuer / verifier) use this to show "what will be hashed".
 */
export function normalizeClaims(claims: CredentialClaims): CredentialClaims {
	return {
		degreeTitle: normalizeText(claims.degreeTitle),
		holderName: normalizeText(claims.holderName),
		institutionName: normalizeText(claims.institutionName),
		issuanceDate: normalizeIssuanceDate(claims.issuanceDate),
	};
}

/**
 * Compute the canonical `claimsHash` from credential claims.
 *
 * Claims are passed through `normalizeClaims` first, so any difference in
 * casing, whitespace, Unicode form, or `YYYY-MM-DD` vs `YYYY-MM` does not
 * change the hash. The encoding then mirrors
 * `abi.encode(string, string, string, string)` with fields sorted
 * alphabetically by key name: degreeTitle, holderName, institutionName,
 * issuanceDate. This order is fixed and MUST NOT change.
 */
export function computeClaimsHash(claims: CredentialClaims): Hex {
	const c = normalizeClaims(claims);
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "string", name: "degreeTitle" },
				{ type: "string", name: "holderName" },
				{ type: "string", name: "institutionName" },
				{ type: "string", name: "issuanceDate" },
			],
			[c.degreeTitle, c.holderName, c.institutionName, c.issuanceDate],
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

// ── Full Credential Envelope ────────────────────────────────────────

/**
 * A complete off-chain credential — everything the holder receives
 * and later presents to a verifier.
 */
export interface VerifiableCredential {
	certificateId: Hex;
	issuer: Hex;
	claims: CredentialClaims;
}

/**
 * Build a complete credential envelope ready for issuance.
 */
export function buildCredential(params: {
	issuer: Hex;
	internalRef: string;
	claims: CredentialClaims;
}): {
	credential: VerifiableCredential;
	claimsHash: Hex;
	certificateId: Hex;
} {
	const certificateId = deriveCertificateId(params.issuer, params.internalRef);
	// Normalize once and reuse: the JSON envelope carries the canonical
	// strings so a downstream verifier hashes the exact same bytes the
	// issuer did, even if they re-render or re-key the JSON.
	const normalizedClaims = normalizeClaims(params.claims);
	const claimsHash = computeClaimsHash(normalizedClaims);

	return {
		credential: {
			certificateId,
			issuer: params.issuer,
			claims: normalizedClaims,
		},
		claimsHash,
		certificateId,
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
		return {
			ok: false,
			error: "Missing or invalid `certificateId` (expected 0x-prefixed bytes32).",
		};
	}
	if (typeof v.issuer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v.issuer)) {
		return { ok: false, error: "Missing or invalid `issuer` (expected 0x-prefixed address)." };
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
			claims: {
				degreeTitle: c.degreeTitle as string,
				holderName: c.holderName as string,
				institutionName: c.institutionName as string,
				issuanceDate: c.issuanceDate as string,
			},
		},
	};
}
