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

function selfHost(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded;
  return headers.get("host")?.trim().toLowerCase() ?? "";
}

/** Extra hosts the operator vouched for, as origins or bare hosts. */
function configuredHosts(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  const hosts: string[] = [];
  for (const entry of raw.split(",")) {
    const host = hostOf(entry);
    if (host) hosts.push(host);
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
    // A non-browser caller must send Origin: <public origin>. There is no off switch for this: an
    // off switch for a CSRF control is the knob that gets set in a template and never unset.
    return { allowed: false, observedOrigin, expectedHost };
  }

  const allowed = observedHost === expectedHost || configuredHosts().includes(observedHost);
  return { allowed, observedOrigin, expectedHost };
}
