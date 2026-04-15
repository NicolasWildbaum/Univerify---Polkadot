# BACKEND DESIGN


## Overview

This document defines the exact data model and behavior of the Solidity smart contract for certificate issuance and verification.

This design MUST be followed strictly.

---

## Entities

### Issuer

Represents an authorized organization that can issue certificates.

Fields:

- account (address)
- display_name (optional)
- status (Active / Suspended)
- metadata_hash (optional)

---

### Certificate

Represents an issued academic certificate.

Fields:

- certificate_id (bytes32)
- issuer (address)
- student_identifier_hash (bytes32)
- document_hash (bytes32)
- certificate_type (string or bytes32)
- issued_on (uint256 timestamp)
- metadata_hash (bytes32)
- file_reference (string, optional)
- status (Active / Revoked)
- issued_at (block timestamp)
- revoked_at (optional)
- revocation_reason_hash (optional)

---

## Certificate ID

The `certificate_id` is deterministic:

certificate_id = keccak256(
    abi.encode(
        issuer,
        student_identifier_hash,
        document_hash,
        nonce
    )
)

A nonce is required to avoid collisions.

---

## Storage

### Authorized Issuers

mapping(address => bool) public authorizedIssuers;

Optional:

mapping(address => IssuerProfile) public issuerProfiles;

---

### Certificates

mapping(bytes32 => Certificate) public certificates;

---

### Nonce

uint256 public nonce;

Used to ensure unique certificate IDs.

---

## Functions

### registerIssuer

Admin only.

Registers a new authorized issuer.

---

### setIssuerStatus

Admin only.

Enables or disables an issuer.

---

### issueCertificate

Callable only by authorized issuers.

Inputs:

- student_identifier_hash
- document_hash
- certificate_type
- issued_on
- metadata_hash
- file_reference (optional)

Creates a new certificate.

---

### revokeCertificate

Callable by issuer.

Inputs:

- certificate_id
- revocation_reason_hash (optional)

Marks certificate as revoked.

---

### attachFileReference (optional)

Allows attaching a Bulletin Chain reference after issuance.

---

## Events

- IssuerRegistered(address issuer)
- IssuerStatusChanged(address issuer, bool active)
- CertificateIssued(bytes32 certificateId, address issuer)
- CertificateRevoked(bytes32 certificateId)
- FileReferenceAttached(bytes32 certificateId)

---

## Errors

- UnauthorizedIssuer
- IssuerNotFound
- IssuerSuspended
- CertificateNotFound
- CertificateAlreadyRevoked
- NotCertificateIssuer
- InvalidInput

---

## Verification Model

The blockchain verifies:

- Existence of certificate
- Issuer authenticity
- Document integrity via `document_hash`
- Revocation status

The blockchain DOES NOT verify:

- Real-world identity (e.g., "Juan Gomez")

Identity is verified through:

- The certificate document itself (PDF)
- Off-chain validation (e.g., ID check)

---

## Bulletin Chain Reference

The `file_reference`:

- Is optional
- Is treated as an opaque string
- Is NOT the source of truth

Verification MUST always rely on `document_hash`.

---

## Design Constraints

- No PII on-chain
- Minimal storage
- Deterministic behavior
- Simple access control

---

## Future Extensions (Not MVP)

- Multi-organization validation
- Decentralized issuer approval
- DID integration
- Verifiable credentials
- Advanced indexing

DO NOT implement these now.