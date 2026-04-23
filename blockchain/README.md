# Blockchain

This directory contains the chain-side part of the project: a Cumulus parachain runtime, the reference Proof-of-Existence pallet, generated chain specs, and the Zombienet topology used by the local full-stack scripts.

The runtime is not a standalone node implementation. The repo expects external Polkadot SDK binaries such as `polkadot-omni-node`, `polkadot`, and `eth-rpc`, either downloaded into `./bin/` by [`../scripts/download-sdk-binaries.sh`](../scripts/download-sdk-binaries.sh) or provided by Docker.

## Directory Map

| Path | Purpose |
| --- | --- |
| [`pallets/template/`](pallets/template/) | Reference FRAME pallet for 32-byte Proof-of-Existence claims |
| [`runtime/`](runtime/) | Parachain runtime that hosts the pallet, `pallet-revive`, and Statement Store runtime APIs |
| [`chain_spec.json`](chain_spec.json) | Generated local chain spec used by scripts and Docker |
| [`zombienet.toml`](zombienet.toml) | Relay-backed local topology for Statement Store-ready runs |
| [`Dockerfile`](Dockerfile) | Image used to package the runtime/chain spec for lightweight chain startup |

## Runtime Responsibilities

- Hosts the template pallet under `TemplatePallet`.
- Exposes `pallet-revive`, which is what the local `eth-rpc` adapter targets for EVM-compatible execution.
- Includes Statement Store runtime support used by the CLI and smoke tests.
- Produces the WASM runtime that `polkadot-omni-node` boots with the generated chain spec.

## Development Modes

| Mode | Command | When to use it |
| --- | --- | --- |
| Solo node | [`../scripts/start-dev.sh`](../scripts/start-dev.sh) | Fastest pallet/runtime loop. No Statement Store RPCs on this path. |
| Relay-backed network | [`../scripts/start-local.sh`](../scripts/start-local.sh) | Runtime validation against a local relay + parachain topology. |
| Full stack | [`../scripts/start-all.sh`](../scripts/start-all.sh) | Runtime + contracts + `eth-rpc` + frontend in one flow. |

## Common Commands

```bash
# Build runtime
cargo build -p stack-template-runtime --release

# Pallet tests
cargo test -p pallet-template

# Runtime tests
cargo test -p stack-template-runtime

# Workspace tests with benchmarks enabled
SKIP_PALLET_REVIVE_FIXTURES=1 cargo test --workspace --features runtime-benchmarks
```

## Notes

- `chain_spec.json` is generated output. Rebuild it through the scripts instead of editing it manually.
- If you need Statement Store locally, use the relay-backed path, not `start-dev.sh`.
- The current product path depends on this runtime because Univerify is deployed as Solidity on top of `pallet-revive`, not as a standalone Ethereum chain.
