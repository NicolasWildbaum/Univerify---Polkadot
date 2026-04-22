// Univerify federated-governance UI.
//
// Architecture notes:
//   - The connected Polkadot wallet (see `account/wallet.ts`) is the sole
//     source of identity. The registry has no privileged owner.
//   - Contract reads use viem; writes are Substrate extrinsics routed through
//     `pallet_revive::call` via `submitReviveCall`, so the injected wallet's
//     signer can drive them.
//   - Permission gating ("active issuer?") comes exclusively from on-chain
//     reads (`getIssuer`); no frontend-only heuristics.
//
// Governance surface rendered by this page:
//   - Apply to join the federation (public, opens a pending waitlist entry)
//   - Approve a pending applicant (active issuers only)
//   - Propose to remove an active issuer (active issuers only, not self)
//   - Vote on an open removal proposal (active issuers only, not the target)
//
// All "admin / emergency" flows from the old owner-based model are gone on
// purpose — removal is driven purely by active-issuer votes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address, type Hex, isAddress } from "viem";
import { getSs58AddressInfo } from "@polkadot-api/substrate-bindings";
import { univerifyAbi, IssuerStatus, issuerStatusLabel } from "../config/univerify";
import { deployments } from "../config/deployments";
import { getInitialUniverifyAddress } from "../config/univerifyContractStorage";
import { getPublicClient } from "../config/evm";
import { useChainStore } from "../store/chainStore";
import {
	useWalletStore,
	selectConnectedEvmAddress,
	selectConnectedSigner,
	ss58ToEvmAddress,
} from "../account/wallet";
import { submitReviveCall } from "../account/reviveCall";
import { extractRevertName, type UniverifyErrorName } from "../utils/contractErrors";
import {
	serializeMetadata,
	computeMetadataHash,
	hasOptionalMetadata,
	type IssuerMetadata,
} from "../utils/issuerMetadata";
import { uploadToBulletin } from "../hooks/useBulletin";
import { blake2b } from "blakejs";
import { hexHashToCid } from "../utils/cid";

const STORAGE_KEY_PREFIX = "univerify:governance:address";
const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// ── On-chain projection ─────────────────────────────────────────────

interface IssuerView {
	account: Address;
	status: number;
	metadataHash: Hex;
	bulletinRef: string;
	name: string;
	registeredAt: bigint;
	approvalCount: number;
}

interface RemovalProposalView {
	proposalId: bigint;
	target: Address;
	proposer: Address;
	createdAt: bigint;
	voteCount: number;
	executed: boolean;
	/** Addresses (lowercased) that have voted on this proposal. */
	voters: Set<string>;
}

interface RegistryView {
	approvalThreshold: number;
	activeIssuerCount: number;
	governanceVotingPeriod: bigint;
	maxNameLength: bigint;
	issuers: IssuerView[];
	/** Map of `${candidate.toLowerCase()}` → set of approver addresses (lowercased). */
	approvals: Map<string, Set<string>>;
	/** Open removal proposals (not yet executed), keyed by proposalId. */
	openProposals: RemovalProposalView[];
}

type LoadState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; data: RegistryView }
	| { kind: "error"; message: string };

type TxState =
	| { kind: "idle" }
	| { kind: "sending"; label: string }
	| { kind: "submitted"; hash: Hex; label: string }
	| { kind: "success"; hash: Hex; label: string }
	| { kind: "error"; message: string };

// ── Component ───────────────────────────────────────────────────────

export default function GovernancePage() {
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const wsUrl = useChainStore((s) => s.wsUrl);
	const walletStatus = useWalletStore((s) => s.status);
	const callerAddress = useWalletStore(selectConnectedEvmAddress);
	const signer = useWalletStore(selectConnectedSigner);
	const isWalletConnected = walletStatus.kind === "connected";

	const scopedStorageKey = `${STORAGE_KEY_PREFIX}:${ethRpcUrl}`;

	const defaultAddress = deployments.univerify ?? "";
	const [contractAddress, setContractAddress] = useState(() =>
		getInitialUniverifyAddress(scopedStorageKey, defaultAddress),
	);

	const [load, setLoad] = useState<LoadState>({ kind: "idle" });
	const [tx, setTx] = useState<TxState>({ kind: "idle" });
	const [reloadToken, setReloadToken] = useState(0);

	// Apply form
	const [applyName, setApplyName] = useState("");
	const [applyMeta, setApplyMeta] = useState<Omit<IssuerMetadata, "schemaVersion" | "name">>({});
	// Tracks the Bulletin Chain upload step separately from the contract tx.
	type BulletinState =
		| { kind: "idle" }
		| { kind: "uploading" }
		| { kind: "done"; blockNumber: number }
		| { kind: "skipped" }
		| { kind: "error"; message: string };
	const [bulletinState, setBulletinState] = useState<BulletinState>({ kind: "idle" });

	// Propose-removal form
	const [proposeTarget, setProposeTarget] = useState<string>("");

	function saveAddress(address: string) {
		setContractAddress(address);
		if (address) localStorage.setItem(scopedStorageKey, address);
		else localStorage.removeItem(scopedStorageKey);
	}

	// ── Contract read pipeline ───────────────────────────────────────
	useEffect(() => {
		if (!contractAddress) return;
		let cancelled = false;
		(async () => {
			setLoad({ kind: "loading" });
			try {
				const client = getPublicClient(ethRpcUrl);
				const data = await loadRegistry(client, contractAddress as Address);
				if (cancelled) return;
				setLoad({ kind: "ready", data });
			} catch (err) {
				if (cancelled) return;
				setLoad({
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [contractAddress, ethRpcUrl, reloadToken]);

	const effectiveLoad: LoadState = contractAddress ? load : { kind: "idle" };
	const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

	// ── Write helper ────────────────────────────────────────────────
	// Centralized so every governance action shares the same preflight checks
	// (contract present, wallet connected) and error/status plumbing.
	const runTx = useCallback(
		async (label: string, functionName: string, args: unknown[]) => {
			if (!contractAddress) {
				setTx({ kind: "error", message: "Enter a contract address first." });
				return;
			}
			if (!signer || !callerAddress) {
				setTx({
					kind: "error",
					message: "Connect a Polkadot wallet first to sign governance transactions.",
				});
				return;
			}
			setTx({ kind: "sending", label });
			try {
				const publicClient = getPublicClient(ethRpcUrl);
				const addr = contractAddress as Address;
				const code = await publicClient.getCode({ address: addr });
				if (isEmptyContractCode(code)) {
					setTx({
						kind: "error",
						message: `No Univerify contract found at ${addr} on ${ethRpcUrl}.`,
					});
					return;
				}

				// Pre-flight simulation via eth-rpc. viem's `simulateContract`
				// runs the call as a read against the connected node and, on
				// revert, returns a `ContractFunctionRevertedError` whose
				// `errorName` has already been decoded against our ABI — that
				// is the 4-byte custom-error name (e.g. `IssuerAlreadyExists`,
				// `CannotProposeSelfRemoval`) we otherwise lose on the
				// Substrate-side `Revive.ContractReverted` wrapping.
				//
				// Failing here means we skip the wallet prompt entirely and
				// show a precise, actionable error. Unlike `eth_estimateGas`
				// this path does not need any gas headroom from the user and
				// is idempotent — it is purely a read.
				try {
					await publicClient.simulateContract({
						address: addr,
						abi: univerifyAbi,
						functionName: functionName as "applyAsIssuer",
						args: args as never,
						account: callerAddress,
					});
				} catch (simErr) {
					console.error(`${label} simulation reverted:`, simErr);
					setTx({ kind: "error", message: friendlyError(label, simErr) });
					return;
				}

				const result = await submitReviveCall({
					wsUrl,
					signer,
					signerEvmAddress: callerAddress,
					contractAddress: addr,
					abi: univerifyAbi as unknown as import("viem").Abi,
					functionName,
					args,
					onBroadcast: (hash) => setTx({ kind: "submitted", hash, label }),
				});
				setTx({ kind: "success", hash: result.txHash, label });
				refresh();
			} catch (err) {
				console.error(`${label} failed:`, err);
				setTx({ kind: "error", message: friendlyError(label, err) });
			}
		},
		[contractAddress, ethRpcUrl, wsUrl, signer, callerAddress, refresh],
	);

	async function handleApply() {
		const name = applyName.trim();
		if (!name) {
			setTx({ kind: "error", message: "Enter a university name." });
			return;
		}

		const meta: IssuerMetadata = { schemaVersion: "1", name, ...applyMeta };
		const withOptional = hasOptionalMetadata(applyMeta);

		let metadataHash: Hex = ZERO_BYTES32;
		let bulletinRef = "";

		if (withOptional) {
			if (!signer) {
				setTx({ kind: "error", message: "Connect a wallet to upload metadata." });
				return;
			}
			const jsonBytes = serializeMetadata(meta);
			metadataHash = computeMetadataHash(jsonBytes);

			setBulletinState({ kind: "uploading" });
			try {
				const result = await uploadToBulletin(jsonBytes, signer);
				// Derive the IPFS CID from the blake2b-256 content hash so the
				// metadata can be fetched from paseo-ipfs.polkadot.io permanently,
				// without needing an archive node for chain_getBlock.
				const b2Hash = blake2b(jsonBytes, undefined, 32);
				const b2Hex = `0x${Array.from(b2Hash)
					.map((b) => b.toString(16).padStart(2, "0"))
					.join("")}`;
				bulletinRef = hexHashToCid(b2Hex);
				setBulletinState({ kind: "done", blockNumber: result.blockNumber });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				setBulletinState({ kind: "error", message: msg });
				setTx({ kind: "error", message: `Bulletin Chain upload failed: ${msg}` });
				return;
			}
		} else {
			setBulletinState({ kind: "skipped" });
		}

		await runTx("Apply", "applyAsIssuer", [name, metadataHash, bulletinRef]);
	}

	async function handleApprove(candidate: Address) {
		await runTx(`Approve ${shortAddr(candidate)}`, "approveIssuer", [candidate]);
	}

	async function handleProposeRemoval() {
		// The button is gated on `proposeRemovalValidation.kind === "valid"`,
		// but we re-check here so a rogue click (disabled bypass, stale memo,
		// …) still surfaces a readable error instead of an uncaught throw.
		// Whatever reason the memo flagged, show it verbatim — no wallet
		// round-trip needed.
		const v = proposeRemovalValidation;
		if (v.kind === "invalid") {
			setTx({ kind: "error", message: v.message });
			return;
		}
		if (v.kind === "empty") {
			setTx({
				kind: "error",
				message: "Enter a target address (EVM 0x... or SS58) to propose for removal.",
			});
			return;
		}
		const target = v.target;
		await runTx(`Propose removal of ${shortAddr(target)}`, "proposeRemoval", [target]);
	}

	async function handleVoteForRemoval(proposalId: bigint, target: Address) {
		await runTx(`Vote to remove ${shortAddr(target)}`, "voteForRemoval", [proposalId]);
	}

	// ── Derived view-model ───────────────────────────────────────────
	const data = effectiveLoad.kind === "ready" ? effectiveLoad.data : null;
	const callerKey = callerAddress?.toLowerCase() ?? null;

	const callerIssuer = useMemo(() => {
		if (!data || !callerKey) return null;
		return data.issuers.find((i) => i.account.toLowerCase() === callerKey) ?? null;
	}, [data, callerKey]);

	const callerIsActive = callerIssuer?.status === IssuerStatus.Active;
	// Pending or Active callers cannot (and need not) apply again. A `Removed`
	// caller *can* re-apply: the contract allows the Removed → Pending
	// transition, bumping an internal approval epoch so previous-round
	// approvals do not carry over. The UI surfaces that as an unlocked Apply
	// button with a short "you can re-apply" helper next to the status.
	const callerHasApplied =
		!!callerIssuer &&
		(callerIssuer.status === IssuerStatus.Pending ||
			callerIssuer.status === IssuerStatus.Active);
	const callerCanReapply = callerIssuer?.status === IssuerStatus.Removed;

	const activeIssuers = data?.issuers.filter((i) => i.status === IssuerStatus.Active) ?? [];
	const pendingIssuers = data?.issuers.filter((i) => i.status === IssuerStatus.Pending) ?? [];
	const removedIssuers = data?.issuers.filter((i) => i.status === IssuerStatus.Removed) ?? [];
	const openProposals = data?.openProposals ?? [];

	// Parse the propose-removal input (accepts SS58 or 0x) once per render.
	// We keep the resolved H160 and the raw validation result around so we
	// can (a) show a live preview of "this is the EVM address I'll submit",
	// (b) surface precise, actionable error messages before the user even
	// signs, and (c) gray out the button with an accurate tooltip/label.
	//
	// Doing this upfront is also our only path to a clear self-removal
	// error: pallet-revive delivers contract reverts as the opaque
	// `Revive.ContractReverted` dispatch error, which drops the 4-byte
	// selector. `CannotProposeSelfRemoval` would never reach us as a
	// decoded name, so we catch it client-side.
	const proposeRemovalValidation = useMemo<
		| { kind: "empty" }
		| { kind: "invalid"; message: string }
		| { kind: "valid"; target: Address }
	>(() => {
		const raw = proposeTarget.trim();
		if (!raw) return { kind: "empty" };
		const target = resolveAddress(raw);
		if (!target) {
			return {
				kind: "invalid",
				message:
					"Enter a valid address to propose for removal. Accepts an EVM address (0x...) or a Polkadot SS58 address.",
			};
		}
		if (callerKey && target.toLowerCase() === callerKey) {
			return {
				kind: "invalid",
				message:
					"You cannot propose your own removal. To exit the federation, ask other active issuers to propose removing you.",
			};
		}
		if (data) {
			const targetIssuer = data.issuers.find(
				(i) => i.account.toLowerCase() === target.toLowerCase(),
			);
			if (!targetIssuer) {
				return {
					kind: "invalid",
					message: "No issuer found at that address on this registry.",
				};
			}
			if (targetIssuer.status !== IssuerStatus.Active) {
				return {
					kind: "invalid",
					message: `That issuer is ${issuerStatusLabel(targetIssuer.status)}, not Active. Only Active issuers can be removed by governance.`,
				};
			}
			if (data.openProposals.some((p) => p.target.toLowerCase() === target.toLowerCase())) {
				return {
					kind: "invalid",
					message:
						"A removal proposal for this issuer is already open. Vote on the existing proposal below instead of creating a duplicate.",
				};
			}
		}
		return { kind: "valid", target };
	}, [proposeTarget, callerKey, data]);

	const proposeRemovalResolvedAddress =
		proposeRemovalValidation.kind === "valid" ? proposeRemovalValidation.target : null;
	const proposeRemovalInputLooksLikeSs58 =
		proposeTarget.trim().length > 0 && !proposeTarget.trim().startsWith("0x");

	const txDisabled = !isWalletConnected || tx.kind === "sending" || tx.kind === "submitted";

	// ── Render ───────────────────────────────────────────────────────
	return (
		<div className="section-stack">
			<div className="page-hero">
				<div className="space-y-3">
					<span className="page-kicker">Federation Control</span>
					<h1 className="page-title text-polka-500">Governance</h1>
					<p className="page-subtitle">
						Federated registry of university issuers. Active universities collectively
						approve new applicants and decide — by vote — whether to remove existing
						members. There is no privileged owner or emergency admin.
					</p>
				</div>
			</div>

			{/* Contract & caller */}
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

				<CallerPanel
					data={data}
					callerAddress={callerAddress}
					callerIssuer={callerIssuer}
					isWalletConnected={isWalletConnected}
				/>
			</div>

			{/* Registry overview */}
			<div className="card space-y-3">
				<div className="flex items-center justify-between">
					<h2 className="section-title">Registry</h2>
					<button onClick={refresh} className="btn-secondary text-xs">
						Refresh
					</button>
				</div>
				<RegistryHeader load={effectiveLoad} />
			</div>

			{/* Active issuers */}
			<div className="card space-y-3">
				<h2 className="section-title">Active universities</h2>
				{activeIssuers.length === 0 ? (
					<p className="text-sm text-text-muted">No active universities yet.</p>
				) : (
					<ul className="space-y-2">
						{activeIssuers.map((i) => (
							<IssuerRow key={i.account} issuer={i} />
						))}
					</ul>
				)}
			</div>

			{/* Waitlist */}
			<div className="card space-y-3">
				<h2 className="section-title text-accent-orange">Waitlist (Pending)</h2>
				{data && (
					<p className="text-xs text-text-muted">
						Applications expire automatically if they do not reach the approval
						threshold within {formatVotingWindow(data.governanceVotingPeriod)}.
					</p>
				)}
				{!data ? (
					<p className="text-sm text-text-muted">Connect to a contract to load.</p>
				) : pendingIssuers.length === 0 ? (
					<p className="text-sm text-text-muted">No pending applications.</p>
				) : (
					<ul className="space-y-3">
						{pendingIssuers.map((i) => {
							const approvers =
								data.approvals.get(i.account.toLowerCase()) ?? new Set();
							const callerAlreadyApproved =
								callerKey !== null && approvers.has(callerKey);
							const callerIsCandidate =
								callerKey !== null && i.account.toLowerCase() === callerKey;
							const disabled =
								txDisabled ||
								!callerIsActive ||
								callerAlreadyApproved ||
								callerIsCandidate;
							return (
								<li
									key={i.account}
									className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 space-y-2"
								>
									<IssuerRow issuer={i} compact />
									<div className="flex flex-wrap items-center gap-3">
										<span className="text-xs text-text-muted">
											{i.approvalCount} / {data.approvalThreshold} approvals
										</span>
										<span className="text-xs text-text-muted">
											Expires{" "}
											{formatDeadline(
												i.registeredAt,
												data.governanceVotingPeriod,
											)}
										</span>
										<button
											onClick={() => handleApprove(i.account)}
											disabled={disabled}
											className="btn-primary text-xs"
										>
											{(tx.kind === "sending" || tx.kind === "submitted") &&
											tx.label === `Approve ${shortAddr(i.account)}`
												? tx.kind === "submitted"
													? "Confirming..."
													: "Signing..."
												: "Approve"}
										</button>
										{callerAlreadyApproved && (
											<span className="text-xs text-text-tertiary">
												You already approved
											</span>
										)}
										{callerIsCandidate && (
											<span className="text-xs text-text-tertiary">
												You cannot approve yourself
											</span>
										)}
										{isWalletConnected && !callerIsActive && (
											<span className="text-xs text-text-tertiary">
												Only Active issuers can approve
											</span>
										)}
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</div>

			{/* Apply form */}
			<div className="card space-y-3">
				<h2 className="section-title">
					{callerCanReapply ? "Re-apply as issuer" : "Apply as issuer"}
				</h2>
				<p className="text-text-secondary text-sm">
					{callerCanReapply ? (
						<>
							This account was removed from the registry by a federated governance
							vote. It can re-apply to re-enter the waitlist. After{" "}
							<strong>{data?.approvalThreshold ?? "N"}</strong> fresh approvals from
							existing Active universities, it becomes Active again automatically —
							previous-round approvals do <em>not</em> carry over.
						</>
					) : (
						<>
							Submit an application from the connected wallet account. After{" "}
							<strong>{data?.approvalThreshold ?? "N"}</strong> approvals from
							existing Active universities, the application becomes Active
							automatically.
						</>
					)}
				</p>
				<div className="space-y-4">
					{/* Required: name */}
					<div>
						<label className="label">
							University name <span className="text-accent-red">*</span>
						</label>
						<input
							type="text"
							value={applyName}
							onChange={(e) => setApplyName(e.target.value)}
							placeholder="University of Buenos Aires"
							className="input-field w-full"
						/>
						{data?.maxNameLength ? (
							<p className="text-xs text-text-muted mt-1">
								Max {data.maxNameLength.toString()} bytes (UTF-8). Stored on-chain.
							</p>
						) : null}
					</div>

					{/* Optional metadata — uploaded to Bulletin Chain */}
					<div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-3">
						<div>
							<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Optional metadata — stored on Bulletin Chain
							</p>
							<p className="text-xs text-text-muted mt-1">
								Fill any field to enable Bulletin Chain upload. The JSON is hashed
								with keccak256 and the hash is committed on-chain as{" "}
								<code>metadataHash</code>. The block number where it was stored is
								recorded as <code>bulletinRef</code>. Leave all fields empty to
								skip.
							</p>
						</div>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							<MetaInput
								label="Country"
								value={applyMeta.country ?? ""}
								placeholder="Argentina"
								onChange={(v) =>
									setApplyMeta((m) => ({ ...m, country: v || undefined }))
								}
							/>
							<MetaInput
								label="Website"
								value={applyMeta.website ?? ""}
								placeholder="https://uba.edu.ar"
								onChange={(v) =>
									setApplyMeta((m) => ({ ...m, website: v || undefined }))
								}
							/>
							<MetaInput
								label="Accreditation body"
								value={applyMeta.accreditationBody ?? ""}
								placeholder="CONEAU"
								onChange={(v) =>
									setApplyMeta((m) => ({
										...m,
										accreditationBody: v || undefined,
									}))
								}
							/>
							<MetaInput
								label="Accreditation ID"
								value={applyMeta.accreditationId ?? ""}
								placeholder="RES-123/2024"
								onChange={(v) =>
									setApplyMeta((m) => ({ ...m, accreditationId: v || undefined }))
								}
							/>
						</div>
						{/* Bulletin status feedback */}
						{bulletinState.kind === "uploading" && (
							<p className="text-xs text-text-tertiary">
								Uploading metadata to Bulletin Chain… approve in your wallet.
							</p>
						)}
						{bulletinState.kind === "done" && (
							<p className="text-xs text-accent-green">
								✓ Metadata uploaded to Bulletin Chain — block{" "}
								{bulletinState.blockNumber}
							</p>
						)}
						{bulletinState.kind === "error" && (
							<p className="text-xs text-accent-red">
								Bulletin upload failed: {bulletinState.message}
							</p>
						)}
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-3">
					<button
						onClick={handleApply}
						disabled={txDisabled || !contractAddress || callerHasApplied}
						className="btn-primary"
					>
						{bulletinState.kind === "uploading"
							? "Uploading to Bulletin…"
							: (tx.kind === "sending" || tx.kind === "submitted") &&
								  tx.label === "Apply"
								? tx.kind === "submitted"
									? "Confirming..."
									: "Signing..."
								: callerCanReapply
									? "Re-apply as issuer"
									: "Apply as issuer"}
					</button>
					{!isWalletConnected && (
						<span className="text-xs text-text-tertiary">
							Connect a wallet to apply.
						</span>
					)}
					{callerHasApplied && (
						<span className="text-xs text-text-tertiary">
							This account is already registered (
							{issuerStatusLabel(callerIssuer!.status)}
							).
						</span>
					)}
				</div>
			</div>

			{/* Tx feedback */}
			<TxBanner tx={tx} />

			{/* Removal governance */}
			<div className="card space-y-4 border border-accent-red/20">
				<div>
					<h2 className="section-title text-accent-red">Remove an issuer (governance)</h2>
					<p className="text-xs text-text-muted mt-1">
						Active issuers can propose the removal of another active issuer. The
						proposal executes automatically once {data?.approvalThreshold ?? "N"} active
						issuers (including the proposer) have voted in favour. There is no other
						path to remove an issuer — no owner, no admin. Unresolved proposals expire
						after {data ? formatVotingWindow(data.governanceVotingPeriod) : "7 days"}.
					</p>
				</div>

				<div>
					<label className="label">Target issuer address</label>
					<input
						type="text"
						value={proposeTarget}
						onChange={(e) => setProposeTarget(e.target.value)}
						placeholder="0x... or SS58 (e.g. 5F...)"
						className="input-field w-full"
						spellCheck={false}
					/>
					<p className="text-xs text-text-muted mt-1">
						Accepts an EVM address (0x...) or a Polkadot SS58 address — they're
						converted to the same on-chain H160 via{" "}
						<code>pallet_revive::AccountId32Mapper</code>.
					</p>
					{proposeRemovalInputLooksLikeSs58 && proposeRemovalResolvedAddress && (
						<p className="text-xs text-text-tertiary mt-1">
							Resolved to EVM address:{" "}
							<code className="font-mono">{proposeRemovalResolvedAddress}</code>
						</p>
					)}
					{proposeRemovalValidation.kind === "invalid" && (
						<p className="text-xs text-accent-red mt-2">
							{proposeRemovalValidation.message}
						</p>
					)}
					<div className="mt-2 flex flex-wrap items-center gap-3">
						<button
							onClick={handleProposeRemoval}
							disabled={
								txDisabled ||
								!callerIsActive ||
								proposeRemovalValidation.kind !== "valid"
							}
							className="btn-primary text-xs"
						>
							{(tx.kind === "sending" || tx.kind === "submitted") &&
							tx.label.startsWith("Propose removal")
								? tx.kind === "submitted"
									? "Confirming..."
									: "Signing..."
								: "Propose removal"}
						</button>
						{!callerIsActive && isWalletConnected && (
							<span className="text-xs text-text-tertiary">
								Only Active issuers can propose removals.
							</span>
						)}
					</div>
				</div>

				<div className="space-y-3">
					<h3 className="text-sm font-medium text-text-primary">
						Open removal proposals
					</h3>
					{!data ? (
						<p className="text-sm text-text-muted">Connect to a contract to load.</p>
					) : openProposals.length === 0 ? (
						<p className="text-sm text-text-muted">No open removal proposals.</p>
					) : (
						<ul className="space-y-3">
							{openProposals.map((p) => {
								const callerVoted = callerKey !== null && p.voters.has(callerKey);
								const callerIsTarget =
									callerKey !== null && p.target.toLowerCase() === callerKey;
								const voteDisabled =
									txDisabled || !callerIsActive || callerVoted || callerIsTarget;
								const targetIssuer = data.issuers.find(
									(i) => i.account.toLowerCase() === p.target.toLowerCase(),
								);
								return (
									<li
										key={p.proposalId.toString()}
										className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 space-y-2"
									>
										<div className="flex items-center justify-between gap-3 flex-wrap">
											<div className="min-w-0">
												<div className="text-sm font-medium text-text-primary truncate">
													Remove {targetIssuer?.name || "(unnamed)"}
												</div>
												<code className="text-xs text-text-tertiary font-mono break-all">
													{p.target}
												</code>
											</div>
											<span className="status-badge border bg-accent-red/10 text-accent-red border-accent-red/30">
												Proposal #{p.proposalId.toString()}
											</span>
										</div>
										<div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs text-text-muted">
											<div>
												Proposed by{" "}
												<code className="font-mono text-text-secondary">
													{shortAddr(p.proposer)}
												</code>
											</div>
											<div>
												Votes: <strong>{p.voteCount}</strong> /{" "}
												{data.approvalThreshold}
											</div>
											<div>
												Created{" "}
												{new Date(
													Number(p.createdAt) * 1000,
												).toLocaleString()}
											</div>
											<div>
												Expires{" "}
												{formatDeadline(
													p.createdAt,
													data.governanceVotingPeriod,
												)}
											</div>
										</div>
										<div className="flex flex-wrap items-center gap-3">
											<button
												onClick={() =>
													handleVoteForRemoval(p.proposalId, p.target)
												}
												disabled={voteDisabled}
												className="btn-primary text-xs"
											>
												{(tx.kind === "sending" ||
													tx.kind === "submitted") &&
												tx.label === `Vote to remove ${shortAddr(p.target)}`
													? tx.kind === "submitted"
														? "Confirming..."
														: "Signing..."
													: "Vote to remove"}
											</button>
											{callerVoted && (
												<span className="text-xs text-text-tertiary">
													You already voted
												</span>
											)}
											{callerIsTarget && (
												<span className="text-xs text-text-tertiary">
													You cannot vote on your own removal
												</span>
											)}
											{isWalletConnected && !callerIsActive && (
												<span className="text-xs text-text-tertiary">
													Only Active issuers can vote
												</span>
											)}
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</div>

			{/* Removed (informational) */}
			{removedIssuers.length > 0 && (
				<div className="card space-y-3">
					<h2 className="section-title text-accent-red">Removed (by governance)</h2>
					<p className="text-xs text-text-muted">
						These universities were removed by federated vote. While Removed, they
						cannot issue, revoke, approve, or participate in governance, but they may
						re-apply at any time to re-enter the waitlist — they'll need a fresh round
						of approvals to become Active again. Historical certificates they previously
						issued remain verifiable on-chain.
					</p>
					<ul className="space-y-2">
						{removedIssuers.map((i) => (
							<IssuerRow key={i.account} issuer={i} />
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

// ── Subcomponents ───────────────────────────────────────────────────

function RegistryHeader({ load }: { load: LoadState }) {
	if (load.kind === "idle") {
		return <p className="text-sm text-text-muted">Enter a contract address to load.</p>;
	}
	if (load.kind === "loading") {
		return <p className="text-sm text-text-muted">Loading registry…</p>;
	}
	if (load.kind === "error") {
		return <p className="text-sm text-accent-red">Could not load registry: {load.message}</p>;
	}
	const d = load.data;
	return (
		<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
			<Stat label="Approval threshold" value={String(d.approvalThreshold)} />
			<Stat label="Active issuers" value={String(d.activeIssuerCount)} />
			<Stat label="Total issuers" value={String(d.issuers.length)} />
		</div>
	);
}

function CallerPanel({
	data,
	callerAddress,
	callerIssuer,
	isWalletConnected,
}: {
	data: RegistryView | null;
	callerAddress: Address | null;
	callerIssuer: IssuerView | null;
	isWalletConnected: boolean;
}) {
	if (!isWalletConnected || !callerAddress) {
		return (
			<div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-1">
				<p className="text-sm text-text-primary">No wallet connected.</p>
				<p className="text-xs text-text-muted">
					Use the <strong>Connect Wallet</strong> button in the header to sign governance
					transactions.
				</p>
			</div>
		);
	}
	const status = callerIssuer ? callerIssuer.status : IssuerStatus.None;
	return (
		<div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
			<div className="flex items-center gap-2 flex-wrap">
				<span className="text-xs text-text-tertiary uppercase tracking-wider">
					Connected account (EVM)
				</span>
				<code className="text-xs font-mono text-text-primary break-all">
					{callerAddress}
				</code>
			</div>
			<div className="flex items-center gap-2 flex-wrap">
				<StatusBadge status={status} />
				{data && callerIssuer?.status === IssuerStatus.Pending && (
					<span className="text-xs text-text-tertiary">
						{callerIssuer.approvalCount} / {data.approvalThreshold} approvals collected
					</span>
				)}
				{callerIssuer?.status === IssuerStatus.Removed && (
					<span className="text-xs text-text-tertiary">
						You can re-apply below — previous-round approvals won't carry over.
					</span>
				)}
			</div>
		</div>
	);
}

function IssuerRow({ issuer, compact = false }: { issuer: IssuerView; compact?: boolean }) {
	return (
		<div className={compact ? "" : "rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"}>
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="min-w-0">
					<div className="text-sm font-medium text-text-primary truncate">
						{issuer.name || "(no name)"}
					</div>
					<code className="text-xs text-text-tertiary font-mono break-all">
						{issuer.account}
					</code>
					{issuer.bulletinRef && (
						<p className="text-xs text-text-muted mt-0.5">
							Metadata on Bulletin Chain —{" "}
							<span className="font-mono text-text-secondary">
								{issuer.bulletinRef.includes(":")
									? `block ${issuer.bulletinRef.split(":")[0]}`
									: `CID ${issuer.bulletinRef.slice(0, 16)}…`}
							</span>
						</p>
					)}
				</div>
				<StatusBadge status={issuer.status} />
			</div>
		</div>
	);
}

function MetaInput({
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

function StatusBadge({ status }: { status: number }) {
	const cls =
		status === IssuerStatus.Active
			? "bg-accent-green/10 text-accent-green border-accent-green/30"
			: status === IssuerStatus.Pending
				? "bg-accent-orange/10 text-accent-orange border-accent-orange/30"
				: status === IssuerStatus.Removed
					? "bg-accent-red/10 text-accent-red border-accent-red/30"
					: "bg-white/[0.04] text-text-muted border-white/[0.08]";
	return <span className={`status-badge border ${cls}`}>{issuerStatusLabel(status)}</span>;
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
	return (
		<div>
			<p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
				{label}
			</p>
			<p className={`text-sm text-text-primary ${mono ? "font-mono break-all" : ""}`}>
				{value}
			</p>
		</div>
	);
}

function TxBanner({ tx }: { tx: TxState }) {
	if (tx.kind === "idle") return null;
	if (tx.kind === "sending") {
		return (
			<p className="text-sm text-text-tertiary">
				Signing <code>{tx.label}</code>… approve in your wallet.
			</p>
		);
	}
	if (tx.kind === "submitted") {
		return (
			<div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 text-sm text-text-secondary animate-fade-in">
				<p>
					<code>{tx.label}</code> broadcast — waiting for block inclusion…
				</p>
				<p className="text-xs text-text-tertiary font-mono break-all mt-1">tx: {tx.hash}</p>
			</div>
		);
	}
	if (tx.kind === "success") {
		return (
			<div className="rounded-lg border border-accent-green/30 bg-accent-green/10 p-3 text-sm text-accent-green animate-fade-in">
				✓ {tx.label} confirmed
				<p className="text-xs text-text-tertiary font-mono break-all mt-1">tx: {tx.hash}</p>
			</div>
		);
	}
	return <p className="text-sm font-medium text-accent-red">{tx.message}</p>;
}

// ── Pure helpers ────────────────────────────────────────────────────

type ReadClient = ReturnType<typeof getPublicClient>;

function isEmptyContractCode(code: string | undefined): boolean {
	if (code == null) return true;
	const c = code.trim().toLowerCase();
	return c === "" || c === "0x";
}

async function loadRegistry(client: ReadClient, address: Address): Promise<RegistryView> {
	const code = await client.getCode({ address });
	if (isEmptyContractCode(code)) {
		throw new Error(
			`No contract bytecode at ${address} on this Ethereum RPC. The address in deployments (or pasted here) does not match a Univerify deploy on this chain. Run "cd contracts/evm && npm run deploy:univerify:testnet", then update web/src/config/deployments.ts (or paste the new address above).`,
		);
	}

	let threshold: unknown;
	let activeCount: unknown;
	let governanceVotingPeriod: unknown;
	let maxName: unknown;
	let count: unknown;
	let proposalCount: unknown;
	try {
		[threshold, activeCount, governanceVotingPeriod, maxName, count, proposalCount] =
			await Promise.all([
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "approvalThreshold",
				}),
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "activeIssuerCount",
				}),
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "GOVERNANCE_VOTING_PERIOD",
				}),
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "MAX_NAME_LENGTH",
				}),
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "issuerCount",
				}),
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "removalProposalCount",
				}),
			]);
	} catch (err) {
		throw explainRegistryReadError(address, err);
	}

	const total = Number(count as bigint);
	const indices = Array.from({ length: total }, (_, i) => BigInt(i));

	const issuerAddresses = (await Promise.all(
		indices.map((i) =>
			client.readContract({
				address,
				abi: univerifyAbi,
				functionName: "issuerAt",
				args: [i],
			}),
		),
	)) as Address[];

	const issuerStructs = (await Promise.all(
		issuerAddresses.map((acc) =>
			client.readContract({
				address,
				abi: univerifyAbi,
				functionName: "getIssuer",
				args: [acc],
			}),
		),
	)) as Array<{
		account: Address;
		status: number | bigint;
		metadataHash: Hex;
		bulletinRef: string;
		name: string;
		registeredAt: bigint;
		approvalCount: number | bigint;
	}>;

	const issuers: IssuerView[] = issuerStructs
		.map((s) => ({
			account: s.account,
			status: Number(s.status),
			metadataHash: s.metadataHash,
			bulletinRef: s.bulletinRef ?? "",
			name: s.name,
			registeredAt: s.registeredAt,
			approvalCount: Number(s.approvalCount),
		}))
		.filter((issuer) => issuer.status !== IssuerStatus.None);

	const pending = issuers.filter((i) => i.status === IssuerStatus.Pending);
	const active = issuers.filter((i) => i.status === IssuerStatus.Active);
	const approvals = new Map<string, Set<string>>();
	for (const candidate of pending) {
		const flags = (await Promise.all(
			active.map((approver) =>
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "hasApproved",
					args: [candidate.account, approver.account],
				}),
			),
		)) as boolean[];
		const set = new Set<string>();
		flags.forEach((flag, idx) => {
			if (flag) set.add(active[idx].account.toLowerCase());
		});
		approvals.set(candidate.account.toLowerCase(), set);
	}

	// Iterate all proposals (1..removalProposalCount), keep open ones. MVP
	// scale: a linear scan is fine since proposals are rare events in a
	// federation. Larger deployments should read proposals via event logs.
	const proposalTotal = Number(proposalCount as bigint);
	const proposalIds = Array.from({ length: proposalTotal }, (_, i) => BigInt(i + 1));
	const proposalStructs = (await Promise.all(
		proposalIds.map((id) =>
			client.readContract({
				address,
				abi: univerifyAbi,
				functionName: "getRemovalProposal",
				args: [id],
			}),
		),
	)) as Array<{
		target: Address;
		proposer: Address;
		createdAt: bigint;
		voteCount: number | bigint;
		executed: boolean;
	}>;

	const openProposals: RemovalProposalView[] = [];
	for (let i = 0; i < proposalStructs.length; i++) {
		const p = proposalStructs[i];
		if (p.target === ZERO_ADDRESS || p.executed) continue;
		const proposalId = proposalIds[i];
		// Per-proposal voter lookup (one `hasVotedOnRemoval` call per active issuer).
		const voteFlags = (await Promise.all(
			active.map((a) =>
				client.readContract({
					address,
					abi: univerifyAbi,
					functionName: "hasVotedOnRemoval",
					args: [proposalId, a.account],
				}),
			),
		)) as boolean[];
		const voters = new Set<string>();
		voteFlags.forEach((v, idx) => {
			if (v) voters.add(active[idx].account.toLowerCase());
		});
		openProposals.push({
			proposalId,
			target: p.target,
			proposer: p.proposer,
			createdAt: p.createdAt,
			voteCount: Number(p.voteCount),
			executed: p.executed,
			voters,
		});
	}

	return {
		approvalThreshold: Number(threshold as number | bigint),
		activeIssuerCount: Number(activeCount as number | bigint),
		governanceVotingPeriod: governanceVotingPeriod as bigint,
		maxNameLength: maxName as bigint,
		issuers,
		approvals,
		openProposals,
	};
}

function explainRegistryReadError(address: Address, err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	if (
		message.includes('function "approvalThreshold" returned no data') ||
		message.includes('function "activeIssuerCount" returned no data') ||
		message.includes('function "GOVERNANCE_VOTING_PERIOD" returned no data') ||
		message.includes('function "MAX_NAME_LENGTH" returned no data') ||
		message.includes('function "issuerCount" returned no data') ||
		message.includes('function "removalProposalCount" returned no data')
	) {
		return new Error(
			`Reading Univerify at ${address} returned empty data ("0x"). Most often there is no contract at this address on the selected Ethereum RPC (check deployments.ts / redeploy), or the RPC is not the same chain as your Substrate node. Less often the address holds a different contract than this ABI.`,
		);
	}
	return err instanceof Error ? err : new Error(message);
}

function friendlyError(label: string, err: unknown): string {
	const revert = extractRevertName(err);
	const hint = revert ? errorHint(revert) : null;
	if (hint) return `${label} reverted: ${hint}`;
	if (revert) return `${label} reverted: ${revert}.`;
	return `${label} failed: ${err instanceof Error ? err.message : String(err)}`;
}

function errorHint(name: UniverifyErrorName): string | null {
	switch (name) {
		case "NotActiveIssuer":
			return "Only Active issuers can perform this action.";
		case "IssuerAlreadyExists":
			// Two reasons this can fire on `applyAsIssuer` post-refactor:
			//   (1) the caller is already Pending or Active; or
			//   (2) the **deployed** contract predates re-application
			//       support and still treats Removed as terminal.
			// We can't distinguish from the revert selector alone, so we
			// surface both possibilities — users on a stale deployment see
			// an actionable hint instead of a silent failure.
			return (
				"This account is already Pending or Active on this registry — nothing to apply. " +
				"If you were removed by governance and still see this, the deployed Univerify " +
				"contract is an older build that does not support re-application; redeploy and " +
				"update `web/src/config/deployments.ts`."
			);
		case "IssuerNotPending":
			return "Target issuer is not Pending. The application may already have activated or expired.";
		case "IssuerNotActive":
			return "Target issuer is not currently Active.";
		case "IssuerNotFound":
			return "No issuer found at that address.";
		case "AlreadyApproved":
			return "You have already approved this candidate.";
		case "CannotApproveSelf":
			return "You cannot approve yourself.";
		case "CannotProposeSelfRemoval":
			return "You cannot propose your own removal.";
		case "RemovalProposalAlreadyOpen":
			return "There is already an open removal proposal for this issuer.";
		case "RemovalProposalNotFound":
			return "That removal proposal does not exist. It may already have expired.";
		case "RemovalProposalAlreadyExecuted":
			return "That removal proposal has already been executed.";
		case "AlreadyVotedForRemoval":
			return "You have already voted on this removal proposal.";
		case "CannotVoteOnOwnRemoval":
			return "The target of a removal proposal cannot vote on their own removal.";
		case "EmptyName":
			return "Name cannot be empty.";
		case "NameTooLong":
			return "Name exceeds the contract's MAX_NAME_LENGTH.";
		case "ZeroAddress":
			return "Address cannot be zero.";
		default:
			return null;
	}
}

// Accepts either a 20-byte H160 (0x-prefixed hex) or an SS58-encoded
// AccountId32, and normalises both to the H160 that `pallet-revive` will see
// as the caller/target on-chain. This mirrors the student-wallet-address
// handling in UniverifyIssuerPage so issuers can paste whichever format
// their Polkadot wallet happens to display.
//
// Returning `null` signals "not a recognisable address" (wrong length, bad
// checksum, bad hex, etc.) — call sites should treat that as a validation
// error rather than silently fall through.
function resolveAddress(raw: string): Address | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("0x")) {
		return isAddress(trimmed, { strict: false }) ? (trimmed as Address) : null;
	}
	const info = getSs58AddressInfo(trimmed);
	if (!info.isValid) return null;
	return ss58ToEvmAddress(trimmed);
}

function formatVotingWindow(seconds: bigint): string {
	const days = Number(seconds / 86400n);
	return days === 1 ? "1 day" : `${days} days`;
}

function formatDeadline(startedAt: bigint, windowSeconds: bigint): string {
	return new Date(Number(startedAt + windowSeconds) * 1000).toLocaleString();
}

function shortAddr(addr: string): string {
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
