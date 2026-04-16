# BACKEND DESIGN

## Overview

This document defines the data model and behavior of the `Univerify` Solidity smart contract — a **verifiable academic credential registry**.

The contract records the **existence, integrity, issuer, and revocation status** of academic certificates on-chain. Verification is **presentation-based**: the holder controls which credential they present, and the verifier checks it against the on-chain record.

This design MUST be followed strictly.

---

## Core Principles

- **Credentials, not documents.** A certificate is a structured credential issued by an authorized institution, not a PDF or file.
- **Presentation-based verification.** A verifier only sees what the holder chooses to present. There is no public discovery of certificates by student identity.
- **No PII on-chain.** The blockchain stores only hashes and addresses — never names, emails, or any personal data.
- **Minimal on-chain footprint.** Only what is needed for integrity verification is stored.

---

## Entities

### Issuer

Represents an authorized institution (university) that can issue certificates.

Fields:

- `account` (address)
- `status` (Active / Suspended)
- `metadataHash` (bytes32) — hash of off-chain issuer metadata (name, DID, etc.)

---

### Certificate

Represents an issued academic credential record.

**Primary identity:** each certificate is keyed and looked up by `certificateId`, a unique identifier generated off-chain by the issuer.

Fields:

- `issuer` (address) — the authorized issuer that registered this credential
- `claimsHash` (bytes32) — deterministic hash of the canonical credential claims (e.g., `keccak256(abi.encode(claims))`)
- `recipientCommitment` (bytes32) — privacy-preserving commitment binding the credential to its holder (e.g., `keccak256(secret || holderIdentifier)`)
- `issuedAt` (uint256) — block timestamp when the credential was registered on-chain
- `revoked` (bool) — whether the certificate has been revoked

---

## Certificate Identity and Lookup

- `certificateId` is the **only** on-chain lookup key for a certificate.
- The issuer generates `certificateId` off-chain using any deterministic unique scheme (e.g., UUID hash, sequential nonce hash, etc.).
- **Uniqueness:** at most one certificate per `certificateId`; duplicate issuance reverts.
- **No enumeration:** there are no arrays, counters, or student-to-certificate mappings. The contract cannot be scanned for all certificates or filtered by student.

---

## Storage

### Authorized Issuers

```
mapping(address => bool) public authorizedIssuers;
mapping(address => IssuerProfile) public issuerProfiles;
```

### Certificates

```
mapping(bytes32 => Certificate) public certificates;
```

The mapping key is `certificateId`.

---

## Functions

### registerIssuer

Admin only. Registers a new authorized issuer with metadata.

### setIssuerStatus

Admin only. Enables or disables an issuer.

### issueCertificate

Callable only by authorized issuers.

Inputs:

- `certificateId` (bytes32)
- `claimsHash` (bytes32)
- `recipientCommitment` (bytes32)

Stores the certificate at `certificates[certificateId]`. Reverts if a certificate already exists for that `certificateId`. Returns `certificateId`.

### revokeCertificate

Callable by the **original issuer** of the certificate.

Inputs:

- `certificateId` (bytes32)

Marks the certificate as revoked. Reverts if the certificate does not exist, is already revoked, or the caller is not the original issuer.

### verifyCertificate

Public view function. Convenience function for verifiers.

Inputs:

- `certificateId` (bytes32)
- `claimsHash` (bytes32) — recomputed from the presented credential

Returns:

- `exists` (bool)
- `issuer` (address)
- `hashMatch` (bool) — whether the presented claimsHash matches the stored one
- `revoked` (bool)
- `issuedAt` (uint256)

---

## Events

- `IssuerRegistered(address indexed issuer)`
- `IssuerStatusChanged(address indexed issuer, bool active)`
- `CertificateIssued(bytes32 indexed certificateId, address indexed issuer)`
- `CertificateRevoked(bytes32 indexed certificateId, address indexed issuer)`

---

## Errors

- `NotOwner`
- `UnauthorizedIssuer`
- `InvalidIssuerAddress`
- `IssuerAlreadyRegistered`
- `IssuerNotFound`
- `InvalidCertificateId`
- `InvalidClaimsHash`
- `InvalidRecipientCommitment`
- `CertificateAlreadyExists`
- `CertificateNotFound`
- `CertificateAlreadyRevoked`
- `NotCertificateIssuer`

---

## Verification Model

The blockchain verifies:

- **Existence** of a certificate for the given `certificateId`
- **Integrity**: the `claimsHash` recomputed from the presented credential matches the on-chain record
- **Issuer authenticity**: the `issuer` address is readable from the record (and can be checked against the authorized issuers registry)
- **Revocation status**: whether the certificate has been revoked

The blockchain DOES NOT verify:

- Real-world identity of the holder
- Content of the credential claims (only the hash)

### Verification Flow

1. Holder presents a credential (structured data, e.g., JSON) to a verifier.
2. The credential includes the `certificateId` and the full claims.
3. The verifier recomputes `claimsHash = keccak256(canonicalClaims)`.
4. The verifier calls `verifyCertificate(certificateId, claimsHash)`.
5. The verifier checks: `exists && hashMatch && !revoked && issuer is trusted`.

### What a PDF is (and is not)

- A PDF (or any visual document) is an **optional rendering** of the credential.
- The PDF is NOT the source of truth — the structured credential is.
- Verification MUST always go through the on-chain record via `certificateId` + `claimsHash`.

---

## Privacy: recipientCommitment

The `recipientCommitment` field allows the issuer to bind a credential to a specific holder without revealing the holder's identity on-chain.

- Computed as, for example: `keccak256(abi.encode(secret, holderIdentifier))`
- The holder can prove they are the intended recipient by revealing the preimage to the verifier off-chain.
- The on-chain value alone reveals nothing about the holder.
- There are no mappings from `recipientCommitment` to certificates, preventing reverse lookups.

---

## Design Constraints

- No PII on-chain
- No public enumeration of certificates
- No student-to-certificate indexing
- Minimal storage (5 fields per certificate)
- Deterministic behavior
- Simple access control (owner + authorized issuers)
- Presentation-based verification path: credential → claimsHash → on-chain lookup

---

## Future Extensions (Not MVP)

- Selective disclosure of credential attributes
- DID-based issuer resolution
- Multi-signature issuance or co-signing
- On-chain credential schema registry
- Batch issuance
- Governance-based issuer approval

DO NOT implement these now.
