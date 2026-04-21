// MyCertificatesPage — student-facing list of soulbound certificate NFTs
// owned by the connected wallet.
//
// Discovery flow (no event indexing required):
//   1. balanceOf(student)                       → number of NFTs held
//   2. tokenOfOwnerByIndex(student, i) for i<n  → tokenIds
//   3. tokenIdToCertId(tokenId)                 → on-chain certificateId
//   4. Univerify.certificates(certId)           → issuer + issuedAt + revoked
//   5. Univerify.getIssuer(cert.issuer).name    → human-readable issuer name
//
// Each row exposes a "Copy verification link" action that produces the same
// public URL the issuer surfaced on success — `/#/verify/cert/<certificateId>`.
//
// TODO(future): the public link currently relies on possession (anyone with
// the URL can present it). A signed presentation flow (challenge bound to a
// verifier audience, signed by the student wallet) is intentionally not
// implemented in this MVP. Add that here as a per-row "Generate signed link"
// action when the verifier UX is defined.

import { useCallback, useEffect, useState } from "react";
import { type Abi, type Address, type Hex } from "viem";
import { univerifyAbi } from "../config/univerify";
import { certificateNftAbi } from "../config/certificateNft";
import { getPublicClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";
import {
	useWalletStore,
	selectConnectedAddress,
	selectConnectedEvmAddress,
	selectConnectedSigner,
} from "../account/wallet";
import { submitReviveCall } from "../account/reviveCall";
import {
	buildChallenge,
	createPresentation,
	encodePresentation,
	PROOF_VALIDITY_SECONDS,
} from "../utils/ownershipProof";
import { extractRevertName } from "../utils/contractErrors";
import { computeClaimsHash } from "../utils/credential";
import {
	downloadPdfBytes,
	extractCertificatePdfPayload,
} from "../utils/certificatePdf";
import { hashBytes } from "../utils/hash";
import { hexHashToCid, ipfsUrl } from "../utils/cid";
import {
	checkBulletinAuthorization,
	uploadToBulletin,
} from "../hooks/useBulletin";
import {
	getStoredCertificatePdf,
	setStoredCertificatePdfCid,
	storeFetchedCertificatePdf,
	type StoredCertificatePdfRecord,
} from "../utils/certificatePdfStore";

interface CertificateRow {
	tokenId: bigint;
	certificateId: Hex;
	issuer: Address;
	issuerName: string;
	claimsHash: Hex;
	issuedAt: bigint;
	revoked: boolean;
	pdfCid: string;
}

export default function MyCertificatesPage() {
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const walletStatus = useWalletStore((s) => s.status);
	const studentSs58 = useWalletStore(selectConnectedAddress);
	const studentAddress = useWalletStore(selectConnectedEvmAddress);
	const isWalletConnected = walletStatus.kind === "connected";

	const univerifyAddress = deployments.univerify as Address | null;
	const nftAddress = deployments.certificateNft as Address | null;

	const [rows, setRows] = useState<CertificateRow[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!isWalletConnected || !studentAddress || !univerifyAddress || !nftAddress) {
			setRows(null);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const client = getPublicClient(ethRpcUrl);

			const balance = (await client.readContract({
				address: nftAddress,
				abi: certificateNftAbi,
				functionName: "balanceOf",
				args: [studentAddress],
			})) as bigint;

			if (balance === 0n) {
				setRows([]);
				return;
			}

			// Discover token ids in parallel.
			const tokenIds = (await Promise.all(
				Array.from({ length: Number(balance) }, (_, i) =>
					client.readContract({
						address: nftAddress,
						abi: certificateNftAbi,
						functionName: "tokenOfOwnerByIndex",
						args: [studentAddress, BigInt(i)],
					}),
				),
			)) as bigint[];

			// Hydrate each token: certId → certificate tuple → issuer name.
			const enriched = await Promise.all(
				tokenIds.map(async (tokenId) => {
					const certificateId = (await client.readContract({
						address: nftAddress,
						abi: certificateNftAbi,
						functionName: "tokenIdToCertId",
						args: [tokenId],
					})) as Hex;

					const cert = (await client.readContract({
						address: univerifyAddress,
						abi: univerifyAbi,
						functionName: "certificates",
						args: [certificateId],
					})) as readonly [Address, Hex, bigint, boolean];

					const [issuer, claimsHash, issuedAt, revoked] = cert;
					const pdfCid = (await client.readContract({
						address: univerifyAddress,
						abi: univerifyAbi,
						functionName: "certificatePdfCids",
						args: [certificateId],
					})) as string;

					let issuerName = "";
					try {
						const profile = (await client.readContract({
							address: univerifyAddress,
							abi: univerifyAbi,
							functionName: "getIssuer",
							args: [issuer],
						})) as { name: string };
						issuerName = profile.name ?? "";
					} catch {
						// Issuer profile lookup is best-effort. A registered issuer
						// will always succeed; the catch only fires if the registry
						// shape changes underneath us.
					}

					return {
						tokenId,
						certificateId,
						issuer,
						issuerName,
						claimsHash,
						issuedAt,
						revoked,
						pdfCid,
					} satisfies CertificateRow;
				}),
			);

			setRows(enriched);
		} catch (e) {
			console.error("Failed to load certificates:", e);
			setError(`Failed to read certificates: ${e instanceof Error ? e.message : String(e)}`);
			setRows(null);
		} finally {
			setLoading(false);
		}
	}, [isWalletConnected, studentAddress, univerifyAddress, nftAddress, ethRpcUrl]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<div className="section-stack">
			<div className="page-hero">
				<div className="space-y-3">
					<span className="page-kicker">Student Wallet View</span>
					<h1 className="page-title text-polka-500">My Certificates</h1>
					<p className="page-subtitle">
					Soulbound certificates minted to the connected wallet. Each is a
					non-transferable NFT whose status mirrors the Univerify registry. Share the
					public verification link with anyone who needs to confirm the certificate
					on-chain, and manage the generated PDF version from here.
					</p>
				</div>
			</div>

			{!isWalletConnected || !studentAddress ? (
				<EmptyState
					title="Wallet not connected"
					body="Connect a Polkadot-compatible wallet using the button in the header to see the certificates owned by your address."
				/>
			) : !univerifyAddress || !nftAddress ? (
				<EmptyState
					title="Contracts not configured"
					body="The frontend has no Univerify or CertificateNft address set. Run the deploy script (cd contracts/evm && npm run deploy:univerify:local) to populate deployments."
				/>
			) : (
				<>
					<div className="card space-y-3">
						<div className="flex items-center justify-between gap-3 flex-wrap">
							<div className="min-w-0">
								<p className="text-xs text-text-tertiary uppercase tracking-wider">
									Connected wallet
								</p>
								<code className="text-xs font-mono text-text-primary break-all">
									{studentAddress}
								</code>
							</div>
							<button
								onClick={() => void refresh()}
								disabled={loading}
								className="btn-secondary text-xs"
							>
								{loading ? "Loading…" : "Refresh"}
							</button>
						</div>
					</div>

					{error && (
						<div className="card border border-accent-red/30 bg-accent-red/5">
							<p className="text-sm text-accent-red">{error}</p>
						</div>
					)}

					{rows === null ? (
						loading ? (
							<EmptyState title="Loading…" body="Reading your certificates from chain." />
						) : null
					) : rows.length === 0 ? (
						<EmptyState
							title="No certificates yet"
							body="Once a university issues a certificate to your wallet, the soulbound NFT will appear here."
						/>
					) : (
						<div className="space-y-3">
							{rows.map((row) => (
								<CertificateCard
									key={row.tokenId.toString()}
									row={row}
									ownerH160={studentAddress!}
									ownerSs58={studentSs58}
									onAttachmentSaved={(pdfCid) =>
										setRows((current) =>
											current
												? current.map((entry) =>
														entry.certificateId === row.certificateId
															? { ...entry, pdfCid }
															: entry,
													)
												: current,
										)
									}
								/>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}

function CertificateCard({
	row,
	ownerH160,
	ownerSs58,
	onAttachmentSaved,
}: {
	row: CertificateRow;
	ownerH160: Address;
	ownerSs58: string | null;
	onAttachmentSaved: (pdfCid: string) => void;
}) {
	const signer = useWalletStore(selectConnectedSigner);
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const wsUrl = useChainStore((s) => s.wsUrl);

	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	// Ownership proof state
	type ProofStatus = "idle" | "signing" | "done" | "error";
	const [proofStatus, setProofStatus] = useState<ProofStatus>("idle");
	const [proofUrl, setProofUrl] = useState<string | null>(null);
	const [proofError, setProofError] = useState<string | null>(null);
	const [proofCopied, setProofCopied] = useState(false);
	const [attachStatus, setAttachStatus] = useState<
		"idle" | "uploading" | "submitting" | "success" | "error"
	>("idle");
	const [attachMessage, setAttachMessage] = useState<string | null>(null);
	const [attachedCid, setAttachedCid] = useState(row.pdfCid);
	const [pdfRecord, setPdfRecord] = useState<StoredCertificatePdfRecord | null>(() =>
		getStoredCertificatePdf(row.certificateId),
	);
	const [pdfLoading, setPdfLoading] = useState(false);
	const [pdfMessage, setPdfMessage] = useState<string | null>(null);

	const verifyUrl = `${window.location.origin}/#/verify/cert/${row.certificateId}`;
	const issuedAtIso =
		row.issuedAt > 0n ? new Date(Number(row.issuedAt) * 1000).toISOString() : "—";

	useEffect(() => {
		setAttachedCid(row.pdfCid);
	}, [row.pdfCid]);

	useEffect(() => {
		const stored = getStoredCertificatePdf(row.certificateId);
		setPdfRecord(stored);
		if (row.pdfCid && stored?.pdfCid !== row.pdfCid) {
			setStoredCertificatePdfCid(row.certificateId, row.pdfCid);
		}
	}, [row.certificateId, row.pdfCid]);

	useEffect(() => {
		if (pdfRecord || !row.pdfCid) return;

		let cancelled = false;
		setPdfLoading(true);
		setPdfMessage(null);

		(async () => {
			try {
				const response = await fetch(ipfsUrl(row.pdfCid));
				if (!response.ok) {
					throw new Error(`HTTP ${response.status} while loading the PDF from Bulletin Chain.`);
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				const extracted = extractCertificatePdfPayload(bytes);
				if (extracted.ok) {
					const recomputedHash = computeClaimsHash(extracted.payload.credential.claims);
					if (
						extracted.payload.credential.certificateId !== row.certificateId ||
						extracted.payload.credential.issuer !== row.issuer ||
						recomputedHash !== row.claimsHash
					) {
						setPdfMessage(
							"Loaded the PDF from Bulletin Chain, but its embedded payload does not match the current on-chain certificate.",
						);
					}
					storeFetchedCertificatePdf({
						certificateId: row.certificateId,
						pdfBytes: bytes,
						pdfCid: row.pdfCid,
						claimsHash: extracted.payload.claimsHash,
						credential: extracted.payload.credential,
						studentAddress: ownerH160,
						issuerName: row.issuerName,
					});
				} else {
					setPdfMessage(
						"Loaded the PDF from Bulletin Chain. Its embedded structured payload could not be parsed, but the document is still available to view and download.",
					);
					storeFetchedCertificatePdf({
						certificateId: row.certificateId,
						pdfBytes: bytes,
						pdfCid: row.pdfCid,
						studentAddress: ownerH160,
						issuerName: row.issuerName,
					});
				}
				if (!cancelled) {
					setPdfRecord(getStoredCertificatePdf(row.certificateId));
				}
			} catch (error) {
				if (!cancelled) {
					setPdfMessage(
						error instanceof Error
							? error.message
							: "Could not load the PDF from Bulletin Chain.",
					);
				}
			} finally {
				if (!cancelled) setPdfLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [pdfRecord, row.certificateId, row.pdfCid, row.issuer, row.claimsHash, row.issuerName, ownerH160]);

	async function handleUploadPdf() {
		if (!signer || !ownerSs58 || !pdfRecord || attachedCid) return;
		setAttachMessage(null);

		try {
			const authorized = await checkBulletinAuthorization(ownerSs58, pdfRecord.pdfBytes.length);
			if (!authorized) {
				throw new Error(
					"Your connected account is not currently authorized to upload this PDF to Bulletin Chain. Use the Bulletin faucet first, then try again.",
				);
			}

			setAttachStatus("uploading");
			await uploadToBulletin(pdfRecord.pdfBytes, signer);
			const cid = hexHashToCid(hashBytes(pdfRecord.pdfBytes));

			setAttachStatus("submitting");
			const client = getPublicClient(ethRpcUrl);
			await client.simulateContract({
				account: ownerH160,
				address: deployments.univerify as Address,
				abi: univerifyAbi as unknown as Abi,
				functionName: "setCertificatePdfCid",
				args: [row.certificateId, cid],
			});

			await submitReviveCall({
				wsUrl,
				signer,
				signerEvmAddress: ownerH160,
				contractAddress: deployments.univerify as Address,
				abi: univerifyAbi as unknown as Abi,
				functionName: "setCertificatePdfCid",
				args: [row.certificateId, cid],
			});

			setStoredCertificatePdfCid(row.certificateId, cid);
			setAttachedCid(cid);
			onAttachmentSaved(cid);
			setAttachStatus("success");
			setAttachMessage("PDF uploaded to Bulletin Chain and linked to this certificate.");
		} catch (error) {
			const revert = extractRevertName(error);
			const message =
				revert === "NotCertificateHolder"
					? "Only the current NFT holder can attach a PDF CID to this certificate."
					: revert === "CertificateNotFound"
						? "This certificate does not exist on the currently connected registry."
						: revert === "EmptyPdfCid"
							? "The generated CID was empty."
							: error instanceof Error
								? error.message
								: String(error);
			setAttachStatus("error");
			setAttachMessage(message);
		}
	}

	function copyLink() {
		navigator.clipboard
			?.writeText(verifyUrl)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
	}

	async function generateProofLink() {
		if (!signer) return;
		setProofStatus("signing");
		setProofError(null);
		setProofUrl(null);
		try {
			const challenge = buildChallenge(row.certificateId, ownerH160);
			const presentation = await createPresentation(challenge, signer);
			const encoded = encodePresentation(presentation);
			const url = `${window.location.origin}/#/verify/cert/${row.certificateId}?presentation=${encoded}`;
			setProofUrl(url);
			setProofStatus("done");
			// Auto-copy to clipboard
			navigator.clipboard?.writeText(url).catch(() => {});
		} catch (e) {
			setProofStatus("error");
			setProofError(e instanceof Error ? e.message : String(e));
		}
	}

	function copyProofUrl() {
		if (!proofUrl) return;
		navigator.clipboard
			?.writeText(proofUrl)
			.then(() => {
				setProofCopied(true);
				setTimeout(() => setProofCopied(false), 1500);
			})
			.catch(() => {});
	}

	function openPdf() {
		if (!pdfRecord) return;
		const blob = new Blob([pdfRecord.pdfBytes], { type: "application/pdf" });
		const url = URL.createObjectURL(blob);
		const opened = window.open(url, "_blank", "noopener,noreferrer");
		if (!opened) {
			URL.revokeObjectURL(url);
			return;
		}
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	return (
		<div className="card space-y-3">
			<div className="flex items-start justify-between gap-3 flex-wrap">
				<div className="min-w-0">
					<h3 className="text-base font-semibold text-text-primary">
						{row.issuerName || "Unknown issuer"}
					</h3>
					<p className="text-xs text-text-tertiary font-mono break-all mt-1">
						{row.certificateId}
					</p>
				</div>
				{row.revoked ? (
					<span className="status-badge border bg-accent-red/10 text-accent-red border-accent-red/30">
						✗ Revoked
					</span>
				) : (
					<span className="status-badge border bg-accent-green/10 text-accent-green border-accent-green/30">
						✓ Active
					</span>
				)}
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
				<Field label="Token ID" value={`#${row.tokenId.toString()}`} />
				<Field label="Issued" value={issuedAtIso} />
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<button onClick={copyLink} className="btn-primary text-xs">
					{copied ? "Copied!" : "Copy verification link"}
				</button>
				<button
					onClick={() => void generateProofLink()}
					disabled={!signer || proofStatus === "signing"}
					className="btn-secondary text-xs"
					title={
						!signer
							? "Connect wallet to generate a signed proof link"
							: `Sign a challenge valid for ${PROOF_VALIDITY_SECONDS / 60} min to prove you control this wallet`
					}
				>
					{proofStatus === "signing" ? "Waiting for signature…" : "Generate ownership proof link"}
				</button>
				<a
					href={`#/verify/cert/${row.certificateId}`}
					target="_blank"
					rel="noreferrer"
					className="btn-secondary text-xs"
				>
					Open verifier
				</a>
				<button
					onClick={openPdf}
					disabled={!pdfRecord}
					className="btn-secondary text-xs"
					title={pdfRecord ? "Open the cached PDF in a new tab" : "PDF not available on this device yet"}
				>
					View PDF
				</button>
				<button
					onClick={() =>
						pdfRecord &&
						downloadPdfBytes(
							pdfRecord.pdfBytes,
							`certificate-${row.certificateId.slice(2, 14)}.pdf`,
						)}
					disabled={!pdfRecord}
					className="btn-secondary text-xs"
					title={pdfRecord ? "Download the cached PDF" : "PDF not available on this device yet"}
				>
					Download PDF
				</button>
				{attachedCid ? (
					<a
						href={ipfsUrl(attachedCid)}
						target="_blank"
						rel="noreferrer"
						className="btn-secondary text-xs"
					>
						View on Bulletin Chain
					</a>
				) : (
					<button
						onClick={() => void handleUploadPdf()}
						disabled={!signer || !pdfRecord || attachStatus === "uploading" || attachStatus === "submitting"}
						className="btn-secondary text-xs"
						title={
							pdfRecord
								? "Upload the already-generated PDF to Bulletin Chain"
								: "This browser does not have a cached PDF for this certificate yet"
						}
					>
						{attachStatus === "uploading"
							? "Uploading to Bulletin…"
							: attachStatus === "submitting"
								? "Saving CID on-chain…"
								: "Upload to Bulletin Chain"}
					</button>
				)}
				<button
					onClick={() => setExpanded((v) => !v)}
					className="btn-secondary text-xs"
				>
					{expanded ? "Hide details" : "View details"}
				</button>
			</div>

			{(pdfLoading || pdfRecord || attachedCid || attachMessage || pdfMessage) && (
				<div
					className={`rounded-lg border p-3 space-y-2 animate-fade-in ${
						attachStatus === "error"
							? "border-accent-red/30 bg-accent-red/5"
							: "border-white/[0.08] bg-white/[0.02]"
					}`}
				>
					<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Certificate PDF
					</p>
					<p className="text-xs text-text-secondary">
						{pdfLoading
							? "Loading the cached or Bulletin-hosted PDF…"
							: pdfRecord
								? "PDF ready to view, download, or upload."
								: "No cached PDF is available on this device yet."}
					</p>
					{attachedCid && (
						<>
							<a
								href={ipfsUrl(attachedCid)}
								target="_blank"
								rel="noreferrer"
								className="text-xs font-mono break-all text-accent-blue hover:underline"
							>
								{attachedCid}
							</a>
						</>
					)}
					{pdfMessage && (
						<p className="text-xs text-text-secondary">{pdfMessage}</p>
					)}
					{attachMessage && (
						<p
							className={`text-xs ${
								attachStatus === "error"
									? "text-accent-red"
									: attachStatus === "success"
										? "text-accent-green"
										: "text-text-secondary"
							}`}
						>
							{attachMessage}
						</p>
					)}
				</div>
			)}

			{proofStatus === "done" && proofUrl && (
				<div className="rounded-lg border border-accent-green/20 bg-accent-green/5 p-3 space-y-2 animate-fade-in">
					<p className="text-xs font-medium text-accent-green">
						✓ Signed — link copied to clipboard. Valid for{" "}
						{PROOF_VALIDITY_SECONDS / 60} minutes.
					</p>
					<p className="text-xs text-text-muted break-all font-mono">{proofUrl}</p>
					<button onClick={copyProofUrl} className="btn-secondary text-xs">
						{proofCopied ? "Copied!" : "Copy again"}
					</button>
				</div>
			)}

			{proofStatus === "error" && proofError && (
				<div className="rounded-lg border border-accent-red/30 bg-accent-red/5 p-3 animate-fade-in">
					<p className="text-xs text-accent-red">{proofError}</p>
				</div>
			)}

			{expanded && (
				<div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 space-y-2 animate-fade-in">
					<Field label="Issuer wallet" value={row.issuer} mono />
					<Field label="Public verification link" value={verifyUrl} mono />
					<Field label="Claims hash" value={row.claimsHash} mono />
					<Field label="PDF availability" value={pdfRecord ? "Cached locally" : attachedCid ? "Remote only" : "Not cached"} />
					<Field
						label="Bulletin PDF CID"
						value={attachedCid || "No PDF attached yet"}
						mono
					/>
				</div>
			)}
		</div>
	);
}

function Field({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div>
			<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
				{label}
			</p>
			<p
				className={`text-text-primary break-all ${mono ? "font-mono text-xs" : "text-sm"}`}
			>
				{value}
			</p>
		</div>
	);
}

function EmptyState({ title, body }: { title: string; body: string }) {
	return (
		<div className="card border border-white/[0.08] bg-white/[0.02]">
			<h2 className="section-title">{title}</h2>
			<p className="text-sm text-text-secondary mt-1">{body}</p>
		</div>
	);
}
