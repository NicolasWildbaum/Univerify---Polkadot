# Claims Schema & Canonical Hashing

This document defines how credential claims are structured and hashed for on-chain registration and verification in Univerify.

## Why This Matters

The `claimsHash` stored on-chain is the integrity anchor: if a verifier recomputes the hash from the presented claims and it matches, the credential has not been tampered with.

For this to work, **every party** (issuer, holder, verifier) must hash claims the exact same way. This document is the canonical reference.

---

## Credential Claims Structure

A credential contains exactly four claim fields:

| Field             | Type   | Description                                            | Example                          |
|-------------------|--------|--------------------------------------------------------|----------------------------------|
| `degreeTitle`     | string | Name of the degree or certificate                      | `"Bachelor of Computer Science"` |
| `holderName`      | string | Full name of the recipient                             | `"Maria Garcia"`                 |
| `institutionName` | string | Name of the issuing institution                        | `"Universidad de Buenos Aires"`  |
| `issuanceDate`    | string | ISO 8601 date of academic issuance (not blockchain tx) | `"2026-03-15"`                   |

### Important

- `holderName` is **never stored on-chain** — it is part of the off-chain credential only. The hash protects integrity without revealing the name.
- Fields are ordered **alphabetically by key name** for hashing (see below).

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

const claimsHash = keccak256(
  encodeAbiParameters(
    [
      { type: "string", name: "degreeTitle" },
      { type: "string", name: "holderName" },
      { type: "string", name: "institutionName" },
      { type: "string", name: "issuanceDate" },
    ],
    [
      "Bachelor of Computer Science",
      "Maria Garcia",
      "Universidad de Buenos Aires",
      "2026-03-15",
    ]
  )
);
```

### Using the shared utility

```typescript
import { computeClaimsHash } from "./src/credential";

const claimsHash = computeClaimsHash({
  degreeTitle: "Bachelor of Computer Science",
  holderName: "Maria Garcia",
  institutionName: "Universidad de Buenos Aires",
  issuanceDate: "2026-03-15",
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

Given a presented credential:

```json
{
  "certificateId": "0x...",
  "issuer": "0x...",
  "claims": {
    "degreeTitle": "Bachelor of Computer Science",
    "holderName": "Maria Garcia",
    "institutionName": "Universidad de Buenos Aires",
    "issuanceDate": "2026-03-15"
  },
  "recipientCommitment": "0x..."
}
```

A verifier:

1. Extracts the `certificateId` from the presentation.
2. Recomputes `claimsHash = computeClaimsHash(claims)`.
3. Calls `verifyCertificate(certificateId, claimsHash)` on-chain.
4. Checks: `exists && hashMatch && !revoked`.
5. Optionally checks that `issuer` is part of the federation via `isActiveIssuer(issuer)`. Certificates issued when the issuer was Active remain cryptographically verifiable even if that issuer is later removed by governance; the trust decision at that point is up to the verifier.

---

## Extending the Schema (Future)

Adding a new claim field to `CredentialClaims` **changes the hash** and is a breaking change. Options:

- Version the schema: add a `schemaVersion` field.
- Maintain backward compatibility by accepting both old and new schemas.
- Use a schema registry on-chain (out of MVP scope).

For MVP, the four-field schema above is fixed.
