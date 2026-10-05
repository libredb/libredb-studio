/**
 * Launch-token sign-in configuration (docs/LAUNCH.md), read from the environment on every call, as
 * src/lib/passkey/config.ts reads PASSKEY_ORIGIN, so a changed value is seen by the next request.
 *
 * The feature is off unless LAUNCH_TOKEN_SECRET is set, and a set secret makes LAUNCH_TOKEN_AUDIENCE
 * and LAUNCH_TOKEN_ISSUER required. A configuration that breaks a rule is reported and never fatal:
 * the launch route answers 503 with the problem and this module logs a problem once, until a
 * different problem replaces it, so the log line cannot be multiplied by an anonymous caller. A
 * boot-time exit like the one a short JWT_SECRET earns would take the whole Studio down over a feature
 * most deployments never turn on.
 *
 * Under NEXT_PUBLIC_AUTH_PROVIDER=oidc launch sign-in is unavailable whatever the three variables say:
 * storedAccountAllows passes every session in that mode without reading the registry, so a disable or a
 * role change would never reach a launched session, and account changes are refused there anyway. The
 * route and the /launch page (src/proxy.ts) answer 503 with that problem, the fail-closed choice the
 * account registry's own OIDC_MODE refusal makes.
 *
 * The secret is used exactly as set, untrimmed: its UTF-8 bytes are the HMAC key the issuing platform
 * signs with, so trimming here would verify against a key the platform never used. A problem names
 * the variable and the rule it broke and never quotes a value.
 *
 * A secret equal to the key that signs sessions is refused (docs/LAUNCH.md, Configuration): the
 * session check verifies an auth-token with that key and pins neither typ nor algorithm, so a launch
 * token would pass as a session. The key is JWT_SECRET, or the development fallback getJwtSecret
 * uses while it is unset. It is compared here without calling getJwtSecret, which warns on every call
 * under the fallback and throws in production when JWT_SECRET is missing; sign-in reports that itself.
 */
import { DEV_FALLBACK_SECRET } from "@/lib/config/auth-env";
import { logger } from "@/lib/logger";

/** The shortest LAUNCH_TOKEN_SECRET accepted, the floor JWT_SECRET has for the same HMAC. */
export const LAUNCH_SECRET_MIN_LENGTH = 32;

const OIDC_PROBLEM = "Launch sign-in is not available when NEXT_PUBLIC_AUTH_PROVIDER=oidc.";
const TOO_SHORT_PROBLEM = `LAUNCH_TOKEN_SECRET must be at least ${LAUNCH_SECRET_MIN_LENGTH} characters: launch sign-in is unavailable until it is fixed.`;
const AUDIENCE_PROBLEM =
  "LAUNCH_TOKEN_AUDIENCE must be set when LAUNCH_TOKEN_SECRET is set: launch sign-in is unavailable until it is.";
const ISSUER_PROBLEM =
  "LAUNCH_TOKEN_ISSUER must be set when LAUNCH_TOKEN_SECRET is set: launch sign-in is unavailable until it is.";
const SESSION_KEY_PROBLEM =
  "LAUNCH_TOKEN_SECRET must differ from the key that signs sessions (JWT_SECRET): launch sign-in is unavailable until it does.";

export type LaunchConfig =
  | { readonly state: "off" }
  | { readonly state: "misconfigured"; readonly problem: string }
  | { readonly state: "ready"; readonly secret: Uint8Array; readonly audience: string; readonly issuer: string };

export type ReadyLaunchConfig = Extract<LaunchConfig, { state: "ready" }>;

let loggedProblem: string | null = null;

function problemWith(secret: string, audience: string, issuer: string): string | null {
  if (secret.length < LAUNCH_SECRET_MIN_LENGTH) return TOO_SHORT_PROBLEM;
  if (audience === "") return AUDIENCE_PROBLEM;
  if (issuer === "") return ISSUER_PROBLEM;
  if (secret === (process.env.JWT_SECRET || DEV_FALLBACK_SECRET)) return SESSION_KEY_PROBLEM;
  return null;
}

function unavailable(problem: string): LaunchConfig {
  if (loggedProblem !== problem) {
    loggedProblem = problem;
    logger.error(`Launch sign-in is unavailable: ${problem}`, undefined, { route: "launch" });
  }
  return { state: "misconfigured", problem };
}

export function readLaunchConfig(): LaunchConfig {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc") return unavailable(OIDC_PROBLEM);
  const secret = process.env.LAUNCH_TOKEN_SECRET ?? "";
  if (secret === "") return { state: "off" };
  const audience = (process.env.LAUNCH_TOKEN_AUDIENCE ?? "").trim();
  const issuer = (process.env.LAUNCH_TOKEN_ISSUER ?? "").trim();
  const problem = problemWith(secret, audience, issuer);
  if (problem === null) return { state: "ready", secret: new TextEncoder().encode(secret), audience, issuer };
  return unavailable(problem);
}

/** Test seam, like resetPasskeyConfigWarning. */
export function resetLaunchConfigWarning(): void {
  loggedProblem = null;
}
