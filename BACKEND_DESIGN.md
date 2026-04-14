# BACKEND DESIGN

## Overview

This document defines the exact data model and behavior of the FRAME pallet for certificate issuance and verification.

This design MUST be followed strictly.

---

## Entities

### Issuer

Represents an authorized organization that can issue certificates.

Fields:

- issuer_id (optional internal ID)
- account_id
- display_name
- status (Active / Suspended)
- metadata_hash (optional)

---

### Certificate

Represents an issued academic certificate.

Fields:

- certificate_id
- issuer_account
- student_identifier_hash
- document_hash
- certificate_type
- issued_on
- metadata_hash
- file_reference (optional)
- status (Active / Revoked)
- issued_at_block
- revoked_at_block (optional)
- revocation_reason_hash (optional)

---

## Certificate ID

The `certificate_id` is deterministic:

certificate_id = hash(
    issuer_account ||
    student_identifier_hash ||
    document_hash ||
    nonce
)

This ensures uniqueness and portability.

---

## Storage

### Authorized Issuers

Map:

AccountId → IssuerProfile

---

### Certificates

Map:

CertificateId → CertificateRecord

---

### Optional Index

DocumentHash → CertificateId

(Only if needed)

---

### Counters

Optional:

- NextIssuerId
- Nonce (if required for certificate_id uniqueness)

---

## Extrinsics

### register_issuer

Admin only.

Registers a new authorized issuer.

---

### set_issuer_status

Admin only.

Enables or disables an issuer.

---

### issue_certificate

Callable only by authorized issuers.

Creates a new certificate.

Inputs:

- student_identifier_hash
- document_hash
- certificate_type
- issued_on
- metadata_hash
- file_reference (optional)

---

### revoke_certificate

Callable by issuer (or admin).

Marks certificate as revoked.

Inputs:

- certificate_id
- revocation_reason_hash (optional)

---

### attach_file_reference (optional)

Allows attaching a Bulletin Chain reference after issuance.

---

## Events

- IssuerRegistered
- IssuerStatusChanged
- CertificateIssued
- CertificateRevoked
- CertificateFileReferenceAttached

---

## Errors

### Issuer Errors

- UnauthorizedIssuer
- IssuerNotFound
- IssuerSuspended

### Certificate Errors

- CertificateNotFound
- CertificateAlreadyRevoked
- DuplicateCertificate (if enforced)
- InvalidInput
- NotCertificateIssuer

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
- Is treated as an opaque identifier
- Is NOT the source of truth

Verification MUST always rely on `document_hash`.

---

## Design Constraints

- No PII on-chain
- Minimal storage
- Deterministic behavior
- Extensible for future issuer validation model

---

## Future Extensions (Not MVP)

- Multi-organization validation
- Decentralized issuer approval
- DID integration
- Verifiable credentials
- Advanced indexing

DO NOT implement these now.