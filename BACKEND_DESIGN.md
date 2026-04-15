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

**Primary identity:** the certificate is keyed and looked up by **`document_hash`** (hash of the certificate PDF / file). There is no separate synthetic `certificate_id`.

Fields:

- issuer (address)
- student_identifier_hash (bytes32)
- document_hash (bytes32) — same value as the mapping key; stored in the struct for full-record reads
- certificate_type (string)
- issued_on (uint256 timestamp)
- metadata_hash (bytes32)
- file_reference (string, optional; MVP may use empty string)
- status (Active / Revoked)
- issued_at (block timestamp)
- revoked_at (optional)
- revocation_reason_hash (optional)

---

## Certificate identity and lookup

- **`document_hash`** is the **only** identifier needed for storage and verification.
- Third parties hash the PDF off-chain and use that **`bytes32`** to read `certificates(document_hash)` on-chain.
- **No nonce** and **no** `keccak256(issuer, …, nonce)` id: those would require hidden inputs and do not match the “verify from file alone” flow.
- **Uniqueness:** at most one certificate per `document_hash`; duplicate issuance must revert.

---

## Storage

### Authorized Issuers

mapping(address => bool) public authorizedIssuers;

Optional:

mapping(address => IssuerProfile) public issuerProfiles;

---

### Certificates

mapping(bytes32 => Certificate) public certificates;

The mapping key **is** `document_hash` (the hash of the certificate file).

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

Stores the certificate at `certificates[document_hash]`. Rejects if a certificate already exists for that `document_hash`.

Returns `document_hash` (the lookup key).

---

### revokeCertificate

Callable by the **issuing** address for that certificate (`msg.sender == certificates[document_hash].issuer`).

Inputs:

- document_hash
- revocation_reason_hash (optional; may be `bytes32(0)`)

Marks the certificate as revoked.

---

### attachFileReference (optional)

Allows attaching a Bulletin Chain reference after issuance.

---

## Events

Implemented in contract:

- IssuerRegistered(address issuer)
- IssuerStatusChanged(address issuer, bool active)

May be added later (not required for MVP logic):

- CertificateIssued(bytes32 indexed document_hash, address issuer)
- CertificateRevoked(bytes32 indexed document_hash)
- FileReferenceAttached(bytes32 indexed document_hash)

---

## Errors

- UnauthorizedIssuer
- IssuerNotFound
- IssuerSuspended
- CertificateNotFound
- CertificateAlreadyRevoked
- NotCertificateIssuer
- InvalidInput

(Concrete revert strings in Solidity may differ; align naming in a later refactor.)

---

## Verification Model

The blockchain verifies:

- Existence of a certificate for the given **`document_hash`**
- Issuer authenticity (read `issuer` from the record)
- Document integrity: the third party’s hash **is** the lookup key — if the record exists, it matches that file
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

Verification MUST always rely on **`document_hash`** as the primary handle.

---

## Design Constraints

- No PII on-chain
- Minimal storage
- Deterministic behavior
- Simple access control
- **Verification path:** PDF → hash → on-chain lookup (no hidden ids)

---

## Future Extensions (Not MVP)

- Multi-organization validation
- Decentralized issuer approval
- DID integration
- Verifiable credentials
- Advanced indexing

DO NOT implement these now.
