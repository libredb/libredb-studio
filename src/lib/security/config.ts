import type { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { HSTS_MAX_AGE_SECONDS, securityHeaders, type SecurityHeaderOptions } from "@/lib/security/headers";

/**
 * Environment reading for the security headers. Kept out of src/lib/security/headers.ts, which is
 * published as @libredb/studio/security and must stay import-free and side-effect-free.
 */

const OFF_VALUES = new Set(["off", "false", "0"]);
const ON_VALUES = new Set(["on", "true", "1"]);

/**
 * The policy is enforced. It was verified against the real production build first, through
 * e2e/security-headers.spec.ts, whose securitypolicyviolation collector drives Monaco, a query,
 * the ELK layout worker and both export formats.
 *
 * CSP_REPORT_ONLY=true remains as an operator escape hatch, because a prebuilt image cannot be
 * rebuilt by the person whose distribution channel broke.
 */
const CSP_DEFAULT_REPORT_ONLY = false;

// withSecurityHeaders runs on every proxied request, so an unrecognized value must warn at most
// once per flag per process, not once per request (same reasoning as auth.ts's cookie-security
// warnOnce, which is latched because shouldMarkCookieSecure() runs on every login).
const warnedFlags = new Set<string>();

/** Test seam: clears the warn-once latches so each case observes a fresh process. */
export function resetSecurityConfigWarnings(): void {
  warnedFlags.clear();
}

/**
 * The operator's explicit answer, or undefined to take the default. Spellings follow
 * AUTH_BOOTSTRAP and AUTH_COOKIE_SECURE so the whole product reads flags the same way; an
 * unrecognized value warns (once per flag) and takes the default rather than silently flipping
 * the security posture.
 */
function readFlag(envVarName: string, raw: string | undefined, hint: string): boolean | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (OFF_VALUES.has(normalized)) return false;
  if (ON_VALUES.has(normalized)) return true;
  if (!warnedFlags.has(envVarName)) {
    warnedFlags.add(envVarName);
    // Single-line message: bun's line coverage under-counts the continuation lines of a wrapped
    // call, which then reads as uncovered new code (same note as auth.ts's readCookieSecureOverride).
    logger.warn(`Unrecognized ${envVarName} value "${raw}"; keeping the default (${hint})`, { route: "security" });
  }
  return undefined;
}

/**
 * Whether the CSP is delivered as Content-Security-Policy-Report-Only.
 *
 * The escape hatch survives past the enforcement flip on purpose: a prebuilt image cannot be
 * rebuilt by the person whose distribution channel broke.
 */
export function readCspReportOnly(): boolean {
  const hint = 'use "false" to enforce, "true" to stay report-only';
  return readFlag("CSP_REPORT_ONLY", process.env.CSP_REPORT_ONLY, hint) ?? CSP_DEFAULT_REPORT_ONLY;
}

/**
 * includeSubDomains is opt-in: a self-hoster on studio.example.com must not be able to break
 * unrelated siblings by upgrading Studio.
 */
export function readHstsIncludeSubDomains(): boolean {
  return readFlag("HSTS_INCLUDE_SUBDOMAINS", process.env.HSTS_INCLUDE_SUBDOMAINS, 'use "true" to opt in') ?? false;
}

/**
 * Whether forwarded-address headers (X-Forwarded-For / X-Real-IP) are trusted as a bucketing hint
 * for rate limiting (src/lib/api/client-address.ts). Trusted by default: a Next.js route handler
 * has no socket address to fall back to, so refusing forwarded headers collapses every caller
 * behind any reverse proxy into one shared bucket - turning the login limiter into a remote
 * lockout switch, a strictly worse failure than trusting a spoofable header. An operator exposed
 * directly to the internet with no reverse proxy in front (the header would then be
 * self-reported by the very client it is meant to identify) sets this to "false".
 */
export function readTrustProxyHeaders(): boolean {
  const hint = 'use "false" only when no reverse proxy sits in front of this deployment';
  return readFlag("TRUST_PROXY_HEADERS", process.env.TRUST_PROXY_HEADERS, hint) ?? true;
}

export function readSecurityHeaderOptions(): SecurityHeaderOptions {
  return {
    reportOnly: readCspReportOnly(),
    monacoVsPath: process.env.NEXT_PUBLIC_MONACO_VS_PATH,
    // HSTS is sent unconditionally. RFC 6797 requires user agents to ignore it over plain HTTP,
    // so the plain-HTTP channels are unaffected and no decision has to be made about trusting
    // the attacker-supplied x-forwarded-proto.
    hsts: { maxAgeSeconds: HSTS_MAX_AGE_SECONDS, includeSubDomains: readHstsIncludeSubDomains() },
  };
}

/**
 * Stamps the header set onto a response. EVERY return in proxy() must go through this; a returned
 * response that skips it is the defect class to watch for in review.
 */
export function withSecurityHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(securityHeaders(readSecurityHeaderOptions()))) {
    response.headers.set(name, value);
  }
  return response;
}
