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

	error NotOwner();
	error UnauthorizedIssuer();
	error InvalidIssuerAddress();
	error IssuerAlreadyRegistered();
	error IssuerNotFound();

	error InvalidStudentIdentifierHash();
	error InvalidDocumentHash();
	error InvalidMetadataHash();
	error EmptyCertificateType();
	error EmptyFileReference();

	error CertificateAlreadyExists();
	error CertificateNotFound();
	error CertificateAlreadyRevoked();
	error NotCertificateIssuer();

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
		if (msg.sender != owner) revert NotOwner();
		_;
	}

	modifier onlyAuthorizedIssuer() {
		if (!authorizedIssuers[msg.sender]) revert UnauthorizedIssuer();
		_;
	}

	function registerIssuer(address issuer, bytes32 metadataHash) external onlyOwner {
		if (issuer == address(0)) revert InvalidIssuerAddress();
		if (issuerProfiles[issuer].account != address(0)) revert IssuerAlreadyRegistered();
		authorizedIssuers[issuer] = true;
		issuerProfiles[issuer] = IssuerProfile({
			account: issuer,
			status: IssuerStatus.Active,
			metadata_hash: metadataHash
		});
		emit IssuerRegistered(issuer);
	}

	function setIssuerStatus(address issuer, bool active) external onlyOwner {
		if (issuerProfiles[issuer].account == address(0)) revert IssuerNotFound();
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
		if (student_identifier_hash == bytes32(0)) revert InvalidStudentIdentifierHash();
		if (document_hash == bytes32(0)) revert InvalidDocumentHash();
		if (metadata_hash == bytes32(0)) revert InvalidMetadataHash();
		if (bytes(certificate_type).length == 0) revert EmptyCertificateType();
		if (certificates[document_hash].issuer != address(0)) revert CertificateAlreadyExists();

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
		if (document_hash == bytes32(0)) revert InvalidDocumentHash();
		Certificate storage cert = certificates[document_hash];
		if (cert.issuer == address(0)) revert CertificateNotFound();
		if (cert.issuer != msg.sender) revert NotCertificateIssuer();
		if (bytes(fileReference).length == 0) revert EmptyFileReference();

		cert.file_reference = fileReference;

		emit FileReferenceAttached(document_hash);
	}

	function revokeCertificate(bytes32 document_hash, bytes32 revocation_reason_hash) external onlyAuthorizedIssuer {
		if (document_hash == bytes32(0)) revert InvalidDocumentHash();
		Certificate storage cert = certificates[document_hash];
		if (cert.issuer == address(0)) revert CertificateNotFound();
		if (cert.issuer != msg.sender) revert NotCertificateIssuer();
		if (cert.status != CertificateStatus.Active) revert CertificateAlreadyRevoked();

		cert.status = CertificateStatus.Revoked;
		cert.revoked_at = block.timestamp;
		cert.revocation_reason_hash = revocation_reason_hash;
	}
}
