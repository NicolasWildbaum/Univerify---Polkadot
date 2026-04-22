import { createClient, type PolkadotClient, type PolkadotSigner, Binary, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { bulletin } from "@polkadot-api/descriptors";
import { blake2b } from "blakejs";
import { computeMetadataHash, type IssuerMetadata } from "../utils/issuerMetadata";

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

/**
 * Check if an account is authorized to store data on the Bulletin Chain.
 */
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

/**
 * Upload file bytes to the Bulletin Chain via TransactionStorage.store().
 * Returns the block number and hash where the data was included.
 */
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

/**
 * Verify that data with a given keccak256 hash exists on the Bulletin Chain at
 * the specified block. Uses TransactionStorage.Transactions to check the
 * blake2b-256 content_hash (Substrate's native hash) against the stored bytes.
 *
 * Returns true if the bulletin chain confirms data matching the blake2b-256 of
 * the provided bytes is stored at that block, false otherwise.
 */
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

/**
 * Fetch metadata JSON from the Bulletin Chain block.
 * Retrieves the raw block extrinsics, scans each one looking for JSON bytes
 * whose keccak256 matches the expectedMetadataHash stored on-chain.
 *
 * Returns parsed IssuerMetadata on success, null if not found or data expired.
 */
export async function fetchMetadataFromBulletin(
	blockNumber: number,
	expectedMetadataHash: `0x${string}`,
): Promise<IssuerMetadata | null> {
	try {
		const api = getBulletinApi();
		const client = getBulletinClient();

		// Get the block hash from block number via System.BlockHash storage
		const blockHashBinary = await api.query.System.BlockHash.getValue(blockNumber);
		if (!blockHashBinary) return null;
		const blockHash = blockHashBinary.asHex();

		// Fetch the raw extrinsics for the block
		const extrinsics = await client.getBlockBody(blockHash);
		if (!extrinsics || extrinsics.length === 0) return null;

		// Scan each extrinsic trying to extract stored JSON bytes.
		// Strategy: parse the raw SCALE hex, locate the first `{` byte and
		// extract bytes from there to the matching `}`. Then verify the keccak256.
		for (const extrinsicHex of extrinsics) {
			const data = extractJsonBytesFromExtrinsic(extrinsicHex);
			if (!data) continue;

			const hash = computeMetadataHash(data);
			if (hash.toLowerCase() !== expectedMetadataHash.toLowerCase()) continue;

			try {
				const text = new TextDecoder().decode(data);
				return JSON.parse(text) as IssuerMetadata;
			} catch {
				continue;
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Extract the stored data bytes from a raw SCALE-encoded TransactionStorage.store extrinsic.
 * Heuristic: locates the first `{` byte (0x7B) and extracts until the matching closing `}`.
 * This works reliably for our canonical JSON metadata format.
 */
function extractJsonBytesFromExtrinsic(extrinsicHex: string): Uint8Array | null {
	try {
		const hex = extrinsicHex.startsWith("0x") ? extrinsicHex.slice(2) : extrinsicHex;
		const bytes = new Uint8Array(hex.length / 2);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		}

		// Find opening `{`
		let start = -1;
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0x7b) { start = i; break; }
		}
		if (start === -1) return null;

		// Walk forward matching braces to find the closing `}`
		let depth = 0;
		let end = -1;
		for (let i = start; i < bytes.length; i++) {
			if (bytes[i] === 0x7b) depth++;
			else if (bytes[i] === 0x7d) {
				depth--;
				if (depth === 0) { end = i; break; }
			}
		}
		if (end === -1) return null;

		return bytes.slice(start, end + 1);
	} catch {
		return null;
	}
}
