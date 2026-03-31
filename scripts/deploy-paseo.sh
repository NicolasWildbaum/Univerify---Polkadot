#!/usr/bin/env bash
set -euo pipefail

echo "=== Deploy Contracts to Polkadot TestNet ==="
echo ""
echo "Make sure you have set your private key:"
echo "  cd contracts/evm && npx hardhat vars set PRIVATE_KEY"
echo "  cd contracts/pvm && npx hardhat vars set PRIVATE_KEY"
echo ""
echo "Get testnet tokens at: https://faucet.polkadot.io/"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Deploy EVM contract (solc)
echo "[1/2] Deploying Solidity counter via EVM (solc)..."
cd "$ROOT_DIR/contracts/evm"
npm install
npx hardhat compile
npx hardhat ignition deploy ./ignition/modules/Counter.js --network polkadotTestnet

# Deploy PVM contract (resolc)
echo "[2/2] Deploying Solidity counter via PVM (resolc)..."
cd "$ROOT_DIR/contracts/pvm"
npm install
npx hardhat compile
npx hardhat ignition deploy ./ignition/modules/Counter.js --network polkadotTestnet

echo ""
echo "=== Deployment complete ==="
