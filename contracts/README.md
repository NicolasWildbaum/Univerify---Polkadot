# Contracts

This directory contains two different contract tracks:

- the actual Univerify product contracts in [`evm/`](evm/),
- the older Proof-of-Existence demo contracts in [`evm/`](evm/) and [`pvm/`](pvm/).

The distinction matters: the frontend is built around Univerify, while the CLI and some scripts still exercise the PoE demos for reference and testing.

## Product Contracts

| Contract | Role |
| --- | --- |
| [`evm/contracts/Univerify.sol`](evm/contracts/Univerify.sol) | Federated issuer registry, issuer governance, certificate issuance/revocation, public verification data |
| [`evm/contracts/CertificateNft.sol`](evm/contracts/CertificateNft.sol) | Soulbound ERC-721 receipt minted to the student wallet on issuance |

Supporting files:

- design spec: [`../BACKEND_DESIGN.md`](../BACKEND_DESIGN.md)
- deployment script: [`evm/scripts/deploy-univerify.ts`](evm/scripts/deploy-univerify.ts)
- tests: [`evm/test/Univerify.test.ts`](evm/test/Univerify.test.ts), [`evm/test/CertificateNft.test.ts`](evm/test/CertificateNft.test.ts)
- genesis issuer configs: [`evm/config/`](evm/config/)

`deploy-univerify.ts` deploys both contracts, wires the NFT into the registry, and updates:

- `deployments.json`
- [`../web/src/config/deployments.ts`](../web/src/config/deployments.ts)

## Reference Contracts

| Contract | Path | VM |
| --- | --- | --- |
| Proof-of-Existence demo (EVM) | [`evm/contracts/ProofOfExistence.sol`](evm/contracts/ProofOfExistence.sol) | REVM via `pallet-revive` |
| Proof-of-Existence demo (PVM) | [`pvm/contracts/ProofOfExistence.sol`](pvm/contracts/ProofOfExistence.sol) | PolkaVM via `resolc` |

These contracts are still useful for:

- comparing FRAME vs EVM vs PVM implementations of the same idea,
- exercising the CLI `contract` and `prove --contract` flows,
- smoke-testing the local stack.

## Local Flows

### Full stack

From the repo root:

```bash
./scripts/start-all.sh
```

This deploys:

- EVM `ProofOfExistence`
- PVM `ProofOfExistence`
- `Univerify`
- `CertificateNft`

### Manual local deployment against a running chain

```bash
# Product contracts
cd contracts/evm
npm install
npx hardhat compile
npm run deploy:univerify:local

# Reference demos
npm run deploy:local
cd ../pvm
npm install
npx hardhat compile
npm run deploy:local
```

The local chain must already expose `eth-rpc`, typically via [`../scripts/start-all.sh`](../scripts/start-all.sh) or the Docker setup in the repo root.

## Testnet Flows

For the product path:

```bash
cd contracts/evm
npx hardhat vars set PRIVATE_KEY
npm run deploy:univerify:testnet
```

For the reference PoE demos:

```bash
./scripts/deploy-paseo.sh
```

`deploy-paseo.sh` deploys only the demo `ProofOfExistence` contracts. It does not deploy Univerify.

## Common Commands

```bash
cd contracts/evm
npm install
npx hardhat compile
npx hardhat test
npm run fmt

cd ../pvm
npm install
npx hardhat compile
npx hardhat test
npm run fmt
```

## Notes

- The `pvm/` project is reference infrastructure, not the current product path.
- The frontend consumes `univerify` and `certificateNft` addresses when available; the CLI contract commands consume the demo `evm` and `pvm` addresses.
- All deploy scripts preserve a shared address registry so local tooling stays in sync.
