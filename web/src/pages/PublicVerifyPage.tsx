import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { getAddress, type Address, type Hex } from "viem";
import { univerifyAbi } from "../config/univerify";
import { certificateNftAbi } from "../config/certificateNft";
import { getPublicClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";
import {
	computeClaimsHash,
	normalizeClaims,
	type CredentialClaims,
} from "../utils/credential";
import {
	extractCertificatePdfPayload,
	type CertificatePdfPayload,
} from "../utils/certificatePdf";
import { ipfsUrl } from "../utils/cid";
import {
	decodePresentation,
	verifyOwnershipPresentation,
	type OwnershipVerdict,
	type SignedPresentation,
} from "../utils/ownershipProof";
import { MonthYearPicker } from "../components/MonthYearPicker";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

function sameHex(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function sameAddress(left: string, right: string): boolean {
	try {
		return getAddress(left) === getAddress(right);
	} catch {
		return left.toLowerCase() === right.toLowerCase();
	}
}

interface VerificationData {
	certificateId: Hex;
	exists: boolean;
	issuer: Address;
	issuerName: string;
	issuerStatus: number;
	claimsHash: Hex;
	issuedAt: bigint;
	revoked: boolean;
	studentAddress: Address | null;
	tokenId: bigint | null;
	pdfCid: string;
}

type PdfIntegrityState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "fetch-error"; message: string }
	| { kind: "payload-error"; message: string }
	| {
			kind: "valid";
			payload: CertificatePdfPayload;
			computedClaimsHash: Hex;
	  }
	| {
			kind: "mismatch";
			payload: CertificatePdfPayload;
			computedClaimsHash: Hex;
			message: string;
	  };

const STATUS_LABEL: Record<number, string> = {
	0: "None",
	1: "Pending",
	2: "Active",
	3: "Removed",
};

export default function PublicVerifyPage() {
	const params = useParams<{ certificateId: string }>();
	const [searchParams] = useSearchParams();
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const univerifyAddress = deployments.univerify as Address | null;
	const nftAddress = deployments.certificateNft as Address | null;

	const [data, setData] = useState<VerificationData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pdfIntegrity, setPdfIntegrity] = useState<PdfIntegrityState>({ kind: "idle" });

	const presentationParam = searchParams.get("presentation");
	const [decodedPresentation, setDecodedPresentation] =
		useState<SignedPresentation | null>(null);
	const [proofVerdict, setProofVerdict] = useState<OwnershipVerdict | null>(null);
	const [proofVerifying, setProofVerifying] = useState(false);

	const rawId = params.certificateId ?? "";
	const idValid = /^0x[0-9a-fA-F]{64}$/.test(rawId);

	useEffect(() => {
		if (!idValid || !univerifyAddress) return;

		const certificateId = rawId as Hex;
		let cancelled = false;

		(async () => {
			setLoading(true);
			setError(null);
			try {
				const client = getPublicClient(ethRpcUrl);

				const cert = (await client.readContract({
					address: univerifyAddress,
					abi: univerifyAbi,
					functionName: "certificates",
					args: [certificateId],
				})) as readonly [Address, Hex, bigint, boolean];
				const [issuer, claimsHash, issuedAt, revoked] = cert;
				const exists = issuer !== ZERO_ADDRESS;

				let issuerName = "";
				let issuerStatus = 0;
				let pdfCid = "";
				if (exists) {
					try {
						const [profile, attachedPdfCid] = await Promise.all([
							client.readContract({
								address: univerifyAddress,
								abi: univerifyAbi,
								functionName: "getIssuer",
								args: [issuer],
							}),
							client.readContract({
								address: univerifyAddress,
								abi: univerifyAbi,
								functionName: "certificatePdfCids",
								args: [certificateId],
							}),
						]);
						const typedProfile = profile as { name: string; status: number | bigint };
						issuerName = typedProfile.name ?? "";
						issuerStatus = Number(typedProfile.status);
						pdfCid = (attachedPdfCid as string) ?? "";
					} catch {
						// Best-effort reads only.
					}
				}

				let tokenId: bigint | null = null;
				let studentAddress: Address | null = null;
				if (exists && nftAddress) {
					try {
						const id = (await client.readContract({
							address: nftAddress,
							abi: certificateNftAbi,
							functionName: "certIdToTokenId",
							args: [certificateId],
						})) as bigint;
						if (id > 0n) {
							tokenId = id;
							studentAddress = (await client.readContract({
								address: nftAddress,
								abi: certificateNftAbi,
								functionName: "ownerOf",
								args: [id],
							})) as Address;
						}
					} catch {
						// Older dev deployments may lack NFT mirror state.
					}
				}

				if (cancelled) return;
				setData({
					certificateId,
					exists,
					issuer,
					issuerName,
					issuerStatus,
					claimsHash,
					issuedAt,
					revoked,
					studentAddress,
					tokenId,
					pdfCid,
				});
			} catch (unknownError) {
				if (cancelled) return;
				console.error("Public verify failed:", unknownError);
				setError(
					`RPC error: ${
						unknownError instanceof Error
							? unknownError.message
							: String(unknownError)
					}`,
				);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [idValid, rawId, ethRpcUrl, univerifyAddress, nftAddress]);

	useEffect(() => {
		if (!data?.exists || !data.pdfCid) {
			setPdfIntegrity({ kind: "idle" });
			return;
		}

		let cancelled = false;
		setPdfIntegrity({ kind: "loading" });

		(async () => {
			try {
				const response = await fetch(ipfsUrl(data.pdfCid));
				if (!response.ok) {
					throw new Error(`HTTP ${response.status} while fetching the PDF from Bulletin.`);
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				const extracted = extractCertificatePdfPayload(bytes);
				if (!extracted.ok) {
					if (!cancelled) {
						setPdfIntegrity({ kind: "payload-error", message: extracted.error });
					}
					return;
				}

				const computedClaimsHash = computeClaimsHash(extracted.payload.credential.claims);
				const mismatches: string[] = [];
				if (!sameHex(extracted.payload.credential.certificateId, data.certificateId)) {
					mismatches.push("embedded certificateId does not match the URL");
				}
				if (!sameAddress(extracted.payload.credential.issuer, data.issuer)) {
					mismatches.push("embedded issuer does not match the on-chain issuer");
				}
				if (computedClaimsHash !== data.claimsHash) {
					mismatches.push("recomputed claimsHash does not match the on-chain claimsHash");
				}

				if (cancelled) return;
				if (mismatches.length > 0) {
					setPdfIntegrity({
						kind: "mismatch",
						payload: extracted.payload,
						computedClaimsHash,
						message: mismatches.join("; "),
					});
					return;
				}

				setPdfIntegrity({
					kind: "valid",
					payload: extracted.payload,
					computedClaimsHash,
				});
			} catch (unknownError) {
				if (cancelled) return;
				setPdfIntegrity({
					kind: "fetch-error",
					message:
						unknownError instanceof Error
							? unknownError.message
							: String(unknownError),
				});
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [data]);

	useEffect(() => {
		if (!presentationParam) {
			setDecodedPresentation(null);
			setProofVerdict(null);
			return;
		}

		const presentation = decodePresentation(presentationParam);
		setDecodedPresentation(presentation);

		if (!presentation) {
			setProofVerdict({
				ok: false,
				reason: "The ?presentation= value could not be decoded.",
			});
			return;
		}

		if (!data || data.studentAddress === null) return;

		let cancelled = false;
		setProofVerifying(true);
		setProofVerdict(null);

		verifyOwnershipPresentation(presentation, data.studentAddress)
			.then((verdict) => {
				if (!cancelled) {
					setProofVerdict(verdict);
					setProofVerifying(false);
				}
			})
			.catch((unknownError: unknown) => {
				if (!cancelled) {
					setProofVerdict({
						ok: false,
						reason: `Unexpected error: ${
							unknownError instanceof Error
								? unknownError.message
								: String(unknownError)
						}`,
					});
					setProofVerifying(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [presentationParam, data]);

	return (
		<div className="section-stack">
			<div className="page-hero">
				<div className="space-y-3">
					<span className="page-kicker">Public Verification</span>
					<h1 className="page-title text-accent-blue">Verify Certificate</h1>
					<p className="page-subtitle">
						Public verification from a single certificate link or id. We confirm
						the on-chain record first, then automatically fetch and validate an
						attached Bulletin PDF when one exists.
					</p>
				</div>
			</div>

			{!univerifyAddress ? (
				<MessageCard
					tone="muted"
					title="Univerify contract not configured"
					body="The frontend has no Univerify contract address set. Deploy the contract or configure deployments before using the public verifier."
				/>
			) : !idValid ? (
				<MessageCard
					tone="red"
					title="Invalid certificate id"
					body="The id in the URL is not a 0x-prefixed bytes32 (64 hex chars)."
				/>
			) : loading ? (
				<MessageCard tone="muted" title="Loading…" body="Reading the registry on-chain." />
			) : error ? (
				<MessageCard tone="red" title="Verification failed" body={error} />
			) : data ? (
				<ResultCard
					data={data}
					nftConfigured={Boolean(nftAddress)}
					presentationParam={presentationParam}
					decodedPresentation={decodedPresentation}
					proofVerifying={proofVerifying}
					proofVerdict={proofVerdict}
					pdfIntegrity={pdfIntegrity}
				/>
			) : null}
		</div>
	);
}

function ResultCard({
	data,
	nftConfigured,
	presentationParam,
	decodedPresentation,
	proofVerifying,
	proofVerdict,
	pdfIntegrity,
}: {
	data: VerificationData;
	nftConfigured: boolean;
	presentationParam: string | null;
	decodedPresentation: SignedPresentation | null;
	proofVerifying: boolean;
	proofVerdict: OwnershipVerdict | null;
	pdfIntegrity: PdfIntegrityState;
}) {
	const issuedAtIso =
		data.issuedAt > 0n ? new Date(Number(data.issuedAt) * 1000).toISOString() : "—";

	let badge: { cls: string; label: string; title: string; body: string };
	if (!data.exists) {
		badge = {
			cls: "bg-accent-red/10 text-accent-red border-accent-red/30",
			label: "✗ Not found",
			title: "No such certificate",
			body: "No certificate with this id exists on the Univerify registry.",
		};
	} else if (data.revoked) {
		badge = {
			cls: "bg-accent-orange/10 text-accent-orange border-accent-orange/30",
			label: "✗ Revoked",
			title: "Certificate revoked",
			body: "The issuer has revoked this certificate. It is no longer considered valid.",
		};
	} else {
		badge = {
			cls: "bg-accent-green/10 text-accent-green border-accent-green/30",
			label: "✓ Valid",
			title: "Certificate valid",
			body: "Recorded on-chain by an authorized issuer and not revoked.",
		};
	}

	const shouldShowManualFallback =
		data.exists &&
		(!data.pdfCid ||
			pdfIntegrity.kind === "fetch-error" ||
			pdfIntegrity.kind === "payload-error");

	return (
		<div className="space-y-4">
			<div className="card space-y-4 animate-fade-in">
				<div>
					<span className={`status-badge border ${badge.cls}`}>{badge.label}</span>
					<h2 className="section-title mt-2">{badge.title}</h2>
					<p className="text-sm text-text-secondary mt-1">{badge.body}</p>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
					<Field label="Certificate ID" value={data.certificateId} mono />
					<Field
						label="Issuer name"
						value={data.exists ? data.issuerName || "(unnamed)" : "—"}
					/>
					<Field
						label="Issuer wallet"
						value={data.exists ? data.issuer : "—"}
						mono={data.exists}
					/>
					<Field
						label="Issuer status"
						value={
							data.exists ? STATUS_LABEL[data.issuerStatus] ?? String(data.issuerStatus) : "—"
						}
					/>
					<Field label="Issued at" value={issuedAtIso} />
					<Field label="On-chain claimsHash" value={data.claimsHash} mono />
					<Field
						label="Student wallet (NFT holder)"
						value={
							data.exists
								? data.studentAddress
									? data.studentAddress
									: nftConfigured
										? "(no NFT minted)"
										: "(NFT contract not configured)"
								: "—"
						}
						mono={data.exists && data.studentAddress !== null}
					/>
					<Field
						label="Attached PDF CID"
						value={data.exists ? data.pdfCid || "No PDF attached" : "—"}
						mono={data.exists}
					/>
					{data.tokenId !== null && (
						<Field label="NFT token id" value={`#${data.tokenId.toString()}`} />
					)}
				</div>

				{data.exists && data.issuerStatus !== 2 && (
					<p className="text-xs text-text-muted">
						Note: the certificate remains on-chain even if the issuer is currently{" "}
						<strong>{STATUS_LABEL[data.issuerStatus] ?? "non-Active"}</strong>.
						Historical issuance remains verifiable by design.
					</p>
				)}
			</div>

			{data.exists && data.pdfCid && (
				<AutoPdfIntegrityCard
					data={data}
					pdfIntegrity={pdfIntegrity}
				/>
			)}

			{shouldShowManualFallback && (
				<ManualIntegrityFallback
					certificateId={data.certificateId}
					onChainClaimsHash={data.claimsHash}
					revoked={data.revoked}
					reason={
						!data.pdfCid
							? "No PDF CID is attached to this certificate, so integrity verification falls back to manual claim entry."
							: pdfIntegrity.kind === "fetch-error" || pdfIntegrity.kind === "payload-error"
								? "Automatic PDF integrity verification is unavailable for this certificate, so manual claim validation is exposed as a fallback."
								: ""
					}
				/>
			)}

			<OwnershipProofCard
				studentAddress={data.studentAddress}
				presentationParam={presentationParam}
				decodedPresentation={decodedPresentation}
				verifying={proofVerifying}
				verdict={proofVerdict}
			/>
		</div>
	);
}

function AutoPdfIntegrityCard({
	data,
	pdfIntegrity,
}: {
	data: VerificationData;
	pdfIntegrity: PdfIntegrityState;
}) {
	const gatewayUrl = ipfsUrl(data.pdfCid);

	return (
		<div className="card space-y-4 animate-fade-in">
			<div className="flex items-start justify-between gap-3 flex-wrap">
				<div>
					<span className="status-badge border border-white/[0.08] bg-white/[0.04] text-text-secondary">
						PDF Integrity
					</span>
					<h2 className="section-title mt-2">Attached Bulletin PDF</h2>
					<p className="text-sm text-text-secondary mt-1">
						The verifier fetched the student-linked PDF from Bulletin Chain and
						checked its embedded credential payload against the on-chain claims hash.
					</p>
				</div>
				<a
					href={gatewayUrl}
					target="_blank"
					rel="noreferrer"
					className="btn-secondary text-xs"
				>
					Open raw PDF
				</a>
			</div>

			<div className="rounded-[1.25rem] border border-white/[0.08] bg-white/[0.02] overflow-hidden">
				<iframe
					title="Certificate PDF preview"
					src={gatewayUrl}
					className="h-[520px] w-full bg-white"
				/>
			</div>

			{pdfIntegrity.kind === "loading" && (
				<MessageCard
					tone="muted"
					title="Checking PDF integrity…"
					body="Fetching the PDF and extracting the embedded certificate payload."
				/>
			)}

			{pdfIntegrity.kind === "fetch-error" && (
				<MessageCard
					tone="red"
					title="Could not fetch the attached PDF"
					body={pdfIntegrity.message}
				/>
			)}

			{pdfIntegrity.kind === "payload-error" && (
				<MessageCard
					tone="red"
					title="Automatic integrity extraction failed"
					body={pdfIntegrity.message}
				/>
			)}

			{(pdfIntegrity.kind === "valid" || pdfIntegrity.kind === "mismatch") && (
				<div className="space-y-4">
					<div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
						<span
							className={`status-badge border ${
								pdfIntegrity.kind === "valid"
									? "border-accent-green/30 bg-accent-green/10 text-accent-green"
									: "border-accent-red/30 bg-accent-red/10 text-accent-red"
							}`}
						>
							{pdfIntegrity.kind === "valid" ? "✓ Integrity valid" : "✗ Integrity mismatch"}
						</span>
						<p className="text-sm text-text-secondary mt-2">
							{pdfIntegrity.kind === "valid"
								? "The PDF's embedded claims reproduce the same canonical claimsHash stored on-chain."
								: pdfIntegrity.message}
						</p>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm mt-4">
							<Field
								label="Computed claimsHash"
								value={pdfIntegrity.computedClaimsHash}
								mono
							/>
							<Field label="On-chain claimsHash" value={data.claimsHash} mono />
						</div>
					</div>
					<CanonicalClaimsPanel claims={pdfIntegrity.payload.credential.claims} />
				</div>
			)}
		</div>
	);
}

function ManualIntegrityFallback({
	certificateId,
	onChainClaimsHash,
	revoked,
	reason,
}: {
	certificateId: Hex;
	onChainClaimsHash: Hex;
	revoked: boolean;
	reason: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const [formClaims, setFormClaims] = useState<CredentialClaims>({
		degreeTitle: "",
		holderName: "",
		institutionName: "",
		issuanceDate: "",
	});
	const [result, setResult] = useState<{ claimsHash: Hex; matches: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const canonicalClaims = useMemo<CredentialClaims | null>(() => {
		const ready =
			formClaims.degreeTitle.trim() &&
			formClaims.holderName.trim() &&
			formClaims.institutionName.trim() &&
			formClaims.issuanceDate.trim();
		if (!ready) return null;
		try {
			return normalizeClaims(formClaims);
		} catch {
			return null;
		}
	}, [formClaims]);

	function handleValidate() {
		if (!canonicalClaims) {
			setError("Fill all four claim fields before validating.");
			setResult(null);
			return;
		}
		try {
			const claimsHash = computeClaimsHash(formClaims);
			setResult({
				claimsHash,
				matches: claimsHash === onChainClaimsHash,
			});
			setError(null);
		} catch (unknownError) {
			setError(
				unknownError instanceof Error ? unknownError.message : String(unknownError),
			);
			setResult(null);
		}
	}

	return (
		<div className="card space-y-4 animate-fade-in">
			<div className="flex items-start justify-between gap-3 flex-wrap">
				<div>
					<span className="status-badge border border-white/[0.08] bg-white/[0.04] text-text-secondary">
						Manual Fallback
					</span>
					<h2 className="section-title mt-2">Manual Integrity Validation</h2>
					<p className="text-sm text-text-secondary mt-1">{reason}</p>
				</div>
				<button onClick={() => setExpanded((value) => !value)} className="btn-secondary text-xs">
					{expanded ? "Hide manual validation" : "Open manual validation"}
				</button>
			</div>

			{expanded && (
				<div className="space-y-4">
					<p className="text-xs text-text-muted">
						Certificate: <code className="font-mono">{certificateId}</code>
					</p>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<ClaimInput
							label="Holder Name"
							value={formClaims.holderName}
							onChange={(value) => {
								setFormClaims((current) => ({ ...current, holderName: value }));
								setResult(null);
								setError(null);
							}}
							placeholder="Ada Lovelace"
						/>
						<ClaimInput
							label="Degree Title"
							value={formClaims.degreeTitle}
							onChange={(value) => {
								setFormClaims((current) => ({ ...current, degreeTitle: value }));
								setResult(null);
								setError(null);
							}}
							placeholder="Bachelor of Computer Science"
						/>
						<ClaimInput
							label="Institution Name"
							value={formClaims.institutionName}
							onChange={(value) => {
								setFormClaims((current) => ({
									...current,
									institutionName: value,
								}));
								setResult(null);
								setError(null);
							}}
							placeholder="Universidad de Buenos Aires"
						/>
						<MonthYearPicker
							label="Issuance Month"
							value={formClaims.issuanceDate}
							onChange={(value) => {
								setFormClaims((current) => ({ ...current, issuanceDate: value }));
								setResult(null);
								setError(null);
							}}
							helpText="Hashed as YYYY-MM. Day is intentionally not part of the canonical claims."
						/>
					</div>

					{canonicalClaims && <CanonicalClaimsPanel claims={canonicalClaims} />}

					<div className="flex items-center gap-3">
						<button onClick={handleValidate} disabled={!canonicalClaims} className="btn-primary">
							Validate integrity manually
						</button>
						{error && <p className="text-sm font-medium text-accent-red">{error}</p>}
					</div>

					{result && (
						<div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
							<span
								className={`status-badge border ${
									result.matches && !revoked
										? "border-accent-green/30 bg-accent-green/10 text-accent-green"
										: result.matches && revoked
											? "border-accent-orange/30 bg-accent-orange/10 text-accent-orange"
											: "border-accent-red/30 bg-accent-red/10 text-accent-red"
								}`}
							>
								{result.matches
									? revoked
										? "✗ Hash matches, but certificate is revoked"
										: "✓ Manual integrity valid"
									: "✗ Manual integrity mismatch"}
							</span>
							<p className="text-sm text-text-secondary mt-2">
								{result.matches
									? revoked
										? "The entered claims reproduce the stored hash, but the certificate itself remains revoked on-chain."
										: "The entered claims reproduce the same on-chain claimsHash."
									: "The entered claims do not reproduce the on-chain claimsHash."}
							</p>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm mt-4">
								<Field label="Computed claimsHash" value={result.claimsHash} mono />
								<Field label="On-chain claimsHash" value={onChainClaimsHash} mono />
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function OwnershipProofCard({
	studentAddress,
	presentationParam,
	decodedPresentation,
	verifying,
	verdict,
}: {
	studentAddress: Address | null;
	presentationParam: string | null;
	decodedPresentation: SignedPresentation | null;
	verifying: boolean;
	verdict: OwnershipVerdict | null;
}) {
	if (!presentationParam) {
		return (
			<div className="card border border-white/[0.08] bg-white/[0.02]">
				<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
					Wallet Ownership Proof
				</p>
				<p className="text-xs text-text-muted mt-2">
					Not included in this link. If you need the holder to prove they
					currently control the wallet that holds this NFT, ask them to generate a
					signed proof link from their <strong>My Certificates</strong> page.
				</p>
			</div>
		);
	}

	if (!decodedPresentation) {
		return (
			<MessageCard
				tone="red"
				title="Wallet ownership proof malformed"
				body="The ?presentation= value in this URL could not be decoded."
			/>
		);
	}

	if (!studentAddress) {
		return (
			<MessageCard
				tone="muted"
				title="Wallet ownership proof unavailable"
				body="No NFT owner is recorded for this certificate, so there is no on-chain wallet to verify the presentation against."
			/>
		);
	}

	const expiry = new Date(
		decodedPresentation.challenge.expiresAt * 1000,
	).toISOString();

	if (verifying || !verdict) {
		return (
			<MessageCard
				tone="muted"
				title="Verifying ownership proof…"
				body="Checking the signed wallet presentation against the current NFT holder."
			/>
		);
	}

	if (verdict.ok) {
		return (
			<div className="card border border-accent-green/20 bg-accent-green/5 space-y-3 animate-fade-in">
				<p className="text-xs font-medium text-accent-green uppercase tracking-wider">
					✓ Wallet Ownership Proof Verified
				</p>
				<p className="text-sm text-text-secondary">
					The presenter cryptographically proved they control the wallet that
					currently holds this certificate NFT.
				</p>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
					<Field label="Signer (H160)" value={verdict.signerH160} mono />
					<Field label="Proof expires" value={expiry} />
				</div>
			</div>
		);
	}

	return (
		<div className="card border border-accent-red/30 bg-accent-red/5 space-y-3 animate-fade-in">
			<p className="text-xs font-medium text-accent-red uppercase tracking-wider">
				✗ Wallet Ownership Proof Failed
			</p>
			<p className="text-sm text-text-secondary">{verdict.reason}</p>
			<div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
				<Field label="Claimed owner" value={decodedPresentation.challenge.ownerH160} mono />
				<Field label="On-chain owner" value={studentAddress} mono />
				<Field label="Proof expires" value={expiry} />
			</div>
		</div>
	);
}

function CanonicalClaimsPanel({ claims }: { claims: CredentialClaims }) {
	return (
		<div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
			<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
				Canonical form (used for hashing)
			</p>
			<dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono text-text-primary">
				<CanonicalRow label="degreeTitle" value={claims.degreeTitle} />
				<CanonicalRow label="holderName" value={claims.holderName} />
				<CanonicalRow label="institutionName" value={claims.institutionName} />
				<CanonicalRow label="issuanceDate" value={claims.issuanceDate} />
			</dl>
		</div>
	);
}

function CanonicalRow({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="text-text-tertiary">{label}</dt>
			<dd className="break-all text-text-primary">{value}</dd>
		</div>
	);
}

function ClaimInput({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
}) {
	return (
		<div>
			<label className="label">{label}</label>
			<input
				type="text"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				className="input-field w-full"
			/>
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
				className={`text-text-primary break-all ${
					mono ? "font-mono text-xs" : "text-sm"
				}`}
			>
				{value}
			</p>
		</div>
	);
}

function MessageCard({
	tone,
	title,
	body,
}: {
	tone: "muted" | "red";
	title: string;
	body: string;
}) {
	const cls =
		tone === "red"
			? "border-accent-red/30 bg-accent-red/5"
			: "border-white/[0.08] bg-white/[0.02]";
	return (
		<div className={`card border ${cls}`}>
			<h2 className="section-title">{title}</h2>
			<p className="text-sm text-text-secondary mt-1">{body}</p>
		</div>
	);
}
