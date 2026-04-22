type DiagnosticLevel = "debug" | "info" | "warn" | "error";

interface DiagnosticEvent {
	timestamp: string;
	scope: string;
	event: string;
	level: DiagnosticLevel;
	details?: unknown;
}

interface DiagnosticStore {
	sessionId: string;
	startedAt: string;
	lastUpdatedAt: string;
	events: DiagnosticEvent[];
	state: Record<string, unknown>;
}

const MAX_EVENTS = 200;

function randomId(): string {
	return Math.random().toString(36).slice(2, 10);
}

function sanitizeDiagnosticValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (depth > 4) return "[MaxDepth]";
	if (value === null || value === undefined) return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
	if (value instanceof Error) return serializeError(value);
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeDiagnosticValue(item, depth + 1, seen));
	}
	if (typeof value === "object") {
		if (seen.has(value as object)) return "[Circular]";
		seen.add(value as object);
		const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			sanitizeDiagnosticValue(item, depth + 1, seen),
		]);
		return Object.fromEntries(entries);
	}
	return value;
}

function getStore(): DiagnosticStore {
	if (!window.__UNIVERIFY_DEBUG__) {
		const now = new Date().toISOString();
		window.__UNIVERIFY_DEBUG__ = {
			sessionId: randomId(),
			startedAt: now,
			lastUpdatedAt: now,
			events: [],
			state: {},
		};
	}
	return window.__UNIVERIFY_DEBUG__;
}

export function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		const withCause = error as Error & { cause?: unknown };
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: withCause.cause ? sanitizeDiagnosticValue(withCause.cause, 1) : undefined,
		};
	}
	return sanitizeDiagnosticValue(error, 1);
}

export function setDiagnosticState(key: string, value: unknown): void {
	const store = getStore();
	store.state[key] = sanitizeDiagnosticValue(value);
	store.lastUpdatedAt = new Date().toISOString();
}

export function logDiagnostic(
	scope: string,
	event: string,
	details?: unknown,
	level: DiagnosticLevel = "info",
): void {
	const store = getStore();
	const payload: DiagnosticEvent = {
		timestamp: new Date().toISOString(),
		scope,
		event,
		level,
		details: sanitizeDiagnosticValue(details),
	};

	store.events.push(payload);
	if (store.events.length > MAX_EVENTS) {
		store.events.splice(0, store.events.length - MAX_EVENTS);
	}
	store.lastUpdatedAt = payload.timestamp;

	const label = `[Univerify:${scope}] ${event}`;
	if (level === "error") {
		console.error(label, payload.details);
		return;
	}
	if (level === "warn") {
		console.warn(label, payload.details);
		return;
	}
	if (level === "debug") {
		console.debug(label, payload.details);
		return;
	}
	console.info(label, payload.details);
}

function inCrossOriginIframe(): boolean {
	try {
		return window !== window.top;
	} catch {
		return true;
	}
}

export function getRuntimeContextSnapshot(): Record<string, unknown> {
	return {
		href: window.location.href,
		origin: window.location.origin,
		host: window.location.host,
		hostname: window.location.hostname,
		referrer: document.referrer || null,
		userAgent: navigator.userAgent,
		isSecureContext: window.isSecureContext,
		visibilityState: document.visibilityState,
		inCrossOriginIframe: inCrossOriginIframe(),
		injectedExtensions: Object.keys(window.injectedWeb3 ?? {}),
	};
}
