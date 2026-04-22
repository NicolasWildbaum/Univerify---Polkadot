// Univerify contract ABI — federated academic credential registry.
// Mirrors `contracts/evm/contracts/Univerify.sol` after the fully-decentralised
// refactor (no owner, governance-based removal). Hand-maintained until a
// shared compiled-artifact pipeline exists.
export const univerifyAbi = [
	// ── Governance: application & approval ─────────────────────────
	{
		type: "function",
		name: "applyAsIssuer",
		inputs: [
			{ name: "name", type: "string" },
			{ name: "metadataHash", type: "bytes32" },
			{ name: "bulletinRef", type: "string" },
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

	// ── Governance: removal proposals ──────────────────────────────
	{
		type: "function",
		name: "proposeRemoval",
		inputs: [{ name: "target", type: "address" }],
		outputs: [{ name: "proposalId", type: "uint256" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "voteForRemoval",
		inputs: [{ name: "proposalId", type: "uint256" }],
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
	{
		type: "function",
		name: "setCertificatePdfCid",
		inputs: [
			{ name: "certificateId", type: "bytes32" },
			{ name: "pdfCid", type: "string" },
		],
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
			{ name: "issuedAt", type: "uint256" },
			{ name: "revoked", type: "bool" },
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "certificatePdfCids",
		inputs: [{ name: "", type: "bytes32" }],
		outputs: [{ name: "", type: "string" }],
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
					{ name: "bulletinRef", type: "string" },
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
		name: "issuerEpoch",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint32" }],
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

	// ── Removal-proposal reads ──────────────────────────────────────
	{
		type: "function",
		name: "getRemovalProposal",
		inputs: [{ name: "proposalId", type: "uint256" }],
		outputs: [
			{
				name: "",
				type: "tuple",
				components: [
					{ name: "target", type: "address" },
					{ name: "proposer", type: "address" },
					{ name: "createdAt", type: "uint64" },
					{ name: "voteCount", type: "uint32" },
					{ name: "executed", type: "bool" },
				],
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "hasVotedOnRemoval",
		inputs: [
			{ name: "proposalId", type: "uint256" },
			{ name: "voter", type: "address" },
		],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "openRemovalProposal",
		inputs: [{ name: "target", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "removalProposalCount",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},

	// ── Top-level state ─────────────────────────────────────────────
	{
		type: "function",
		name: "approvalThreshold",
		inputs: [],
		outputs: [{ name: "", type: "uint32" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "activeIssuerCount",
		inputs: [],
		outputs: [{ name: "", type: "uint32" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "GOVERNANCE_VOTING_PERIOD",
		inputs: [],
		outputs: [{ name: "", type: "uint64" }],
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
		name: "IssuerApplied",
		inputs: [
			{ name: "issuer", type: "address", indexed: true },
			{ name: "name", type: "string", indexed: false },
			{ name: "metadataHash", type: "bytes32", indexed: false },
			{ name: "bulletinRef", type: "string", indexed: false },
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
		name: "RemovalProposalCreated",
		inputs: [
			{ name: "proposalId", type: "uint256", indexed: true },
			{ name: "target", type: "address", indexed: true },
			{ name: "proposer", type: "address", indexed: true },
		],
	},
	{
		type: "event",
		name: "RemovalVoteCast",
		inputs: [
			{ name: "proposalId", type: "uint256", indexed: true },
			{ name: "voter", type: "address", indexed: true },
			{ name: "voteCount", type: "uint32", indexed: false },
		],
	},
	{
		type: "event",
		name: "IssuerRemoved",
		inputs: [
			{ name: "issuer", type: "address", indexed: true },
			{ name: "proposalId", type: "uint256", indexed: true },
		],
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
		name: "CertificatePdfCidSet",
		inputs: [
			{ name: "certificateId", type: "bytes32", indexed: true },
			{ name: "student", type: "address", indexed: true },
			{ name: "pdfCid", type: "string", indexed: false },
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
//   None = 0, Pending = 1, Active = 2, Removed = 3
export const IssuerStatus = {
	None: 0,
	Pending: 1,
	Active: 2,
	Removed: 3,
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
		case IssuerStatus.Removed:
			return "Removed";
		default:
			return "Unknown";
	}
}
