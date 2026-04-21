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
import { type Address, type Hex } from "viem";
import { univerifyAbi } from "../config/univerify";
import { certificateNftAbi } from "../config/certificateNft";
import { getPublicClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";
import { useWalletStore, selectConnectedEvmAddress } from "../account/wallet";

interface CertificateRow {
	tokenId: bigint;
	certificateId: Hex;
	issuer: Address;
	issuerName: string;
	issuedAt: bigint;
	revoked: boolean;
}

export default function MyCertificatesPage() {
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const walletStatus = useWalletStore((s) => s.status);
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

					const [issuer, , issuedAt, revoked] = cert;

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
						issuedAt,
						revoked,
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
					on-chain.
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
								<CertificateCard key={row.tokenId.toString()} row={row} />
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}

function CertificateCard({ row }: { row: CertificateRow }) {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const verifyUrl = `${window.location.origin}/#/verify/cert/${row.certificateId}`;
	const issuedAtIso =
		row.issuedAt > 0n ? new Date(Number(row.issuedAt) * 1000).toISOString() : "—";

	function copyLink() {
		navigator.clipboard
			?.writeText(verifyUrl)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
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
				<a
					href={`#/verify/cert/${row.certificateId}`}
					target="_blank"
					rel="noreferrer"
					className="btn-secondary text-xs"
				>
					Open verifier
				</a>
				<button
					onClick={() => setExpanded((v) => !v)}
					className="btn-secondary text-xs"
				>
					{expanded ? "Hide details" : "View details"}
				</button>
			</div>

			{expanded && (
				<div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 space-y-2 animate-fade-in">
					<Field label="Issuer wallet" value={row.issuer} mono />
					<Field label="Public verification link" value={verifyUrl} mono />
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
