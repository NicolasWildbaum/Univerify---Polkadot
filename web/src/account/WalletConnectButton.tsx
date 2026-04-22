// Wallet widget for the app header.
//
// Discovers injected Polkadot extensions (Polkadot.js, Talisman, SubWallet,
// PWAllet / DotSama, …), lets the user pick one, and exposes the connected
// account + its derived EVM address to the rest of the app via `useWalletStore`.

import { useEffect, useRef, useState } from "react";
import { useWalletStore, ss58ToEvmAddress, type WalletStatus } from "./wallet";
import { useChainStore } from "../store/chainStore";
import { isLocalChain, requestDevFunds } from "./faucet";

const WALLET_LABELS: Record<string, string> = {
	"polkadot-js": "Polkadot.js",
	"subwallet-js": "SubWallet",
	talisman: "Talisman",
	"nova-wallet": "Nova Wallet",
	"pwallet-js": "PWAllet",
	dotsama: "DotSama",
	"dotsama-wallet": "DotSama",
};

function labelFor(extensionName: string): string {
	return WALLET_LABELS[extensionName] ?? extensionName;
}

function short(address: string): string {
	if (address.length <= 12) return address;
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function WalletConnectButton() {
	const status = useWalletStore((s) => s.status);
	const availableExtensions = useWalletStore((s) => s.availableExtensions);
	const extensionAccounts = useWalletStore((s) => s.extensionAccounts);
	const refreshExtensions = useWalletStore((s) => s.refreshExtensions);
	const connect = useWalletStore((s) => s.connect);
	const disconnect = useWalletStore((s) => s.disconnect);
	const selectAccount = useWalletStore((s) => s.selectAccount);
	const restore = useWalletStore((s) => s.restore);

	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		refreshExtensions();
		// Some extensions inject a tick or two after the page loads, so re-check.
		const t = setTimeout(refreshExtensions, 750);
		void restore();
		return () => clearTimeout(t);
	}, [refreshExtensions, restore]);

	// Close on outside click.
	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	return (
		<div ref={rootRef} className="relative">
			<button
				onClick={() => {
					refreshExtensions();
					setOpen((o) => !o);
				}}
				className="btn-primary text-xs whitespace-nowrap min-w-[180px]"
				title="Connect a Polkadot wallet"
			>
				{renderButtonLabel(status)}
			</button>

			{open && (
				<div className="absolute right-0 mt-3 w-[22rem] card z-50 animate-fade-in">
					<div className="mb-3 flex items-center justify-between gap-3">
						<div>
							<div className="hero-stat-label">Wallet Access</div>
							<div className="mt-1 text-sm text-text-secondary">
								Connect a Polkadot wallet to sign contract calls through your chain.
							</div>
						</div>
					</div>
					{status.kind === "connected" ? (
						<ConnectedPanel
							status={status}
							accounts={extensionAccounts}
							onPick={(addr) => {
								selectAccount(addr);
								setOpen(false);
							}}
							onDisconnect={() => {
								disconnect();
								setOpen(false);
							}}
						/>
					) : (
						<DiscoverPanel
							status={status}
							extensions={availableExtensions}
							onConnect={async (name) => {
								await connect(name);
								setOpen(false);
							}}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function renderButtonLabel(status: WalletStatus): string {
	if (status.kind === "connected") {
		const name = status.account.name || short(status.account.address);
		return `${name} · ${short(ss58ToEvmAddress(status.account.address))}`;
	}
	if (status.kind === "connecting") return "Connecting…";
	return "Connect Wallet";
}

function ConnectedPanel({
	status,
	accounts,
	onPick,
	onDisconnect,
}: {
	status: Extract<WalletStatus, { kind: "connected" }>;
	accounts: Array<{ address: string; name?: string }>;
	onPick: (address: string) => void;
	onDisconnect: () => void;
}) {
	const activeAddr = status.account.address;
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs uppercase tracking-wider text-text-tertiary">
					{labelFor(status.extensionName)}
				</span>
				<button onClick={onDisconnect} className="btn-secondary text-[11px] px-3 py-1.5">
					Disconnect
				</button>
			</div>

			{accounts.length > 1 && (
				<div className="space-y-1 max-h-56 overflow-y-auto pr-1">
					{accounts.map((a) => {
						const isActive = a.address === activeAddr;
						return (
							<button
								key={a.address}
								onClick={() => onPick(a.address)}
								className={`w-full text-left rounded-2xl px-3 py-3 border transition-colors ${
									isActive
										? "bg-[#635bff]/15 border-[#635bff]/35"
										: "bg-white/[0.02] border-white/[0.06] hover:border-white/[0.12]"
								}`}
							>
								<div className="text-sm text-text-primary truncate">
									{a.name || "Unnamed"}
								</div>
								<div className="text-[10px] text-text-tertiary font-mono truncate">
									{a.address}
								</div>
								<div className="text-[10px] text-text-muted font-mono truncate">
									{ss58ToEvmAddress(a.address)}
								</div>
							</button>
						);
					})}
				</div>
			)}

			{accounts.length <= 1 && (
				<div className="card-muted space-y-1">
					<div className="text-sm text-text-primary">
						{status.account.name || "Unnamed"}
					</div>
					<div className="text-[10px] text-text-tertiary font-mono break-all">
						SS58 {status.account.address}
					</div>
					<div className="text-[10px] text-text-muted font-mono break-all">
						EVM {ss58ToEvmAddress(status.account.address)}
					</div>
				</div>
			)}

			<DevFaucet address={status.account.address} />
		</div>
	);
}

// Dev-only: one-click top-up from //Alice to the connected account. Rendered
// only when the app is talking to the local chain; on Paseo / production the
// component returns null and the tree-shaker drops the faucet import.
function DevFaucet({ address }: { address: string }) {
	const wsUrl = useChainStore((s) => s.wsUrl);
	const [state, setState] = useState<
		| { kind: "idle" }
		| { kind: "sending" }
		| { kind: "success"; hash: string }
		| { kind: "error"; message: string }
	>({ kind: "idle" });

	if (!isLocalChain(wsUrl)) return null;

	async function onClick() {
		setState({ kind: "sending" });
		try {
			const res = await requestDevFunds(wsUrl, address);
			setState({ kind: "success", hash: res.txHash });
		} catch (e) {
			setState({
				kind: "error",
				message: e instanceof Error ? e.message : String(e),
			});
		}
	}

	return (
		<div className="pt-2 border-t border-white/[0.06] space-y-1.5">
			<button
				onClick={onClick}
				disabled={state.kind === "sending"}
				className="w-full btn-secondary text-xs justify-center disabled:opacity-50"
				title="Send a small transfer from //Alice so this account can pay for fees on the local chain"
			>
				{state.kind === "sending" ? "Sending…" : "Request dev funds (local)"}
			</button>
			{state.kind === "success" && (
				<p className="text-[10px] text-accent-green font-mono truncate">
					Funded. tx {state.hash.slice(0, 10)}…
				</p>
			)}
			{state.kind === "error" && (
				<p className="text-[10px] text-accent-red break-words">{state.message}</p>
			)}
		</div>
	);
}

function DiscoverPanel({
	status,
	extensions,
	onConnect,
}: {
	status: WalletStatus;
	extensions: string[];
	onConnect: (extensionName: string) => void | Promise<void>;
}) {
	return (
		<div className="space-y-3">
			<p className="text-xs text-text-tertiary">
				Connect a Polkadot-compatible browser wallet. Any wallet implementing the standard
				injected interface works (Polkadot.js, Talisman, SubWallet,{" "}
				<a
					href="https://app.dotsamalabs.com/#/"
					target="_blank"
					rel="noopener noreferrer"
					className="text-polka-400 underline"
				>
					PWAllet
				</a>
				, …).
			</p>

			{extensions.length === 0 ? (
				<p className="text-xs text-accent-orange">
					No wallet detected. Install an extension and refresh.
				</p>
			) : (
				<div className="flex flex-col gap-1.5">
					{extensions.map((name) => (
						<button
							key={name}
							onClick={() => onConnect(name)}
							disabled={status.kind === "connecting"}
							className="btn-secondary text-xs justify-start px-4"
						>
							{labelFor(name)}
						</button>
					))}
				</div>
			)}

			{status.kind === "error" && <p className="text-xs text-accent-red">{status.message}</p>}
		</div>
	);
}
