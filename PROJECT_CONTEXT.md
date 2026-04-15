# PROJECT CONTEXT

## Project Name
Univerify (working name)

## Overview
This project is a Web3 application built on the Polkadot ecosystem to issue and verify academic certificates on-chain using Solidity smart contracts running in an EVM environment.

The system allows authorized educational institutions (issuers) to register certificates whose integrity can be publicly verified using blockchain data.

## Core Idea
Each certificate is represented on-chain by:

- A deterministic `certificate_id`
- A `document_hash` (hash of the certificate PDF/image)
- A `student_identifier_hash` (no PII on-chain)
- Minimal metadata
- An optional reference to a file stored on Bulletin Chain
- A status (Active / Revoked)

The blockchain acts as a **source of truth for authenticity**, not for identity.

## Verification Model
Verification works as follows:

1. A user provides a certificate file (PDF/image)
2. The system computes its hash
3. The hash is compared with the on-chain `document_hash`
4. If it matches and the certificate is Active → valid certificate

The student's name is included in the certificate document itself, not on-chain.

## MVP Scope (STRICT)

The MVP includes:

- Register authorized issuers (admin-controlled)
- Issue certificates
- Revoke certificates
- Verify certificates (via hash comparison)
- Optionally attach a Bulletin Chain file reference

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