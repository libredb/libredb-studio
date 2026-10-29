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
 * The same reasoning covers `STORAGE_ENCRYPTION_KEY` (backlog K3): too short, it
 * throws only at the first storage write - after login, after the migration
 * attempt - and reaches the operator as a `syncError` badge in someone's browser
 * rather than as a startup failure. It is checked only when a server storage
 * provider is configured, because with STORAGE_PROVIDER=local (the default) the
 * variable is inert and refusing to boot over it would be plainly wrong.
 *
 * Runs only on standalone boot (called from instrumentation.ts `register()`),
 * so embedding @libredb/studio in libredb-platform is unaffected.
 */

import {
  JWT_SECRET_MIN_LENGTH,
  SESSION_TTL_MAX_SECONDS,
  SESSION_TTL_MIN_SECONDS,
  sessionTtlSeconds,
} from "@/lib/config/auth-env";
import { isBootstrapEnabled } from "@/lib/auth-bootstrap";
import { AUTH_PROVIDER_INVALID_MESSAGE, authProviderSetting, authProviderValue } from "@/lib/config/auth-provider";
import { openShiftAuthEnvProblems, strayOpenShiftVariables } from "@/lib/openshift-auth/preflight";
import { readBearerAudience } from "@/lib/oidc-bearer";
import { isServerStorageEnabled } from "@/lib/storage/factory";
import { getStorageProviderType } from "@/lib/storage/provider-type";
import { readSchemaName } from "@/lib/storage/schema-name";

/**
 * Validate `STORAGE_ENCRYPTION_KEY` when server-side storage is configured.
 *
 * Absent is fine and stays silent: src/lib/storage/encryption.ts then derives the
 * key from JWT_SECRET, which verifyAuthEnvAtBoot already covers. Only an
 * explicitly set, too-short key is fatal - exactly the value that would throw on
 * the first write.
 */
function verifyStorageEncryptionKeyAtBoot(): boolean {
  const key = process.env.STORAGE_ENCRYPTION_KEY;
  if (!key || key.length >= JWT_SECRET_MIN_LENGTH || !isServerStorageEnabled()) return true;

  // The key value never reaches the logs - only its length.
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: STORAGE_ENCRYPTION_KEY is too short",
      ` Got ${key.length} characters; the minimum is ${JWT_SECRET_MIN_LENGTH}.`,
      " Every credential write would fail, so boot stops here.",
      " Fix it either way:",
      "   1. Set a strong key: STORAGE_ENCRYPTION_KEY=$(openssl rand -base64 32)",
      "   2. Unset STORAGE_ENCRYPTION_KEY and let it derive from JWT_SECRET",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}

/**
 * Validate `NEXT_PUBLIC_AUTH_PROVIDER`: an unknown value would otherwise run local sign-in with a generated admin
 * password, and an OpenShift identity variable set in another mode means the operator meant openshift sign-in.
 */
function verifyAuthProviderAtBoot(): boolean {
  if (authProviderSetting() === "invalid") {
    console.error(
      [
        "",
        "============================================================",
        " LibreDB Studio cannot start: NEXT_PUBLIC_AUTH_PROVIDER is invalid",
        ` Got ${JSON.stringify(authProviderValue())}. ${AUTH_PROVIDER_INVALID_MESSAGE}.`,
        " The value is case-sensitive; any other value would leave the sign-in mode undecided, so boot stops here.",
        "============================================================",
        "",
      ].join("\n"),
    );
    process.exit(1);
    return false;
  }
  const stray = strayOpenShiftVariables();
  if (stray.length === 0) return true;
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: OpenShift sign-in variables are set, but NEXT_PUBLIC_AUTH_PROVIDER is not openshift",
      ...stray.map((name) => `   - ${name} is set`),
      " Set NEXT_PUBLIC_AUTH_PROVIDER=openshift to sign in through the cluster, or unset these variables.",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}

/** In openshift sign-in mode, one banner naming every variable to fix (src/lib/openshift-auth/preflight.ts). */
function verifyOpenShiftAuthAtBoot(): boolean {
  if (authProviderSetting() !== "openshift") return true;
  const problems = openShiftAuthEnvProblems();
  if (problems.length === 0) return true;
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: the environment contradicts openshift sign-in",
      " NEXT_PUBLIC_AUTH_PROVIDER=openshift signs people in through the cluster, and these variables have to change:",
      ...problems.map((problem) => `   - ${problem}`),
      " docs/OPENSHIFT.md lists every check.",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}

/**
 * Validate `AUTH_SESSION_TTL_SECONDS`. Unset keeps the 24-hour default; a set value that is not an integer from 300
 * to 86400 would make every login throw, so boot stops here instead.
 */
function verifySessionTtlAtBoot(): boolean {
  try {
    sessionTtlSeconds();
    return true;
  } catch {
    console.error(
      [
        "",
        "============================================================",
        " LibreDB Studio cannot start: AUTH_SESSION_TTL_SECONDS is invalid",
        ` Got "${process.env.AUTH_SESSION_TTL_SECONDS}"; it must be a whole number of seconds`,
        ` from ${SESSION_TTL_MIN_SECONDS} to ${SESSION_TTL_MAX_SECONDS}.`,
        " Every login would fail, so boot stops here.",
        " Fix it either way:",
        "   1. Set a value in range, for example AUTH_SESSION_TTL_SECONDS=28800",
        "   2. Unset AUTH_SESSION_TTL_SECONDS to keep the 24-hour default",
        "============================================================",
        "",
      ].join("\n"),
    );
    process.exit(1);
    return false;
  }
}

/**
 * Validate `STORAGE_POSTGRES_SCHEMA` when the PostgreSQL storage provider is configured.
 *
 * The provider writes the name into every storage statement, so a value that is not a plain
 * lowercase identifier would fail only at the first storage request, after sign-in. Under any other
 * provider the variable is inert and is not checked.
 */
function verifyStorageSchemaAtBoot(): boolean {
  if (getStorageProviderType() !== "postgres") return true;
  try {
    readSchemaName("STORAGE_POSTGRES_SCHEMA");
    return true;
  } catch (error) {
    console.error(
      [
        "",
        "============================================================",
        " LibreDB Studio cannot start: STORAGE_POSTGRES_SCHEMA is invalid",
        ` ${(error as Error).message}.`,
        " Set it to the schema that holds the storage tables, such as studio,",
        " or unset it to keep the tables where the connection's search_path puts them.",
        "============================================================",
        "",
      ].join("\n"),
    );
    process.exit(1);
    return false;
  }
}

/**
 * Validate `OIDC_BEARER_AUDIENCE` (src/lib/oidc-bearer.ts). Unset leaves the bearer channel off. A set value without
 * NEXT_PUBLIC_AUTH_PROVIDER=oidc, or equal to OIDC_CLIENT_ID, would answer every native client 503, so boot stops here.
 * The same check runs on every bearer request, because an embedded Studio never runs this preflight.
 */
function verifyBearerAudienceAtBoot(): boolean {
  try {
    readBearerAudience();
    return true;
  } catch (error) {
    console.error(
      [
        "",
        "============================================================",
        " LibreDB Studio cannot start: OIDC_BEARER_AUDIENCE is invalid",
        ` ${(error as Error).message}.`,
        " Set it to the audience the identity provider puts in the native client's access tokens,",
        " or unset it to turn bearer access tokens off.",
        "============================================================",
        "",
      ].join("\n"),
    );
    process.exit(1);
    return false;
  }
}

/**
 * Validate the auth environment before the server starts serving.
 *
 * Returns `true` when boot may continue. On a fatal misconfiguration it prints
 * an operator-facing banner and calls `process.exit(1)`; it also returns `false`
 * so callers stop their remaining boot work in environments where `process.exit`
 * is stubbed (tests) rather than terminating the process immediately.
 */
export function verifyAuthEnvAtBoot(): boolean {
  if (!verifyAuthProviderAtBoot() || !verifyOpenShiftAuthAtBoot()) return false;
  if (!verifySessionTtlAtBoot() || !verifyBearerAudienceAtBoot()) return false;

  const secret = process.env.JWT_SECRET;

  // A missing secret is only this check's business in the one case where nothing
  // else will produce one: AUTH_BOOTSTRAP=off, which turns off secret generation
  // along with credential generation, in production, where getJwtSecret has no dev
  // fallback either. The server then starts, answers the health probe "healthy",
  // and returns 503 to every login - the monitor stays green and the first report
  // comes from a user who cannot sign in (#908).
  //
  // The reasoning in this file's header applies unchanged: with no secret the
  // server can sign no session at all, so no working deployment can regress by
  // stopping here, and the operator gets the same actionable banner the too-short
  // path already prints.
  if (!secret && process.env.NODE_ENV === "production" && !isBootstrapEnabled()) {
    console.error(
      [
        "",
        "============================================================",
        " LibreDB Studio cannot start: JWT_SECRET is not set",
        " AUTH_BOOTSTRAP is off, which also turns off secret generation,",
        " so nothing will produce one. Every login would fail with HTTP 503.",
        " Fix it either way:",
        "   1. Set a secret: JWT_SECRET=$(openssl rand -base64 32)",
        "   2. Leave AUTH_BOOTSTRAP on and let the first run generate one",
        "============================================================",
        "",
      ].join("\n"),
    );
    process.exit(1);
    return false;
  }

  // Otherwise an unset secret is not this check's business: zero-config bootstrap
  // generates one, and outside production getJwtSecret has its dev fallback.
  if (!secret || secret.length >= JWT_SECRET_MIN_LENGTH) {
    return verifyStorageEncryptionKeyAtBoot() && verifyStorageSchemaAtBoot();
  }

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
