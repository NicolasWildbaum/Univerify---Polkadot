// PublicVerifyPage — verifies by certificateId only. Anyone holding the link
// can verify; we intentionally do not require wallet ownership proof here.
//
// TODO(future): add an optional "?presentation=<sig>" query param so the
// student can prove they currently control the holding wallet via a signed
// challenge bound to this verifier. Out of scope for this MVP — the public
// link is "possession is enough" by design today.

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { type Address, type Hex } from "viem";
import { univerifyAbi } from "../config/univerify";
import { certificateNftAbi } from "../config/certificateNft";
import { getPublicClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

interface VerificationData {
	certificateId: Hex;
	exists: boolean;
	issuer: Address;
	issuerName: string;
	issuerStatus: number;
	issuedAt: bigint;
	revoked: boolean;
	studentAddress: Address | null;
	tokenId: bigint | null;
}

const STATUS_LABEL: Record<number, string> = {
	0: "None",
	1: "Pending",
	2: "Active",
	3: "Removed",
};

export default function PublicVerifyPage() {
	const params = useParams<{ certificateId: string }>();
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const univerifyAddress = deployments.univerify as Address | null;
	const nftAddress = deployments.certificateNft as Address | null;

	const [data, setData] = useState<VerificationData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

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
				const [issuer, , issuedAt, revoked] = cert;

				const exists = issuer !== ZERO_ADDRESS;

				let issuerName = "";
				let issuerStatus = 0;
				if (exists) {
					try {
						const profile = (await client.readContract({
							address: univerifyAddress,
							abi: univerifyAbi,
							functionName: "getIssuer",
							args: [issuer],
						})) as { name: string; status: number | bigint };
						issuerName = profile.name ?? "";
						issuerStatus = Number(profile.status);
					} catch {
						// Issuer profile lookup is best-effort; fall through to defaults.
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
						// NFT lookup is best-effort; older certificates issued before
						// the NFT was wired (in dev/local resets) may not have one.
					}
				}

				if (cancelled) return;
				setData({
					certificateId,
					exists,
					issuer,
					issuerName,
					issuerStatus,
					issuedAt,
					revoked,
					studentAddress,
					tokenId,
				});
			} catch (e) {
				if (cancelled) return;
				console.error("Public verify failed:", e);
				setError(`RPC error: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [idValid, rawId, ethRpcUrl, univerifyAddress, nftAddress]);

	return (
		<div className="section-stack">
			<div className="page-hero">
				<div className="space-y-3">
					<span className="page-kicker">Public Verification</span>
					<h1 className="page-title text-accent-blue">Verify Certificate</h1>
					<p className="page-subtitle">
					Public on-chain verification by certificate id. No login or wallet
					required. Anyone with this link can confirm whether the certificate
					exists, who issued it, and whether it is currently valid.
					</p>
				</div>
			</div>

			{!univerifyAddress ? (
				<MessageCard
					tone="muted"
					title="Univerify contract not configured"
					body="The frontend has no Univerify contract address set. Deploy the contract or paste the address into the Verify tab."
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
				<ResultCard data={data} nftConfigured={Boolean(nftAddress)} />
			) : null}

			<div className="card border border-white/[0.08] bg-white/[0.02] text-sm text-text-secondary">
				Need to also check that the credential's content matches what the holder
				claims? Use the{" "}
				<Link to="/verify" className="text-accent-blue hover:underline">
					Verify
				</Link>{" "}
				tab and pick <strong>Validate Information Integrity</strong> to recompute the
				claims hash from holder name, degree, institution and issuance month.
			</div>
		</div>
	);
}

function ResultCard({
	data,
	nftConfigured,
}: {
	data: VerificationData;
	nftConfigured: boolean;
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

	return (
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
				{data.tokenId !== null && (
					<Field label="NFT token id" value={`#${data.tokenId.toString()}`} />
				)}
			</div>

			{data.exists && data.issuerStatus !== 2 && (
				<p className="text-xs text-text-muted">
					Note: the certificate remains on-chain even if the issuer is currently{" "}
					<strong>{STATUS_LABEL[data.issuerStatus] ?? "non-Active"}</strong>. Verification
					reflects historical issuance — the registry deliberately does not invalidate
					past certificates when an issuer's status changes.
				</p>
			)}

			{data.exists && (
				<div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="text-sm text-text-primary">
							Want to also confirm the certificate's content matches what the
							holder claims?
						</p>
						<p className="text-xs text-text-muted mt-1">
							Type the holder name, degree, institution and issuance month — we
							hash them with the same canonical rules the issuer used and
							compare against this certificate's on-chain hash.
						</p>
					</div>
					<Link
						to={`/verify?mode=integrity&cert=${data.certificateId}`}
						className="btn-secondary text-xs whitespace-nowrap"
					>
						Validate claim integrity →
					</Link>
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
