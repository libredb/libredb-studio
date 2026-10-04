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

/**
 * Where this tab is, app-relative: the prefix is stripped, because the Next router and
 * withBasePath() both add it again and a path that already carries it would be prefixed twice.
 */
export function currentAppPath(): string {
  const base = getBasePath();
  let { pathname } = window.location;
  if (base !== "" && (pathname === base || pathname.startsWith(`${base}/`))) {
    pathname = pathname.slice(base.length) || "/";
  }
  return `${pathname}${window.location.search}`;
}

/**
 * ApiErrorCode.AUTH_REQUIRED (src/lib/api/error-codes.ts), the code of the session-required 401
 * (#1420). Written out rather than imported because next.config.ts reads this file, and a config
 * file cannot resolve the `@/` alias: this file stays import-free. A test pins the two together.
 */
export const SESSION_REQUIRED_CODE = "AUTH_REQUIRED";

let sessionEndedHandler: (() => void) | null = null;

/**
 * Registers what the page does when an API call reports that the session has ended, and returns
 * the function that removes it. Only the standalone app registers one (its root layout). An
 * application that embeds the published components and handles sign-in itself registers nothing,
 * and a 401 then reaches its own code untouched, as before.
 */
export function onSessionEnded(handler: () => void): () => void {
  sessionEndedHandler = handler;
  return () => {
    if (sessionEndedHandler === handler) sessionEndedHandler = null;
  };
}

/**
 * Calls the registered handler when `response` is the session-required answer. Keyed on the code,
 * not the status: 401 also reports a database refusing its credentials and a model provider
 * refusing its key, with the session intact. Reads a clone, so the caller can still read the body,
 * and never throws: a body that is not JSON is simply not that answer.
 */
async function noticeSessionEnded(response: Response): Promise<void> {
  if (response.status !== 401 || sessionEndedHandler === null) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  if ((body as { code?: unknown } | null)?.code === SESSION_REQUIRED_CODE) sessionEndedHandler?.();
}

/**
 * Preserve fetch's arguments and cancellation while applying the application's prefix. A
 * session-required 401 is also reported to the page's session-ended handler, when it has one; the
 * response itself is returned unchanged either way.
 */
export async function appFetch(path: string, ...init: [RequestInit?]): Promise<Response> {
  const response = await fetch(withBasePath(path), ...init);
  await noticeSessionEnded(response);
  return response;
}
