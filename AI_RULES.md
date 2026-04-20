# AI RULES

Apply always = true.

These rules must be strictly followed when generating or modifying code in this repository.

## General Principles

- Prefer **simple, minimal solutions**.
- Work **incrementally**.
- Do NOT introduce unnecessary abstractions.
- Do NOT over-engineer.

## Architecture Rules

- The backend is two Solidity contracts in `contracts/evm/contracts/`: **`Univerify.sol`** (registry + federated governance) and **`CertificateNft.sol`** (soulbound ERC-721).
- DO NOT implement backend logic in `blockchain/` (FRAME pallet) or `cli/` — those are inert template leftovers.
- DO NOT introduce new FRAME pallet code.
- DO NOT modify unrelated parts of the underlying template.

## Editing Rules

Before writing code:

1. State what you are going to do.
2. List files that will change.
3. Explain why.

After writing code:

- Explain each change briefly.
- Keep consistency with existing patterns.
- Ensure the project compiles (`hardhat compile`, `tsc`, `vite build` as applicable).
- Run the relevant test suite (`hardhat test`) when contract logic changes.

## Scope Control

The following are **already implemented**; extend them carefully, do not replace them:

- Federated issuer governance (`applyAsIssuer`, `approveIssuer`, `proposeRemoval`, `voteForRemoval`).
- Re-application for removed issuers via `issuerEpoch`.
- Soulbound NFT wired via one-shot permissionless `setCertificateNft` with a `minter()` self-check.

Do NOT implement unless explicitly requested:

- Owner / admin / emergency paths. **There is no owner. Do not add one.**
- Timelocks, quorum scaling, dynamic majorities.
- DID / W3C VC standards.
- Complex indexing, batch issuance, schema registries.
- Public enumeration of certificates by holder identity on the registry side (NFT per-owner enumeration is the only permitted exception).

If unsure → ask before implementing.

## Backend Design Compliance

All contract changes MUST follow [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md) at the repo root (not `docs/`). Supporting context lives in [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) and [`CLAIMS_SCHEMA.md`](CLAIMS_SCHEMA.md).

Do NOT invent new storage layouts, enum values, or events without updating `BACKEND_DESIGN.md` in the same change.

## Smart Contract Rules

- Solidity 0.8.28, matching the existing pragma.
- Use `custom errors`, not revert strings.
- Emit events for every state change (issuer lifecycle, removal votes, certificate lifecycle, NFT wiring).
- Keep storage writes minimal; reuse slots where possible (re-application reuses the existing `_issuerList` slot and bumps `issuerEpoch` instead of clearing mappings).
- Preserve historical verifiability: do not alter or wipe certificate records when their issuer is removed.

## Access Control

- **No owner, no admin, no role hierarchy.** All write privileges flow from `IssuerStatus.Active`.
- Use the `onlyActiveIssuer` modifier (or inline check) for governance writes.
- `approvalThreshold` is reused for both admission and removal — keep the symmetry unless the spec changes.
- `setCertificateNft` must stay permissionless and one-shot, protected only by the NFT-side `minter()` check.

## Security & Data Rules

- NEVER store PII on-chain. Names, emails, student IDs belong off-chain.
- Use hashes (`claimsHash`) and commitments (`recipientCommitment`) for sensitive bindings.
- Validate all inputs: non-zero addresses, non-empty / bounded names, non-zero hashes.
- Preserve the `CannotProposeSelfRemoval` / `CannotVoteOnOwnRemoval` invariants.

## Frontend Rules

- Writes go through `pallet_revive::call` (`web/src/account/reviveCall.ts`) signed by the connected Polkadot wallet. Reads go through viem + eth-rpc.
- Before submitting a write, run `publicClient.simulateContract` in the `runTx` helper so custom-error names (e.g. `IssuerAlreadyExists`, `CannotProposeSelfRemoval`) surface to the user instead of the opaque `Revive.ContractReverted`.
- Resolve user-entered addresses with the shared helper that accepts both SS58 and 0x forms and converts SS58 to H160.
- Keep ABI (`web/src/config/univerify.ts`), error parser (`web/src/utils/contractErrors.ts`), and `IssuerStatus` mirror in sync with the contract when errors / events / enum values change.

## Testing Rules

- Add / update Hardhat tests in `contracts/evm/test/` for every contract change: new error path, new event, new state transition (especially re-application and removal flows).
- Tests use viem types — prefer `getContractAt` + typed calls over raw encoding.

## Code Quality

- Keep contracts small and readable.
- Avoid deeply nested logic; early-`revert` on invariants.
- No inheritance trees deeper than OpenZeppelin's ERC-721 baseline already used by `CertificateNft`.

## Communication Style

- Be precise and explicit.
- Avoid assumptions.
- Ask before implementing scope changes.
