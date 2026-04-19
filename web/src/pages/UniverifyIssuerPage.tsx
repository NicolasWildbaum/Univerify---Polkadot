// Univerify issuer (Issue / Revoke) UI.
//
// Identity is the connected Polkadot wallet. The contract only accepts
// issuance and revocation from an Active issuer, and we mirror that here:
// we read `getIssuer(callerEvmAddress)` on every relevant change and only
// unlock actions when the live on-chain status is Active.

import { useEffect, useMemo, useState } from "react";
import { type Address, type Hex, type Abi, isAddress } from "viem";
import { univerifyAbi } from "../config/univerify";
import { getPublicClient } from "../config/evm";
import { deployments } from "../config/deployments";
import { useChainStore } from "../store/chainStore";
import {
	useWalletStore,
	selectConnectedEvmAddress,
	selectConnectedSigner,
	ss58ToEvmAddress,
} from "../account/wallet";
import { getSs58AddressInfo } from "@polkadot-api/substrate-bindings";
import { submitReviveCall } from "../account/reviveCall";
import {
	buildCredential,
	deriveCertificateId,
	type CredentialClaims,
	type VerifiableCredential,
} from "../utils/credential";
import { extractRevertName } from "../utils/contractErrors";

const STORAGE_KEY_PREFIX = "univerify:address";

type TxState =
	| { kind: "idle" }
	| { kind: "sending" }
	| {
			kind: "success";
			hash: Hex;
			credential: VerifiableCredential;
			studentAddress: Address;
	  }
	| { kind: "error"; message: string };

type RevokeTxState =
	| { kind: "idle" }
	| { kind: "sending" }
	| { kind: "success"; hash: Hex; certificateId: Hex; internalRef: string }
	| { kind: "error"; message: string };

// `unknown` covers the loading state and unreachable contracts. Anything other
// than `active` blocks issuance/revocation in the UI just like the contract.
type AuthStatus =
	| "unknown"
	| "no-wallet"
	| "no-contract"
	| "active"
	| "pending"
	| "suspended"
	| "not-registered";

// ── Helpers ─────────────────────────────────────────────────────────

function randomBytes32(): Hex {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as Hex;
}

/// Friendlier message when an error reaches us as the opaque
/// `Revive.ContractReverted` dispatch error — typically because the on-chain
/// contract is older than the one this UI was built against (e.g. it lacks
/// the new `setCertificateNft` wiring), or because the eth-rpc proxy is
/// unreachable and the pre-flight `simulateContract` couldn't decode the
/// revert payload before submission.
function contractRevertedFallback(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	if (raw.includes("Revive.ContractReverted") || raw.includes("ContractReverted")) {
		return (
			"The contract reverted, but the dispatch error didn't carry a reason. " +
			"Most common causes:\n" +
			"  • The deployed Univerify contract is the old version (no NFT wiring). " +
			"Re-run `cd contracts/evm && npx hardhat run scripts/deploy-univerify.ts --network <net>` and refresh.\n" +
			"  • A certificate with this Internal Reference already exists for your issuer.\n" +
			"  • The CertificateNft contract isn't wired (`setCertificateNft` was never called).\n\n" +
			`Raw error: ${raw}`
		);
	}
	return `Transaction failed: ${raw}`;
}

// ── Component ───────────────────────────────────────────────────────

export default function UniverifyIssuerPage() {
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const wsUrl = useChainStore((s) => s.wsUrl);
	const walletStatus = useWalletStore((s) => s.status);
	const issuerAddress = useWalletStore(selectConnectedEvmAddress);
	const signer = useWalletStore(selectConnectedSigner);
	const isWalletConnected = walletStatus.kind === "connected";

	const scopedStorageKey = `${STORAGE_KEY_PREFIX}:${ethRpcUrl}`;

	const defaultAddress = deployments.univerify ?? "";
	const [contractAddress, setContractAddress] = useState(
		() => localStorage.getItem(scopedStorageKey) || defaultAddress,
	);

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
	// Student wallet that receives the soulbound NFT. The contract requires
	// a non-zero address; we validate the EIP-55 / hex shape with viem.
	const [studentAddress, setStudentAddress] = useState("");

	const [tx, setTx] = useState<TxState>({ kind: "idle" });

	// Revoke state
	const [revokeInternalRef, setRevokeInternalRef] = useState("");
	const [revokeTx, setRevokeTx] = useState<RevokeTxState>({ kind: "idle" });

	// Two layers: synchronous pre-checks (wallet, contract address) and the
	// async on-chain issuer lookup. The sync case is derived at render time so
	// it never triggers cascading renders; the async case lives in state.
	const [onChainStatus, setOnChainStatus] = useState<AuthStatus>("unknown");
	const authStatus: AuthStatus = !isWalletConnected || !issuerAddress
		? "no-wallet"
		: !contractAddress
			? "no-contract"
			: onChainStatus;

	function saveAddress(address: string) {
		setContractAddress(address);
		if (address) localStorage.setItem(scopedStorageKey, address);
		else localStorage.removeItem(scopedStorageKey);
	}

	// ── Live preview ─────────────────────────────────────────────────
	const derivedRevokeCertificateId = useMemo<Hex | null>(() => {
		const ref = revokeInternalRef.trim();
		if (!ref || !issuerAddress) return null;
		return deriveCertificateId(issuerAddress, ref);
	}, [issuerAddress, revokeInternalRef]);

	// ── Issuer authorization check ───────────────────────────────────
	// Purely on-chain: reads `getIssuer(connectedWalletAddress).status`. The
	// contract is the single source of truth; we just surface its answer.
	useEffect(() => {
		if (!isWalletConnected || !issuerAddress || !contractAddress) {
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const client = getPublicClient(ethRpcUrl);
				const addr = contractAddress as Address;
				const code = await client.getCode({ address: addr });
				if (cancelled) return;
				if (!code || code === "0x") {
					setOnChainStatus("unknown");
					return;
				}
				const issuer = (await client.readContract({
					address: addr,
					abi: univerifyAbi,
					functionName: "getIssuer",
					args: [issuerAddress],
				})) as { status: number };
				if (cancelled) return;
				switch (Number(issuer.status)) {
					case 2:
						setOnChainStatus("active");
						break;
					case 1:
						setOnChainStatus("pending");
						break;
					case 3:
						setOnChainStatus("suspended");
						break;
					default:
						setOnChainStatus("not-registered");
				}
			} catch {
				if (cancelled) return;
				setOnChainStatus("unknown");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isWalletConnected, contractAddress, issuerAddress, ethRpcUrl]);

	const isAuthorized = authStatus === "active";

	const trimmedStudent = studentAddress.trim();
	// The contract takes an H160 (EVM, 20 bytes), but issuers commonly only
	// know the student's SS58 address (the one Polkadot.js / Talisman /
	// SubWallet show by default). We accept either:
	//   - 0x-prefixed 40-char hex → used as-is (any casing, no checksum check)
	//   - SS58 → converted via the same `pallet_revive::AccountId32Mapper`
	//     logic the rest of the app uses (`ss58ToEvmAddress`), so the H160
	//     we mint to matches what the student will see when they connect.
	const resolvedStudent: Address | null = (() => {
		if (!trimmedStudent) return null;
		if (trimmedStudent.startsWith("0x")) {
			return isAddress(trimmedStudent, { strict: false }) ? trimmedStudent : null;
		}
		const info = getSs58AddressInfo(trimmedStudent);
		if (!info.isValid) return null;
		return ss58ToEvmAddress(trimmedStudent);
	})();
	const studentAddressValid = resolvedStudent !== null;
	const studentInputLooksLikeSs58 =
		trimmedStudent.length > 0 && !trimmedStudent.startsWith("0x");

	const preview = useMemo(() => {
		if (!issuerAddress) return null;
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

	const busy = tx.kind === "sending" || revokeTx.kind === "sending";
	const canSubmit =
		isAuthorized &&
		contractAddress.length > 0 &&
		preview !== null &&
		studentAddressValid &&
		!busy;

	async function handleIssue() {
		if (!preview) return;
		if (!isAuthorized || !signer) {
			setTx({
				kind: "error",
				message: "Your connected account is not an Active issuer on this contract.",
			});
			return;
		}
		if (!studentAddressValid || !resolvedStudent) {
			setTx({
				kind: "error",
				message:
					"Enter a valid student wallet address. Either an EVM/H160 (0x… 20 bytes) or a Polkadot SS58 address (e.g. 5F…).",
			});
			return;
		}
		const student = resolvedStudent;
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

			// Pre-flight `eth_call`. pallet-revive's `Revive.ContractReverted`
			// dispatch error doesn't carry the contract's revert payload, so
			// without this simulation the user only ever sees the opaque
			// dispatch error. viem decodes the revert against the ABI here
			// and the catch branch surfaces the actual custom-error name.
			try {
				await publicClient.simulateContract({
					account: issuerAddress as Address,
					address: addr,
					abi: univerifyAbi as unknown as Abi,
					functionName: "issueCertificate",
					args: [
						preview.certificateId,
						preview.claimsHash,
						preview.recipientCommitment,
						student,
					],
				});
			} catch (simErr) {
				console.warn("[Univerify] issueCertificate pre-flight reverted", {
					issuerAddress,
					student,
					certificateId: preview.certificateId,
					error: simErr,
				});
				throw simErr;
			}

			const result = await submitReviveCall({
				wsUrl,
				signer,
				signerEvmAddress: issuerAddress as Address,
				contractAddress: addr,
				abi: univerifyAbi as unknown as Abi,
				functionName: "issueCertificate",
				args: [
					preview.certificateId,
					preview.claimsHash,
					preview.recipientCommitment,
					student,
				],
			});

			setTx({
				kind: "success",
				hash: result.txHash,
				credential: preview.credential,
				studentAddress: student,
			});
		} catch (e) {
			console.error("Issue failed:", e);
			const revert = extractRevertName(e);
			const message =
				revert === "NotActiveIssuer"
					? `This account (${issuerAddress}) is not an Active issuer on this Univerify contract. Apply via the Governance page and wait for enough approvals before issuing.`
					: revert === "CertificateAlreadyExists"
						? "A certificate with this ID already exists. Change the Internal Reference to issue a new one."
						: revert === "InvalidStudentAddress"
							? "The student wallet address is invalid (zero address)."
							: revert === "NftNotConfigured"
								? "This Univerify contract has no CertificateNft wired up. Re-run the deploy script so the NFT contract is set."
								: revert === "AlreadyMinted"
									? "An NFT for this certificate id has already been minted."
									: revert
										? `Contract reverted: ${revert}.`
										: contractRevertedFallback(e);
			setTx({ kind: "error", message });
		}
	}

	async function handleRevoke() {
		if (!isAuthorized || !signer || !issuerAddress) {
			setRevokeTx({
				kind: "error",
				message: "Your connected account is not an Active issuer on this contract.",
			});
			return;
		}
		const ref = revokeInternalRef.trim();
		if (!ref) {
			setRevokeTx({
				kind: "error",
				message: "Enter the internal reference of the certificate to revoke.",
			});
			return;
		}
		const certificateId = deriveCertificateId(issuerAddress, ref);

		setRevokeTx({ kind: "sending" });

		try {
			const publicClient = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Address;
			const code = await publicClient.getCode({ address: addr });
			if (!code || code === "0x") {
				setRevokeTx({
					kind: "error",
					message: `No Univerify contract found at this address on ${ethRpcUrl}.`,
				});
				return;
			}

			// Pre-flight `eth_call` so the catch branch can decode the
			// custom-error name (see the issuance handler for the full why).
			await publicClient.simulateContract({
				account: issuerAddress as Address,
				address: addr,
				abi: univerifyAbi as unknown as Abi,
				functionName: "revokeCertificate",
				args: [certificateId],
			});

			const result = await submitReviveCall({
				wsUrl,
				signer,
				signerEvmAddress: issuerAddress as Address,
				contractAddress: addr,
				abi: univerifyAbi as unknown as Abi,
				functionName: "revokeCertificate",
				args: [certificateId],
			});

			setRevokeTx({
				kind: "success",
				hash: result.txHash,
				certificateId,
				internalRef: ref,
			});
		} catch (e) {
			console.error("Revoke failed:", e);
			const revert = extractRevertName(e);
			const message =
				revert === "NotActiveIssuer"
					? `This account (${issuerAddress}) is not an Active issuer on this Univerify contract.`
					: revert === "CertificateNotFound"
						? `No certificate exists for internal reference "${ref}" issued by ${issuerAddress}. Double-check the spelling and that you are using the same issuer that emitted it.`
						: revert === "NotCertificateIssuer"
							? "This certificate was issued by a different account. Switch wallets to the original issuer."
							: revert === "CertificateAlreadyRevoked"
								? "This certificate has already been revoked."
								: revert === "InvalidCertificateId"
									? "Invalid certificate id (zero)."
									: revert
										? `Contract reverted: ${revert}.`
										: contractRevertedFallback(e);
			setRevokeTx({ kind: "error", message });
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
					contract. The resulting credential JSON is the artefact you give to the holder —
					they present it to verifiers, who recompute the hash and check the on-chain
					record.
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

				<IssuerPanel
					status={authStatus}
					issuerAddress={issuerAddress}
					isWalletConnected={isWalletConnected}
				/>
			</div>

			{/* Gated content */}
			{!isAuthorized ? (
				<BlockedState status={authStatus} />
			) : (
				<>
					{/* Claims */}
					<div className="card space-y-4">
						<h2 className="section-title">Credential Claims</h2>
						<p className="text-text-secondary text-sm">
							These fields are hashed deterministically into{" "}
							<code>claimsHash</code>. Any change — even a single character —
							produces a different hash and invalidates the credential at
							verification time.
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
							These values make the certificate unique and privacy-preserving but are
							not part of the claims hash.
						</p>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div>
								<label className="label">
									Internal Reference
									<span className="text-text-muted ml-1">
										(unique per issuer)
									</span>
								</label>
								<input
									type="text"
									value={internalRef}
									onChange={(e) => setInternalRef(e.target.value)}
									placeholder="DIPLOMA-0001"
									className="input-field w-full"
								/>
								<p className="text-xs text-text-muted mt-1">
									Feeds{" "}
									<code>certificateId = keccak256(issuer, internalRef)</code>.
								</p>
							</div>

							<div>
								<label className="label">
									Holder Identifier
									<span className="text-text-muted ml-1">
										(never stored on-chain)
									</span>
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
								<label className="label">
									Student Wallet Address
									<span className="text-text-muted ml-1">
										(receives the soulbound NFT)
									</span>
								</label>
								<input
									type="text"
									value={studentAddress}
									onChange={(e) => setStudentAddress(e.target.value)}
									placeholder="0x… (EVM) or 5F… (Polkadot SS58)"
									className="input-field w-full"
									spellCheck={false}
								/>
								<p className="text-xs text-text-muted mt-1">
									Accepts an EVM/H160 address or a Polkadot SS58 address — we
									convert SS58 to its mapped H160 the same way{" "}
									<code>pallet-revive</code> does. Issued in the same
									transaction; soulbound, so the student wallet keeps the NFT
									and cannot transfer it.
								</p>
								{trimmedStudent && !studentAddressValid ? (
									<p className="text-xs text-accent-red mt-1">
										Not a valid address. Use either a 0x-prefixed 20-byte hex
										string (40 hex chars) or a Polkadot SS58 address.
									</p>
								) : null}
								{studentAddressValid &&
								studentInputLooksLikeSs58 &&
								resolvedStudent ? (
									<p className="text-xs text-text-muted mt-1">
										Will mint to H160:{" "}
										<code className="font-mono text-text-primary break-all">
											{resolvedStudent}
										</code>
									</p>
								) : null}
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
									Shared secret between issuer and holder. Anyone who knows it
									plus the <code>holderIdentifier</code> can prove ownership of
									the certificate.
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
								{tx.kind === "sending" ? "Signing..." : "Issue Certificate"}
							</button>
							{tx.kind === "error" && (
								<p className="text-sm font-medium text-accent-red">{tx.message}</p>
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
									The soulbound NFT has been minted to{" "}
									<code className="font-mono text-xs">{tx.studentAddress}</code>
									. Give the JSON below to the holder, or share the public
									verification link so anyone can check the certificate
									on-chain.
								</p>
								<p className="text-xs text-text-tertiary font-mono break-all mt-2">
									tx: {tx.hash}
								</p>
							</div>

							<VerifyLinkRow certificateId={tx.credential.certificateId} />

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

					{/* Revoke card */}
					<div className="card space-y-4">
						<h2 className="section-title text-accent-orange">Revoke Certificate</h2>
						<p className="text-text-secondary text-sm">
							Enter the <code>Internal Reference</code> you used when issuing (e.g.{" "}
							<code>DIPLOMA-0001</code>). The <code>certificateId</code> is
							re-derived from the connected wallet's EVM address, so you do not need
							to remember the 32-byte id. Only the account that originally issued the
							certificate can revoke it.
						</p>

						<div>
							<label className="label">Internal Reference</label>
							<input
								type="text"
								value={revokeInternalRef}
								onChange={(e) => {
									setRevokeInternalRef(e.target.value);
									if (
										revokeTx.kind === "success" ||
										revokeTx.kind === "error"
									) {
										setRevokeTx({ kind: "idle" });
									}
								}}
								placeholder="DIPLOMA-0001"
								className="input-field w-full"
							/>
							{derivedRevokeCertificateId && (
								<p className="text-xs text-text-muted mt-2 break-all">
									Derived Certificate ID:{" "}
									<code className="text-text-secondary font-mono">
										{derivedRevokeCertificateId}
									</code>
								</p>
							)}
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button
								onClick={handleRevoke}
								disabled={
									!isAuthorized ||
									!revokeInternalRef.trim() ||
									revokeTx.kind === "sending"
								}
								className="btn-accent"
								style={{
									background:
										"linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
									boxShadow:
										"0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)",
								}}
							>
								{revokeTx.kind === "sending" ? "Signing..." : "Revoke"}
							</button>
							{revokeTx.kind === "error" && (
								<p className="text-sm font-medium text-accent-red">
									{revokeTx.message}
								</p>
							)}
						</div>

						{revokeTx.kind === "success" && (
							<div className="rounded-lg border border-accent-orange/30 bg-accent-orange/10 p-4 space-y-2 animate-fade-in">
								<span className="status-badge border bg-accent-orange/10 text-accent-orange border-accent-orange/30">
									✓ Revoked
								</span>
								<p className="text-sm text-text-primary">
									Certificate <code>{revokeTx.internalRef}</code> has been revoked
									on-chain. Verifications will now show it as revoked.
								</p>
								<p className="text-xs text-text-tertiary font-mono break-all">
									certificateId: {revokeTx.certificateId}
								</p>
								<p className="text-xs text-text-tertiary font-mono break-all">
									tx: {revokeTx.hash}
								</p>
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}

// ── Issuer status readout ───────────────────────────────────────────

function IssuerPanel({
	status,
	issuerAddress,
	isWalletConnected,
}: {
	status: AuthStatus;
	issuerAddress: Address | null;
	isWalletConnected: boolean;
}) {
	return (
		<div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="min-w-0">
					<p className="text-xs text-text-tertiary uppercase tracking-wider">
						Issuer (connected wallet)
					</p>
					{isWalletConnected && issuerAddress ? (
						<code className="text-xs font-mono text-text-primary break-all">
							{issuerAddress}
						</code>
					) : (
						<p className="text-sm text-text-muted">
							Connect a wallet in the header to act as an issuer.
						</p>
					)}
				</div>
				<AuthorizationBadge status={status} />
			</div>
			<p className="text-xs text-text-muted">
				Issuance authorization is read from the Univerify contract on every change. You
				must be an <strong>Active</strong> issuer — apply and get approved on the Governance
				page first.
			</p>
		</div>
	);
}

function BlockedState({ status }: { status: AuthStatus }) {
	const msg: Record<AuthStatus, { title: string; body: string; tone: "muted" | "red" | "orange" }> = {
		"no-wallet": {
			title: "Wallet not connected",
			body: "Connect a Polkadot-compatible wallet via the button in the top-right to issue or revoke credentials.",
			tone: "muted",
		},
		"no-contract": {
			title: "Contract not found",
			body: "Enter a valid Univerify contract address above. Until then issuance is disabled.",
			tone: "muted",
		},
		unknown: {
			title: "Checking authorization…",
			body: "Reading your issuer status from the Univerify contract.",
			tone: "muted",
		},
		"not-registered": {
			title: "Not authorized to issue",
			body: "Your wallet is not registered on this Univerify contract. Apply on the Governance page and wait for enough approvals from active universities.",
			tone: "red",
		},
		pending: {
			title: "Application pending",
			body: "Your wallet has applied but does not yet have enough approvals to become Active. Ask existing universities to approve you on the Governance page.",
			tone: "orange",
		},
		suspended: {
			title: "Issuer suspended",
			body: "Your wallet is a Suspended issuer on this contract. Issuance and revocation will revert until the owner unsuspends you.",
			tone: "red",
		},
		active: { title: "", body: "", tone: "muted" },
	};
	const m = msg[status];
	const classes =
		m.tone === "red"
			? "border-accent-red/30 bg-accent-red/5"
			: m.tone === "orange"
				? "border-accent-orange/30 bg-accent-orange/5"
				: "border-white/[0.08] bg-white/[0.02]";
	return (
		<div className={`card border ${classes}`}>
			<h2 className="section-title">{m.title}</h2>
			<p className="text-sm text-text-secondary mt-1">{m.body}</p>
		</div>
	);
}

function AuthorizationBadge({ status }: { status: AuthStatus }) {
	switch (status) {
		case "active":
			return (
				<span className="status-badge border bg-accent-green/10 text-accent-green border-accent-green/30">
					✓ Active issuer
				</span>
			);
		case "pending":
			return (
				<span className="status-badge border bg-accent-orange/10 text-accent-orange border-accent-orange/30">
					⏳ Pending — needs more approvals before issuing
				</span>
			);
		case "suspended":
			return (
				<span className="status-badge border bg-accent-red/10 text-accent-red border-accent-red/30">
					✗ Suspended — issuance and revocation will revert
				</span>
			);
		case "not-registered":
			return (
				<span className="status-badge border bg-accent-red/10 text-accent-red border-accent-red/30">
					✗ Not registered — apply on the Governance page
				</span>
			);
		case "no-wallet":
			return (
				<span className="status-badge border bg-white/[0.04] text-text-muted border-white/[0.08]">
					Wallet not connected
				</span>
			);
		case "no-contract":
			return (
				<span className="status-badge border bg-white/[0.04] text-text-muted border-white/[0.08]">
					No contract configured
				</span>
			);
		case "unknown":
		default:
			return (
				<span className="status-badge border bg-white/[0.04] text-text-muted border-white/[0.08]">
					· Checking…
				</span>
			);
	}
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

function VerifyLinkRow({ certificateId }: { certificateId: Hex }) {
	const url = `${window.location.origin}/#/verify/cert/${certificateId}`;
	return (
		<div>
			<label className="label mb-2">Public verification link</label>
			<div className="flex flex-wrap items-center gap-2">
				<a
					href={`#/verify/cert/${certificateId}`}
					target="_blank"
					rel="noreferrer"
					className="text-xs font-mono break-all text-accent-blue hover:underline"
				>
					{url}
				</a>
				<button
					onClick={() => navigator.clipboard?.writeText(url).catch(() => {})}
					className="btn-secondary text-xs"
				>
					Copy link
				</button>
			</div>
			<p className="text-xs text-text-muted mt-2">
				Anyone with the link can verify the certificate's existence, issuer, and
				revocation status on-chain — no wallet required.
			</p>
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
