import { parsePositiveInt } from "@/lib/api/rate-limit";
import { readTrustProxyHeaders } from "@/lib/security/config";

/**
 * A client key derived from forwarded headers.
 *
 * READ THIS BEFORE USING IT FOR ANYTHING ELSE. The result is a BUCKETING HINT, never an identity.
 * X-Forwarded-For is attacker-controlled, and this codebase already has the right precedent for
 * refusing to make a security decision from a forwarded header: shouldMarkCookieSecure()
 * (src/lib/auth.ts:131) will not read x-forwarded-proto to drop the Secure flag. The rule here is
 * the same with one sharper distinction - forwarded headers are used for bucketing, never for
 * authorization, and never as evidence in an audit record beyond a labelled hint.
 *
 * Why use them at all: NextRequest in Next 16 exposes no .ip and a route handler has no socket
 * address. An app that ignores forwarded headers has NO client identity, so every anonymous caller
 * collapses into one bucket - which converts the login limiter into a remote lockout switch where
 * one attacker denies login to everyone. A spoofable key is the better failure mode, and the
 * login_account bucket is the compensating control that spoofing cannot reach.
 *
 * TRUST_PROXY_HEADERS decides which of those two failure modes this deployment picked, and reads
 * through src/lib/security/config.ts's readTrustProxyHeaders() - the same warn-once bridge that
 * guards CSP_REPORT_ONLY and HSTS_INCLUDE_SUBDOMAINS - rather than comparing process.env directly,
 * so a typo'd value warns once and keeps the default instead of silently flipping the posture.
 * TRUSTED_PROXY_HOPS answers the second failure mode directly: it names which hop in the forwarded
 * chain is this deployment's own reverse proxy, so a caller behind that proxy is bucketed on the
 * client the proxy reported rather than on the proxy itself (which would lump every user behind it
 * into one bucket and let one abuser lock out everyone else).
 */

/** No usable signal. Audit omits the field rather than recording this as an address. */
const UNKNOWN = "unknown";
const MAX_ADDRESS_LENGTH = 64;
const MAX_HOPS = 16;

export function clientAddress(request: { headers: Headers }): string {
  if (!readTrustProxyHeaders()) return UNKNOWN;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) {
      const hops = parsePositiveInt(process.env.TRUSTED_PROXY_HOPS, 0, MAX_HOPS);
      // 0 means "the leftmost entry", the conventional client position. A non-zero value counts
      // back from the rightmost entry, which is the hop the operator's own proxy appended.
      const index = hops === 0 ? 0 : Math.min(Math.max(entries.length - 1 - hops, 0), entries.length - 1);
      return entries[index].slice(0, MAX_ADDRESS_LENGTH);
    }
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, MAX_ADDRESS_LENGTH);

  return UNKNOWN;
}
