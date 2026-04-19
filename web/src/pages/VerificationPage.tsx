import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type Address, type Hex } from "viem";
import { univerifyAbi } from "../config/univerify";
import { getPublicClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";
import {
	computeClaimsHash,
	parseVerifiableCredential,
	type CredentialClaims,
} from "../utils/credential";

type Mode = "link" | "json" | "form";

const CERT_ID_RE = /^0x[0-9a-fA-F]{64}$/;

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

const STORAGE_KEY_PREFIX = "univerify:address";

const EXAMPLE_JSON = `{
  "certificateId": "0x...",
  "issuer": "0x...",
  "recipientCommitment": "0x...",
  "claims": {
    "degreeTitle": "Bachelor of Computer Science",
    "holderName": "Ada Lovelace",
    "institutionName": "Universidad de Buenos Aires",
    "issuanceDate": "2026-03-15"
  }
}`;

export default function VerificationPage() {
	const navigate = useNavigate();
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const scopedStorageKey = `${STORAGE_KEY_PREFIX}:${ethRpcUrl}`;

	const [mode, setMode] = useState<Mode>("link");

	// ── Link / ID mode state ─────────────────────────────────────────
	// We keep this mode UI-only (no on-chain reads here): once we extract
	// a valid id, navigate to the public verifier route, which already
	// does all the on-chain reads and renders the verdict. This keeps
	// "verify by id" logic in exactly one place.
	const [linkInput, setLinkInput] = useState("");
	const linkCertId = useMemo(() => extractCertificateId(linkInput), [linkInput]);
	const linkInputHasContent = linkInput.trim().length > 0;

	// Contract address (defaults to deployments.univerify, per-rpc-url override via localStorage).
	const defaultAddress = deployments.univerify ?? "";
	const [contractAddress, setContractAddress] = useState("");

	useEffect(() => {
		setContractAddress(localStorage.getItem(scopedStorageKey) || defaultAddress);
	}, [defaultAddress, scopedStorageKey]);

	function saveAddress(address: string) {
		setContractAddress(address);
		if (address) {
			localStorage.setItem(scopedStorageKey, address);
		} else {
			localStorage.removeItem(scopedStorageKey);
		}
	}

	// ── JSON mode state ──────────────────────────────────────────────
	const [jsonText, setJsonText] = useState("");

	// ── Form mode state ──────────────────────────────────────────────
	const [formClaims, setFormClaims] = useState<CredentialClaims>({
		degreeTitle: "",
		holderName: "",
		institutionName: "",
		issuanceDate: "",
	});
	const [formCertificateId, setFormCertificateId] = useState("");

	// ── Verification result ──────────────────────────────────────────
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<VerificationResult | null>(null);

	// Clear stale result/error when the user changes inputs.
	const resetOutputs = () => {
		setResult(null);
		setError(null);
	};

	const canVerify = useMemo(() => {
		// `link` mode delegates to PublicVerifyPage and doesn't need a
		// contract address typed in here (the public page reads from
		// `deployments.univerify` directly).
		if (mode === "link") return linkCertId !== null;
		if (!contractAddress) return false;
		if (mode === "json") return jsonText.trim().length > 0;
		return (
			formCertificateId.trim().length > 0 &&
			formClaims.degreeTitle.trim().length > 0 &&
			formClaims.holderName.trim().length > 0 &&
			formClaims.institutionName.trim().length > 0 &&
			formClaims.issuanceDate.trim().length > 0
		);
	}, [contractAddress, mode, jsonText, formCertificateId, formClaims, linkCertId]);

	async function handleVerify() {
		resetOutputs();

		// Link mode: just navigate. The public page handles everything.
		if (mode === "link") {
			if (!linkCertId) {
				setError("Paste a verification link or a 0x-prefixed certificate id.");
				return;
			}
			navigate(`/verify/cert/${linkCertId}`);
			return;
		}

		if (!contractAddress) {
			setError("Enter a contract address first.");
			return;
		}

		let certificateId: Hex;
		let claims: CredentialClaims;

		if (mode === "json") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(jsonText);
			} catch (e) {
				setError(
					`Invalid JSON: ${e instanceof Error ? e.message : "could not parse input"}.`,
				);
				return;
			}
			const check = parseVerifiableCredential(parsed);
			if (!check.ok) {
				setError(check.error);
				return;
			}
			certificateId = check.credential.certificateId;
			claims = check.credential.claims;
		} else {
			if (!/^0x[0-9a-fA-F]{64}$/.test(formCertificateId.trim())) {
				setError("`certificateId` must be a 0x-prefixed bytes32 (64 hex chars).");
				return;
			}
			certificateId = formCertificateId.trim() as Hex;
			claims = {
				degreeTitle: formClaims.degreeTitle.trim(),
				holderName: formClaims.holderName.trim(),
				institutionName: formClaims.institutionName.trim(),
				issuanceDate: formClaims.issuanceDate.trim(),
			};
		}

		const claimsHash = computeClaimsHash(claims);

		try {
			setLoading(true);
			const client = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Address;

			const code = await client.getCode({ address: addr });
			if (!code || code === "0x") {
				setError(
					`No Univerify contract found at this address on ${ethRpcUrl}. Update the address or deploy one first.`,
				);
				return;
			}

			const [exists, issuer, hashMatch, revoked, issuedAt] = await client.readContract({
				address: addr,
				abi: univerifyAbi,
				functionName: "verifyCertificate",
				args: [certificateId, claimsHash],
			});

			setResult({
				exists,
				issuer,
				hashMatch,
				revoked,
				issuedAt,
				certificateId,
				claimsHash,
			});
		} catch (e) {
			console.error("Verification failed:", e);
			setError(`RPC error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setLoading(false);
		}
	}

	function pasteExample() {
		setJsonText(EXAMPLE_JSON);
		resetOutputs();
	}

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title text-accent-blue">Verify Credential</h1>
				<p className="text-text-secondary">
					Public verification of a Univerify academic credential. Pick a mode below:
					paste the public link (or just the certificate id), paste the full credential
					JSON, or fill the fields manually. The link mode confirms existence and status;
					the JSON / form modes additionally check that the claims haven't been tampered
					with.
				</p>
			</div>

			{/* Contract address */}
			<div className="card space-y-4">
				{mode !== "link" && (
					<div>
						<label className="label">Univerify Contract Address</label>
						<div className="flex gap-2">
							<input
								type="text"
								value={contractAddress}
								onChange={(e) => {
									saveAddress(e.target.value);
									resetOutputs();
								}}
								placeholder="0x..."
								className="input-field w-full"
							/>
							{defaultAddress && contractAddress !== defaultAddress && (
								<button
									onClick={() => {
										saveAddress(defaultAddress);
										resetOutputs();
									}}
									className="btn-secondary text-xs whitespace-nowrap"
								>
									Reset
								</button>
							)}
						</div>
						{!defaultAddress && (
							<p className="text-xs text-text-muted mt-2">
								<code>deployments.univerify</code> is not set. Deploy the
								Univerify contract or paste the address manually.
							</p>
						)}
					</div>
				)}

				{/* Mode tabs */}
				<div className="flex gap-2 flex-wrap">
					<button
						onClick={() => {
							setMode("link");
							resetOutputs();
						}}
						className={`btn-secondary text-xs ${
							mode === "link" ? "!bg-white/[0.08] !text-text-primary" : ""
						}`}
					>
						Link / ID
					</button>
					<button
						onClick={() => {
							setMode("json");
							resetOutputs();
						}}
						className={`btn-secondary text-xs ${
							mode === "json" ? "!bg-white/[0.08] !text-text-primary" : ""
						}`}
					>
						Paste JSON
					</button>
					<button
						onClick={() => {
							setMode("form");
							resetOutputs();
						}}
						className={`btn-secondary text-xs ${
							mode === "form" ? "!bg-white/[0.08] !text-text-primary" : ""
						}`}
					>
						Manual fields
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
				) : mode === "json" ? (
					<div>
						<div className="flex items-center justify-between">
							<label className="label">Credential JSON</label>
							<button
								onClick={pasteExample}
								className="text-xs text-text-tertiary hover:text-text-secondary underline-offset-2 hover:underline"
							>
								Insert example
							</button>
						</div>
						<textarea
							value={jsonText}
							onChange={(e) => {
								setJsonText(e.target.value);
								resetOutputs();
							}}
							placeholder={EXAMPLE_JSON}
							rows={12}
							className="input-field w-full resize-y"
							spellCheck={false}
						/>
					</div>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div className="md:col-span-2">
							<label className="label">Certificate ID (bytes32)</label>
							<input
								type="text"
								value={formCertificateId}
								onChange={(e) => {
									setFormCertificateId(e.target.value);
									resetOutputs();
								}}
								placeholder="0x..."
								className="input-field w-full"
							/>
						</div>
						<div>
							<label className="label">Degree Title</label>
							<input
								type="text"
								value={formClaims.degreeTitle}
								onChange={(e) => {
									setFormClaims((c) => ({ ...c, degreeTitle: e.target.value }));
									resetOutputs();
								}}
								placeholder="Bachelor of Computer Science"
								className="input-field w-full"
							/>
						</div>
						<div>
							<label className="label">Holder Name</label>
							<input
								type="text"
								value={formClaims.holderName}
								onChange={(e) => {
									setFormClaims((c) => ({ ...c, holderName: e.target.value }));
									resetOutputs();
								}}
								placeholder="Ada Lovelace"
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
						<div>
							<label className="label">Issuance Date (ISO)</label>
							<input
								type="text"
								value={formClaims.issuanceDate}
								onChange={(e) => {
									setFormClaims((c) => ({ ...c, issuanceDate: e.target.value }));
									resetOutputs();
								}}
								placeholder="2026-03-15"
								className="input-field w-full"
							/>
						</div>
					</div>
				)}

				<div className="flex items-center gap-3">
					<button
						onClick={handleVerify}
						disabled={!canVerify || loading}
						className="btn-primary"
					>
						{loading
							? "Verifying..."
							: mode === "link"
								? "Open public verifier"
								: "Verify"}
					</button>
					{error && <p className="text-sm font-medium text-accent-red">{error}</p>}
				</div>
			</div>

			{result && <ResultCard result={result} />}
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
				"A certificate with this ID exists, but the claims hash does not match. The presented credential has been modified.",
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
