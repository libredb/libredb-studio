import { logger } from "@/lib/logger";
import { readTrustProxyHeaders } from "@/lib/security/config";

/**
 * Origin check: a second CSRF layer for state-changing requests.
 *
 * The comparison is HOST-ONLY and ignores the scheme. That is deliberate and it is what removes
 * the single largest false-positive class: a TLS-terminating proxy that forwards plain HTTP
 * without setting x-forwarded-proto makes the browser send Origin: https://db.example.com while
 * the app computes http://db.example.com, and comparing schemes there locks the operator out of
 * their own login form. The security given up is an http:// page on the same host posting to the
 * https:// app, which requires an active network attacker who has already broken transport - a
 * smaller threat than the deployment class this protects.
 *
 * GET, HEAD and OPTIONS are exempt by method. That is what lets GET /api/auth/oidc/callback work:
 * it is a legitimate cross-origin top-level navigation from the identity provider, and browsers
 * may omit Origin on it entirely. Method-based exemption covers it without a path special case.
 *
 * A request that carries NEITHER Origin NOR Referer is accepted, but only when its Content-Type is
 * application/json. That is not an off switch smuggled in under another name; it is the one shape
 * a cross-site browser cannot produce against a victim's session, for two independent reasons:
 *
 * - An HTML <form>, the classic CSRF vector, can only submit as
 *   application/x-www-form-urlencoded, multipart/form-data or text/plain - `enctype` has no fourth
 *   value. It is structurally incapable of sending Content-Type: application/json, so this
 *   carve-out is invisible to a <form>-based attack no matter what the form's target does.
 * - A cross-site fetch()/XHR CAN set that content type, but application/json is not one of the
 *   three CORS-safelisted values, so doing so turns the request "non-simple" and forces a
 *   preflight (OPTIONS) before the browser will send the real request with credentials. This
 *   deployment answers no request anywhere with an Access-Control-Allow-* header, so the preflight
 *   is never affirmatively answered and the browser never sends the follow-up carrying the
 *   victim's cookie. (If that ever changes, this reasoning must be re-checked against whatever
 *   route added it.)
 *
 * What remains is a caller that sets its own Content-Type deliberately outside a browser
 * altogether - curl, a server-to-server integration, this project's own documented API examples
 * (scripts/engine-smoke.sh, docs/RANCHER.md, docs/API_DOCS.md all POST JSON with neither Origin
 * nor Referer). That is not a CSRF vector: CSRF is specifically an unwitting BROWSER carrying
 * credentials it did not choose to send. A script that sets its own headers chose to send them.
 *
 * A header that IS present but malformed (e.g. "Origin: /") does NOT qualify for this carve-out -
 * only true absence of both headers does. See the `observedOrigin === ""` guard below.
 */

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginCheckResult {
  allowed: boolean;
  /** The Origin, or the Referer when there was no Origin. Empty when the request carried neither. */
  observedOrigin: string;
  /** The host this deployment computed for itself. Empty when no Host header arrived. */
  expectedHost: string;
}

/** "https://host:port/path" and a bare "host:port" both reduce to "host:port". */
function hostOf(value: string): string | null {
  const withoutScheme = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutScheme.split("/")[0].trim().toLowerCase();
  return host.length > 0 ? host : null;
}

/**
 * True only for a bare "application/json" media type, ignoring parameters (charset, ...) and case,
 * per RFC 9110's media-type grammar: `type "/" subtype *( OWS ";" OWS parameter )`.
 */
function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function selfHost(headers: Headers): string {
  // Gated behind the same trust decision client-address.ts makes for the identical header, for the
  // identical reason: x-forwarded-host is attacker-supplied unless a reverse proxy is known to set
  // it and overwrite any client-supplied copy. An operator who sets TRUST_PROXY_HEADERS=false to
  // declare "no proxy in front of me" must have that decision honoured here too, not just there.
  if (readTrustProxyHeaders()) {
    const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded) return forwarded;
  }
  return headers.get("host")?.trim().toLowerCase() ?? "";
}

let warnedAboutWildcardOrigin = false;

/** Test seam: clears the warn-once latch so each case observes a fresh process. */
export function resetOriginCheckWarnings(): void {
  warnedAboutWildcardOrigin = false;
}

/**
 * Extra hosts the operator vouched for, as origins or bare hosts. A literal "*" is ignored rather
 * than trusted: this is a host allowlist compared exactly, never a CORS-style wildcard, and an
 * operator who copies the CORS convention here would otherwise get silent, unexplained trust of
 * nothing (no real Origin header is ever literally "*") instead of the explicit list they meant to
 * write. Warn once so the mistake is visible instead of a self-hoster wondering why it "did
 * nothing".
 */
function configuredHosts(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  const hosts: string[] = [];
  for (const entry of raw.split(",")) {
    const host = hostOf(entry);
    if (!host) continue;
    if (host === "*") {
      if (!warnedAboutWildcardOrigin) {
        warnedAboutWildcardOrigin = true;
        logger.warn(
          'ALLOWED_ORIGINS contains "*", which is ignored: this is a host allowlist compared exactly, ' +
            "not a CORS wildcard. List the exact host(s) that must be trusted instead.",
          { route: "security" },
        );
      }
      continue;
    }
    hosts.push(host);
  }
  return hosts;
}

export function checkOrigin(request: { method: string; headers: Headers }): OriginCheckResult {
  const expectedHost = selfHost(request.headers);

  if (!STATE_CHANGING.has(request.method.toUpperCase())) {
    return { allowed: true, observedOrigin: "", expectedHost };
  }

  // Referer is the fallback, which is why Referrer-Policy is same-origin rather than no-referrer:
  // no-referrer would suppress exactly this signal.
  const observedOrigin = request.headers.get("origin") ?? request.headers.get("referer") ?? "";
  const observedHost = observedOrigin ? hostOf(observedOrigin) : null;

  if (!observedHost) {
    // True absence (neither header sent at all) is eligible for the JSON carve-out documented
    // above. A header that arrived but did not resolve to a host (observedOrigin non-empty, e.g.
    // "Origin: /") is NOT: it is evidence of a header a browser did send, just a malformed one, and
    // there is no legitimate reason to treat that more kindly than an outright cross-site mismatch.
    if (observedOrigin === "" && isJsonContentType(request.headers.get("content-type"))) {
      return { allowed: true, observedOrigin, expectedHost };
    }
    // A non-browser caller that is not sending JSON must send Origin: <public origin> instead.
    // There is no other off switch for this: an off switch for a CSRF control is the knob that
    // gets set in a template and never unset.
    return { allowed: false, observedOrigin, expectedHost };
  }

  const allowed = observedHost === expectedHost || configuredHosts().includes(observedHost);
  return { allowed, observedOrigin, expectedHost };
}
