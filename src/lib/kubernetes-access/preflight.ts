/**
 * Boot-time Kubernetes access review preflight (docs/SEED_CONNECTIONS.md, "Kubernetes access review").
 *
 * With the review on, a connection that names its Kubernetes Secret is the review's alone and a Studio admin is
 * whoever may update Studio's Deployment. An environment that also runs governance, signs in without OIDC, keeps a
 * password account, maps an admin role from an identity provider claim, takes bearer access tokens, runs MCP or the
 * agent, keeps a session longer than 900 seconds, or leaves a setting of the review unusable contradicts that, and each
 * would surface later as a way around the review or as a review that denies everyone while the health check stays
 * green. So this check refuses to start instead, naming every variable to fix in one banner and never quoting a secret.
 *
 * The session bound is the owner's rule for this mode: signing out of the identity provider does not end a Studio
 * session, and a review asserts the groups the session's sign-in recorded, so the session lifetime is how long a
 * removed group or a signed-out user keeps Studio. It reads each variable as written, as the governance preflight does,
 * and reads the token and CA files only to see that they can be used. A value that `verifyAuthEnvAtBoot()` refuses
 * first, an invalid session lifetime, is not reported twice.
 *
 * Runs only on standalone boot, after the governance preflight in `src/instrumentation.ts`, and checks nothing while
 * the review is off.
 */
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { sessionTtlSeconds } from "@/lib/config/auth-env";
import {
  ACCESS_REVIEW_ENV,
  accessReviewAdminDeployment,
  accessReviewApiUrl,
  accessReviewCacheMs,
  accessReviewCaPath,
  accessReviewEnabled,
  accessReviewSignIn,
  accessReviewSwitch,
  accessReviewTokenPath,
} from "./config";

/** D8: the longest session the review's mode allows, in seconds. */
const MAX_SESSION_SECONDS = 900;
/** The spellings that switch MCP (`src/lib/mcp/config.ts`) or the agent (`src/lib/agent/config.ts`) off. */
const SWITCH_OFF = new Set(["false", "off", "0"]);

/** A value as the banner shows it. Only a variable that never holds a secret is ever shown. */
const shown = (value: string | undefined): string => (value === undefined ? "unset" : JSON.stringify(value));

/** The message a reader refuses the environment with, or null when it accepts it. */
function refusalOf(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Why the token file cannot carry the review's credential, or null when it can. */
function tokenProblem(): string | null {
  const file = accessReviewTokenPath();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return `KUBERNETES_ACCESS_REVIEW_TOKEN_PATH: the token file ${file} cannot be read; mount the pod's ServiceAccount token there, or point the variable at the file a projected volume mounts`;
  }
  return text.trim() === "" ? `KUBERNETES_ACCESS_REVIEW_TOKEN_PATH: the token file ${file} is empty` : null;
}

/** Why the CA file cannot verify the API server, or null when it can. */
function caProblem(): string | null {
  const file = accessReviewCaPath();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return `KUBERNETES_ACCESS_REVIEW_CA_PATH: the CA file ${file} cannot be read; mount the cluster's CA there, such as the ca.crt of the kube-root-ca.crt ConfigMap`;
  }
  return parsesAsCertificate(text)
    ? null
    : `KUBERNETES_ACCESS_REVIEW_CA_PATH: the CA file ${file} holds no certificate`;
}

/** Whether `text` starts with a PEM certificate node:crypto can parse. */
function parsesAsCertificate(text: string): boolean {
  try {
    const certificate = new X509Certificate(text);
    return certificate.raw.length > 0;
  } catch {
    return false;
  }
}

/** Every reason this environment contradicts the review, each starting with the variable to fix. */
function accessReviewEnvProblems(): string[] {
  const problems: (string | null)[] = [];

  if (accessReviewSwitch() === "invalid") {
    problems.push(
      `${ACCESS_REVIEW_ENV} is ${shown(process.env[ACCESS_REVIEW_ENV])}: set it to on, true or 1 to keep the review, or off, false or 0 to run without it; any other value counts as on, so the server fails closed`,
    );
  }
  if ((process.env.GOVERNANCE_SOURCE ?? "") !== "") {
    problems.push(
      "GOVERNANCE_SOURCE is set: governance mode decides who opens a connection from its own grants, so the Kubernetes access review cannot run beside it; unset one of the two",
    );
  }
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER !== "oidc") {
    problems.push(
      `NEXT_PUBLIC_AUTH_PROVIDER is ${shown(process.env.NEXT_PUBLIC_AUTH_PROVIDER)}: the access review asks about the identity provider subject an OIDC sign-in gives a session, so set it to oidc`,
    );
  }
  // An empty password counts as unset, as it does for sign-in (src/lib/local-auth.ts).
  for (const name of ["ADMIN_PASSWORD", "USER_PASSWORD"] as const) {
    if (process.env[name]) {
      problems.push(
        `${name} is set: with the access review on, every sign-in goes through the identity provider and its reviews, and a Studio admin is whoever may update Studio's Deployment, so unset it`,
      );
    }
  }
  if (process.env.OIDC_ROLE_CLAIM?.trim()) {
    problems.push(
      "OIDC_ROLE_CLAIM is set: with the access review on, a Studio admin is whoever may update Studio's Deployment, and no identity provider claim may grant it, so unset it",
    );
  }
  if (process.env.OIDC_BEARER_AUDIENCE?.trim()) {
    problems.push(
      "OIDC_BEARER_AUDIENCE is set: a bearer access token comes with no groups record for the review to assert, so unset it",
    );
  }
  for (const [name, feature] of [
    ["LIBREDB_MCP_ENABLED", "MCP"],
    ["LIBREDB_AGENT_ENABLED", "the agent"],
  ] as const) {
    const value = process.env[name];
    const switched = (value ?? "").trim().toLowerCase();
    if (switched !== "" && !SWITCH_OFF.has(switched)) {
      problems.push(
        `${name} is ${shown(value)}: this version does not run ${feature} under the Kubernetes access review, so set it to false or unset it`,
      );
    }
  }
  if (refusalOf(sessionTtlSeconds) === null && sessionTtlSeconds() > MAX_SESSION_SECONDS) {
    problems.push(
      `AUTH_SESSION_TTL_SECONDS is ${shown(process.env.AUTH_SESSION_TTL_SECONDS)}: with the access review on a session lasts at most ${MAX_SESSION_SECONDS} seconds, because signing out of the identity provider does not end it and its groups are those of its sign-in; set it to ${MAX_SESSION_SECONDS} or less`,
    );
  }

  problems.push(
    refusalOf(accessReviewAdminDeployment),
    refusalOf(accessReviewSignIn),
    refusalOf(accessReviewApiUrl),
    refusalOf(accessReviewCacheMs),
    tokenProblem(),
    caProblem(),
  );
  return problems.filter((problem): problem is string => problem !== null);
}

/**
 * Check the environment against the Kubernetes access review before the server starts serving.
 *
 * Returns `true` when boot may continue, which it always may with the review off. Otherwise it prints one banner that
 * names every variable to fix and calls `process.exit(1)`; it also returns `false`, so the caller stops its remaining
 * boot work where `process.exit` is stubbed (tests).
 */
export function verifyAccessReviewEnvAtBoot(): boolean {
  if (!accessReviewEnabled()) return true;
  const problems = accessReviewEnvProblems();
  if (problems.length === 0) return true;

  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: the environment contradicts the Kubernetes access review",
      ` ${ACCESS_REVIEW_ENV} switches the Kubernetes access review on, and these variables have to change:`,
      ...problems.map((problem) => `   - ${problem}`),
      ' docs/SEED_CONNECTIONS.md lists every check under "Kubernetes access review".',
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}
