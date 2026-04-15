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
		bytes32 certificate_id;
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

	mapping(bytes32 => Certificate) public certificates;

	uint256 public nonce;

	event IssuerRegistered(address issuer);
	event IssuerStatusChanged(address issuer, bool active);

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
}
