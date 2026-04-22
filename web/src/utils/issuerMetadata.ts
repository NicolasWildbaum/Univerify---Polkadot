import { keccak256 } from "viem";

export interface IssuerMetadata {
	schemaVersion: "1";
	name: string;
	country?: string;
	website?: string;
	accreditationBody?: string;
	accreditationId?: string;
}

/**
 * Serialize metadata to canonical JSON bytes (sorted keys, no extra whitespace).
 * The same byte sequence must be reproduced by any verifier to recompute the hash.
 */
export function serializeMetadata(m: IssuerMetadata): Uint8Array {
	const canonical: Record<string, string> = { schemaVersion: m.schemaVersion, name: m.name };
	if (m.country) canonical.country = m.country;
	if (m.accreditationBody) canonical.accreditationBody = m.accreditationBody;
	if (m.accreditationId) canonical.accreditationId = m.accreditationId;
	if (m.website) canonical.website = m.website;
	return new TextEncoder().encode(JSON.stringify(canonical));
}

/** keccak256 of the canonical metadata bytes — stored as metadataHash in the contract. */
export function computeMetadataHash(bytes: Uint8Array): `0x${string}` {
	return keccak256(bytes);
}

/** True if all optional fields are empty (only name is always present via the contract). */
export function hasOptionalMetadata(m: Partial<IssuerMetadata>): boolean {
	return !!(m.country || m.website || m.accreditationBody || m.accreditationId);
}
