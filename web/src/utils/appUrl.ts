function getAppBasePathname() {
	const path = window.location.pathname || "/";
	const withoutIndex = path.replace(/index\.html$/, "");
	return withoutIndex.endsWith("/") ? withoutIndex : `${withoutIndex}/`;
}

export function buildAppHashUrl(route: string, search = ""): string {
	const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
	return `${window.location.origin}${getAppBasePathname()}#${normalizedRoute}${search}`;
}
