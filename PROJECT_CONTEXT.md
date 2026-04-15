# PROJECT CONTEXT

## Project Name
Univerify (working name)

## Overview
This project is a Web3 application built on the Polkadot ecosystem to issue and verify academic certificates on-chain using Solidity smart contracts running in an EVM environment.

The system allows authorized educational institutions (issuers) to register certificates whose integrity can be publicly verified using blockchain data.

## Core Idea
Each certificate is represented on-chain primarily by **`document_hash`**: the hash of the certificate PDF (or image). That hash is both the **public lookup key** and the **integrity anchor**—a third party only needs the file to recompute the hash and query the contract.

On-chain fields include:

- **`document_hash`** — canonical identifier; maps to `certificates[document_hash]`
- **`issuer`** — who attested to this file
- **`student_identifier_hash`** (no PII on-chain)
- Minimal metadata (`certificate_type`, `issued_on`, `metadata_hash`, etc.)
- An optional reference to a file stored on Bulletin Chain (`file_reference`)
- A status (Active / Revoked)

There is **no** separate synthetic certificate id (no nonce-based `keccak256` identity): verification is designed so that **hashing the PDF is enough** to find the record.

The blockchain acts as a **source of truth for authenticity**, not for identity.

## Verification Model
Verification works as follows:

1. A user provides a certificate file (PDF/image).
2. The system computes its hash → **`document_hash`**.
3. The app reads **`certificates(document_hash)`** on-chain (or equivalent via the contract ABI).
4. If no record exists (`issuer == address(0)`) → not registered on-chain.
5. If a record exists: check **`status`** (Active vs Revoked) and interpret **`issuer`** (and optional issuer metadata off-chain).
6. The on-chain **`document_hash`** field matches the key; integrity is “same file as registered.”

The student's name appears in the certificate document itself, not as raw PII on-chain.

## MVP Scope (STRICT)

The MVP includes:

- Register authorized issuers (admin-controlled)
- Issue certificates (one per `document_hash`)
- Revoke certificates by `document_hash` (issuer-only)
- Verify certificates by recomputing the file hash and querying storage
- Optionally attach a Bulletin Chain file reference (future / optional field)

## Out of Scope (for MVP)

- Decentralized organization validation
- Governance mechanisms
- DID / Verifiable Credentials
- Identity resolution on-chain
- Complex indexing or querying
- Advanced access control models

## Tech Stack

- Backend: Solidity Smart Contract (EVM)
- Frontend: Web App (React/Vite from template)
- Storage: On-chain + optional Bulletin Chain
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
