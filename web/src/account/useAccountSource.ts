// Single hook that returns the currently active AccountSource.
//
// For now it is hardcoded to the dev-account source. A future PR will replace
// this with a context provider that swaps in a wallet-backed source on
// connect. Pages should consume this hook (never `evmDevAccounts` directly)
// so that swap is a single-line change.

import { devAccountSource } from "./devAccountSource";
import type { AccountSource } from "./AccountSource";

export function useAccountSource(): AccountSource {
	return devAccountSource;
}
