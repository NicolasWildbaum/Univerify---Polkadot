// Account-source abstraction.
//
// Pages that need to sign EVM transactions go through an `AccountSource`
// rather than reaching into `config/evm.ts` directly. This isolates the
// account-selection mechanism from any business logic, so we can later swap
// the dev-account selector for a Polkadot/Talisman/MetaMask-style wallet
// connector without touching page state or contract logic.
//
// The interface intentionally stays minimal: list accounts (for selectors)
// and produce a viem WalletClient bound to one. Anything more (chain switching,
// connect/disconnect prompts, multi-source aggregation) belongs in concrete
// implementations or a future provider.

import type { Address, WalletClient } from "viem";

export type AccountSourceKind = "dev" | "wallet";

export interface AccountOption {
	/** Stable identifier within the source (e.g. dev-account index, wallet account id). */
	id: string;
	/** Human-readable label for selectors (e.g. "Alice", or a shortened wallet address). */
	label: string;
	/** EVM address of the account. */
	address: Address;
}

export interface AccountSource {
	readonly kind: AccountSourceKind;
	/** All accounts the source currently exposes. May be empty if the user
	 *  hasn't connected a wallet yet. */
	listAccounts(): AccountOption[];
	/** Build a WalletClient for the given account, configured for an EVM RPC URL.
	 *  Implementations are free to cache. */
	getWalletClient(accountId: string, ethRpcUrl: string): Promise<WalletClient>;
}
