function getStoredValue(storageKey: string, defaultKey: string, defaultValue: string) {
	if (defaultValue) {
		localStorage.setItem(defaultKey, defaultValue);
		localStorage.setItem(storageKey, defaultValue);
		return defaultValue;
	}

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
