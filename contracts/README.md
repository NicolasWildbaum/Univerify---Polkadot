# Contracts

This directory hosts the Solidity backend. The **Univerify product contracts** live in [`evm/contracts/Univerify.sol`](evm/contracts/Univerify.sol) and [`evm/contracts/CertificateNft.sol`](evm/contracts/CertificateNft.sol); see [`../BACKEND_DESIGN.md`](../BACKEND_DESIGN.md) for the full spec.

The `pvm/` project and the `ProofOfExistence.sol` files are **template leftovers** kept for reference — they compile but are not part of Univerify.

## Univerify

- Registry + federated governance (no owner): `evm/contracts/Univerify.sol`
- Soulbound ERC-721: `evm/contracts/CertificateNft.sol`
- Tests: `evm/test/Univerify.test.ts`, `evm/test/CertificateNft.test.ts`
- Deploy (both + wiring, one script): `evm/scripts/deploy-univerify.ts`

```bash
cd contracts/evm
npm install
npx hardhat compile
npx hardhat test
npm run deploy:local     # local dev chain via eth-rpc
npm run deploy:testnet   # Polkadot Hub TestNet (Paseo)
```

## Template projects (reference only)

| Project | Path | Toolchain | VM backend |
| --- | --- | --- | --- |
| EVM | [`evm/`](evm/) | Hardhat + solc + viem | REVM |
| PVM | [`pvm/`](pvm/) | Hardhat + `@parity/resolc` + viem | PolkaVM |

Each includes its own `ProofOfExistence.sol` entrypoint:

- [`evm/contracts/ProofOfExistence.sol`](evm/contracts/ProofOfExistence.sol)
- [`pvm/contracts/ProofOfExistence.sol`](pvm/contracts/ProofOfExistence.sol)

Both projects target either:

- The local dev chain through `eth-rpc`
- Polkadot Hub TestNet (`420420417`)

## Local Deployment

From the repo root, the recommended full local path is:

```bash
./scripts/start-all.sh
```

Manual path against an already running local node, also from the repo root:

```bash
# Terminal 1
./scripts/start-dev.sh

# Terminal 2
eth-rpc --node-rpc-url "${SUBSTRATE_RPC_WS:-ws://127.0.0.1:9944}" --rpc-port "${STACK_ETH_RPC_PORT:-8545}" --rpc-cors all

# Terminal 3
cd contracts/evm && npm install && npm run deploy:local
cd contracts/pvm && npm install && npm run deploy:local
```

## Testnet Deployment

From the repo root:

```bash
cd contracts/evm && npx hardhat vars set PRIVATE_KEY
cd contracts/pvm && npx hardhat vars set PRIVATE_KEY

./scripts/deploy-paseo.sh
```

You can also deploy each project directly with `npm run deploy:testnet`.

## Shared Deployment Outputs

The deploy scripts update:

- `deployments.json` in the repo root for CLI usage
- [`../web/src/config/deployments.ts`](../web/src/config/deployments.ts) for the frontend

## Common Commands

From the repo root:

```bash
# EVM
cd contracts/evm
npm install
npx hardhat compile
npx hardhat test
npm run fmt

# PVM
cd contracts/pvm
npm install
npx hardhat compile
npx hardhat test
npm run fmt
```

See [`../scripts/README.md`](../scripts/README.md) for the local stack scripts and [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for hosted deployment details.
