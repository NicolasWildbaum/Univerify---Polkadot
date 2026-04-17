// Centralised parser for Univerify Solidity custom errors.
//
// viem surfaces revert reasons in different fields depending on the error
// type and provider, and walking the `cause` chain is required for nested
// JSON-RPC errors. This module isolates that fragility behind one helper.

/** All custom-error names declared by `Univerify.sol`. Keep in sync with the
 *  contract source. The discriminated union lets call sites use exhaustive
 *  switch/match while still falling back to `null` for unknown reverts. */
export type UniverifyErrorName =
	// Governance errors
	| "NotOwner"
	| "ZeroAddress"
	| "NotActiveIssuer"
	| "AlreadyApplied"
	| "AlreadyActive"
	| "NotPending"
	| "AlreadySuspended"
	| "NotSuspended"
	| "AlreadyApproved"
	| "SelfApproval"
	| "InvalidApprovalThreshold"
	| "EmptyName"
	| "NameTooLong"
	| "DuplicateGenesisIssuer"
	// Certificate errors
	| "InvalidCertificateId"
	| "InvalidClaimsHash"
	| "InvalidRecipientCommitment"
	| "CertificateAlreadyExists"
	| "CertificateNotFound"
	| "NotCertificateIssuer"
	| "CertificateAlreadyRevoked";

const KNOWN_ERROR_NAMES: readonly UniverifyErrorName[] = [
	"NotOwner",
	"ZeroAddress",
	"NotActiveIssuer",
	"AlreadyApplied",
	"AlreadyActive",
	"NotPending",
	"AlreadySuspended",
	"NotSuspended",
	"AlreadyApproved",
	"SelfApproval",
	"InvalidApprovalThreshold",
	"EmptyName",
	"NameTooLong",
	"DuplicateGenesisIssuer",
	"InvalidCertificateId",
	"InvalidClaimsHash",
	"InvalidRecipientCommitment",
	"CertificateAlreadyExists",
	"CertificateNotFound",
	"NotCertificateIssuer",
	"CertificateAlreadyRevoked",
] as const;

const MAX_CAUSE_DEPTH = 10;

/** Walk an error and its `.cause` chain, collecting every textual field viem
 *  may use to surface revert info. Returns the matched custom error name if
 *  any known token appears verbatim, otherwise `null`. */
export function extractRevertName(err: unknown): UniverifyErrorName | null {
	const haystack = collectErrorText(err);
	for (const name of KNOWN_ERROR_NAMES) {
		if (haystack.includes(name)) return name;
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
