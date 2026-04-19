// Univerify federated-governance UI.
//
// Architecture notes:
//   - The connected Polkadot wallet (see `account/wallet.ts`) is the sole
//     source of identity. The old manual "Caller account" selector is gone.
//   - Contract reads use viem; writes are Substrate extrinsics routed through
//     `pallet_revive::call` via `submitReviveCall`, so the injected wallet's
//     signer can drive them.
//   - Permission gating (owner / active issuer) comes exclusively from
//     on-chain reads (`owner`, `getIssuer`); no frontend-only heuristics.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { univerifyAbi, IssuerStatus, issuerStatusLabel } from "../config/univerify";
import { deployments } from "../config/deployments";
import { getPublicClient } from "../config/evm";
import { useChainStore } from "../store/chainStore";
import {
	useWalletStore,
	selectConnectedEvmAddress,
	selectConnectedSigner,
} from "../account/wallet";
import { submitReviveCall } from "../account/reviveCall";
import { extractRevertName, type UniverifyErrorName } from "../utils/contractErrors";

const STORAGE_KEY_PREFIX = "univerify:governance:address";
const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── On-chain projection ─────────────────────────────────────────────

interface IssuerView {
	account: Address;
	status: number;
	metadataHash: Hex;
	name: string;
	registeredAt: bigint;
	approvalCount: number;
}

interface RegistryView {
	owner: Address;
	approvalThreshold: number;
	maxNameLength: bigint;
	issuers: IssuerView[];
	/** Map of `${candidate.toLowerCase()}` → set of approver addresses (lowercased). */
	approvals: Map<string, Set<string>>;
}

type LoadState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; data: RegistryView }
	| { kind: "error"; message: string };

type TxState =
	| { kind: "idle" }
	| { kind: "sending"; label: string }
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
	const [contractAddress, setContractAddress] = useState(
		() => localStorage.getItem(scopedStorageKey) || defaultAddress,
	);

	const [load, setLoad] = useState<LoadState>({ kind: "idle" });
	const [tx, setTx] = useState<TxState>({ kind: "idle" });
	const [reloadToken, setReloadToken] = useState(0);

	// Apply form
	const [applyName, setApplyName] = useState("");
	const [applyMetadataHash, setApplyMetadataHash] = useState<Hex>(ZERO_BYTES32);

	// Owner-only emergency form
	const [adminTarget, setAdminTarget] = useState<string>("");
	const [transferTarget, setTransferTarget] = useState<string>("");

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
				if (!code || code === "0x") {
					setTx({
						kind: "error",
						message: `No Univerify contract found at ${addr} on ${ethRpcUrl}.`,
					});
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
		await runTx("Apply", "applyAsIssuer", [name, applyMetadataHash]);
	}

	async function handleApprove(candidate: Address) {
		await runTx(`Approve ${shortAddr(candidate)}`, "approveIssuer", [candidate]);
	}

	async function handleSuspend() {
		const target = parseAddress(adminTarget);
		if (!target) {
			setTx({ kind: "error", message: "Enter a valid issuer address to suspend." });
			return;
		}
		await runTx(`Suspend ${shortAddr(target)}`, "suspendIssuer", [target]);
	}

	async function handleUnsuspend() {
		const target = parseAddress(adminTarget);
		if (!target) {
			setTx({ kind: "error", message: "Enter a valid issuer address to unsuspend." });
			return;
		}
		await runTx(`Unsuspend ${shortAddr(target)}`, "unsuspendIssuer", [target]);
	}

	async function handleTransferOwnership() {
		const target = parseAddress(transferTarget);
		if (!target) {
			setTx({ kind: "error", message: "Enter a valid new owner address." });
			return;
		}
		await runTx(`Transfer ownership → ${shortAddr(target)}`, "transferOwnership", [target]);
	}

	// ── Derived view-model ───────────────────────────────────────────
	const data = effectiveLoad.kind === "ready" ? effectiveLoad.data : null;
	const callerKey = callerAddress?.toLowerCase() ?? null;

	const callerIssuer = useMemo(() => {
		if (!data || !callerKey) return null;
		return data.issuers.find((i) => i.account.toLowerCase() === callerKey) ?? null;
	}, [data, callerKey]);

	const isOwner = !!data && !!callerKey && data.owner.toLowerCase() === callerKey;
	const callerCanApprove = callerIssuer?.status === IssuerStatus.Active;
	const callerHasApplied =
		!!callerIssuer &&
		(callerIssuer.status === IssuerStatus.Pending ||
			callerIssuer.status === IssuerStatus.Active ||
			callerIssuer.status === IssuerStatus.Suspended);

	const activeIssuers = data?.issuers.filter((i) => i.status === IssuerStatus.Active) ?? [];
	const pendingIssuers = data?.issuers.filter((i) => i.status === IssuerStatus.Pending) ?? [];
	const suspendedIssuers = data?.issuers.filter((i) => i.status === IssuerStatus.Suspended) ?? [];

	const txDisabled = !isWalletConnected || tx.kind === "sending";

	// ── Render ───────────────────────────────────────────────────────
	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title text-polka-500">Governance</h1>
				<p className="text-text-secondary">
					Federated registry of university issuers. Active universities collectively
					approve new applicants. The contract owner only retains emergency powers.
				</p>
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
					isOwner={isOwner}
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
								!callerCanApprove ||
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
										<button
											onClick={() => handleApprove(i.account)}
											disabled={disabled}
											className="btn-primary text-xs"
										>
											{tx.kind === "sending" &&
											tx.label === `Approve ${shortAddr(i.account)}`
												? "Signing..."
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
										{isWalletConnected && !callerCanApprove && (
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
				<h2 className="section-title">Apply as issuer</h2>
				<p className="text-text-secondary text-sm">
					Submit an application from the connected wallet account. After{" "}
					<strong>{data?.approvalThreshold ?? "N"}</strong> approvals from existing Active
					universities, the application becomes Active automatically.
				</p>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label className="label">University name</label>
						<input
							type="text"
							value={applyName}
							onChange={(e) => setApplyName(e.target.value)}
							placeholder="University of Buenos Aires"
							className="input-field w-full"
						/>
						{data?.maxNameLength ? (
							<p className="text-xs text-text-muted mt-1">
								Max {data.maxNameLength.toString()} bytes (UTF-8).
							</p>
						) : null}
					</div>
					<div>
						<label className="label">Metadata hash (bytes32)</label>
						<input
							type="text"
							value={applyMetadataHash}
							onChange={(e) => setApplyMetadataHash(e.target.value as Hex)}
							className="input-field w-full"
							spellCheck={false}
						/>
						<p className="text-xs text-text-muted mt-1">
							Optional pointer to off-chain metadata. Leave as zero if unused.
						</p>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<button
						onClick={handleApply}
						disabled={txDisabled || !contractAddress || callerHasApplied}
						className="btn-primary"
					>
						{tx.kind === "sending" && tx.label === "Apply"
							? "Signing..."
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

			{/* Suspended (informational) */}
			{suspendedIssuers.length > 0 && (
				<div className="card space-y-3">
					<h2 className="section-title text-accent-red">Suspended</h2>
					<ul className="space-y-2">
						{suspendedIssuers.map((i) => (
							<IssuerRow key={i.account} issuer={i} />
						))}
					</ul>
				</div>
			)}

			{/* Owner-only emergency admin */}
			<div
				className={`card space-y-4 border ${
					isOwner ? "border-accent-orange/30" : "border-white/[0.06]"
				}`}
			>
				<div className="flex items-center justify-between gap-3 flex-wrap">
					<div>
						<h2 className="section-title text-accent-orange">Emergency admin</h2>
						<p className="text-xs text-text-muted mt-1">
							Owner-only. The federated approval flow above is the normal path — this
							section exists for emergency intervention.
						</p>
					</div>
					{isOwner ? (
						<span className="status-badge border bg-accent-orange/10 text-accent-orange border-accent-orange/30">
							Owner controls unlocked
						</span>
					) : (
						<span className="status-badge border bg-white/[0.04] text-text-muted border-white/[0.08]">
							Read-only — connected account is not owner
						</span>
					)}
				</div>

				<fieldset disabled={!isOwner || txDisabled} className="space-y-4">
					<div>
						<label className="label">Issuer address (suspend / unsuspend)</label>
						<input
							type="text"
							value={adminTarget}
							onChange={(e) => setAdminTarget(e.target.value)}
							placeholder="0x..."
							className="input-field w-full"
						/>
						<div className="mt-2 flex gap-2 flex-wrap">
							<button onClick={handleSuspend} className="btn-primary text-xs">
								Suspend
							</button>
							<button onClick={handleUnsuspend} className="btn-secondary text-xs">
								Unsuspend
							</button>
						</div>
					</div>

					<div>
						<label className="label">Transfer ownership</label>
						<input
							type="text"
							value={transferTarget}
							onChange={(e) => setTransferTarget(e.target.value)}
							placeholder="0x..."
							className="input-field w-full"
						/>
						<button
							onClick={handleTransferOwnership}
							className="btn-primary text-xs mt-2"
						>
							Transfer ownership
						</button>
					</div>
				</fieldset>
			</div>
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
			<Stat label="Owner" value={shortAddr(d.owner)} mono />
			<Stat label="Approval threshold" value={String(d.approvalThreshold)} />
			<Stat label="Total issuers" value={String(d.issuers.length)} />
		</div>
	);
}

function CallerPanel({
	data,
	callerAddress,
	callerIssuer,
	isOwner,
	isWalletConnected,
}: {
	data: RegistryView | null;
	callerAddress: Address | null;
	callerIssuer: IssuerView | null;
	isOwner: boolean;
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
				{isOwner && (
					<span className="status-badge border bg-accent-orange/10 text-accent-orange border-accent-orange/30">
						★ Owner
					</span>
				)}
				{data && callerIssuer?.status === IssuerStatus.Pending && (
					<span className="text-xs text-text-tertiary">
						{callerIssuer.approvalCount} / {data.approvalThreshold} approvals collected
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
				</div>
				<StatusBadge status={issuer.status} />
			</div>
		</div>
	);
}

function StatusBadge({ status }: { status: number }) {
	const cls =
		status === IssuerStatus.Active
			? "bg-accent-green/10 text-accent-green border-accent-green/30"
			: status === IssuerStatus.Pending
				? "bg-accent-orange/10 text-accent-orange border-accent-orange/30"
				: status === IssuerStatus.Suspended
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

async function loadRegistry(client: ReadClient, address: Address): Promise<RegistryView> {
	const [owner, threshold, maxName, count] = await Promise.all([
		client.readContract({
			address,
			abi: univerifyAbi,
			functionName: "owner",
		}),
		client.readContract({
			address,
			abi: univerifyAbi,
			functionName: "approvalThreshold",
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
	]);

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
		name: string;
		registeredAt: bigint;
		approvalCount: number | bigint;
	}>;

	const issuers: IssuerView[] = issuerStructs.map((s) => ({
		account: s.account,
		status: Number(s.status),
		metadataHash: s.metadataHash,
		name: s.name,
		registeredAt: s.registeredAt,
		approvalCount: Number(s.approvalCount),
	}));

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

	return {
		owner: owner as Address,
		approvalThreshold: Number(threshold as number | bigint),
		maxNameLength: maxName as bigint,
		issuers,
		approvals,
	};
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
		case "NotOwner":
			return "Caller is not the contract owner.";
		case "NotActiveIssuer":
			return "Only Active issuers can perform this action.";
		case "AlreadyApplied":
			return "This account has already applied or is already registered.";
		case "AlreadyActive":
			return "This issuer is already Active.";
		case "NotPending":
			return "Target issuer is not Pending.";
		case "AlreadySuspended":
			return "Issuer is already suspended.";
		case "NotSuspended":
			return "Issuer is not suspended.";
		case "AlreadyApproved":
			return "You have already approved this candidate.";
		case "SelfApproval":
			return "You cannot approve yourself.";
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

function parseAddress(raw: string): Address | null {
	const trimmed = raw.trim();
	if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
	return trimmed as Address;
}

function shortAddr(addr: string): string {
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
