# Claims Schema & Canonical Hashing

This document defines how credential claims are structured and hashed for on-chain registration and verification in Univerify.

> **Schema version: v2** — strings are normalized (NFC + trim + collapse whitespace + UPPERCASE) and `issuanceDate` is reduced to `YYYY-MM` before hashing. Credentials issued under v1 (`YYYY-MM-DD`, case-sensitive) will not verify under v2 unless they happen to be already canonical. `Univerify.sol` only stores `claimsHash` and is unchanged — the migration is purely off-chain.

## Why This Matters

The `claimsHash` stored on-chain is the integrity anchor: if a verifier recomputes the hash from the presented claims and it matches, the credential has not been tampered with.

For this to work, **every party** (issuer, holder, verifier) must hash claims the exact same way. This document is the canonical reference.

---

## Credential Claims Structure

A credential contains exactly four claim fields:

| Field             | Type   | Description                                                   | Example (raw input)              | Example (canonical, hashed)      |
|-------------------|--------|---------------------------------------------------------------|----------------------------------|----------------------------------|
| `degreeTitle`     | string | Name of the degree or certificate                             | `"Bachelor of Computer Science"` | `"BACHELOR OF COMPUTER SCIENCE"` |
| `holderName`      | string | Full name of the recipient                                    | `"Maria Garcia"`                 | `"MARIA GARCIA"`                 |
| `institutionName` | string | Name of the issuing institution                               | `"Universidad de Buenos Aires"`  | `"UNIVERSIDAD DE BUENOS AIRES"`  |
| `issuanceDate`    | string | Year-month of academic issuance (`YYYY-MM`; day not retained) | `"2026-03"` or legacy `"2026-03-15"` | `"2026-03"`                  |

### Important

- `holderName` is **never stored on-chain** — it is part of the off-chain credential only. The hash protects integrity without revealing the name.
- Fields are ordered **alphabetically by key name** for hashing (see below).
- The credential JSON the holder receives carries the **canonical** strings (the issuer page bakes them in via `normalizeClaims`) so that re-hashing the JSON is byte-for-byte deterministic.

---

## Normalization (Schema v2)

Both issuer and verifier feed claims through a single normalization step (`normalizeClaims`) before hashing. The web UI surfaces the canonicalized output as a "Canonical form (used for hashing)" panel so both sides can see exactly what they are committing to.

For each string claim (`degreeTitle`, `holderName`, `institutionName`):

1. Unicode NFC (avoids visually-identical but binary-different code points).
2. Trim leading/trailing whitespace.
3. Collapse internal runs of whitespace to a single space.
4. Uppercase (default locale).

For `issuanceDate`:

- Accept `YYYY-MM` (canonical) or legacy `YYYY-MM-DD`. Both produce the same hash.
- Reject anything else (e.g. `"March 2026"`, `"2026/03"`, `"2026-13"`).
- The day component is **deliberately discarded** — issuers do not need to remember a day, and verifiers cannot fail integrity over an off-by-one day they no longer recall.

This means a verifier typing `"  ada lovelace "` and `"2026-03-15"` reproduces the same `claimsHash` as the issuer who originally typed `"Ada Lovelace"` and picked `2026-03` from a month picker.

---

## Computing `claimsHash`

The canonical hash uses Solidity-compatible ABI encoding:

```
claimsHash = keccak256(
  abi.encode(
    string degreeTitle,
    string holderName,
    string institutionName,
    string issuanceDate
  )
)
```

### In TypeScript (viem)

```typescript
import { encodeAbiParameters, keccak256 } from "viem";

// NB: feeding raw (un-normalized) strings here will NOT match what
// `computeClaimsHash` produces. Always normalize first (see below)
// or use the shared utility, which normalizes for you.
const claimsHash = keccak256(
  encodeAbiParameters(
    [
      { type: "string", name: "degreeTitle" },
      { type: "string", name: "holderName" },
      { type: "string", name: "institutionName" },
      { type: "string", name: "issuanceDate" },
    ],
    [
      "BACHELOR OF COMPUTER SCIENCE",
      "MARIA GARCIA",
      "UNIVERSIDAD DE BUENOS AIRES",
      "2026-03",
    ]
  )
);
```

### Using the shared utility (recommended)

`computeClaimsHash` runs the input through `normalizeClaims` internally, so you can pass mixed-case strings and a legacy `YYYY-MM-DD` and still get the canonical hash:

```typescript
import { computeClaimsHash } from "./src/credential";

const claimsHash = computeClaimsHash({
  degreeTitle: "Bachelor of Computer Science",
  holderName: "Maria Garcia",
  institutionName: "Universidad de Buenos Aires",
  issuanceDate: "2026-03", // or "2026-03-15" — both hash to the same value
});
```

The reference implementation lives at `contracts/evm/src/credential.ts`.

---

## Computing `certificateId`

The `certificateId` is derived from the issuer address and an institution-internal reference:

```
certificateId = keccak256(abi.encode(address issuer, string internalRef))
```

- `issuer`: the Ethereum address of the issuing institution
- `internalRef`: a unique string within the issuer's system (e.g., diploma number `"UBA-CS-2026-00142"`)

```typescript
import { deriveCertificateId } from "./src/credential";

const certificateId = deriveCertificateId(
  "0x1234...issuerAddress",
  "UBA-CS-2026-00142"
);
```

---

## Computing `recipientCommitment`

The `recipientCommitment` binds the credential to a specific holder without revealing their identity on-chain:

```
recipientCommitment = keccak256(abi.encode(bytes32 secret, string holderIdentifier))
```

- `secret`: a random `bytes32` value shared between issuer and holder
- `holderIdentifier`: a stable identifier (e.g., email, student ID)

The holder proves they are the intended recipient by revealing the preimage (secret + identifier) to a verifier off-chain.

```typescript
import { computeRecipientCommitment } from "./src/credential";

const recipientCommitment = computeRecipientCommitment(
  "0xabc...randomSecret",
  "maria.garcia@uba.edu"
);
```

---

## Verification Flow (Concrete)

A presented credential carries the **canonical** claims (already normalized), since `buildCredential` bakes them in:

```json
{
  "certificateId": "0x...",
  "issuer": "0x...",
  "claims": {
    "degreeTitle": "BACHELOR OF COMPUTER SCIENCE",
    "holderName": "MARIA GARCIA",
    "institutionName": "UNIVERSIDAD DE BUENOS AIRES",
    "issuanceDate": "2026-03"
  },
  "recipientCommitment": "0x..."
}
```

The frontend offers two complementary verification paths:

**Existence + validity (NFT-anchored)** — `/verify/cert/<certificateId>`:

1. Anyone with the link reads `certificates(certificateId)` directly.
2. The page reports existence, issuer wallet, issuer name and current `IssuerStatus`, the soulbound NFT holder, `issuedAt`, and revocation. No claims are involved.

**Information integrity (claims-anchored)** — `/verify` → "Validate Information Integrity":

1. Verifier pastes the public link / certificate id (no need to retype the 64-char hash).
2. Verifier types the four claims (mixed casing OK; month picker for issuance).
3. The page computes `claimsHash = computeClaimsHash(claims)` (which normalizes first).
4. Calls `verifyCertificate(certificateId, claimsHash)` on-chain.
5. Renders one of `valid | tampered | not-found | revoked`.

Trust decision in either path: `exists && hashMatch && !revoked`, optionally combined with `isActiveIssuer(issuer)`. Certificates issued when the issuer was Active remain cryptographically verifiable even if that issuer is later removed by governance; the trust decision at that point is up to the verifier.

---

## Extending the Schema (Future)

Adding a new claim field to `CredentialClaims` **changes the hash** and is a breaking change. Options:

- Version the schema: add a `schemaVersion` field.
- Maintain backward compatibility by accepting both old and new schemas.
- Use a schema registry on-chain (out of MVP scope).

For MVP, the four-field schema above is fixed.
