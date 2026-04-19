// Univerify contract ABI — federated academic credential registry.
// Mirrors `contracts/evm/contracts/Univerify.sol` after the federated-issuer
// refactor. Hand-maintained until a shared compiled-artifact pipeline exists.
export const univerifyAbi = [
	// ── Governance: application & approval ─────────────────────────
	{
		type: "function",
		name: "applyAsIssuer",
		inputs: [
			{ name: "name", type: "string" },
			{ name: "metadataHash", type: "bytes32" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "approveIssuer",
		inputs: [{ name: "candidate", type: "address" }],
		outputs: [],
		stateMutability: "nonpayable",
	},

	// ── Governance: emergency admin (owner-only) ───────────────────
	{
		type: "function",
		name: "suspendIssuer",
		inputs: [{ name: "issuer", type: "address" }],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "unsuspendIssuer",
		inputs: [{ name: "issuer", type: "address" }],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "transferOwnership",
		inputs: [{ name: "newOwner", type: "address" }],
		outputs: [],
		stateMutability: "nonpayable",
	},

	// ── Certificate lifecycle ───────────────────────────────────────
	{
		type: "function",
		name: "issueCertificate",
		inputs: [
			{ name: "certificateId", type: "bytes32" },
			{ name: "claimsHash", type: "bytes32" },
			{ name: "recipientCommitment", type: "bytes32" },
			{ name: "studentAddress", type: "address" },
		],
		outputs: [{ name: "", type: "bytes32" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "setCertificateNft",
		inputs: [{ name: "nft", type: "address" }],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "certificateNft",
		inputs: [],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
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

	// ── Issuer reads ────────────────────────────────────────────────
	{
		type: "function",
		name: "getIssuer",
		inputs: [{ name: "account", type: "address" }],
		outputs: [
			{
				name: "",
				type: "tuple",
				components: [
					{ name: "account", type: "address" },
					{ name: "status", type: "uint8" },
					{ name: "metadataHash", type: "bytes32" },
					{ name: "name", type: "string" },
					{ name: "registeredAt", type: "uint64" },
					{ name: "approvalCount", type: "uint32" },
				],
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "isActiveIssuer",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "hasApproved",
		inputs: [
			{ name: "candidate", type: "address" },
			{ name: "approver", type: "address" },
		],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "issuerCount",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "issuerAt",
		inputs: [{ name: "index", type: "uint256" }],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},

	// ── Top-level state ─────────────────────────────────────────────
	{
		type: "function",
		name: "owner",
		inputs: [],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "approvalThreshold",
		inputs: [],
		outputs: [{ name: "", type: "uint32" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "MAX_NAME_LENGTH",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},

	// ── Events ──────────────────────────────────────────────────────
	{
		type: "event",
		name: "OwnershipTransferred",
		inputs: [
			{ name: "previousOwner", type: "address", indexed: true },
			{ name: "newOwner", type: "address", indexed: true },
		],
	},
	{
		type: "event",
		name: "IssuerApplied",
		inputs: [
			{ name: "issuer", type: "address", indexed: true },
			{ name: "name", type: "string", indexed: false },
			{ name: "metadataHash", type: "bytes32", indexed: false },
		],
	},
	{
		type: "event",
		name: "IssuerApproved",
		inputs: [
			{ name: "approver", type: "address", indexed: true },
			{ name: "issuer", type: "address", indexed: true },
			{ name: "approvalCount", type: "uint32", indexed: false },
		],
	},
	{
		type: "event",
		name: "IssuerActivated",
		inputs: [{ name: "issuer", type: "address", indexed: true }],
	},
	{
		type: "event",
		name: "IssuerSuspended",
		inputs: [{ name: "issuer", type: "address", indexed: true }],
	},
	{
		type: "event",
		name: "IssuerUnsuspended",
		inputs: [{ name: "issuer", type: "address", indexed: true }],
	},
	{
		type: "event",
		name: "CertificateIssued",
		inputs: [
			{ name: "certificateId", type: "bytes32", indexed: true },
			{ name: "issuer", type: "address", indexed: true },
			{ name: "student", type: "address", indexed: true },
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
	{
		type: "event",
		name: "CertificateNftSet",
		inputs: [{ name: "nft", type: "address", indexed: true }],
	},
] as const;

// ── IssuerStatus mirror ─────────────────────────────────────────────
// Numeric values must match the Solidity `enum IssuerStatus` order:
//   None = 0, Pending = 1, Active = 2, Suspended = 3
export const IssuerStatus = {
	None: 0,
	Pending: 1,
	Active: 2,
	Suspended: 3,
} as const;

export type IssuerStatusValue = (typeof IssuerStatus)[keyof typeof IssuerStatus];

export function issuerStatusLabel(status: IssuerStatusValue | number): string {
	switch (status) {
		case IssuerStatus.None:
			return "Not registered";
		case IssuerStatus.Pending:
			return "Pending";
		case IssuerStatus.Active:
			return "Active";
		case IssuerStatus.Suspended:
			return "Suspended";
		default:
			return "Unknown";
	}
}
