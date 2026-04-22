import { keccak256, toBytes } from "viem";

// Centralised parser for Univerify Solidity custom errors.
//
// viem surfaces revert reasons in different fields depending on the error
// type and provider, and walking the `cause` chain is required for nested
// JSON-RPC errors. This module isolates that fragility behind one helper.
//
// We look for the error name in three places (most → least reliable):
//   1. `errorName` on any `ContractFunctionRevertedError` in the cause chain
//      (viem decoded it for us against the ABI).
//   2. Raw revert data bytes in the cause chain (`data` / `cause.data`),
//      decoded here against `KNOWN_ERROR_SELECTORS`.
//   3. Plain text scan of the concatenated error messages (last-resort, for
//      providers that surface revert reasons only as strings).

/** All custom-error names declared by `Univerify.sol` after the decentralised
 *  refactor. Keep in sync with the contract source. The discriminated union
 *  lets call sites use exhaustive switch/match while still falling back to
 *  `null` for unknown reverts. */
export type UniverifyErrorName =
	// Governance errors
	| "NotActiveIssuer"
	| "ZeroAddress"
	| "EmptyName"
	| "NameTooLong"
	| "IssuerAlreadyExists"
	| "IssuerNotFound"
	| "IssuerNotPending"
	| "IssuerNotActive"
	| "CannotApproveSelf"
	| "AlreadyApproved"
	| "InvalidThreshold"
	| "InvalidGenesis"
	// Removal-governance errors
	| "CannotProposeSelfRemoval"
	| "RemovalProposalAlreadyOpen"
	| "RemovalProposalNotFound"
	| "RemovalProposalAlreadyExecuted"
	| "AlreadyVotedForRemoval"
	| "CannotVoteOnOwnRemoval"
	// Certificate errors
	| "InvalidCertificateId"
	| "InvalidClaimsHash"
	| "InvalidStudentAddress"
	| "CertificateAlreadyExists"
	| "CertificateNotFound"
	| "NotCertificateIssuer"
	| "CertificateAlreadyRevoked"
	| "NotCertificateHolder"
	| "EmptyPdfCid"
	// NFT wiring errors (Univerify ↔ CertificateNft)
	| "NftAlreadySet"
	| "NftNotConfigured"
	| "NftMinterMismatch"
	// CertificateNft errors (surface through the cross-contract call)
	| "NotMinter"
	| "AlreadyMinted"
	| "InvalidStudent"
	| "SoulboundNonTransferable"
	| "SoulboundNoApprovals";

const KNOWN_ERROR_NAMES: readonly UniverifyErrorName[] = [
	"NotActiveIssuer",
	"ZeroAddress",
	"EmptyName",
	"NameTooLong",
	"IssuerAlreadyExists",
	"IssuerNotFound",
	"IssuerNotPending",
	"IssuerNotActive",
	"CannotApproveSelf",
	"AlreadyApproved",
	"InvalidThreshold",
	"InvalidGenesis",
	"CannotProposeSelfRemoval",
	"RemovalProposalAlreadyOpen",
	"RemovalProposalNotFound",
	"RemovalProposalAlreadyExecuted",
	"AlreadyVotedForRemoval",
	"CannotVoteOnOwnRemoval",
	"InvalidCertificateId",
	"InvalidClaimsHash",
	"InvalidStudentAddress",
	"CertificateAlreadyExists",
	"CertificateNotFound",
	"NotCertificateIssuer",
	"CertificateAlreadyRevoked",
	"NotCertificateHolder",
	"EmptyPdfCid",
	"NftAlreadySet",
	"NftNotConfigured",
	"NftMinterMismatch",
	"NotMinter",
	"AlreadyMinted",
	"InvalidStudent",
	"SoulboundNonTransferable",
	"SoulboundNoApprovals",
] as const;

const MAX_CAUSE_DEPTH = 10;

// 4-byte selector → error name. Computed lazily on first use because
// `keccak256` isn't free and most pages never hit this code path.
let SELECTOR_TO_NAME: Map<string, UniverifyErrorName> | null = null;
function getSelectorMap(): Map<string, UniverifyErrorName> {
	if (SELECTOR_TO_NAME) return SELECTOR_TO_NAME;
	SELECTOR_TO_NAME = new Map();
	for (const name of KNOWN_ERROR_NAMES) {
		// All Univerify custom errors are zero-arg — selector is keccak256("Name()")[:4].
		const sig = `${name}()`;
		const sel = keccak256(toBytes(sig)).slice(0, 10).toLowerCase();
		SELECTOR_TO_NAME.set(sel, name);
	}
	return SELECTOR_TO_NAME;
}

/** Walk an error and its `.cause` chain, returning the matched Univerify
 *  custom error name if any layer carries it, otherwise `null`. */
export function extractRevertName(err: unknown): UniverifyErrorName | null {
	// 1. viem-decoded `errorName` on a ContractFunctionRevertedError.
	const decoded = findDecodedErrorName(err);
	if (decoded) return decoded;

	// 2. Raw revert data → look up by selector.
	const data = findRevertData(err);
	if (data && data.length >= 10) {
		const sel = data.slice(0, 10).toLowerCase();
		const name = getSelectorMap().get(sel);
		if (name) return name;
	}

	// 3. Text scan (covers older providers / Substrate-side errors).
	const haystack = collectErrorText(err);
	for (const name of KNOWN_ERROR_NAMES) {
		if (haystack.includes(name)) return name;
	}
	return null;
}

function findDecodedErrorName(err: unknown): UniverifyErrorName | null {
	let current: unknown = err;
	let depth = 0;
	while (current && depth < MAX_CAUSE_DEPTH) {
		const obj = current as { name?: string; errorName?: string; cause?: unknown };
		if (typeof obj.errorName === "string") {
			const candidate = obj.errorName as UniverifyErrorName;
			if ((KNOWN_ERROR_NAMES as readonly string[]).includes(candidate)) {
				return candidate;
			}
		}
		current = obj.cause;
		depth += 1;
	}
	return null;
}

function findRevertData(err: unknown): string | null {
	let current: unknown = err;
	let depth = 0;
	while (current && depth < MAX_CAUSE_DEPTH) {
		const obj = current as { data?: unknown; cause?: unknown };
		if (typeof obj.data === "string" && obj.data.startsWith("0x")) {
			return obj.data;
		}
		// JSON-RPC errors sometimes wrap the data: { data: { data: "0x..." } }.
		if (obj.data && typeof obj.data === "object") {
			const inner = (obj.data as { data?: unknown }).data;
			if (typeof inner === "string" && inner.startsWith("0x")) return inner;
		}
		current = obj.cause;
		depth += 1;
	}
	return null;
}

function collectErrorText(err: unknown): string {
	const parts: string[] = [];
	let current: unknown = err;
	let depth = 0;
	while (current && depth < MAX_CAUSE_DEPTH) {
		if (current instanceof Error) {
			parts.push(current.message);
			const extras = current as { shortMessage?: string; details?: string };
			if (extras.shortMessage) parts.push(extras.shortMessage);
			if (extras.details) parts.push(extras.details);
			current = (current as { cause?: unknown }).cause;
		} else {
			parts.push(String(current));
			break;
		}
		depth += 1;
	}
	return parts.join("\n");
}
