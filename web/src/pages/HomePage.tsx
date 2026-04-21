import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useChainStore } from "../store/chainStore";
import { useConnection } from "../hooks/useConnection";
import { getClient } from "../hooks/useChain";
import {
	LOCAL_ETH_RPC_URL,
	LOCAL_WS_URL,
	getNetworkPresetEndpoints,
	type NetworkPreset,
} from "../config/network";

export default function HomePage() {
	const { wsUrl, ethRpcUrl, setEthRpcUrl, connected, blockNumber } = useChainStore();
	const { connect } = useConnection();
	const [urlInput, setUrlInput] = useState(wsUrl);
	const [ethRpcInput, setEthRpcInput] = useState(ethRpcUrl);
	const [error, setError] = useState<string | null>(null);
	const [chainName, setChainName] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);

	useEffect(() => {
		setUrlInput(wsUrl);
	}, [wsUrl]);

	useEffect(() => {
		setEthRpcInput(ethRpcUrl);
	}, [ethRpcUrl]);

	useEffect(() => {
		if (!connected) {
			return;
		}

		getClient(wsUrl)
			.getChainSpecData()
			.then((data) => setChainName(data.name))
			.catch(() => {});
	}, [connected, wsUrl]);

	async function handleConnect() {
		setConnecting(true);
		setError(null);
		setChainName(null);
		try {
			const result = await connect(urlInput);
			if (result?.ok && result.chain) {
				setChainName(result.chain.name);
			}
		} catch (e) {
			setError(`Could not connect to ${urlInput}. Is the chain running?`);
			console.error(e);
		} finally {
			setConnecting(false);
		}
	}

	function applyPreset(preset: NetworkPreset) {
		const endpoints = getNetworkPresetEndpoints(preset);
		setUrlInput(endpoints.wsUrl);
		setEthRpcInput(endpoints.ethRpcUrl);
		setEthRpcUrl(endpoints.ethRpcUrl);
	}

	return (
		<div className="section-stack">
			<div className="page-hero">
				<div className="space-y-5">
					<span className="page-kicker">Academic Trust Layer</span>
					<div className="space-y-4">
						<h1 className="page-title">
							Univerify turns your blockchain into a native rail for issuing,
							governing and verifying academic credentials.
						</h1>
						<p className="page-subtitle">
							Connect your chain, route wallet-based governance, issue verifiable
							certificates and expose a public verification experience from one
							cohesive control surface.
						</p>
					</div>

					<div className="hero-grid">
						<HeroStat
							label="Chain State"
							value={connected ? "Online" : "Awaiting connection"}
							caption={error ?? (connected ? "RPC and runtime are reachable" : "Connect your node to begin")}
						/>
						<HeroStat
							label="Connected Network"
							value={chainName ?? "Unknown"}
							caption={connected ? "Runtime metadata loaded from chain" : "Detected after a successful connection"}
						/>
						<HeroStat
							label="Latest Block"
							value={`#${blockNumber}`}
							caption="Live chain head observed by the UI"
						/>
					</div>

					<div className="grid gap-3 md:grid-cols-4">
						<QuickLink
							to="/univerify"
							title="Issue"
							description="Create and register credentials through the Univerify contract."
						/>
						<QuickLink
							to="/governance"
							title="Governance"
							description="Manage issuer admission and removal with on-chain federation rules."
						/>
						<QuickLink
							to="/verify"
							title="Verify"
							description="Validate links, claims integrity and certificate status in one flow."
						/>
						<QuickLink
							to="/my-certificates"
							title="My Certificates"
							description="Surface the soulbound credentials held by the connected wallet."
						/>
					</div>
				</div>
			</div>

			<div className="card space-y-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<p className="page-kicker">Network Control</p>
						<h2 className="section-title mt-3">Chain endpoints</h2>
						<p className="mt-2 text-sm text-text-secondary max-w-2xl">
							Point the interface at your Substrate node and your Ethereum-compatible
							RPC without changing the business logic behind issuance or verification.
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
					<button onClick={() => applyPreset("local")} className="btn-secondary text-xs">
						Use Local Dev
					</button>
					<button
						onClick={() => applyPreset("testnet")}
						className="btn-secondary text-xs"
					>
						Use Hub TestNet
					</button>
					</div>
				</div>

				<div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
					<div className="space-y-4">
				<div>
					<label className="label">Substrate WebSocket Endpoint</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={urlInput}
							onChange={(e) => setUrlInput(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleConnect()}
							placeholder={LOCAL_WS_URL}
							className="input-field flex-1"
						/>
						<button
							onClick={handleConnect}
							disabled={connecting}
							className="btn-primary"
						>
							{connecting ? "Connecting..." : "Connect chain"}
						</button>
					</div>
				</div>

				<div>
					<label className="label">Ethereum JSON-RPC Endpoint</label>
					<input
						type="text"
						value={ethRpcInput}
						onChange={(e) => {
							setEthRpcInput(e.target.value);
							setEthRpcUrl(e.target.value);
						}}
						placeholder={LOCAL_ETH_RPC_URL}
						className="input-field w-full"
					/>
					<p className="text-xs text-text-muted mt-2">
						Used by the credential issuance, governance, verification, and certificate
						pages.
					</p>
				</div>
					</div>

					<div className="space-y-3">
						<div className="info-banner">
							<div className="hero-stat-label">Endpoint Profile</div>
							<div className="hero-stat-value text-xl">
								{wsUrl.includes("localhost") ? "Local environment" : "Remote network"}
							</div>
							<div className="hero-stat-caption">
								Current WS endpoint: <code className="text-text-primary">{wsUrl}</code>
							</div>
						</div>
						<div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
							<StatusItem label="Chain Status">
						{error ? (
							<span className="text-accent-red text-sm">{error}</span>
						) : connected ? (
							<span className="text-accent-green flex items-center gap-1.5">
								<span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse-slow" />
								Connected
							</span>
						) : connecting ? (
							<span className="text-accent-yellow">Connecting...</span>
						) : (
							<span className="text-text-muted">Disconnected</span>
						)}
					</StatusItem>
					<StatusItem label="Chain Name">
						{chainName || <span className="text-text-muted">...</span>}
					</StatusItem>
					<StatusItem label="Latest Block">
						<span className="font-mono">#{blockNumber}</span>
					</StatusItem>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function StatusItem({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="hero-stat">
			<h3 className="hero-stat-label">
				{label}
			</h3>
			<p className="hero-stat-value text-xl">{children}</p>
		</div>
	);
}

function HeroStat({
	label,
	value,
	caption,
}: {
	label: string;
	value: string;
	caption: string;
}) {
	return (
		<div className="hero-stat">
			<p className="hero-stat-label">{label}</p>
			<p className="hero-stat-value">{value}</p>
			<p className="hero-stat-caption">{caption}</p>
		</div>
	);
}

function QuickLink({
	to,
	title,
	description,
}: {
	to: string;
	title: string;
	description: string;
}) {
	return (
		<Link to={to} className="card-hover block h-full">
			<p className="hero-stat-label">Open tab</p>
			<h3 className="section-title mt-3">{title}</h3>
			<p className="mt-2 text-sm text-text-secondary">{description}</p>
		</Link>
	);
}
