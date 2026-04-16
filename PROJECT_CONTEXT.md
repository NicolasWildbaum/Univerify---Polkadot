# PROJECT CONTEXT

## Project Name
Univerify (working name)

## Overview
This project is a Web3 application built on the Polkadot ecosystem for issuing and verifying academic certificates on-chain using Solidity smart contracts running in an EVM environment.

The system allows authorized educational institutions (issuers) to register verifiable credential records on-chain. Verification is **presentation-based**: a holder presents their credential to a verifier, and the verifier checks existence, integrity, issuer authenticity, and revocation status against the blockchain.

## Core Idea
Each certificate is represented on-chain as a **verifiable credential record**, not as a document or file hash.

The issuer constructs a structured credential (claims), computes a deterministic hash (`claimsHash`), and registers it on-chain under a unique `certificateId`. The holder receives the full credential off-chain and controls what they present to verifiers.

On-chain fields:

- **`certificateId`** — unique identifier (mapping key), generated off-chain by the issuer
- **`issuer`** — address of the authorized institution that issued the credential
- **`claimsHash`** — deterministic hash of the canonical credential claims
- **`recipientCommitment`** — privacy-preserving commitment binding the credential to its holder
- **`issuedAt`** — block timestamp of on-chain registration
- **`revoked`** — revocation status (bool)

There is **no** public enumeration or discovery of certificates by student identity. The contract cannot be scanned or filtered to find all certificates belonging to a given person.

The blockchain acts as a **source of truth for authenticity and integrity**, not for identity or content.

## Verification Model
Verification follows a presentation-based flow:

1. A holder presents a structured credential (e.g., JSON) to a verifier.
2. The credential includes the `certificateId` and the full claims data.
3. The verifier recomputes `claimsHash = keccak256(canonicalClaims)`.
4. The verifier calls `verifyCertificate(certificateId, claimsHash)` on-chain.
5. If the record exists, the hash matches, the issuer is trusted, and the certificate is not revoked → the credential is verified.

### What a PDF is (and is not)
A PDF (or any visual document) is an **optional rendering** of the credential for human readability. It is NOT the source of truth. Verification always goes through the structured credential data and the on-chain record.

## MVP Scope (STRICT)

The MVP includes:

- Register authorized issuers (admin-controlled)
- Issue certificates as verifiable credential records (`certificateId` + `claimsHash` + `recipientCommitment`)
- Revoke certificates by `certificateId` (original issuer only)
- Verify certificates via `verifyCertificate(certificateId, claimsHash)`
- No public enumeration or student-based indexing

## Out of Scope (for MVP)

- Selective disclosure of credential attributes
- Decentralized organization validation
- Governance mechanisms
- DID / W3C Verifiable Credentials standard compliance
- Identity resolution on-chain
- Complex indexing or querying
- Batch issuance
- Advanced access control models

## Tech Stack

- Backend: Solidity Smart Contract (EVM)
- Frontend: Web App (React/Vite from template)
- Network: Paseo (for deployment)

## Template Structure (IMPORTANT)

This project is built on the `polkadot-stack-template`.

Relevant directories:

- `contracts/evm/` → MAIN BACKEND (Solidity)
- `web/` → frontend
- `blockchain/` → NOT USED
- `cli/` → NOT USED

## Key Constraint

This project MUST:

- Keep a minimal, modular design
- Avoid over-engineering
- Remain fully functional within 2 weeks
- Prioritize presentation-based verification over public discoverability
