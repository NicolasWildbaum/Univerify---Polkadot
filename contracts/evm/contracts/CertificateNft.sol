// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice Minimal read-only view of the Univerify registry that this NFT
///         contract depends on. We re-declare instead of importing the full
///         contract to keep the dependency surface and bytecode small.
interface IUniverifyRegistry {
	function certificates(
		bytes32
	)
		external
		view
		returns (
			address issuer,
			bytes32 claimsHash,
			bytes32 recipientCommitment,
			uint256 issuedAt,
			bool revoked
		);
}

/// @title CertificateNft — soulbound ERC721 ownership layer for Univerify
/// @notice Each token is a non-transferable receipt of a Univerify
///         certificate, held in the student's wallet. The token is the
///         presentation/ownership layer; the registry is the source of truth.
///
///         Design notes:
///         - Soulbound: transfers and approvals revert. We allow mint only;
///           burn is also disabled to keep the receipt visible to the holder
///           even after revocation.
///         - Revocation is NOT stored here. `isRevoked(tokenId)` reads the
///           live state from the Univerify registry so there is exactly one
///           source of truth and no risk of the two contracts going out of
///           sync.
///         - Minting is restricted to the configured `minter` (the Univerify
///           contract). Issuance flows there call `mintFor` atomically in the
///           same transaction as `issueCertificate`.
///
///         TODO(future): support a student-signed presentation that proves
///         current wallet ownership for a specific verifier/audience
///         (challenge-response over the certificateId). Out of scope for the
///         current MVP — the public verifier trusts the URL holder today.
contract CertificateNft is ERC721, ERC721Enumerable {
	error NotMinter();
	error AlreadyMinted();
	error InvalidStudent();
	error InvalidCertificateId();
	error SoulboundNonTransferable();
	error SoulboundNoApprovals();

	/// @notice Address allowed to call `mintFor` — the Univerify contract.
	address public immutable minter;

	/// @notice Univerify registry consulted for live revocation state.
	IUniverifyRegistry public immutable registry;

	/// @dev Token ids start at 1 so `0` can mean "unminted" in the
	///      `certIdToTokenId` mapping without an extra existence check.
	uint256 private _nextTokenId = 1;

	/// @notice Token id → on-chain certificate id (registry key).
	mapping(uint256 => bytes32) public tokenIdToCertId;

	/// @notice Certificate id → token id (`0` if not yet minted).
	mapping(bytes32 => uint256) public certIdToTokenId;

	event CertificateMinted(
		uint256 indexed tokenId,
		bytes32 indexed certificateId,
		address indexed to
	);

	constructor(
		address minter_,
		address registry_
	) ERC721("Univerify Certificate", "UVC") {
		if (minter_ == address(0) || registry_ == address(0)) revert InvalidStudent();
		minter = minter_;
		registry = IUniverifyRegistry(registry_);
	}

	// ── Mint ────────────────────────────────────────────────────────────

	/// @notice Mint a soulbound certificate token to `to`. Callable only by
	///         the configured minter (the Univerify contract). Reverts if a
	///         token already exists for this `certificateId`.
	function mintFor(
		address to,
		bytes32 certificateId
	) external returns (uint256 tokenId) {
		if (msg.sender != minter) revert NotMinter();
		if (to == address(0)) revert InvalidStudent();
		if (certificateId == bytes32(0)) revert InvalidCertificateId();
		if (certIdToTokenId[certificateId] != 0) revert AlreadyMinted();

		tokenId = _nextTokenId++;
		tokenIdToCertId[tokenId] = certificateId;
		certIdToTokenId[certificateId] = tokenId;

		_safeMint(to, tokenId);
		emit CertificateMinted(tokenId, certificateId, to);
	}

	// ── Views ───────────────────────────────────────────────────────────

	/// @notice Returns the live revocation status from the Univerify
	///         registry. Mirrors the registry; never stored locally.
	function isRevoked(uint256 tokenId) external view returns (bool) {
		bytes32 certId = tokenIdToCertId[tokenId];
		if (certId == bytes32(0)) return false;
		(, , , , bool revoked) = registry.certificates(certId);
		return revoked;
	}

	// ── Soulbound enforcement ───────────────────────────────────────────

	/// @dev OZ v5 routes mint, transfer, and burn through `_update`. We allow
	///      only mint (`from == address(0)`); transfer and burn revert.
	function _update(
		address to,
		uint256 tokenId,
		address auth
	) internal override(ERC721, ERC721Enumerable) returns (address) {
		address from = _ownerOf(tokenId);
		if (from != address(0)) revert SoulboundNonTransferable();
		return super._update(to, tokenId, auth);
	}

	function approve(address, uint256) public pure override(ERC721, IERC721) {
		revert SoulboundNoApprovals();
	}

	function setApprovalForAll(address, bool) public pure override(ERC721, IERC721) {
		revert SoulboundNoApprovals();
	}

	// ── Required OZ overrides for ERC721 + Enumerable ───────────────────

	function _increaseBalance(
		address account,
		uint128 value
	) internal override(ERC721, ERC721Enumerable) {
		super._increaseBalance(account, value);
	}

	function supportsInterface(
		bytes4 id
	) public view override(ERC721, ERC721Enumerable) returns (bool) {
		return super.supportsInterface(id);
	}
}
