// Public verifier — two flows in one page:
//
//   "link"      : paste a verification link or a 0x… certificate id and
//                 jump to PublicVerifyPage which checks existence, issuer
//                 authenticity, and revocation status via the soulbound NFT.
//
//   "integrity" : prove that a presented (holderName, degreeTitle,
//                 institutionName, month/year) tuple matches the on-chain
//                 `claimsHash` for a given certificate id. Both sides hash
//                 with the canonical Schema v2 normalization (uppercase +
//                 trim + collapse whitespace + NFC + YYYY-MM), so verifiers
//                 don't have to mirror the issuer's casing exactly.
//
// We deliberately do NOT accept a pasted credential JSON or a free-form
// 0x-prefixed bytes32 claims hash anymore: the only way to prove integrity
// is by reproducing the canonical claims, which makes the meaning of a
// "match" unambiguous to a non-technical verifier.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { type Address, type Hex } from "viem";
import { univerifyAbi } from "../config/univerify";
import { getPublicClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";
import {
	computeClaimsHash,
	normalizeClaims,
	type CredentialClaims,
} from "../utils/credential";
import { MonthYearPicker } from "../components/MonthYearPicker";

type Mode = "link" | "integrity";

/// Pull a certificateId out of any of:
///   - bare hex id: `0xabc…`
///   - hash route fragment: `#/verify/cert/0xabc…`
///   - full URL with hash router: `http://host/#/verify/cert/0xabc…`
///   - trailing slashes / whitespace
/// Returns `null` if no valid id is found.
function extractCertificateId(input: string): Hex | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/0x[0-9a-fA-F]{64}/);
	if (!match) return null;
	return match[0] as Hex;
}

interface VerificationResult {
	exists: boolean;
	issuer: Address;
	hashMatch: boolean;
	revoked: boolean;
	issuedAt: bigint;
	certificateId: Hex;
	claimsHash: Hex;
}

type Verdict = "valid" | "not-found" | "tampered" | "revoked";

function deriveVerdict(r: VerificationResult): Verdict {
	if (!r.exists) return "not-found";
	if (!r.hashMatch) return "tampered";
	if (r.revoked) return "revoked";
	return "valid";
}

export default function VerificationPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);

	const univerifyAddress = deployments.univerify as Address | null;

	// Initial mode + cert id come from the query string when the user lands
	// here from the "Validate claim integrity" CTA on the public verifier.
	const initialCert = searchParams.get("cert") ?? "";
	const initialMode: Mode = searchParams.get("mode") === "integrity" ? "integrity" : "link";

	const [mode, setMode] = useState<Mode>(initialMode);

	// ── Link / ID mode ───────────────────────────────────────────────
	const [linkInput, setLinkInput] = useState(initialMode === "link" ? initialCert : "");
	const linkCertId = useMemo(() => extractCertificateId(linkInput), [linkInput]);
	const linkInputHasContent = linkInput.trim().length > 0;

	// ── Integrity mode ───────────────────────────────────────────────
	const [integrityCert, setIntegrityCert] = useState(
		initialMode === "integrity" ? initialCert : "",
	);
	const integrityCertId = useMemo(
		() => extractCertificateId(integrityCert),
		[integrityCert],
	);
	const [formClaims, setFormClaims] = useState<CredentialClaims>({
		degreeTitle: "",
		holderName: "",
		institutionName: "",
		issuanceDate: "",
	});

	// ── Verification result ──────────────────────────────────────────
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<VerificationResult | null>(null);

	const resetOutputs = () => {
		setResult(null);
		setError(null);
	};

	// If the URL query params change (e.g. user clicks the CTA from another
	// tab), pull them back into local state so the form prefills correctly.
	useEffect(() => {
		const next = searchParams.get("cert") ?? "";
		const m: Mode = searchParams.get("mode") === "integrity" ? "integrity" : "link";
		setMode(m);
		if (m === "integrity") setIntegrityCert(next);
		else setLinkInput(next);
		resetOutputs();
	}, [searchParams]);

	// Live preview of what `computeClaimsHash` will actually hash. We try/catch
	// because `normalizeClaims` throws on a partially-typed `issuanceDate`.
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

	const canVerify = useMemo(() => {
		if (mode === "link") return linkCertId !== null;
		return integrityCertId !== null && canonicalClaims !== null;
	}, [mode, linkCertId, integrityCertId, canonicalClaims]);

	async function handleVerify() {
		resetOutputs();

		if (mode === "link") {
			if (!linkCertId) {
				setError("Paste a verification link or a 0x-prefixed certificate id.");
				return;
			}
			navigate(`/verify/cert/${linkCertId}`);
			return;
		}

		if (!univerifyAddress) {
			setError(
				"Univerify contract address is not configured in this build. Deploy the contract or set `deployments.univerify`.",
			);
			return;
		}
		if (!integrityCertId) {
			setError("Paste a verification link or a 0x-prefixed certificate id.");
			return;
		}
		if (!canonicalClaims) {
			setError(
				"Fill all four claim fields. Issuance month must be a valid month (use the picker).",
			);
			return;
		}

		let claimsHash: Hex;
		try {
			claimsHash = computeClaimsHash(formClaims);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return;
		}

		try {
			setLoading(true);
			const client = getPublicClient(ethRpcUrl);

			const code = await client.getCode({ address: univerifyAddress });
			if (!code || code === "0x") {
				setError(
					`No Univerify contract found at ${univerifyAddress} on ${ethRpcUrl}. The deployment in this build may be stale.`,
				);
				return;
			}

			const [exists, issuer, hashMatch, revoked, issuedAt] = await client.readContract({
				address: univerifyAddress,
				abi: univerifyAbi,
				functionName: "verifyCertificate",
				args: [integrityCertId, claimsHash],
			});

			setResult({
				exists,
				issuer,
				hashMatch,
				revoked,
				issuedAt,
				certificateId: integrityCertId,
				claimsHash,
			});
		} catch (e) {
			console.error("Verification failed:", e);
			setError(`RPC error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setLoading(false);
		}
	}

	function switchMode(next: Mode) {
		setMode(next);
		resetOutputs();
	}

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title text-accent-blue">Verify Credential</h1>
				<p className="text-text-secondary">
					Two paths, both public, both on-chain. Use <strong>Link / ID</strong> to
					confirm that a certificate exists, who issued it, who holds it, and whether
					it has been revoked. Use <strong>Validate Information Integrity</strong> to
					additionally prove that a specific (holder, degree, institution, month) tuple
					matches the on-chain hash for that certificate.
				</p>
			</div>

			<div className="card space-y-4">
				{/* Mode tabs */}
				<div className="flex gap-2 flex-wrap">
					<button
						onClick={() => switchMode("link")}
						className={`btn-secondary text-xs ${
							mode === "link" ? "!bg-white/[0.08] !text-text-primary" : ""
						}`}
					>
						Link / ID
					</button>
					<button
						onClick={() => switchMode("integrity")}
						className={`btn-secondary text-xs ${
							mode === "integrity" ? "!bg-white/[0.08] !text-text-primary" : ""
						}`}
					>
						Validate Information Integrity
					</button>
				</div>

				{mode === "link" ? (
					<div>
						<label className="label">Verification link or certificate ID</label>
						<input
							type="text"
							value={linkInput}
							onChange={(e) => {
								setLinkInput(e.target.value);
								resetOutputs();
							}}
							placeholder="https://…/#/verify/cert/0x…  or  0x…"
							className="input-field w-full"
							spellCheck={false}
							onKeyDown={(e) => {
								if (e.key === "Enter" && linkCertId) {
									navigate(`/verify/cert/${linkCertId}`);
								}
							}}
						/>
						<p className="text-xs text-text-muted mt-1">
							Paste the public link the issuer or student shared with you, or the
							raw <code>certificateId</code>. We'll open the public verifier which
							confirms existence, issuer, student wallet, and revocation status
							on-chain — no JSON or wallet required.
							{linkInputHasContent && !linkCertId ? (
								<span className="block text-accent-red mt-1">
									Couldn't find a 0x-prefixed 32-byte certificate id in the
									input.
								</span>
							) : null}
							{linkCertId ? (
								<span className="block text-accent-green mt-1">
									Found id:{" "}
									<code className="font-mono text-text-primary break-all">
										{linkCertId}
									</code>
								</span>
							) : null}
						</p>
					</div>
				) : (
					<div className="space-y-4">
						<div>
							<label className="label">Verification link or certificate ID</label>
							<input
								type="text"
								value={integrityCert}
								onChange={(e) => {
									setIntegrityCert(e.target.value);
									resetOutputs();
								}}
								placeholder="https://…/#/verify/cert/0x…  or  0x…"
								className="input-field w-full"
								spellCheck={false}
							/>
							<p className="text-xs text-text-muted mt-1">
								We pull the <code>certificateId</code> out of the link so you
								never have to retype the 64-character hash.
								{integrityCert.trim().length > 0 && !integrityCertId ? (
									<span className="block text-accent-red mt-1">
										Couldn't find a 0x-prefixed 32-byte certificate id in
										the input.
									</span>
								) : null}
								{integrityCertId ? (
									<span className="block text-accent-green mt-1">
										Found id:{" "}
										<code className="font-mono text-text-primary break-all">
											{integrityCertId}
										</code>
									</span>
								) : null}
							</p>
						</div>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div>
								<label className="label">Holder Name</label>
								<input
									type="text"
									value={formClaims.holderName}
									onChange={(e) => {
										setFormClaims((c) => ({
											...c,
											holderName: e.target.value,
										}));
										resetOutputs();
									}}
									placeholder="Ada Lovelace"
									className="input-field w-full"
								/>
							</div>
							<div>
								<label className="label">Degree Title</label>
								<input
									type="text"
									value={formClaims.degreeTitle}
									onChange={(e) => {
										setFormClaims((c) => ({
											...c,
											degreeTitle: e.target.value,
										}));
										resetOutputs();
									}}
									placeholder="Bachelor of Computer Science"
									className="input-field w-full"
								/>
							</div>
							<div>
								<label className="label">Institution Name</label>
								<input
									type="text"
									value={formClaims.institutionName}
									onChange={(e) => {
										setFormClaims((c) => ({
											...c,
											institutionName: e.target.value,
										}));
										resetOutputs();
									}}
									placeholder="Universidad de Buenos Aires"
									className="input-field w-full"
								/>
							</div>
							<MonthYearPicker
								label="Issuance Month"
								value={formClaims.issuanceDate}
								onChange={(v) => {
									setFormClaims((c) => ({ ...c, issuanceDate: v }));
									resetOutputs();
								}}
								helpText="Hashed as YYYY-MM. Day is intentionally not part of the hash."
							/>
						</div>

						{canonicalClaims && <CanonicalClaimsPanel claims={canonicalClaims} />}

						<p className="text-xs text-text-muted">
							Spelling matters; casing and whitespace don't. Strings are
							upper-cased, NFC-normalized and whitespace-collapsed before hashing,
							so "ada lovelace" and "ADA  LOVELACE" produce the same hash.
						</p>
					</div>
				)}

				<div className="flex items-center gap-3">
					<button
						onClick={handleVerify}
						disabled={!canVerify || loading || (mode === "integrity" && !univerifyAddress)}
						className="btn-primary"
					>
						{loading
							? "Verifying..."
							: mode === "link"
								? "Open public verifier"
								: "Validate integrity"}
					</button>
					{error && <p className="text-sm font-medium text-accent-red">{error}</p>}
				</div>

				{mode === "integrity" && !univerifyAddress && (
					<p className="text-xs text-accent-red">
						<code>deployments.univerify</code> is not set in this build. Integrity
						verification is unavailable until the contract is deployed.
					</p>
				)}
			</div>

			{result && <ResultCard result={result} />}
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

function ResultCard({ result }: { result: VerificationResult }) {
	const verdict = deriveVerdict(result);

	const verdictStyles: Record<
		Verdict,
		{ badge: string; title: string; label: string; explanation: string }
	> = {
		valid: {
			badge: "bg-accent-green/10 text-accent-green border-accent-green/30",
			title: "text-accent-green",
			label: "✓ Valid",
			explanation:
				"The certificate exists on-chain, the claims hash matches, and it has not been revoked.",
		},
		"not-found": {
			badge: "bg-accent-red/10 text-accent-red border-accent-red/30",
			title: "text-accent-red",
			label: "✗ Not found",
			explanation: "No certificate with this ID exists on the Univerify contract.",
		},
		tampered: {
			badge: "bg-accent-red/10 text-accent-red border-accent-red/30",
			title: "text-accent-red",
			label: "✗ Tampered",
			explanation:
				"A certificate with this ID exists, but the claims hash does not match. The presented credential has been modified or the typed values differ from the issued ones.",
		},
		revoked: {
			badge: "bg-accent-orange/10 text-accent-orange border-accent-orange/30",
			title: "text-accent-orange",
			label: "✗ Revoked",
			explanation:
				"The issuer has revoked this certificate. It is no longer considered valid.",
		},
	};

	const v = verdictStyles[verdict];
	const issuedAt =
		result.issuedAt > 0n ? new Date(Number(result.issuedAt) * 1000).toISOString() : "—";

	return (
		<div className="card space-y-4 animate-fade-in">
			<div className="flex items-start justify-between gap-4 flex-wrap">
				<div>
					<span className={`status-badge border ${v.badge}`}>{v.label}</span>
					<h2 className={`section-title mt-2 ${v.title}`}>{v.label.slice(2)}</h2>
					<p className="text-sm text-text-secondary mt-1">{v.explanation}</p>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
				<Field label="Certificate ID" value={result.certificateId} mono />
				<Field label="Claims Hash (computed)" value={result.claimsHash} mono />
				<Field
					label="Issuer"
					value={result.exists ? result.issuer : "—"}
					mono={result.exists}
				/>
				<Field label="Issued At" value={issuedAt} />
				<Field label="Exists" value={result.exists ? "yes" : "no"} />
				<Field label="Hash Match" value={result.hashMatch ? "yes" : "no"} />
				<Field label="Revoked" value={result.revoked ? "yes" : "no"} />
			</div>
		</div>
	);
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
	return (
		<div>
			<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
				{label}
			</p>
			<p className={`text-text-primary break-all ${mono ? "font-mono text-xs" : "text-sm"}`}>
				{value}
			</p>
		</div>
	);
}
