// Generic <select>-based picker rendered from the current AccountSource.
// Stays presentational: it owns no state, never imports concrete sources.

import { useAccountSource } from "./useAccountSource";

interface AccountSelectorProps {
	value: string;
	onChange: (accountId: string) => void;
	label?: string;
	helpText?: string;
}

export function AccountSelector({ value, onChange, label, helpText }: AccountSelectorProps) {
	const source = useAccountSource();
	const accounts = source.listAccounts();
	if (accounts.length === 0) {
		return (
			<div>
				{label && <label className="label">{label}</label>}
				<p className="text-sm text-text-muted">No accounts available.</p>
			</div>
		);
	}
	return (
		<div>
			{label && <label className="label">{label}</label>}
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="input-field w-full"
			>
				{accounts.map((acc) => (
					<option key={acc.id} value={acc.id}>
						{acc.label} ({acc.address})
					</option>
				))}
			</select>
			{helpText && <p className="text-xs text-text-muted mt-2">{helpText}</p>}
		</div>
	);
}
