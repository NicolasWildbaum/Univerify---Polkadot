// Univerify contract ABI — verifiable academic credential registry.
// This ABI matches contracts/evm/contracts/Univerify.sol after the
// credential-model refactor.
export const univerifyAbi = [
	// ── Issuer Management ───────────────────────────────────────────
	{
		type: "function",
		name: "registerIssuer",
		inputs: [
			{ name: "issuer", type: "address" },
			{ name: "metadataHash", type: "bytes32" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "setIssuerStatus",
		inputs: [
			{ name: "issuer", type: "address" },
			{ name: "active", type: "bool" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "authorizedIssuers",
		inputs: [{ name: "", type: "address" }],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "view",
	},

	// ── Certificate Lifecycle ───────────────────────────────────────
	{
		type: "function",
		name: "issueCertificate",
		inputs: [
			{ name: "certificateId", type: "bytes32" },
			{ name: "claimsHash", type: "bytes32" },
			{ name: "recipientCommitment", type: "bytes32" },
		],
		outputs: [{ name: "", type: "bytes32" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "revokeCertificate",
		inputs: [{ name: "certificateId", type: "bytes32" }],
		outputs: [],
		stateMutability: "nonpayable",
	},

	// ── Verification ────────────────────────────────────────────────
	{
		type: "function",
		name: "verifyCertificate",
		inputs: [
			{ name: "certificateId", type: "bytes32" },
			{ name: "claimsHash", type: "bytes32" },
		],
		outputs: [
			{ name: "exists", type: "bool" },
			{ name: "issuer", type: "address" },
			{ name: "hashMatch", type: "bool" },
			{ name: "revoked", type: "bool" },
			{ name: "issuedAt", type: "uint256" },
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "certificates",
		inputs: [{ name: "", type: "bytes32" }],
		outputs: [
			{ name: "issuer", type: "address" },
			{ name: "claimsHash", type: "bytes32" },
			{ name: "recipientCommitment", type: "bytes32" },
			{ name: "issuedAt", type: "uint256" },
			{ name: "revoked", type: "bool" },
		],
		stateMutability: "view",
	},

	// ── Read-only State ─────────────────────────────────────────────
	{
		type: "function",
		name: "owner",
		inputs: [],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},

	// ── Events ──────────────────────────────────────────────────────
	{
		type: "event",
		name: "IssuerRegistered",
		inputs: [{ name: "issuer", type: "address", indexed: true }],
	},
	{
		type: "event",
		name: "IssuerStatusChanged",
		inputs: [
			{ name: "issuer", type: "address", indexed: true },
			{ name: "active", type: "bool", indexed: false },
		],
	},
	{
		type: "event",
		name: "CertificateIssued",
		inputs: [
			{ name: "certificateId", type: "bytes32", indexed: true },
			{ name: "issuer", type: "address", indexed: true },
		],
	},
	{
		type: "event",
		name: "CertificateRevoked",
		inputs: [
			{ name: "certificateId", type: "bytes32", indexed: true },
			{ name: "issuer", type: "address", indexed: true },
		],
	},
] as const;
