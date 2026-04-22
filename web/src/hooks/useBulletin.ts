import { createClient, type PolkadotClient, type PolkadotSigner, Binary, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { bulletin } from "@polkadot-api/descriptors";
import { blake2b } from "blakejs";
import { computeMetadataHash, type IssuerMetadata } from "../utils/issuerMetadata";
import { ipfsUrl } from "../utils/cid";

const BULLETIN_WS = "wss://paseo-bulletin-rpc.polkadot.io";
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MiB
const UPLOAD_TIMEOUT_MS = 60_000;

let bulletinClient: PolkadotClient | null = null;

function getBulletinClient(): PolkadotClient {
	if (!bulletinClient) {
		bulletinClient = createClient(withPolkadotSdkCompat(getWsProvider(BULLETIN_WS)));
	}
	return bulletinClient;
}

function getBulletinApi() {
	return getBulletinClient().getTypedApi(bulletin);
}

export interface BulletinUploadResult {
	blockNumber: number;
	blockHash: string;
}

export async function checkBulletinAuthorization(
	address: string,
	dataSize: number,
): Promise<boolean> {
	try {
		const api = getBulletinApi();
		const auth = await api.query.TransactionStorage.Authorizations.getValue(
			Enum("Account", address),
		);
		if (!auth) return false;
		return auth.extent.transactions > 0n && auth.extent.bytes >= BigInt(dataSize);
	} catch {
		return false;
	}
}

export async function uploadToBulletin(
	fileBytes: Uint8Array,
	signer: PolkadotSigner,
): Promise<BulletinUploadResult> {
	if (fileBytes.length > MAX_FILE_SIZE) {
		throw new Error(
			`File too large (${(fileBytes.length / 1024 / 1024).toFixed(1)} MiB). Maximum is 8 MiB.`,
		);
	}

	const api = getBulletinApi();
	const tx = api.tx.TransactionStorage.store({
		data: Binary.fromBytes(fileBytes),
	});

	return new Promise<BulletinUploadResult>((resolve, reject) => {
		const timeout = setTimeout(() => {
			subscription.unsubscribe();
			reject(new Error("Bulletin Chain upload timed out"));
		}, UPLOAD_TIMEOUT_MS);

		const subscription = tx.signSubmitAndWatch(signer).subscribe({
			next: (ev) => {
				if (ev.type === "txBestBlocksState" && ev.found) {
					clearTimeout(timeout);
					subscription.unsubscribe();
					resolve({
						blockNumber: ev.block.number,
						blockHash: ev.block.hash,
					});
				}
			},
			error: (err) => {
				clearTimeout(timeout);
				subscription.unsubscribe();
				reject(err);
			},
		});
	});
}

export async function verifyMetadataOnBulletin(
	blockNumber: number,
	dataBytes: Uint8Array,
): Promise<boolean> {
	try {
		const api = getBulletinApi();
		const txInfos = await api.query.TransactionStorage.Transactions.getValue(blockNumber);
		if (!txInfos || txInfos.length === 0) return false;

		const blake2Hash = blake2b(dataBytes, undefined, 32);

		for (const info of txInfos) {
			const stored = info.content_hash.asBytes();
			if (stored.length === blake2Hash.length && stored.every((b: number, i: number) => b === blake2Hash[i])) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

// Fetch metadata via the Paseo IPFS gateway using a CIDv1 derived from the
// blake2b-256 content hash. Data stored via TransactionStorage.store() is
// pinned by the Bulletin Chain node — no archive RPC node required.
async function fetchMetadataFromIpfsGateway(
	cid: string,
	expectedMetadataHash: `0x${string}`,
): Promise<IssuerMetadata | null> {
	try {
		const response = await fetch(ipfsUrl(cid));
		if (!response.ok) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (computeMetadataHash(bytes).toLowerCase() !== expectedMetadataHash.toLowerCase()) return null;
		return JSON.parse(new TextDecoder().decode(bytes)) as IssuerMetadata;
	} catch {
		return null;
	}
}

// Fetch raw extrinsics for a historical block via legacy chain_getBlock JSON-RPC.
// Used only for legacy bulletinRef values that predate the CID format.
function chainGetBlockExtrinsics(wsUrl: string, blockHash: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let settled = false;
		const timeout = setTimeout(() => {
			if (!settled) { settled = true; ws.close(); reject(new Error("chain_getBlock timeout")); }
		}, 20_000);

		ws.onopen = () => {
			ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_getBlock", params: [blockHash] }));
		};
		ws.onmessage = (event) => {
			if (settled) return;
			try {
				const msg = JSON.parse(event.data as string);
				if (msg.id === 1) {
					settled = true; clearTimeout(timeout); ws.close();
					if (msg.error) reject(new Error(msg.error.message));
					else resolve((msg.result?.block?.extrinsics as string[]) ?? []);
				}
			} catch (e) { settled = true; clearTimeout(timeout); ws.close(); reject(e); }
		};
		ws.onerror = () => {
			if (!settled) { settled = true; clearTimeout(timeout); reject(new Error("WebSocket error")); }
		};
		ws.onclose = (ev) => {
			if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`WS closed (code ${ev.code})`)); }
		};
	});
}

/**
 * Fetch issuer metadata JSON from the Bulletin Chain.
 *
 * bulletinRef formats:
 *   - CIDv1 string (current): fetched from the Paseo IPFS gateway, permanently available.
 *   - "blockNumber:blockHash" (legacy): fetched via chain_getBlock; fails on pruning nodes.
 *   - "blockNumber" (oldest): cannot fetch — block hash unavailable.
 */
export async function fetchMetadataFromBulletin(
	bulletinRef: string,
	expectedMetadataHash: `0x${string}`,
): Promise<IssuerMetadata | null> {
	if (!bulletinRef.includes(":")) {
		return fetchMetadataFromIpfsGateway(bulletinRef, expectedMetadataHash);
	}

	const parts = bulletinRef.split(":");
	if (parts.length < 2) return null;
	const blockHash = parts.slice(1).join(":");

	try {
		const extrinsics = await chainGetBlockExtrinsics(BULLETIN_WS, blockHash);
		if (!extrinsics || extrinsics.length === 0) return null;

		for (const extrinsicHex of extrinsics) {
			const data = extractJsonBytesFromExtrinsic(extrinsicHex);
			if (!data) continue;

			if (computeMetadataHash(data).toLowerCase() !== expectedMetadataHash.toLowerCase()) continue;

			try {
				return JSON.parse(new TextDecoder().decode(data)) as IssuerMetadata;
			} catch {
				continue;
			}
		}
		return null;
	} catch {
		return null;
	}
}

// Extract the stored JSON bytes from a raw SCALE-encoded TransactionStorage.store extrinsic.
// Searches for the canonical metadata prefix `{"schemaVersion":"1"` rather than a bare `{`
// to avoid false positives from random 0x7B bytes in the Sr25519 signature.
function extractJsonBytesFromExtrinsic(extrinsicHex: string): Uint8Array | null {
	try {
		const hex = extrinsicHex.startsWith("0x") ? extrinsicHex.slice(2) : extrinsicHex;
		const bytes = new Uint8Array(hex.length / 2);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		}

		const marker = new TextEncoder().encode('{"schemaVersion":"1"');

		outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
			for (let j = 0; j < marker.length; j++) {
				if (bytes[i + j] !== marker[j]) continue outer;
			}
			let depth = 0;
			let end = -1;
			for (let k = i; k < bytes.length; k++) {
				if (bytes[k] === 0x7b) depth++;
				else if (bytes[k] === 0x7d) {
					depth--;
					if (depth === 0) { end = k; break; }
				}
			}
			if (end !== -1) return bytes.slice(i, end + 1);
		}
		return null;
	} catch {
		return null;
	}
}
