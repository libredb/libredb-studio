import { isLoopbackHost } from "@/lib/auth";
import { readTrustProxyHeaders } from "@/lib/security/config";

/**
 * The scheme a request arrived on, for a DISPLAY WARNING only: the admin discovery card
 * (GET /api/admin/discovery) warns while the session cookie can travel over plain HTTP.
 *
 * Never base a security decision on this. x-forwarded-proto and x-forwarded-host are attacker-supplied
 * unless a reverse proxy overwrites them, which is why shouldMarkCookieSecure() in src/lib/auth.ts will
 * not drop the Secure flag on their word. They are read here only behind readTrustProxyHeaders(), the
 * gate origin-check.ts uses for x-forwarded-host. CapRover's nginx overwrites X-Forwarded-Proto with $scheme.
 */
export function requestScheme(request: Request): "http" | "https" {
  if (readTrustProxyHeaders()) {
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded === "http" || forwarded === "https") return forwarded;
  }
  return new URL(request.url).protocol === "https:" ? "https" : "http";
}

function requestHost(request: Request): string {
  if (readTrustProxyHeaders()) {
    const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return request.headers.get("host")?.trim() || new URL(request.url).host;
}

/** True when the request arrived over http on a host that is not loopback. Display only, see above. */
export function isPlainHttpRequest(request: Request): boolean {
  return requestScheme(request) === "http" && !isLoopbackHost(requestHost(request));
}
