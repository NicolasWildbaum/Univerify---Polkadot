// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Univerify — Verifiable Academic Credential Registry
/// @notice Authorized issuers register certificate records on-chain (existence,
///         integrity, issuer, and revocation status). Verification is
///         presentation-based: a holder presents their credential off-chain and
///         a verifier checks the on-chain record using the certificateId and
///         claimsHash. No PII or student identity is stored on-chain.
contract Univerify {
	/// @notice On-chain representation of an academic credential.
	/// @dev The mapping key (`certificateId`) is generated off-chain by the
	///      issuer. The `claimsHash` is a deterministic hash of the canonical
	///      credential claims. The `recipientCommitment` is a privacy-preserving
	///      binding to the holder (e.g., hash of a secret + holder identifier).
	struct Certificate {
		address issuer;
		bytes32 claimsHash;
		bytes32 recipientCommitment;
		uint256 issuedAt;
		bool revoked;
	}

	enum IssuerStatus {
		Active,
		Suspended
	}

	struct IssuerProfile {
		address account;
		IssuerStatus status;
		bytes32 metadataHash;
	}

	// ── Errors ──────────────────────────────────────────────────────────

	error NotOwner();
	error UnauthorizedIssuer();
	error InvalidIssuerAddress();
	error IssuerAlreadyRegistered();
	error IssuerNotFound();

	error InvalidCertificateId();
	error InvalidClaimsHash();
	error InvalidRecipientCommitment();
	error CertificateAlreadyExists();
	error CertificateNotFound();
	error CertificateAlreadyRevoked();
	error NotCertificateIssuer();

	// ── State ───────────────────────────────────────────────────────────

	address public owner;

	mapping(address => bool) public authorizedIssuers;
	mapping(address => IssuerProfile) public issuerProfiles;

	/// @notice Certificates keyed by a unique `certificateId`.
	mapping(bytes32 => Certificate) public certificates;

	// ── Events ──────────────────────────────────────────────────────────

	event IssuerRegistered(address indexed issuer);
	event IssuerStatusChanged(address indexed issuer, bool active);
	event CertificateIssued(bytes32 indexed certificateId, address indexed issuer);
	event CertificateRevoked(bytes32 indexed certificateId, address indexed issuer);

	// ── Constructor & Modifiers ─────────────────────────────────────────

	constructor() {
		owner = msg.sender;
	}

	modifier onlyOwner() {
		if (msg.sender != owner) revert NotOwner();
		_;
	}

	modifier onlyAuthorizedIssuer() {
		if (!authorizedIssuers[msg.sender]) revert UnauthorizedIssuer();
		_;
	}

	// ── Issuer Management ───────────────────────────────────────────────

	/// @notice Register a new authorized issuer (admin only).
	/// @param issuer  Address of the institution to authorize.
	/// @param metadataHash  Off-chain metadata hash (e.g. institution name, DID).
	function registerIssuer(address issuer, bytes32 metadataHash) external onlyOwner {
		if (issuer == address(0)) revert InvalidIssuerAddress();
		if (issuerProfiles[issuer].account != address(0)) revert IssuerAlreadyRegistered();

		authorizedIssuers[issuer] = true;
		issuerProfiles[issuer] = IssuerProfile({
			account: issuer,
			status: IssuerStatus.Active,
			metadataHash: metadataHash
		});

		emit IssuerRegistered(issuer);
	}

	/// @notice Enable or disable an issuer (admin only).
	/// @param issuer  Address of the issuer to update.
	/// @param active  True to activate, false to suspend.
	function setIssuerStatus(address issuer, bool active) external onlyOwner {
		if (issuerProfiles[issuer].account == address(0)) revert IssuerNotFound();

		authorizedIssuers[issuer] = active;
		issuerProfiles[issuer].status = active ? IssuerStatus.Active : IssuerStatus.Suspended;

		emit IssuerStatusChanged(issuer, active);
	}

	// ── Certificate Lifecycle ───────────────────────────────────────────

	/// @notice Issue a new verifiable credential record.
	/// @param certificateId         Unique identifier (generated off-chain by the issuer).
	/// @param claimsHash            Deterministic hash of the canonical credential claims.
	/// @param recipientCommitment   Privacy-preserving commitment binding the credential to its holder.
	/// @return The `certificateId` used as the on-chain key.
	function issueCertificate(
		bytes32 certificateId,
		bytes32 claimsHash,
		bytes32 recipientCommitment
	) external onlyAuthorizedIssuer returns (bytes32) {
		if (certificateId == bytes32(0)) revert InvalidCertificateId();
		if (claimsHash == bytes32(0)) revert InvalidClaimsHash();
		if (recipientCommitment == bytes32(0)) revert InvalidRecipientCommitment();
		if (certificates[certificateId].issuer != address(0)) revert CertificateAlreadyExists();

		certificates[certificateId] = Certificate({
			issuer: msg.sender,
			claimsHash: claimsHash,
			recipientCommitment: recipientCommitment,
			issuedAt: block.timestamp,
			revoked: false
		});

		emit CertificateIssued(certificateId, msg.sender);
		return certificateId;
	}

	/// @notice Revoke an issued certificate. Only the original issuer may revoke.
	/// @param certificateId  The identifier of the certificate to revoke.
	function revokeCertificate(bytes32 certificateId) external onlyAuthorizedIssuer {
		if (certificateId == bytes32(0)) revert InvalidCertificateId();

		Certificate storage cert = certificates[certificateId];
		if (cert.issuer == address(0)) revert CertificateNotFound();
		if (cert.issuer != msg.sender) revert NotCertificateIssuer();
		if (cert.revoked) revert CertificateAlreadyRevoked();

		cert.revoked = true;

		emit CertificateRevoked(certificateId, msg.sender);
	}

	// ── Verification ────────────────────────────────────────────────────

	/// @notice Verify a certificate against presented credential data.
	/// @dev    A verifier recomputes `claimsHash` from the off-chain credential
	///         and calls this function with the `certificateId` included in the
	///         presentation. The function returns all fields needed for a
	///         complete verification decision.
	/// @param certificateId  The certificate to verify.
	/// @param claimsHash     The hash recomputed from the presented claims.
	/// @return exists     True if a record exists for this certificateId.
	/// @return issuer     The address that issued the certificate.
	/// @return hashMatch  True if the presented claimsHash matches the stored record.
	/// @return revoked    True if the certificate has been revoked.
	/// @return issuedAt   Block timestamp when the certificate was registered.
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
}
