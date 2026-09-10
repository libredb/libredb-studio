/** Validate the build-time deployment prefix before Next.js bakes it into routes. */
export function readBasePath(value = ""): string {
  if (value === "" || value === "/") return "";
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(
      "BASE_PATH must be empty or an absolute path such as /tools/libredb, without a trailing slash, dot segments, encoding, query or fragment.",
    );
  }
  return value;
}

// next.config.ts supplies this value at build time. Reading BASE_PATH here would
// allow runtime configuration to disagree with the already-built client router.
export function getBasePath(): string {
  return process.env.NEXT_PUBLIC_BASE_PATH || "";
}

/** For fetch, native browser navigation and public assets; Next's router/Link prefix themselves. */
export function withBasePath(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? `${getBasePath()}${path}` : path;
}

/** Preserve fetch's arguments and cancellation while applying the application's prefix. */
export function appFetch(path: string, ...init: [RequestInit?]): Promise<Response> {
  return fetch(withBasePath(path), ...init);
}
