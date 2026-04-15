# AI RULES
Apply always = true

These rules must be strictly followed when generating or modifying code in this repository.

## General Principles

- Prefer **simple, minimal solutions**
- Work **incrementally**
- Do NOT introduce unnecessary abstractions
- Do NOT over-engineer

## Architecture Rules

- The backend is a **Solidity smart contract (EVM)** located in `contracts/evm/`
- DO NOT implement backend logic in `blockchain/`
- DO NOT introduce FRAME pallet code
- DO NOT modify unrelated parts of the template

## Editing Rules

Before writing code:

1. Explain what you are going to do
2. List which files will be modified
3. Explain why

After writing code:

- Explain each change clearly
- Ensure consistency with existing code
- Ensure the project compiles

## Scope Control

DO NOT implement:

- Organization validation systems
- Governance
- DID / identity systems
- Complex indexing
- Features outside the MVP

If unsure → ask before implementing

## Backend Design Compliance

All backend logic MUST follow:

- `docs/BACKEND_DESIGN.md`

Do NOT invent new models or structures unless explicitly requested.

## Smart Contract Rules

- Use Solidity best practices
- Prefer `custom errors` over revert strings
- Use `events` for all state changes
- Avoid unnecessary storage writes
- Minimize gas usage when possible
- Use `keccak256` for hashing

## Access Control

- Use a simple admin model for MVP
- Use mappings like `authorizedIssuers`
- Avoid complex role systems (no OpenZeppelin AccessControl unless necessary)

## Security & Data Rules

- NEVER store PII on-chain
- Always use hashes for sensitive data
- Validate all inputs

## Code Quality

- Keep contracts small and readable
- Avoid deeply nested logic
- Avoid unnecessary inheritance

## Communication Style

- Be precise
- Be explicit
- Avoid assumptions
- Ask questions when needed