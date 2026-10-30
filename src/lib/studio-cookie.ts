/**
 * The scope of a Studio cookie in the current request: `secureCookieDecision` (src/lib/auth-cookies.ts) over the Host
 * and x-forwarded-proto headers `headers()` returns, for the route handlers and the modules they call. The proxy
 * reads the same two headers from its own request (src/proxy.ts), so both always agree on a cookie's name.
 */
import { headers } from "next/headers";
import { type CookieScope, cookieScope, secureCookieDecision } from "@/lib/auth-cookies";

/** Whether this request's cookies carry the Secure flag, and so `__Host-` names. */
async function shouldMarkCookieSecure(): Promise<boolean> {
  try {
    const headerStore = await headers();
    return secureCookieDecision({
      host: headerStore.get("host"),
      forwardedProto: headerStore.get("x-forwarded-proto"),
    });
  } catch {
    // No request scope (headers() throws): the decision keeps the stricter default.
    return secureCookieDecision(undefined);
  }
}

/**
 * The name, path and Secure flag a Studio cookie takes in this request: `__Host-<base name>` at Path=/ whenever it is
 * Secure, else the base name at `plainPath`. Set with all three, read by `name` alone and deleted with
 * `cookieDeletion`.
 */
export async function studioCookie(baseName: string, plainPath: string): Promise<CookieScope> {
  return cookieScope(baseName, plainPath, await shouldMarkCookieSecure());
}
