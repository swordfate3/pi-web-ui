/** Only the package-owned Hub route gets a same-origin home link. */
export function hubHomePath(pathname: string): string | null {
  return /^\/s\/[a-f0-9]{32}\/(?:index\.html)?$/.test(pathname) ? "/sessions/" : null;
}

/** Routes belong to the current page entry, including a reverse-proxy subpath. */
export function webBasePath(pathname: string): string {
  if (pathname.endsWith("/index.html")) return pathname.slice(0, -"index.html".length);
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function webRoute(route: string, pathname: string): string {
  const relative = route.replace(/^\//, "");
  if (
    !/^[a-z0-9_./-]+$/i.test(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error("Invalid Pi Web route");
  }
  return `${webBasePath(pathname)}${relative}`;
}
