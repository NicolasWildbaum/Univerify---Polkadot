function getStoredValue(storageKey: string, defaultKey: string, defaultValue: string) {
	const storedValue = localStorage.getItem(storageKey);
	const previousDefault = localStorage.getItem(defaultKey);
	localStorage.setItem(defaultKey, defaultValue);

	if (!storedValue || storedValue === previousDefault) {
		return defaultValue;
	}

	return storedValue;
}

export function getInitialUniverifyAddress(storageKey: string, defaultAddress: string) {
	return getStoredValue(storageKey, `${storageKey}:default`, defaultAddress);
}
