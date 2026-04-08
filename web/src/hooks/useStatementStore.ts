import { Bytes, compact, u8 } from "@polkadot-api/substrate-bindings";
import { blake2b } from "blakejs";

const MAX_STATEMENT_STORE_ENCODED_SIZE = 1024 * 1024 - 1;
const FIELD_TAG_AUTH = 0;
const FIELD_TAG_PLAIN_DATA = 8;
const PROOF_VARIANT_SR25519 = 0;

// Field discriminants from sp_statement_store::Field
const FIELD_AUTHENTICITY_PROOF = 0;
// const FIELD_DECRYPTION_KEY = 1;
const FIELD_EXPIRY = 2;
// const FIELD_CHANNEL = 3;
const FIELD_TOPIC1 = 4;
const FIELD_TOPIC2 = 5;
const FIELD_TOPIC3 = 6;
const FIELD_TOPIC4 = 7;
const FIELD_DATA = 8;

// Proof variants
const PROOF_SR25519 = 0;
const PROOF_ED25519 = 1;
// const PROOF_SECP256K1 = 2;
// const PROOF_ON_CHAIN = 3;

const encodeVecU8 = Bytes.enc();

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(totalLen);
	let offset = 0;

	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
}

function ensureFixedLength(value: Uint8Array, length: number, label: string): void {
	if (value.length !== length) {
		throw new Error(`${label} must be ${length} bytes, got ${value.length}`);
	}
}

function encodeSr25519Proof(publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
	ensureFixedLength(publicKey, 32, "Statement Store public key");
	ensureFixedLength(signature, 64, "Statement Store signature");

	return concatBytes([u8.enc(PROOF_VARIANT_SR25519), signature, publicKey]);
}

function encodeDataField(data: Uint8Array): Uint8Array {
	return concatBytes([u8.enc(FIELD_TAG_PLAIN_DATA), encodeVecU8(data)]);
}

function encodeProofField(publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
	return concatBytes([u8.enc(FIELD_TAG_AUTH), encodeSr25519Proof(publicKey, signature)]);
}

function buildStatementSignaturePayload(data: Uint8Array): Uint8Array {
	// Matches sp_statement_store::Statement::encoded(true) for a data-only statement.
	return encodeDataField(data);
}

function buildSignedStatement(
	data: Uint8Array,
	publicKey: Uint8Array,
	signature: Uint8Array,
): Uint8Array {
	return concatBytes([
		compact.enc(2),
		encodeProofField(publicKey, signature),
		encodeDataField(data),
	]);
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Convert a ws:// or wss:// URL to http:// or https:// for JSON-RPC POST.
 */
function wsToHttp(wsUrl: string): string {
	return wsUrl.replace(/^ws(s?):\/\//, "http$1://");
}

/**
 * Check if the node exposes the statement_submit RPC method.
 */
export async function checkStatementStoreAvailable(wsUrl: string): Promise<boolean> {
	const httpUrl = wsToHttp(wsUrl);
	try {
		const response = await fetch(httpUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "rpc_methods",
				params: [],
			}),
		});
		const result = await response.json();
		const methods: string[] = result?.result?.methods ?? [];
		return methods.includes("statement_submit");
	} catch {
		return false;
	}
}

/**
 * Submit file bytes to the local node's Statement Store.
 *
 * Builds a canonical SCALE-encoded sp_statement_store::Statement and
 * calls the `statement_submit` JSON-RPC method via HTTP POST.
 */
export async function submitToStatementStore(
	wsUrl: string,
	fileBytes: Uint8Array,
	publicKey: Uint8Array,
	sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<void> {
	const signaturePayload = buildStatementSignaturePayload(fileBytes);
	const signature = await sign(signaturePayload);
	const encoded = buildSignedStatement(fileBytes, publicKey, signature);

	if (encoded.length > MAX_STATEMENT_STORE_ENCODED_SIZE) {
		throw new Error(
			`Statement is too large for node propagation (${encoded.length} encoded bytes, max ${MAX_STATEMENT_STORE_ENCODED_SIZE}). Choose a smaller file.`,
		);
	}

	const httpUrl = wsToHttp(wsUrl);
	const response = await fetch(httpUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "statement_submit",
			params: [`0x${bytesToHex(encoded)}`],
		}),
	});

	const result = await response.json();
	if (result.error) {
		throw new Error(
			`Statement Store error: ${result.error.message}${result.error.data ? ` (${JSON.stringify(result.error.data)})` : ""}`,
		);
	}
}

export interface DecodedStatement {
	hash: string;
	signer: string | null;
	proofType: string | null;
	dataLength: number;
	data: Uint8Array | null;
	topics: string[];
	expiry: bigint | null;
}

function hexToBytes(hex: string): Uint8Array {
	const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function readCompact(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
	const first = bytes[offset];
	const mode = first & 0b11;
	if (mode === 0) return { value: first >> 2, bytesRead: 1 };
	if (mode === 1) {
		const value = ((bytes[offset + 1] << 8) | first) >> 2;
		return { value, bytesRead: 2 };
	}
	if (mode === 2) {
		const value =
			((bytes[offset + 3] << 24) |
				(bytes[offset + 2] << 16) |
				(bytes[offset + 1] << 8) |
				first) >>>
			2;
		return { value, bytesRead: 4 };
	}
	// Big-integer mode (mode === 3) — not expected for field counts
	throw new Error("Compact big-integer mode not supported");
}

function readVecU8(bytes: Uint8Array, offset: number): { data: Uint8Array; bytesRead: number } {
	const { value: len, bytesRead: prefixLen } = readCompact(bytes, offset);
	const data = bytes.slice(offset + prefixLen, offset + prefixLen + len);
	return { data, bytesRead: prefixLen + len };
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
	let val = 0n;
	for (let i = 0; i < 8; i++) {
		val |= BigInt(bytes[offset + i]) << BigInt(i * 8);
	}
	return val;
}

function decodeStatement(encoded: Uint8Array): Omit<DecodedStatement, "hash"> {
	let offset = 0;
	const { value: numFields, bytesRead } = readCompact(encoded, offset);
	offset += bytesRead;

	let signer: string | null = null;
	let proofType: string | null = null;
	let data: Uint8Array | null = null;
	let dataLength = 0;
	const topics: string[] = [];
	let expiry: bigint | null = null;

	for (let i = 0; i < numFields; i++) {
		const tag = encoded[offset];
		offset += 1;

		if (tag === FIELD_AUTHENTICITY_PROOF) {
			const variant = encoded[offset];
			offset += 1;
			if (variant === PROOF_SR25519) {
				proofType = "Sr25519";
				offset += 64; // signature
				signer = "0x" + bytesToHex(encoded.slice(offset, offset + 32));
				offset += 32;
			} else if (variant === PROOF_ED25519) {
				proofType = "Ed25519";
				offset += 64; // signature
				signer = "0x" + bytesToHex(encoded.slice(offset, offset + 32));
				offset += 32;
			} else {
				// Secp256k1Ecdsa or OnChain — skip remaining encoded bytes conservatively
				proofType = variant === 2 ? "Secp256k1Ecdsa" : "OnChain";
				break;
			}
		} else if (tag === FIELD_EXPIRY) {
			expiry = readU64LE(encoded, offset);
			offset += 8;
		} else if (
			tag === FIELD_TOPIC1 ||
			tag === FIELD_TOPIC2 ||
			tag === FIELD_TOPIC3 ||
			tag === FIELD_TOPIC4
		) {
			topics.push("0x" + bytesToHex(encoded.slice(offset, offset + 32)));
			offset += 32;
		} else if (tag === FIELD_DATA) {
			const result = readVecU8(encoded, offset);
			data = result.data;
			dataLength = result.data.length;
			offset += result.bytesRead;
		} else if (tag === 1 || tag === 3) {
			// DecryptionKey or Channel — fixed [u8; 32]
			offset += 32;
		} else {
			// Unknown field — cannot safely skip, stop decoding
			break;
		}
	}

	return { signer, proofType, data, dataLength, topics, expiry };
}

/**
 * Dump all statements from the node's Statement Store via statement_dump RPC.
 */
export async function dumpStatements(wsUrl: string): Promise<DecodedStatement[]> {
	const httpUrl = wsToHttp(wsUrl);
	const response = await fetch(httpUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "statement_dump",
			params: [],
		}),
	});

	const result = await response.json();
	if (result.error) {
		throw new Error(
			`Statement Store error: ${result.error.message}${result.error.data ? ` (${JSON.stringify(result.error.data)})` : ""}`,
		);
	}

	const encodedStatements: string[] = result.result ?? [];
	return encodedStatements.map((hex) => {
		const bytes = hexToBytes(hex);
		const hash = "0x" + bytesToHex(blake2b(bytes, undefined, 32));
		const decoded = decodeStatement(bytes);
		return { hash, ...decoded };
	});
}
