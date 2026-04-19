// CertificateNft ABI — soulbound ERC721 ownership layer for Univerify.
// Mirrors `contracts/evm/contracts/CertificateNft.sol`. Hand-maintained
// alongside `univerify.ts` until a shared compiled-artifact pipeline exists.
//
// Read-only surface used by the frontend: token enumeration for the holder
// (My Certificates view), id ↔ certificateId mapping, and live revocation
// mirroring from the Univerify registry.
//
// Writes are intentionally restricted: `mintFor` is callable only by the
// Univerify contract itself, so no UI button surfaces it.
export const certificateNftAbi = [
	// ── ERC721 reads ──────────────────────────────────────────────
	{
		type: "function",
		name: "ownerOf",
		inputs: [{ name: "tokenId", type: "uint256" }],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "balanceOf",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "name",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "symbol",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
		stateMutability: "view",
	},

	// ── ERC721Enumerable ──────────────────────────────────────────
	{
		type: "function",
		name: "tokenOfOwnerByIndex",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "index", type: "uint256" },
		],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "totalSupply",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "tokenByIndex",
		inputs: [{ name: "index", type: "uint256" }],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},

	// ── Univerify-specific links ──────────────────────────────────
	{
		type: "function",
		name: "tokenIdToCertId",
		inputs: [{ name: "", type: "uint256" }],
		outputs: [{ name: "", type: "bytes32" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "certIdToTokenId",
		inputs: [{ name: "", type: "bytes32" }],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "isRevoked",
		inputs: [{ name: "tokenId", type: "uint256" }],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "minter",
		inputs: [],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "registry",
		inputs: [],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},

	// ── Mint (only Univerify can call; UI uses it only via reads) ─
	{
		type: "function",
		name: "mintFor",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "certificateId", type: "bytes32" },
		],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "nonpayable",
	},

	// ── Events ────────────────────────────────────────────────────
	{
		type: "event",
		name: "CertificateMinted",
		inputs: [
			{ name: "tokenId", type: "uint256", indexed: true },
			{ name: "certificateId", type: "bytes32", indexed: true },
			{ name: "to", type: "address", indexed: true },
		],
	},
] as const;
