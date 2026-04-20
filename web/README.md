# Web

React frontend for **Univerify** plus the original template pages.

## Stack

- React 18 + Vite + TypeScript + Tailwind.
- [viem](https://viem.sh/) for EVM reads through `eth-rpc`.
- `pallet_revive::call` for writes, signed by the connected Polkadot wallet (`src/account/reviveCall.ts`), so every contract write is a Substrate extrinsic.
- Every write is pre-flighted with `publicClient.simulateContract` so custom-error names (`CannotProposeSelfRemoval`, `IssuerAlreadyExists`, ...) surface instead of the opaque `Revive.ContractReverted`.
- [PAPI](https://papi.how/) for pallet-side reads.
- Zustand for state.

## Univerify pages

- `src/pages/GovernancePage.tsx` — apply / re-apply (Removed → Pending via new `issuerEpoch`), approve, propose removal, vote. Accepts both SS58 and 0x addresses and converts to H160 internally.
- `src/pages/UniverifyIssuerPage.tsx` — issue / revoke certificates.
- `src/pages/PublicVerifyPage.tsx` — presentation-based verification.
- `src/pages/MyCertificatesPage.tsx` — student view via soulbound NFT enumeration.
- `src/config/univerify.ts` — ABI + `IssuerStatus` mirror (must stay in sync with the contract).
- `src/utils/contractErrors.ts` — custom-error parser and user-facing hints.

Template pages (Home, Pallet / EVM / PVM Proof of Existence, Statements, Accounts) remain available for reference.

## Local Development

Run the frontend directly:

```bash
cd web
npm install
npm run dev
```

Or, from the repo root, if the chain is already running and you want the scripted dev flow:

```bash
./scripts/start-frontend.sh
```

## Endpoint Configuration

The app uses configurable Substrate WebSocket and Ethereum JSON-RPC endpoints.

For hosted builds:

```bash
cp web/.env.example web/.env.local
```

Set:

- `VITE_WS_URL`
- `VITE_ETH_RPC_URL`

For local scripted development, [`../scripts/start-all.sh`](../scripts/start-all.sh) and [`../scripts/start-frontend.sh`](../scripts/start-frontend.sh) export:

- `VITE_LOCAL_WS_URL`
- `VITE_LOCAL_ETH_RPC_URL`

That keeps the browser aligned with the active local stack ports.

## PAPI Descriptors

Generated descriptors live in [`.papi/`](.papi/).

Useful commands:

```bash
cd web
npm run update-types
npm run codegen
npm run build
npm run lint
npm run fmt
```

## Deployment Data

The frontend keeps [`src/config/deployments.ts`](src/config/deployments.ts) checked in as a stub so a fresh clone still works. Contract deploy scripts update that file automatically after successful deployment.

See [`../contracts/README.md`](../contracts/README.md) for contract deployment flows and [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for hosted frontend deployment options.
