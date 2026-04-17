// Dev-mnemonic backed AccountSource — the temporary account source used while
// the app does not yet integrate a real wallet connector. All real keys live
// in `config/evm.ts`; this module only adapts them to the AccountSource API.

import type { AccountOption, AccountSource } from "./AccountSource";
import { evmDevAccounts, getWalletClient as createDevWalletClient } from "../config/evm";

export const devAccountSource: AccountSource = {
	kind: "dev",
	listAccounts(): AccountOption[] {
		return evmDevAccounts.map((acc, index) => ({
			id: String(index),
			label: acc.name,
			address: acc.account.address,
		}));
	},
	async getWalletClient(accountId, ethRpcUrl) {
		const index = Number(accountId);
		if (!Number.isInteger(index) || index < 0 || index >= evmDevAccounts.length) {
			throw new Error(`Unknown dev account id: ${accountId}`);
		}
		return createDevWalletClient(index, ethRpcUrl);
	},
};
