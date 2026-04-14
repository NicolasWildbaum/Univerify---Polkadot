# AI RULES
apply always = true

These rules must be strictly followed when generating or modifying code in this repository.

## General Principles

- Prefer **simple, minimal solutions**
- Work **incrementally**
- Do NOT introduce unnecessary abstractions
- Do NOT over-engineer

## Architecture Rules

- The backend is a **FRAME pallet (Rust)** located in `blockchain/`
- DO NOT implement backend logic in `contracts/`
- DO NOT introduce smart contracts unless explicitly requested
- DO NOT modify unrelated parts of the template

## Editing Rules

Before writing code:

1. Explain what you are going to do
2. List which files will be modified
3. Explain why

After writing code:

- Explain each change clearly
- Ensure consistency with existing code
- Ensure the project still compiles

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

## Storage Rules

- Avoid unnecessary storage items
- Avoid duplicating data
- Keep storage minimal and efficient

## Security & Data Rules

- NEVER store PII on-chain
- Always use hashes for sensitive data
- Validate all inputs

## Code Quality

- Follow Rust best practices
- Avoid panics in production code
- Keep functions small and readable

## Communication Style

- Be precise
- Be explicit
- Avoid assumptions
- Ask questions when needed