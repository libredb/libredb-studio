/**
 * Boot-time auth-config preflight (issue #227).
 *
 * A `JWT_SECRET` shorter than the minimum used to slip through every startup
 * path: zero-config bootstrap only fills a MISSING secret, nothing validated an
 * explicitly-set one, and `GET /api/db/health` answers "healthy" unconditionally.
 * The deployment looked fine from the outside while every login returned 503 —
 * how the Cosmos servapp shipped broken for three weeks (Cosmos generates
 * 24-character passwords; the template passed one straight to `JWT_SECRET`).
 *
 * Why a hard exit rather than a health-check signal: `/api/db/health` is wired
 * as the Kubernetes **livenessProbe** (charts/libredb-studio/values.yaml) and as
 * the Docker/PaaS health check. Reporting a config error there would restart the
 * pod forever without ever fixing it, and would hide the login screen's
 * actionable 503 behind CrashLoopBackOff. Refusing to boot costs nothing either:
 * with a too-short secret the server can sign no session at all, so no working
 * deployment can regress — there is simply nothing to lose by stopping loudly.
 *
 * Runs only on standalone boot (called from instrumentation.ts `register()`),
 * so embedding @libredb/studio in libredb-platform is unaffected.
 */

import { JWT_SECRET_MIN_LENGTH } from "@/lib/config/auth-env";

/**
 * Validate the auth environment before the server starts serving.
 *
 * Returns `true` when boot may continue. On a fatal misconfiguration it prints
 * an operator-facing banner and calls `process.exit(1)`; it also returns `false`
 * so callers stop their remaining boot work in environments where `process.exit`
 * is stubbed (tests) rather than terminating the process immediately.
 */
export function verifyAuthEnvAtBoot(): boolean {
  const secret = process.env.JWT_SECRET;

  // Unset or empty is not this check's business: zero-config bootstrap generates
  // a secret, and with AUTH_BOOTSTRAP=off getJwtSecret owns the missing-secret
  // path (dev fallback outside production, clear 503 in it).
  if (!secret || secret.length >= JWT_SECRET_MIN_LENGTH) return true;

  // The secret value never reaches the logs — only its length.
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: JWT_SECRET is too short",
      ` Got ${secret.length} characters; the minimum is ${JWT_SECRET_MIN_LENGTH}.`,
      " Every login would fail with HTTP 503, so boot stops here.",
      " Fix it either way:",
      "   1. Set a strong secret: JWT_SECRET=$(openssl rand -base64 32)",
      "   2. Unset JWT_SECRET and let the first run generate one",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}
