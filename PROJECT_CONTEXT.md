# PROJECT CONTEXT

## Project Name

Univerify — federated academic credential registry on Polkadot.

## Overview

Web3 application built on the Polkadot ecosystem (EVM contracts via `pallet-revive`) that lets a **federation of universities** issue and verify academic certificates on-chain. Verification is **presentation-based**: the holder presents a structured credential to a verifier, who recomputes its hash and checks the on-chain record.

The system has **no privileged operator** — no owner, no admin, no emergency authority. The active universities collectively govern who joins (`apply` + `approve`) and who is removed (`proposeRemoval` + `voteForRemoval`), with the same approval threshold reused for both paths.

## Core Idea

A certificate is a **verifiable credential record** (not a PDF and not a file hash). The issuer:

1. Builds canonical claims off-chain.
2. Computes `claimsHash = keccak256(abi.encode(claims))`.
3. Registers it on-chain under a unique `certificateId` (derived from `issuer` + `internalRef`).
4. Atomically mints a **soulbound ERC-721** to the student's wallet (`CertificateNft`) so the holder owns a non-transferable token mirroring the on-chain record.

On-chain certificate fields:

- `certificateId` — unique mapping key, derived off-chain
- `issuer` — H160 of the active university
- `claimsHash` — deterministic hash of canonical claims
- `issuedAt` — block timestamp
- `revoked` — bool

Holder binding is handled exclusively by the soulbound `CertificateNft` minted to the student's wallet in the same transaction; there is no separate holder commitment stored on-chain.

There is **no public enumeration by holder identity**. The contract cannot be scanned to find all credentials owned by a given person — except trivially via the soulbound NFT's `tokenOfOwnerByIndex`, which is a deliberate UX trade-off so a student can list their own credentials in the UI without an indexer.

## Verification Model

1. Holder presents a structured credential to the verifier.
2. Verifier recomputes `claimsHash`.
3. Verifier calls `verifyCertificate(certificateId, claimsHash)`.
4. Trust decision: `exists && hashMatch && !revoked && isActiveIssuer(issuer)` (or accepts an issuer that was Active at issuance — historical certificates remain verifiable even if the issuer is later removed by governance).

A PDF is at most an optional human-readable rendering. The structured credential and the on-chain record are the source of truth.

## Governance Model (federated, no owner)

| Actor             | Powers                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Genesis issuers   | Active from block 0, set in the constructor.                                                    |
| Pending applicant | Has called `applyAsIssuer`, awaiting `approvalThreshold` approvals.                             |
| Active issuer     | Issues, revokes (own certs), approves applicants, proposes/votes removals.                      |
| Removed issuer    | Cannot act. **May re-apply** via `applyAsIssuer`; a per-issuer `issuerEpoch` invalidates prior-round approvals so they need a fresh quorum to be re-admitted. |

Same `approvalThreshold` governs admission and removal — symmetric trust model. No timelocks, no quorum scaling, no off-chain voting. Self-proposal of removal is rejected; the target of a proposal cannot vote on it.

## NFT Wiring

`CertificateNft` is a soulbound ERC-721 (no transfers, no approvals, `isRevoked` mirrors the registry). Wired post-deploy via `setCertificateNft`, which is **permissionless and one-shot**: the only safety gate is that the NFT's immutable `minter()` must already be the registry address. Front-running is mitigated by deploying both contracts and calling `setCertificateNft` in the same script.

## MVP Scope (current)

- Federated governance: `applyAsIssuer`, `approveIssuer`, `proposeRemoval`, `voteForRemoval`, with re-application via `issuerEpoch`.
- Issue / revoke / verify certificates with atomic soulbound NFT mint.
- Frontend: governance page (apply, re-apply, approve, propose, vote), issuer page (issue/revoke), public verify page, my-certificates page (via NFT enumeration).

## Out of Scope (deliberate)

- Timelocks, quorum scaling, dynamic majorities.
- Selective disclosure of attributes.
- DID / W3C VC standard compliance.
- On-chain identity resolution.
- Batch issuance, schema registry.

## Tech Stack

- Smart contracts: Solidity 0.8.28 (`Univerify.sol`, `CertificateNft.sol`), Hardhat.
- Frontend: React 18 + Vite + TypeScript + Tailwind, viem (reads), PAPI + `pallet_revive::call` (writes signed by the connected Polkadot wallet).
- Network: Polkadot Hub TestNet (Paseo) and the local dev chain via `eth-rpc`.

## Project Layout (relevant slices)

- `contracts/evm/contracts/Univerify.sol` — registry + governance.
- `contracts/evm/contracts/CertificateNft.sol` — soulbound NFT.
- `contracts/evm/test/` — Hardhat tests for both.
- `contracts/evm/scripts/deploy-univerify.ts` — deploys Univerify + NFT and wires them in one script.
- `web/src/pages/GovernancePage.tsx` — federated governance UI.
- `web/src/pages/UniverifyIssuerPage.tsx` — issue / revoke.
- `web/src/pages/PublicVerifyPage.tsx` — verifier UX.
- `web/src/pages/MyCertificatesPage.tsx` — student view via NFT enumeration.
- `web/src/config/univerify.ts` — ABI + `IssuerStatus` mirror.
- `web/src/utils/contractErrors.ts` — custom-error parser.
- `web/src/account/reviveCall.ts` — Substrate-side write path (`pallet_revive::call`).

`blockchain/` and `cli/` come from the underlying template and are not used by Univerify.

## Key Constraints

- Minimal, modular, no over-engineering.
- No PII on-chain — only hashes and addresses.
- No privileged accounts. Any future "rescue" path must go through the federated vote.
- Historical verifiability: certificates issued by an Active issuer remain verifiable even if that issuer is later removed.
