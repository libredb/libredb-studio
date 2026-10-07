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
 * Reports that the session has ended, from a check that is not an appFetch answer (GET
 * /api/auth/me answering 401): the registered handler sends the tab to sign in. Nothing happens
 * without one.
 */
export function reportSessionEnded(): void {
  sessionEndedHandler?.();
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
 * The request header that names the account this tab claimed the browser copy for, URI-encoded
 * so any username fits a header value. The proxy (src/proxy.ts) answers 409 with
 * WORKSPACE_OWNER_MISMATCH_CODE when it is not the signed-in account.
 */
export const WORKSPACE_OWNER_HEADER = "X-LibreDB-Workspace-Owner";

/**
 * ApiErrorCode.WORKSPACE_OWNER_MISMATCH (src/lib/api/error-codes.ts), written out for the reason
 * SESSION_REQUIRED_CODE is. A test pins the two together.
 */
export const WORKSPACE_OWNER_MISMATCH_CODE = "WORKSPACE_OWNER_MISMATCH";

let workspaceOwner: string | null = null;

/**
 * Records the account this tab claimed the browser copy for, in server storage mode
 * (`claimAccountWorkspace`), so every request it sends from then on names it; null sends none.
 * Nothing is held in local mode or before a claim.
 */
export function holdWorkspaceOwner(username: string | null): void {
  workspaceOwner = username;
}

/** The account this tab claimed the browser copy for, or null when it holds no claim. */
export function heldWorkspaceOwner(): string | null {
  return workspaceOwner;
}

/** Adds the owner header to an app request; any other request, or no claim, passes as it came. */
function withWorkspaceOwner(path: string, init: [RequestInit?], owner: string | null): [RequestInit?] {
  if (owner === null || !path.startsWith("/") || path.startsWith("//")) return init;
  const headers = new Headers(init[0]?.headers);
  headers.set(WORKSPACE_OWNER_HEADER, encodeURIComponent(owner));
  return [{ ...init[0], headers }];
}

/**
 * The browser copy this tab claimed belongs to a different account than the one signed in now
 * (another tab signed in as someone else). The tab reloads, so the owner check runs again for the
 * account signed in now. Reads a clone and never throws, as noticeSessionEnded does.
 */
async function noticeOwnerMismatch(response: Response, owner: string | null): Promise<void> {
  if (response.status !== 409 || owner === null) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  if ((body as { code?: unknown } | null)?.code === WORKSPACE_OWNER_MISMATCH_CODE) window.location.reload();
}

/**
 * Preserve fetch's arguments and cancellation while applying the application's prefix. A
 * session-required 401 is also reported to the page's session-ended handler, when it has one; the
 * response itself is returned unchanged either way. While this tab holds a claim on the browser
 * copy, every app request names its account (WORKSPACE_OWNER_HEADER), and an answer that it is not
 * the signed-in account reloads the tab.
 */
export async function appFetch(path: string, ...init: [RequestInit?]): Promise<Response> {
  const owner = workspaceOwner;
  const response = await fetch(withBasePath(path), ...withWorkspaceOwner(path, init, owner));
  await noticeSessionEnded(response);
  await noticeOwnerMismatch(response, owner);
  return response;
}
