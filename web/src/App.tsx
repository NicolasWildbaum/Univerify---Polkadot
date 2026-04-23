import { Outlet, Link, useLocation } from "react-router-dom";
import { useChainStore } from "./store/chainStore";
import { useConnectionManagement } from "./hooks/useConnection";
import WalletConnectButton from "./account/WalletConnectButton";

export default function App() {
	const location = useLocation();
	const pallets = useChainStore((s) => s.pallets);
	const connected = useChainStore((s) => s.connected);

	useConnectionManagement();

	const navItems = [
		{ path: "/", label: "Home", enabled: true },
		{ path: "/univerify", label: "Issue", enabled: pallets.revive === true },
		{ path: "/governance", label: "Governance", enabled: pallets.revive === true },
		{
			path: "/my-certificates",
			label: "My Certificates",
			enabled: pallets.revive === true,
		},
		{ path: "/verify", label: "Verify", enabled: true },
		{ path: "/accounts", label: "Accounts", enabled: true },
	];

	function isActive(path: string) {
		if (path === "/") return location.pathname === "/";
		return location.pathname === path || location.pathname.startsWith(`${path}/`);
	}

	return (
		<div className="app-shell bg-pattern">
			<div
				className="gradient-orb"
				style={{ background: "#635bff", top: "-240px", right: "-120px" }}
			/>
			<div
				className="gradient-orb"
				style={{ background: "#12b7ff", bottom: "-280px", left: "-120px" }}
			/>
			<div
				className="gradient-orb"
				style={{ background: "#e6007a", top: "32%", left: "38%", width: "420px", height: "420px" }}
			/>

			<nav className="nav-shell">
				<div className="nav-frame">
					<Link to="/" className="flex items-center gap-2.5 shrink-0 group">
						<div className="brand-mark transition-transform duration-300 group-hover:scale-[1.03]">
							<svg viewBox="0 0 16 16" className="w-4 h-4" fill="white">
								<circle cx="8" cy="3" r="2" />
								<circle cx="3" cy="8" r="2" />
								<circle cx="13" cy="8" r="2" />
								<circle cx="8" cy="13" r="2" />
								<circle cx="8" cy="8" r="1.5" opacity="0.6" />
							</svg>
						</div>
						<div className="min-w-0">
							<div className="brand-title">Univerify</div>
							<div className="brand-subtitle">Blockchain Credential Rail</div>
						</div>
					</Link>

					<div className="nav-pill">
						{navItems.map((item) =>
							item.enabled ? (
								<Link
									key={item.path}
									to={item.path}
									className={`nav-link ${isActive(item.path) ? "nav-link-active" : ""}`}
								>
									{item.label}
								</Link>
							) : (
								<span
									key={item.path}
									className="nav-link-disabled"
									title="Feature not available on the connected chain"
								>
									{item.label}
								</span>
							),
						)}
					</div>

					<div className="ml-auto flex items-center gap-3 shrink-0">
						<div className="hidden sm:flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-2">
							<span
								className={`w-2 h-2 rounded-full transition-colors duration-500 ${
									connected
										? "bg-accent-green shadow-[0_0_8px_rgba(52,211,153,0.6)]"
										: "bg-text-muted"
								}`}
							/>
							<span className="text-xs text-text-secondary">
								{connected ? "Chain live" : "Offline"}
							</span>
						</div>
						<WalletConnectButton />
					</div>
				</div>
			</nav>

			<main className="page-shell">
				<Outlet />
			</main>
		</div>
	);
}
