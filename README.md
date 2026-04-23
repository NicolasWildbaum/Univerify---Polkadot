# Univerify on Polkadot

Univerify is an academic credential platform built on the Polkadot stack. The production-facing path in this repository is an EVM-compatible contract system deployed through `pallet-revive`, backed by a React frontend and local orchestration scripts. The repo also keeps the original Proof-of-Existence pallet, EVM/PVM demo contracts, and Statement Store tooling as reference implementations and testing fixtures.

## Architecture

| Layer | Role | Main paths |
| --- | --- | --- |
| Runtime | Cumulus-based parachain runtime with `pallet-revive`, the template PoE pallet, and Statement Store runtime APIs | [`blockchain/`](blockchain/) |
| Product contracts | Federated issuer registry and soulbound certificate NFT used by Univerify | [`contracts/evm/contracts/Univerify.sol`](contracts/evm/contracts/Univerify.sol), [`contracts/evm/contracts/CertificateNft.sol`](contracts/evm/contracts/CertificateNft.sol) |
| Reference contracts | Proof-of-Existence examples for EVM and PVM/PolkaVM | [`contracts/evm/contracts/ProofOfExistence.sol`](contracts/evm/contracts/ProofOfExistence.sol), [`contracts/pvm/contracts/ProofOfExistence.sol`](contracts/pvm/contracts/ProofOfExistence.sol) |
| Frontend | React app for issuer onboarding, governance, issuance, student certificates, and public verification | [`web/`](web/) |
| CLI | Rust tooling for chain inspection, Statement Store, Bulletin uploads, the template pallet, and PoE demo contracts | [`cli/`](cli/) |
| Automation | Local stack, deployment, binary download, and smoke/E2E scripts | [`scripts/`](scripts/) |
| Presentation assets | Reveal.js deck and demo material | [`files/`](files/) |

The contracts write their deployed addresses to both `deployments.json` at the repo root and [`web/src/config/deployments.ts`](web/src/config/deployments.ts), which keeps the CLI and frontend aligned.

## What Is Product vs Reference

- Product: [`contracts/evm/contracts/Univerify.sol`](contracts/evm/contracts/Univerify.sol) + [`contracts/evm/contracts/CertificateNft.sol`](contracts/evm/contracts/CertificateNft.sol), the React app in [`web/`](web/), and the local stack that exposes `pallet-revive` through `eth-rpc`.
- Runtime infrastructure: the parachain runtime in [`blockchain/runtime/`](blockchain/runtime/) is required because it hosts `pallet-revive`.
- Reference/demo modules: the FRAME pallet in [`blockchain/pallets/template/`](blockchain/pallets/template/), the EVM/PVM `ProofOfExistence` contracts, and the CLI `contract`/`prove` flows that exercise them.
- Optional integrations: Statement Store and Bulletin upload flows are present for demos, testing, and hackathon-style workflows, but they are not the main Univerify product path.

See [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md) for the detailed contract-level design of Univerify.

## Quick Start

### Recommended full local stack

```bash
./scripts/start-all.sh
```

This script:

1. Builds the runtime and chain spec.
2. Starts a relay-backed local network through Zombienet.
3. Starts `eth-rpc`.
4. Deploys the EVM and PVM PoE demo contracts.
5. Deploys `Univerify` and `CertificateNft`.
6. Builds the CLI.
7. Starts the frontend.

Default endpoints:

- Substrate RPC: `ws://127.0.0.1:9944`
- Ethereum RPC: `http://127.0.0.1:8545`
- Frontend: `http://127.0.0.1:5173`

### Docker-based chain only

```bash
docker compose up -d

cd contracts/evm
npm install
npm run deploy:univerify:local

cd ../..
cd web
npm install
npm run dev
```

This path is useful when you want Docker to host the chain and `eth-rpc`, while contract deployment and frontend development stay on the host.

## Repository Guide

- [`blockchain/README.md`](blockchain/README.md): runtime, pallet, chain-spec, and local network details.
- [`contracts/README.md`](contracts/README.md): product contracts vs demo contracts, deploy flows, and shared outputs.
- [`web/README.md`](web/README.md): frontend routes, data flow, and environment variables.
- [`cli/README.md`](cli/README.md): Rust CLI capabilities and boundaries.
- [`scripts/README.md`](scripts/README.md): one-command workflows.
- [`files/README.md`](files/README.md): presentation deck setup.

## Tooling

- Rust workspace: `blockchain/runtime`, `blockchain/pallets/template`, `cli`
- Node.js projects: `web`, `contracts/evm`, `contracts/pvm`, `files`
- Local SDK binaries: downloaded into `./bin/` by [`scripts/download-sdk-binaries.sh`](scripts/download-sdk-binaries.sh)

Primary versions currently wired by the repo:

- `polkadot-sdk` `stable2512-3`
- `pallet-revive` `0.12.x`
- Node.js `22.x`
- Solidity `0.8.28`
- React `18`
- PAPI `1.23.x`

## Common Commands

```bash
# Rust
cargo +nightly fmt
cargo clippy --workspace
cargo test -p pallet-template
cargo test -p stack-template-runtime
cargo test -p stack-cli

# Frontend
cd web && npm run lint
cd web && npm run build

# Contracts
cd contracts/evm && npx hardhat test
cd contracts/pvm && npx hardhat test

# Full-stack smoke test
./scripts/test-statement-store-smoke.sh
```

## Documentation

- [`docs/INSTALL.md`](docs/INSTALL.md): native setup and binary fallback notes
- [`docs/TOOLS.md`](docs/TOOLS.md): stack components used by the project
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): hosted/frontend deployment guidance
- [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md): Univerify contract design

## License

[MIT](LICENSE)
