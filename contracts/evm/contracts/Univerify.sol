// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface to the soulbound NFT minted on issuance. The
///         registry calls into it atomically from `issueCertificate` so the
///         student wallet receives the token in the same transaction.
interface ICertificateNft {
	function mintFor(address to, bytes32 certificateId) external returns (uint256);
}

/// @title Univerify — Federated Academic Credential Registry
/// @notice Issuers are universities. A small set of **genesis** universities is
///         activated at deployment; new universities self-apply and enter a
///         pending waitlist. A candidate becomes Active once it is approved by
///         at least `approvalThreshold` already-Active universities. Only
///         Active universities can issue or revoke certificates.
///
///         The contract owner has a minimal, emergency-only surface: suspend
///         and unsuspend an issuer, and transfer ownership. The owner cannot
///         register, approve, force-activate, or remove universities.
///
///         Verification is presentation-based: a verifier recomputes
///         `claimsHash` off-chain and calls `verifyCertificate`. No PII or
///         holder identity is stored on-chain — only the student's wallet
///         address as the recipient of the soulbound NFT minted by
///         `CertificateNft` (`certificateNft`).
contract Univerify {
	// ── Types ───────────────────────────────────────────────────────────

	/// @notice On-chain representation of an academic credential.
	struct Certificate {
		address issuer;
		bytes32 claimsHash;
		bytes32 recipientCommitment;
		uint256 issuedAt;
		bool revoked;
	}

	/// @notice Lifecycle of an issuing university.
	/// @dev `None` is the default (zero) value so an unknown address reads as
	///      `None` without an extra sentinel check.
	enum IssuerStatus {
		None,
		Pending,
		Active,
		Suspended
	}

	/// @notice Full on-chain profile of an issuing university.
	/// @dev `name` is kept on-chain to make the waitlist and verification UIs
	///      self-contained without requiring an off-chain metadata resolver.
	///      Its length is bounded by `MAX_NAME_LENGTH` to cap storage cost.
	struct Issuer {
		address account;
		IssuerStatus status;
		bytes32 metadataHash;
		string name;
		uint64 registeredAt;
		uint32 approvalCount;
	}

	/// @notice Constructor-only descriptor for a genesis university.
	struct GenesisIssuer {
		address account;
		string name;
		bytes32 metadataHash;
	}

	// ── Errors ──────────────────────────────────────────────────────────

	error NotOwner();
	error NotActiveIssuer();

	error ZeroAddress();
	error EmptyName();
	error NameTooLong();
	error IssuerAlreadyExists();
	error IssuerNotFound();
	error IssuerNotPending();
	error IssuerNotActive();
	error IssuerNotSuspended();
	error CannotApproveSelf();
	error AlreadyApproved();

	error InvalidThreshold();
	error InvalidGenesis();

	error InvalidCertificateId();
	error InvalidClaimsHash();
	error InvalidRecipientCommitment();
	error InvalidStudentAddress();
	error CertificateAlreadyExists();
	error CertificateNotFound();
	error CertificateAlreadyRevoked();
	error NotCertificateIssuer();

	error NftAlreadySet();
	error NftNotConfigured();

	// ── Constants ───────────────────────────────────────────────────────

	/// @notice Maximum byte length of an issuer's on-chain `name`.
	/// @dev Keeps storage bounded and protects against pathological names.
	uint256 public constant MAX_NAME_LENGTH = 64;

	// ── State ───────────────────────────────────────────────────────────

	/// @notice Minimum number of approvals from Active universities required
	///         to promote a Pending applicant to Active. Set once at deploy.
	uint32 public immutable approvalThreshold;

	/// @notice Emergency-only administrator. Can suspend / unsuspend issuers
	///         and transfer ownership. Cannot register, approve, or issue.
	address public owner;

	/// @dev Primary issuer storage. Unknown addresses read as `{status: None}`.
	mapping(address => Issuer) private _issuers;

	/// @dev Append-only enumeration of every issuer that has ever applied or
	///      been seeded at genesis. Frontends read this list and filter by
	///      `status` to render the waitlist / active set. No removals means no
	///      swap-and-pop complexity and no storage gaps.
	address[] private _issuerList;

	/// @dev Approval tracking: candidate => approver => approved?
	///      Used to prevent double approvals and to expose `hasApproved()`
	///      to the frontend without relying on event indexing.
	mapping(address => mapping(address => bool)) private _hasApproved;

	/// @notice Certificates keyed by `certificateId`.
	mapping(bytes32 => Certificate) public certificates;

	/// @notice Soulbound NFT contract that mirrors certificate ownership in
	///         the student's wallet. Set once, post-deploy, by the owner via
	///         `setCertificateNft` (avoids the chicken-and-egg of the NFT
	///         needing this contract's address in its constructor).
	address public certificateNft;

	// ── Events ──────────────────────────────────────────────────────────

	event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

	event IssuerApplied(address indexed issuer, string name, bytes32 metadataHash);
	event IssuerApproved(address indexed approver, address indexed issuer, uint32 approvalCount);
	event IssuerActivated(address indexed issuer);
	event IssuerSuspended(address indexed issuer);
	event IssuerUnsuspended(address indexed issuer);

	event CertificateIssued(
		bytes32 indexed certificateId,
		address indexed issuer,
		address indexed student
	);
	event CertificateRevoked(bytes32 indexed certificateId, address indexed issuer);
	event CertificateNftSet(address indexed nft);

	// ── Modifiers ───────────────────────────────────────────────────────

	modifier onlyOwner() {
		if (msg.sender != owner) revert NotOwner();
		_;
	}

	modifier onlyActiveIssuer() {
		if (_issuers[msg.sender].status != IssuerStatus.Active) revert NotActiveIssuer();
		_;
	}

	// ── Constructor ─────────────────────────────────────────────────────

	/// @notice Bootstrap the registry with a set of genesis universities that
	///         are Active from block zero.
	/// @param  genesis   Non-empty list of genesis universities.
	/// @param  threshold Number of Active-issuer approvals required to promote
	///                   a future Pending applicant to Active. Must satisfy
	///                   `1 <= threshold <= genesis.length` so that at least
	///                   one onboarding path exists from day one.
	constructor(GenesisIssuer[] memory genesis, uint32 threshold) {
		if (threshold == 0) revert InvalidThreshold();
		if (genesis.length == 0 || threshold > genesis.length) revert InvalidGenesis();

		owner = msg.sender;
		emit OwnershipTransferred(address(0), msg.sender);

		approvalThreshold = threshold;

		for (uint256 i = 0; i < genesis.length; i++) {
			GenesisIssuer memory g = genesis[i];
			if (g.account == address(0)) revert ZeroAddress();
			_validateName(g.name);
			if (_issuers[g.account].status != IssuerStatus.None) revert IssuerAlreadyExists();

			_issuers[g.account] = Issuer({
				account: g.account,
				status: IssuerStatus.Active,
				metadataHash: g.metadataHash,
				name: g.name,
				registeredAt: uint64(block.timestamp),
				approvalCount: 0
			});
			_issuerList.push(g.account);
			emit IssuerActivated(g.account);
		}
	}

	// ── Governance: Application & Approval ──────────────────────────────

	/// @notice Self-apply to join the registry as a university. The caller's
	///         address becomes the issuer identity. Starts in `Pending`.
	/// @param  name          Human-readable institution name (1..MAX_NAME_LENGTH bytes).
	/// @param  metadataHash  Off-chain metadata commitment (DID doc, IPFS CID,
	///                       etc.). Not resolved on-chain.
	function applyAsIssuer(string calldata name, bytes32 metadataHash) external {
		_validateName(name);
		if (_issuers[msg.sender].status != IssuerStatus.None) revert IssuerAlreadyExists();

		_issuers[msg.sender] = Issuer({
			account: msg.sender,
			status: IssuerStatus.Pending,
			metadataHash: metadataHash,
			name: name,
			registeredAt: uint64(block.timestamp),
			approvalCount: 0
		});
		_issuerList.push(msg.sender);

		emit IssuerApplied(msg.sender, name, metadataHash);
	}

	/// @notice Approve a Pending university. Only Active universities can
	///         approve, and only once per candidate. Reaching the threshold
	///         promotes the candidate to Active atomically in the same tx.
	/// @param  candidate Address of the Pending applicant.
	function approveIssuer(address candidate) external onlyActiveIssuer {
		if (candidate == msg.sender) revert CannotApproveSelf();

		Issuer storage c = _issuers[candidate];
		if (c.status != IssuerStatus.Pending) revert IssuerNotPending();
		if (_hasApproved[candidate][msg.sender]) revert AlreadyApproved();

		_hasApproved[candidate][msg.sender] = true;
		uint32 newCount = c.approvalCount + 1;
		c.approvalCount = newCount;

		emit IssuerApproved(msg.sender, candidate, newCount);

		if (newCount >= approvalThreshold) {
			c.status = IssuerStatus.Active;
			emit IssuerActivated(candidate);
		}
	}

	// ── Governance: Emergency (owner) ───────────────────────────────────

	/// @notice Suspend an Active issuer. Previously issued certificates remain
	///         readable and verifiable, but the issuer can no longer issue
	///         or revoke. Only the contract owner can call this.
	function suspendIssuer(address issuer) external onlyOwner {
		Issuer storage prof = _issuers[issuer];
		if (prof.status == IssuerStatus.None) revert IssuerNotFound();
		if (prof.status != IssuerStatus.Active) revert IssuerNotActive();
		prof.status = IssuerStatus.Suspended;
		emit IssuerSuspended(issuer);
	}

	/// @notice Lift a prior suspension. Only callable by the contract owner.
	function unsuspendIssuer(address issuer) external onlyOwner {
		Issuer storage prof = _issuers[issuer];
		if (prof.status == IssuerStatus.None) revert IssuerNotFound();
		if (prof.status != IssuerStatus.Suspended) revert IssuerNotSuspended();
		prof.status = IssuerStatus.Active;
		emit IssuerUnsuspended(issuer);
	}

	/// @notice Transfer ownership of the emergency-admin role.
	/// @dev    One-step transfer; the deploying account is responsible for
	///         choosing a safe target (EOA, multisig, etc.).
	function transferOwnership(address newOwner) external onlyOwner {
		if (newOwner == address(0)) revert ZeroAddress();
		address prev = owner;
		owner = newOwner;
		emit OwnershipTransferred(prev, newOwner);
	}

	/// @notice Wire up the soulbound `CertificateNft` contract. Settable
	///         exactly once by the deploy script, immediately after both
	///         contracts exist on-chain. After that, issuance always mints.
	///         We keep this as a separate one-shot setter (rather than a
	///         constructor argument) to avoid the circular dependency
	///         between the two contracts at construction time.
	function setCertificateNft(address nft) external onlyOwner {
		if (nft == address(0)) revert ZeroAddress();
		if (certificateNft != address(0)) revert NftAlreadySet();
		certificateNft = nft;
		emit CertificateNftSet(nft);
	}

	// ── Certificate Lifecycle ───────────────────────────────────────────

	/// @notice Issue a new verifiable credential record and mint the
	///         corresponding soulbound NFT to the student's wallet
	///         atomically. Only Active issuers may call.
	/// @param  studentAddress Wallet that receives the soulbound NFT. The
	///                        registry continues to omit any PII; the wallet
	///                        is the only on-chain link to the holder.
	function issueCertificate(
		bytes32 certificateId,
		bytes32 claimsHash,
		bytes32 recipientCommitment,
		address studentAddress
	) external onlyActiveIssuer returns (bytes32) {
		if (certificateId == bytes32(0)) revert InvalidCertificateId();
		if (claimsHash == bytes32(0)) revert InvalidClaimsHash();
		if (recipientCommitment == bytes32(0)) revert InvalidRecipientCommitment();
		if (studentAddress == address(0)) revert InvalidStudentAddress();
		if (certificates[certificateId].issuer != address(0)) revert CertificateAlreadyExists();
		address nft = certificateNft;
		if (nft == address(0)) revert NftNotConfigured();

		certificates[certificateId] = Certificate({
			issuer: msg.sender,
			claimsHash: claimsHash,
			recipientCommitment: recipientCommitment,
			issuedAt: block.timestamp,
			revoked: false
		});

		emit CertificateIssued(certificateId, msg.sender, studentAddress);

		// Atomic mint: any failure on the NFT side reverts the entire
		// issuance, so registry state and NFT supply can never diverge.
		ICertificateNft(nft).mintFor(studentAddress, certificateId);

		return certificateId;
	}

	/// @notice Revoke a certificate. Only the original issuer, and only while
	///         still Active, may revoke.
	function revokeCertificate(bytes32 certificateId) external onlyActiveIssuer {
		if (certificateId == bytes32(0)) revert InvalidCertificateId();

		Certificate storage cert = certificates[certificateId];
		if (cert.issuer == address(0)) revert CertificateNotFound();
		if (cert.issuer != msg.sender) revert NotCertificateIssuer();
		if (cert.revoked) revert CertificateAlreadyRevoked();

		cert.revoked = true;
		emit CertificateRevoked(certificateId, msg.sender);
	}

	// ── Verification ────────────────────────────────────────────────────

	/// @notice Presentation-based verification entrypoint. Returns all fields
	///         a verifier needs to make a trust decision off-chain.
	function verifyCertificate(
		bytes32 certificateId,
		bytes32 claimsHash
	)
		external
		view
		returns (bool exists, address issuer, bool hashMatch, bool revoked, uint256 issuedAt)
	{
		Certificate memory cert = certificates[certificateId];
		exists = cert.issuer != address(0);
		if (!exists) return (false, address(0), false, false, 0);

		issuer = cert.issuer;
		hashMatch = cert.claimsHash == claimsHash;
		revoked = cert.revoked;
		issuedAt = cert.issuedAt;
	}

	// ── Read Helpers ────────────────────────────────────────────────────

	/// @notice Full issuer profile. Returns a zeroed struct (`status = None`)
	///         for addresses that have never applied or been seeded.
	function getIssuer(address account) external view returns (Issuer memory) {
		return _issuers[account];
	}

	/// @notice Convenience gate for the frontend and for off-chain verifiers.
	function isActiveIssuer(address account) external view returns (bool) {
		return _issuers[account].status == IssuerStatus.Active;
	}

	/// @notice Whether a given Active issuer has already approved a candidate.
	///         Enables the UI to disable an already-used approval button
	///         without replaying events.
	function hasApproved(address candidate, address approver) external view returns (bool) {
		return _hasApproved[candidate][approver];
	}

	/// @notice Total number of known issuers (any status).
	function issuerCount() external view returns (uint256) {
		return _issuerList.length;
	}

	/// @notice Nth known issuer address, for paginated reads.
	function issuerAt(uint256 index) external view returns (address) {
		return _issuerList[index];
	}

	// ── Internal ────────────────────────────────────────────────────────

	function _validateName(string memory name) internal pure {
		bytes memory b = bytes(name);
		if (b.length == 0) revert EmptyName();
		if (b.length > MAX_NAME_LENGTH) revert NameTooLong();
	}
}
