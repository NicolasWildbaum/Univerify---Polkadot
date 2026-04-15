// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Univerify
/// @notice This contract will manage academic certificates on-chain.
contract Univerify {
	enum CertificateStatus {
		Active,
		Revoked
	}

	enum IssuerStatus {
		Active,
		Suspended
	}

	struct Certificate {
		address issuer;
		bytes32 student_identifier_hash;
		bytes32 document_hash;
		string certificate_type;
		uint256 issued_on;
		bytes32 metadata_hash;
		string file_reference;
		CertificateStatus status;
		uint256 issued_at;
		uint256 revoked_at;
		bytes32 revocation_reason_hash;
	}

	struct IssuerProfile {
		address account;
		IssuerStatus status;
		bytes32 metadata_hash;
	}

	address public owner;

	mapping(address => bool) public authorizedIssuers;

	mapping(address => IssuerProfile) public issuerProfiles;

	/// @notice Certificates keyed by `document_hash` (hash of the certificate PDF / file).
	mapping(bytes32 => Certificate) public certificates;

	event IssuerRegistered(address issuer);
	event IssuerStatusChanged(address issuer, bool active);
	event CertificateIssued(bytes32 documentHash, address issuer);
	event FileReferenceAttached(bytes32 documentHash);

	constructor() {
		owner = msg.sender;
	}

	modifier onlyOwner() {
		require(msg.sender == owner, "Not owner");
		_;
	}

	modifier onlyAuthorizedIssuer() {
		require(authorizedIssuers[msg.sender], "Not authorized issuer");
		_;
	}

	function registerIssuer(address issuer, bytes32 metadataHash) external onlyOwner {
		require(issuer != address(0), "Zero address");
		require(issuerProfiles[issuer].account == address(0), "Issuer already registered");
		authorizedIssuers[issuer] = true;
		issuerProfiles[issuer] = IssuerProfile({
			account: issuer,
			status: IssuerStatus.Active,
			metadata_hash: metadataHash
		});
		emit IssuerRegistered(issuer);
	}

	function setIssuerStatus(address issuer, bool active) external onlyOwner {
		require(issuerProfiles[issuer].account != address(0), "Issuer not registered");
		authorizedIssuers[issuer] = active;
		issuerProfiles[issuer].status = active ? IssuerStatus.Active : IssuerStatus.Suspended;
		emit IssuerStatusChanged(issuer, active);
	}

	function issueCertificate(
		bytes32 student_identifier_hash,
		bytes32 document_hash,
		string calldata certificate_type,
		uint256 issued_on,
		bytes32 metadata_hash
	) external onlyAuthorizedIssuer returns (bytes32) {
		require(student_identifier_hash != bytes32(0), "Invalid student identifier hash");
		require(document_hash != bytes32(0), "Invalid document hash");
		require(certificates[document_hash].issuer == address(0), "Certificate already exists");

		certificates[document_hash] = Certificate({
			issuer: msg.sender,
			student_identifier_hash: student_identifier_hash,
			document_hash: document_hash,
			certificate_type: certificate_type,
			issued_on: issued_on,
			metadata_hash: metadata_hash,
			file_reference: "",
			status: CertificateStatus.Active,
			issued_at: block.timestamp,
			revoked_at: 0,
			revocation_reason_hash: bytes32(0)
		});

		emit CertificateIssued(document_hash, msg.sender);

		return document_hash;
	}

	function attachFileReference(
		bytes32 document_hash,
		string calldata fileReference
	) external onlyAuthorizedIssuer {
		require(document_hash != bytes32(0), "Invalid document hash");
		Certificate storage cert = certificates[document_hash];
		require(cert.issuer != address(0), "Certificate not found");
		require(cert.issuer == msg.sender, "Not certificate issuer");

		cert.file_reference = fileReference;

		emit FileReferenceAttached(document_hash);
	}

	function revokeCertificate(bytes32 document_hash, bytes32 revocation_reason_hash) external onlyAuthorizedIssuer {
		require(document_hash != bytes32(0), "Invalid document hash");
		Certificate storage cert = certificates[document_hash];
		require(cert.issuer != address(0), "Certificate not found");
		require(cert.issuer == msg.sender, "Not certificate issuer");
		require(cert.status == CertificateStatus.Active, "Not active");

		cert.status = CertificateStatus.Revoked;
		cert.revoked_at = block.timestamp;
		cert.revocation_reason_hash = revocation_reason_hash;
	}
}
