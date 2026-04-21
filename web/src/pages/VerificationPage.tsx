import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { type Hex } from "viem";

function extractCertificateId(input: string): Hex | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/0x[0-9a-fA-F]{64}/);
	if (!match) return null;
	return match[0] as Hex;
}

export default function VerificationPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const [input, setInput] = useState(searchParams.get("cert") ?? "");
	const certificateId = useMemo(() => extractCertificateId(input), [input]);
	const [error, setError] = useState<string | null>(null);

	function handleVerify() {
		if (!certificateId) {
			setError("Paste a public verification link or a 0x-prefixed certificate id.");
			return;
		}
		setError(null);
		navigate(`/verify/cert/${certificateId}`);
	}

	return (
		<div className="section-stack">
			<div className="page-hero">
				<div className="space-y-3">
					<span className="page-kicker">Verification Workflow</span>
					<h1 className="page-title text-accent-blue">Verify Certificate</h1>
					<p className="page-subtitle">
						Paste a public verification link or a certificate id. We load the
						on-chain record first, then automatically check for an attached
						Bulletin PDF and validate its integrity when one exists.
					</p>
				</div>
			</div>

			<div className="card space-y-4">
				<div>
					<label className="label">Verification link or certificate ID</label>
					<input
						type="text"
						value={input}
						onChange={(event) => {
							setInput(event.target.value);
							setError(null);
						}}
						placeholder="https://…/#/verify/cert/0x…  or  0x…"
						className="input-field w-full"
						spellCheck={false}
						onKeyDown={(event) => {
							if (event.key === "Enter") handleVerify();
						}}
					/>
					<p className="text-xs text-text-muted mt-2">
						The public verifier stays the single source of truth. If the
						certificate has a linked PDF CID, it will preview the document and
						recompute the canonical <code>claimsHash</code> automatically.
					</p>
					{certificateId && (
						<p className="text-xs text-accent-green mt-2">
							Found id: <code className="font-mono break-all">{certificateId}</code>
						</p>
					)}
				</div>

				<div className="flex items-center gap-3">
					<button onClick={handleVerify} disabled={!certificateId} className="btn-primary">
						Verify certificate
					</button>
					{error && <p className="text-sm font-medium text-accent-red">{error}</p>}
				</div>
			</div>
		</div>
	);
}
