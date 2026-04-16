import { useMemo, useState } from "react";
import { type Address, type Hex } from "viem";
import { univerifyAbi } from "../config/univerify";
import { evmDevAccounts, getPublicClient, getWalletClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";
import {
	buildCredential,
	type CredentialClaims,
	type VerifiableCredential,
} from "../utils/credential";

const STORAGE_KEY_PREFIX = "univerify:address";

type TxState =
	| { kind: "idle" }
	| { kind: "sending" }
	| { kind: "waiting"; hash: Hex }
	| { kind: "success"; hash: Hex; credential: VerifiableCredential }
	| { kind: "error"; message: string };

// ── Helpers ─────────────────────────────────────────────────────────

function randomBytes32(): Hex {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as Hex;
}

function extractRevertName(err: unknown): string | null {
	// viem surfaces custom errors in various places depending on version.
	// We inspect .message / .shortMessage / walk .cause for the error name.
	const parts: string[] = [];
	let cur: unknown = err;
	let depth = 0;
	while (cur && depth < 10) {
		if (cur instanceof Error) {
			parts.push(cur.message);
			const any = cur as { shortMessage?: string; details?: string };
			if (any.shortMessage) parts.push(any.shortMessage);
			if (any.details) parts.push(any.details);
			cur = (cur as { cause?: unknown }).cause;
		} else {
			parts.push(String(cur));
			break;
		}
		depth++;
	}
	const joined = parts.join("\n");
	const known = [
		"UnauthorizedIssuer",
		"InvalidCertificateId",
		"InvalidClaimsHash",
		"InvalidRecipientCommitment",
		"CertificateAlreadyExists",
	];
	for (const name of known) {
		if (joined.includes(name)) return name;
	}
	return null;
}

// ── Component ───────────────────────────────────────────────────────

export default function UniverifyIssuerPage() {
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const scopedStorageKey = `${STORAGE_KEY_PREFIX}:${ethRpcUrl}`;

	const defaultAddress = deployments.univerify ?? "";
	const [contractAddress, setContractAddress] = useState(
		() => localStorage.getItem(scopedStorageKey) || defaultAddress,
	);
	const [selectedAccount, setSelectedAccount] = useState(0);

	// Claims
	const [claims, setClaims] = useState<CredentialClaims>({
		degreeTitle: "",
		holderName: "",
		institutionName: "",
		issuanceDate: "",
	});

	// Issuance-time metadata
	const [internalRef, setInternalRef] = useState("");
	const [holderIdentifier, setHolderIdentifier] = useState("");
	const [secret, setSecret] = useState<Hex>(randomBytes32());

	const [tx, setTx] = useState<TxState>({ kind: "idle" });

	function saveAddress(address: string) {
		setContractAddress(address);
		if (address) localStorage.setItem(scopedStorageKey, address);
		else localStorage.removeItem(scopedStorageKey);
	}

	// ── Live preview (pure computation on every render) ──────────────
	const issuerAddress = evmDevAccounts[selectedAccount].account.address as Hex;

	const preview = useMemo(() => {
		// Only compute when all required fields are present to avoid showing
		// hashes of empty strings.
		const ready =
			claims.degreeTitle.trim() &&
			claims.holderName.trim() &&
			claims.institutionName.trim() &&
			claims.issuanceDate.trim() &&
			internalRef.trim() &&
			holderIdentifier.trim();

		if (!ready) return null;

		return buildCredential({
			issuer: issuerAddress,
			internalRef: internalRef.trim(),
			claims: {
				degreeTitle: claims.degreeTitle.trim(),
				holderName: claims.holderName.trim(),
				institutionName: claims.institutionName.trim(),
				issuanceDate: claims.issuanceDate.trim(),
			},
			secret,
			holderIdentifier: holderIdentifier.trim(),
		});
	}, [claims, internalRef, holderIdentifier, secret, issuerAddress]);

	const canSubmit =
		contractAddress.length > 0 && preview !== null && tx.kind !== "sending" && tx.kind !== "waiting";

	async function handleIssue() {
		if (!preview) return;
		if (!contractAddress) {
			setTx({ kind: "error", message: "Enter a contract address first." });
			return;
		}

		setTx({ kind: "sending" });

		try {
			const publicClient = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Address;

			const code = await publicClient.getCode({ address: addr });
			if (!code || code === "0x") {
				setTx({
					kind: "error",
					message: `No Univerify contract found at this address on ${ethRpcUrl}. Deploy one first or update the address.`,
				});
				return;
			}

			const walletClient = await getWalletClient(selectedAccount, ethRpcUrl);
			const hash = await walletClient.writeContract({
				address: addr,
				abi: univerifyAbi,
				functionName: "issueCertificate",
				args: [preview.certificateId, preview.claimsHash, preview.recipientCommitment],
			});

			setTx({ kind: "waiting", hash });

			await publicClient.waitForTransactionReceipt({ hash });

			setTx({ kind: "success", hash, credential: preview.credential });
		} catch (e) {
			console.error("Issue failed:", e);
			const revert = extractRevertName(e);
			const message =
				revert === "UnauthorizedIssuer"
					? `This account (${issuerAddress}) is not an authorized issuer on this Univerify contract. Register it via the admin account or the CLI before issuing.`
					: revert === "CertificateAlreadyExists"
						? "A certificate with this ID already exists. Change the Internal Reference to issue a new one."
						: revert
							? `Contract reverted: ${revert}.`
							: `Transaction failed: ${e instanceof Error ? e.message : String(e)}`;
			setTx({ kind: "error", message });
		}
	}

	function regenerateSecret() {
		setSecret(randomBytes32());
		if (tx.kind === "success" || tx.kind === "error") setTx({ kind: "idle" });
	}

	function copyCredentialJson(credential: VerifiableCredential) {
		const json = JSON.stringify(credential, null, 2);
		navigator.clipboard?.writeText(json).catch(() => {});
	}

	function downloadCredentialJson(credential: VerifiableCredential) {
		const json = JSON.stringify(credential, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const filename = `credential-${credential.certificateId.slice(2, 14)}.json`;
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title text-polka-500">Issue Credential</h1>
				<p className="text-text-secondary">
					Sign and register a new verifiable academic credential on the Univerify
					contract. The resulting credential JSON is the artefact you give to the
					holder — they present it to verifiers, who recompute the hash and check the
					on-chain record.
				</p>
			</div>

			{/* Contract & signer */}
			<div className="card space-y-4">
				<div>
					<label className="label">Univerify Contract Address</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={contractAddress}
							onChange={(e) => saveAddress(e.target.value)}
							placeholder="0x..."
							className="input-field w-full"
						/>
						{defaultAddress && contractAddress !== defaultAddress && (
							<button
								onClick={() => saveAddress(defaultAddress)}
								className="btn-secondary text-xs whitespace-nowrap"
							>
								Reset
							</button>
						)}
					</div>
					{!defaultAddress && (
						<p className="text-xs text-text-muted mt-2">
							<code>deployments.univerify</code> is not set. Run{" "}
							<code>cd contracts/evm &amp;&amp; npm run deploy:univerify:local</code>{" "}
							or paste the address manually.
						</p>
					)}
				</div>

				<div>
					<label className="label">Issuer (Dev Account)</label>
					<select
						value={selectedAccount}
						onChange={(e) => setSelectedAccount(parseInt(e.target.value))}
						className="input-field w-full"
					>
						{evmDevAccounts.map((acc, i) => (
							<option key={i} value={i}>
								{acc.name} ({acc.account.address})
							</option>
						))}
					</select>
					<p className="text-xs text-text-muted mt-2">
						The selected account signs the <code>issueCertificate</code> transaction.
						It must already be an authorized issuer (the deploy script registers the
						deployer — usually Alice — by default).
					</p>
				</div>
			</div>

			{/* Claims */}
			<div className="card space-y-4">
				<h2 className="section-title">Credential Claims</h2>
				<p className="text-text-secondary text-sm">
					These fields are hashed deterministically into <code>claimsHash</code>. Any
					change — even a single character — produces a different hash and invalidates
					the credential at verification time.
				</p>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<ClaimInput
						label="Degree Title"
						value={claims.degreeTitle}
						placeholder="Bachelor of Computer Science"
						onChange={(v) => setClaims((c) => ({ ...c, degreeTitle: v }))}
					/>
					<ClaimInput
						label="Holder Name"
						value={claims.holderName}
						placeholder="Ada Lovelace"
						onChange={(v) => setClaims((c) => ({ ...c, holderName: v }))}
					/>
					<ClaimInput
						label="Institution Name"
						value={claims.institutionName}
						placeholder="Universidad de Buenos Aires"
						onChange={(v) => setClaims((c) => ({ ...c, institutionName: v }))}
					/>
					<ClaimInput
						label="Issuance Date (ISO)"
						value={claims.issuanceDate}
						placeholder="2026-03-15"
						onChange={(v) => setClaims((c) => ({ ...c, issuanceDate: v }))}
					/>
				</div>
			</div>

			{/* Issuance metadata */}
			<div className="card space-y-4">
				<h2 className="section-title">Issuance Metadata</h2>
				<p className="text-text-secondary text-sm">
					These values make the certificate unique and privacy-preserving but are not
					part of the claims hash.
				</p>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label className="label">
							Internal Reference
							<span className="text-text-muted ml-1">(unique per issuer)</span>
						</label>
						<input
							type="text"
							value={internalRef}
							onChange={(e) => setInternalRef(e.target.value)}
							placeholder="DIPLOMA-0001"
							className="input-field w-full"
						/>
						<p className="text-xs text-text-muted mt-1">
							Feeds <code>certificateId = keccak256(issuer, internalRef)</code>.
						</p>
					</div>

					<div>
						<label className="label">
							Holder Identifier
							<span className="text-text-muted ml-1">(never stored on-chain)</span>
						</label>
						<input
							type="text"
							value={holderIdentifier}
							onChange={(e) => setHolderIdentifier(e.target.value)}
							placeholder="ada@uba.ar"
							className="input-field w-full"
						/>
						<p className="text-xs text-text-muted mt-1">
							Used only to derive <code>recipientCommitment</code>.
						</p>
					</div>

					<div className="md:col-span-2">
						<label className="label">Secret (bytes32)</label>
						<div className="flex gap-2">
							<input
								type="text"
								value={secret}
								onChange={(e) => setSecret(e.target.value as Hex)}
								className="input-field w-full"
								spellCheck={false}
							/>
							<button
								onClick={regenerateSecret}
								className="btn-secondary text-xs whitespace-nowrap"
							>
								Regenerate
							</button>
						</div>
						<p className="text-xs text-text-muted mt-1">
							Shared secret between issuer and holder. Anyone who knows it plus the{" "}
							<code>holderIdentifier</code> can prove ownership of the certificate.
						</p>
					</div>
				</div>
			</div>

			{/* Live preview */}
			<div className="card space-y-4">
				<h2 className="section-title">Computed Values</h2>
				{preview ? (
					<div className="space-y-3">
						<HashField label="Certificate ID" value={preview.certificateId} />
						<HashField label="Claims Hash" value={preview.claimsHash} />
						<HashField
							label="Recipient Commitment"
							value={preview.recipientCommitment}
						/>
					</div>
				) : (
					<p className="text-sm text-text-muted">
						Fill in all claim and issuance fields to see the computed hashes.
					</p>
				)}

				<div className="flex flex-wrap items-center gap-3 pt-2">
					<button
						onClick={handleIssue}
						disabled={!canSubmit}
						className="btn-primary"
					>
						{tx.kind === "sending"
							? "Signing..."
							: tx.kind === "waiting"
								? "Waiting for receipt..."
								: "Issue Certificate"}
					</button>
					{tx.kind === "error" && (
						<p className="text-sm font-medium text-accent-red">{tx.message}</p>
					)}
					{tx.kind === "waiting" && (
						<p className="text-sm text-text-tertiary font-mono break-all">
							tx: {tx.hash}
						</p>
					)}
				</div>
			</div>

			{/* Success panel */}
			{tx.kind === "success" && (
				<div className="card space-y-4 animate-fade-in">
					<div>
						<span className="status-badge border bg-accent-green/10 text-accent-green border-accent-green/30">
							✓ Issued
						</span>
						<h2 className="section-title mt-2 text-accent-green">
							Certificate issued
						</h2>
						<p className="text-sm text-text-secondary mt-1">
							Give the JSON below to the holder. They (or any verifier) can paste it
							into the Verify tab to check it against the on-chain record.
						</p>
						<p className="text-xs text-text-tertiary font-mono break-all mt-2">
							tx: {tx.hash}
						</p>
					</div>

					<div>
						<div className="flex items-center justify-between mb-2">
							<label className="label mb-0">Credential JSON</label>
							<div className="flex gap-2">
								<button
									onClick={() => copyCredentialJson(tx.credential)}
									className="btn-secondary text-xs"
								>
									Copy
								</button>
								<button
									onClick={() => downloadCredentialJson(tx.credential)}
									className="btn-secondary text-xs"
								>
									Download .json
								</button>
							</div>
						</div>
						<pre className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 text-xs font-mono text-text-secondary whitespace-pre-wrap break-all overflow-x-auto">
							{JSON.stringify(tx.credential, null, 2)}
						</pre>
					</div>
				</div>
			)}
		</div>
	);
}

// ── Small presentational components ─────────────────────────────────

function ClaimInput({
	label,
	value,
	placeholder,
	onChange,
}: {
	label: string;
	value: string;
	placeholder: string;
	onChange: (v: string) => void;
}) {
	return (
		<div>
			<label className="label">{label}</label>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="input-field w-full"
			/>
		</div>
	);
}

function HashField({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-1">
				{label}
			</p>
			<code className="block text-text-primary font-mono text-xs break-all">{value}</code>
		</div>
	);
}
