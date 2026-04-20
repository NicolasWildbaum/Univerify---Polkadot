# BACKEND DESIGN

## Overview

Two contracts, fully decentralized, no privileged operator:

- **`Univerify.sol`** — federated registry: issuer governance + certificate lifecycle + verification.
- **`CertificateNft.sol`** — soulbound ERC-721 minted atomically on issuance, mirroring revocation.

Verification is **presentation-based**: a verifier recomputes `claimsHash` off-chain and calls `verifyCertificate`. No PII on-chain.

---

## Core Principles

- **Credentials, not documents.** Structured claims + on-chain hash, not files.
- **Federated governance, no owner.** All write privileges flow from Active-issuer status.
- **Presentation-based verification.** No public discovery by holder identity.
- **Soulbound ownership.** The NFT mirrors registry state; transfers and approvals revert.
- **Historical verifiability.** Certificates remain verifiable even if their issuer is later removed.

---

## Entities

### `IssuerStatus` (enum)

| Value | Meaning                                                                       |
| ----- | ----------------------------------------------------------------------------- |
| `None` | Default zero — never registered.                                              |
| `Pending` | Applied via `applyAsIssuer`, awaiting `approvalThreshold` approvals.        |
| `Active` | Can issue, revoke, approve applicants, propose / vote removals.             |
| `Removed` | Removed by federated vote. May re-apply (returns to `Pending`, fresh epoch). |

### `Issuer` (struct)

```
struct Issuer {
    address account;
    IssuerStatus status;
    bytes32 metadataHash;     // off-chain pointer (IPFS CID, DID doc, ...)
    string  name;             // ≤ MAX_NAME_LENGTH (64 bytes UTF-8)
    uint64  registeredAt;     // block.timestamp at last apply
    uint32  approvalCount;    // approvals collected in the current epoch
}
```

### `Certificate` (struct)

```
struct Certificate {
    address issuer;
    bytes32 claimsHash;
    bytes32 recipientCommitment;
    uint256 issuedAt;
    bool    revoked;
}
```

### `RemovalProposal` (struct)

```
struct RemovalProposal {
    address target;
    address proposer;
    uint64  createdAt;
    uint32  voteCount;        // proposer is counted as the first vote
    bool    executed;
}
```

---

## Storage

```
// Top-level
uint32 public immutable approvalThreshold;        // governs admission and removal
uint32 public activeIssuerCount;                  // bookkeeping for the UI
address public certificateNft;                    // wired once via setCertificateNft

// Issuers
mapping(address => Issuer) private _issuers;
address[] private _issuerList;                    // append-only enumeration
mapping(address => uint32) public issuerEpoch;    // bumped on Removed → Pending re-apply
mapping(address => mapping(uint32 => mapping(address => bool))) private _hasApproved;
                                                  // candidate => epoch => approver => bool

// Removal governance
uint256 public removalProposalCount;
mapping(uint256 => RemovalProposal) private _removalProposals;
mapping(uint256 => mapping(address => bool)) private _hasVotedOnRemoval;
mapping(address => uint256) public openRemovalProposal;   // 0 = none

// Certificates
mapping(bytes32 => Certificate) public certificates;
```

`certificateId` is the **only** lookup key. No student-to-certificate mapping on the registry side. The soulbound NFT exposes per-holder enumeration as a UX convenience for the student themselves; the registry does not.

---

## Functions

### Constructor

```
constructor(GenesisIssuer[] memory genesis, uint32 threshold)
```

Seeds the genesis universities (Active from block 0). Requires `1 ≤ threshold ≤ genesis.length`. `activeIssuerCount` starts at `genesis.length`.

### Issuer governance

| Function                             | Caller             | Effect                                                                                              |
| ------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| `applyAsIssuer(name, metadataHash)`  | Anyone             | `None → Pending` (new slot) or `Removed → Pending` (reuses slot, bumps `issuerEpoch`).              |
| `approveIssuer(candidate)`           | Active issuer      | Records vote at `(candidate, currentEpoch, msg.sender)`. Promotes to `Active` once threshold met.   |
| `proposeRemoval(target)`             | Active issuer      | Opens proposal (proposer's vote counted = 1). Self-proposal disallowed.                             |
| `voteForRemoval(proposalId)`         | Active issuer      | Adds vote. Target cannot vote on own removal. Executes (`Active → Removed`) when threshold reached. |

`applyAsIssuer` reverts `IssuerAlreadyExists` only for `Pending` or `Active` callers. Re-application from `Removed` is the explicit re-onboarding path; bumping `issuerEpoch` invalidates all prior approvals without iterating storage.

`approveIssuer` and the `hasApproved(candidate, approver)` view both read through `issuerEpoch[candidate]`, so previous-round records cannot bleed into the current round.

### Certificate lifecycle

| Function                                                                                       | Caller                          | Notes                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `issueCertificate(certificateId, claimsHash, recipientCommitment, studentAddress)`             | Active issuer                   | Stores the record and atomically calls `CertificateNft.mintFor(studentAddress, certificateId)`. Reverts on duplicate `certificateId`.    |
| `revokeCertificate(certificateId)`                                                             | Original issuer (still Active)  | Marks `revoked = true`. Reverts if not found, already revoked, caller not the original issuer, or caller no longer Active.               |
| `verifyCertificate(certificateId, claimsHash)` (view)                                          | Anyone                          | Returns `(exists, issuer, hashMatch, revoked, issuedAt)`. The verifier decides trust off-chain (typically against `isActiveIssuer`).     |

### NFT wiring

```
function setCertificateNft(address nft) external
```

**Permissionless and one-shot.** Reverts on `ZeroAddress`, `NftAlreadySet`, or `NftMinterMismatch` (the NFT's immutable `minter()` must equal `address(this)`). The minter check is the security backstop — an NFT wired here can only be minted by this registry, so a mis-wiring can at worst deny service and require a redeploy. Front-running is mitigated by deploying both contracts and calling this in the same script (`scripts/deploy-univerify.ts`).

### Read helpers

`getIssuer`, `isActiveIssuer`, `hasApproved`, `issuerCount`, `issuerAt`, `getRemovalProposal`, `hasVotedOnRemoval`, `issuerEpoch`, `removalProposalCount`, `openRemovalProposal`.

---

## Events

```
event IssuerApplied(address indexed issuer, string name, bytes32 metadataHash);
event IssuerApproved(address indexed approver, address indexed issuer, uint32 approvalCount);
event IssuerActivated(address indexed issuer);

event RemovalProposalCreated(uint256 indexed proposalId, address indexed target, address indexed proposer);
event RemovalVoteCast(uint256 indexed proposalId, address indexed voter, uint32 voteCount);
event IssuerRemoved(address indexed issuer, uint256 indexed proposalId);

event CertificateIssued(bytes32 indexed certificateId, address indexed issuer, address indexed student);
event CertificateRevoked(bytes32 indexed certificateId, address indexed issuer);
event CertificateNftSet(address indexed nft);
```

`IssuerApplied` is re-emitted on re-application (the new `name` / `metadataHash` is in the event payload; epoch is observable via `issuerEpoch`).

---

## Errors

Governance: `NotActiveIssuer`, `ZeroAddress`, `EmptyName`, `NameTooLong`, `IssuerAlreadyExists`, `IssuerNotFound`, `IssuerNotPending`, `IssuerNotActive`, `CannotApproveSelf`, `AlreadyApproved`, `InvalidThreshold`, `InvalidGenesis`.

Removal governance: `CannotProposeSelfRemoval`, `RemovalProposalAlreadyOpen`, `RemovalProposalNotFound`, `RemovalProposalAlreadyExecuted`, `AlreadyVotedForRemoval`, `CannotVoteOnOwnRemoval`.

Certificates: `InvalidCertificateId`, `InvalidClaimsHash`, `InvalidRecipientCommitment`, `InvalidStudentAddress`, `CertificateAlreadyExists`, `CertificateNotFound`, `CertificateAlreadyRevoked`, `NotCertificateIssuer`.

NFT wiring: `NftAlreadySet`, `NftNotConfigured`, `NftMinterMismatch`.

`CertificateNft` adds: `NotMinter`, `AlreadyMinted`, `InvalidStudent`, `SoulboundNonTransferable`, `SoulboundNoApprovals`.

---

## Verification model

Verifies on-chain:

- **Existence** of a record at `certificateId`.
- **Integrity**: presented `claimsHash` matches the stored one.
- **Issuer authenticity**: `issuer` is readable; verifier checks `isActiveIssuer(issuer)` (or accepts a previously-Active issuer).
- **Revocation status**.

Does not verify:

- Real-world holder identity.
- Content of the claims (only the hash).

---

## Privacy: `recipientCommitment`

Computed off-chain as `keccak256(abi.encode(secret, holderIdentifier))`. Reveals nothing on-chain. The holder proves recipiency to a verifier off-chain by disclosing the preimage. No reverse mapping `commitment → certificate` exists.

---

## Soulbound NFT (`CertificateNft`)

- Standard ERC-721 + ERC-721Enumerable.
- All transfer / approval entry points revert (`SoulboundNonTransferable`, `SoulboundNoApprovals`).
- Immutable `minter` and `registry` (set in constructor; the registry calls `minter == registry` here).
- `mintFor(to, certificateId)` is `onlyMinter`. `tokenId` is sequential starting at 1; `certIdToTokenId` and `tokenIdToCertId` expose the bijection.
- `isRevoked(tokenId)` proxies the registry, so the NFT layer never goes out of sync.

---

## Design Constraints

- No PII on-chain.
- No public enumeration by holder on the registry side. NFT enumeration is per-owner only.
- Minimal storage per certificate (5 fields).
- Federated access control — no owner, no admin, no role hierarchy.
- Symmetric admission and removal threshold (`approvalThreshold` reused).
- Re-application via `issuerEpoch` keeps storage bounded (no per-removal mass writes).

---

## Known governance trade-offs (MVP, accepted)

- If `activeIssuerCount` drops below `approvalThreshold`, both admission and removal stall. Recovery requires a redeploy. Accepted to keep the model simple.
- `_maybeExecuteRemoval` does **not** retroactively decrement votes when a prior voter is itself removed. Each vote was valid at cast time.
- `setCertificateNft` is permissionless. The `minter()` self-check + same-script wiring is the practical mitigation; redeploy if front-run.

---

## Future Extensions (not MVP)

- Timelocks / cooldowns on removal.
- Dynamic threshold scaling with `activeIssuerCount`.
- Selective disclosure of attributes.
- DID-based issuer resolution.
- On-chain credential schema registry.
- Batch issuance.

Do not implement these without explicit scope expansion.
