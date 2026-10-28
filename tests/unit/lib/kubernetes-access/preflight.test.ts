/**
 * The Kubernetes access review's boot preflight (src/lib/kubernetes-access/preflight.ts, docs/SECURITY.md control 1.12).
 *
 * With `KUBERNETES_ACCESS_REVIEW` on, or set to a value Studio does not know, an environment that contradicts the
 * review refuses to start, naming every variable to fix in one banner and never quoting a secret: governance beside
 * it, a sign-in that is not OIDC, a password, a role claim, the bearer channel, MCP or the agent switched on, a session
 * longer than 900 seconds, a setting of the review that is missing or invalid, and a token or CA file that cannot be
 * used. With the review off it checks nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyAccessReviewEnvAtBoot } from "@/lib/kubernetes-access/preflight";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

/** Recognisable on sight as test values; the banner must never carry one. */
const TOKEN = "not-a-real-token-preflight";
const SECRET = "not-a-real-secret-preflight";
const PASSWORD = "not-a-real-password-preflight";

const dir = mkdtempSync(path.join(tmpdir(), "libredb-access-review-preflight-"));

beforeAll(() => {
  writeFileSync(path.join(dir, "token"), TOKEN);
  writeFileSync(path.join(dir, "ca.crt"), loadTlsFixtures().ca);
  writeFileSync(path.join(dir, "empty"), " \n");
  writeFileSync(path.join(dir, "not-a-certificate"), "not a certificate");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Rancher-mode install: everything the preflight requires, nothing it refuses. */
function reviewed(): Record<string, string> {
  return {
    KUBERNETES_ACCESS_REVIEW: "on",
    KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT: "libredb-studio/libredb-studio",
    KUBERNETES_ACCESS_REVIEW_TOKEN_PATH: path.join(dir, "token"),
    KUBERNETES_ACCESS_REVIEW_CA_PATH: path.join(dir, "ca.crt"),
    NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
    AUTH_SESSION_TTL_SECONDS: "900",
    OIDC_CLIENT_SECRET: SECRET,
  };
}

// tests/setup.ts sets both passwords for every suite; a Rancher-mode install has neither.
const UNSET = [
  "ADMIN_PASSWORD",
  "USER_PASSWORD",
  "GOVERNANCE_SOURCE",
  "OIDC_ROLE_CLAIM",
  "OIDC_BEARER_AUDIENCE",
  "LIBREDB_MCP_ENABLED",
  "LIBREDB_AGENT_ENABLED",
  "KUBERNETES_ACCESS_REVIEW_API_URL",
  "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
  "KUBERNETES_ACCESS_REVIEW_SIGN_IN",
] as const;

const KEYS = [...Object.keys(reviewed()), ...UNSET];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(reviewed())) process.env[key] = value;
  for (const key of UNSET) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

interface Run {
  readonly passed: boolean;
  readonly exitCalls: Array<number | undefined>;
  readonly banner: string;
  readonly problems: string[];
}

/** Runs the preflight as a boot would, with process.exit stubbed. */
function runPreflight(): Run {
  const originalExit = process.exit;
  const exitCalls: Array<number | undefined> = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code);
  }) as unknown as typeof process.exit;
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const passed = verifyAccessReviewEnvAtBoot();
    const banner = errorSpy.mock.calls.flat().join("\n");
    const problems = banner
      .split("\n")
      .filter((line) => line.startsWith("   - "))
      .map((line) => line.slice("   - ".length));
    return { passed, exitCalls, banner, problems };
  } finally {
    process.exit = originalExit;
    errorSpy.mockRestore();
  }
}

/** One refused value per condition. */
const REFUSED: readonly { readonly variable: string; readonly value: string | undefined; readonly says: string }[] = [
  { variable: "KUBERNETES_ACCESS_REVIEW", value: "enabled", says: 'KUBERNETES_ACCESS_REVIEW is "enabled"' },
  { variable: "GOVERNANCE_SOURCE", value: "postgres", says: "GOVERNANCE_SOURCE is set" },
  { variable: "NEXT_PUBLIC_AUTH_PROVIDER", value: "local", says: 'NEXT_PUBLIC_AUTH_PROVIDER is "local"' },
  { variable: "NEXT_PUBLIC_AUTH_PROVIDER", value: undefined, says: "NEXT_PUBLIC_AUTH_PROVIDER is unset" },
  { variable: "ADMIN_PASSWORD", value: PASSWORD, says: "ADMIN_PASSWORD is set" },
  { variable: "USER_PASSWORD", value: PASSWORD, says: "USER_PASSWORD is set" },
  { variable: "OIDC_ROLE_CLAIM", value: "groups", says: "OIDC_ROLE_CLAIM is set" },
  { variable: "OIDC_BEARER_AUDIENCE", value: "libredb-studio-api", says: "OIDC_BEARER_AUDIENCE is set" },
  { variable: "LIBREDB_MCP_ENABLED", value: "true", says: 'LIBREDB_MCP_ENABLED is "true"' },
  { variable: "LIBREDB_AGENT_ENABLED", value: "on", says: 'LIBREDB_AGENT_ENABLED is "on"' },
  { variable: "AUTH_SESSION_TTL_SECONDS", value: undefined, says: "AUTH_SESSION_TTL_SECONDS is unset" },
  { variable: "AUTH_SESSION_TTL_SECONDS", value: "901", says: 'AUTH_SESSION_TTL_SECONDS is "901"' },
  {
    variable: "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
    value: undefined,
    says: "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT is not set",
  },
  {
    variable: "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
    value: "libredb-studio",
    says: "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT must name Studio's Deployment",
  },
  {
    variable: "KUBERNETES_ACCESS_REVIEW_SIGN_IN",
    value: "list",
    says: "KUBERNETES_ACCESS_REVIEW_SIGN_IN must be a review as kubectl auth can-i takes it",
  },
  { variable: "KUBERNETES_ACCESS_REVIEW_API_URL", value: "http://kubernetes.default.svc", says: "must use https" },
  {
    variable: "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
    value: "120",
    says: "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS must be a whole number of seconds from 0 to 60",
  },
  { variable: "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH", value: "/nonexistent/token", says: "cannot be read" },
  { variable: "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH", value: "EMPTY", says: "is empty" },
  { variable: "KUBERNETES_ACCESS_REVIEW_CA_PATH", value: "/nonexistent/ca.crt", says: "cannot be read" },
  { variable: "KUBERNETES_ACCESS_REVIEW_CA_PATH", value: "NOT_A_CERTIFICATE", says: "holds no certificate" },
];

describe("verifyAccessReviewEnvAtBoot", () => {
  test("a Rancher-mode install passes, silently", () => {
    const run = runPreflight();
    expect(run).toEqual({ passed: true, exitCalls: [], banner: "", problems: [] });
  });

  test("the switch accepts its on spellings and a shorter session", () => {
    process.env.AUTH_SESSION_TTL_SECONDS = "300";
    for (const value of ["true", "1", " ON "]) {
      process.env.KUBERNETES_ACCESS_REVIEW = value;
      expect(runPreflight().passed, value).toBe(true);
    }
  });

  test("with the review off it checks nothing, whatever else is set", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    process.env.OIDC_ROLE_CLAIM = "groups";
    process.env.LIBREDB_MCP_ENABLED = "true";
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "not a number";
    expect(runPreflight()).toEqual({ passed: true, exitCalls: [], banner: "", problems: [] });
  });

  test.each(REFUSED)("$variable=$value stops the boot with a banner that names it", ({ variable, value, says }) => {
    const resolved =
      value === "EMPTY"
        ? path.join(dir, "empty")
        : value === "NOT_A_CERTIFICATE"
          ? path.join(dir, "not-a-certificate")
          : value;
    if (resolved === undefined) delete process.env[variable];
    else process.env[variable] = resolved;
    const run = runPreflight();
    expect(run.passed).toBe(false);
    expect(run.exitCalls).toEqual([1]);
    expect(run.problems).toHaveLength(1);
    expect(run.problems[0]).toStartWith(variable);
    expect(run.problems[0]).toContain(says);
  });

  test("every problem is named in one banner, which quotes no secret", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.OIDC_ROLE_CLAIM = "groups";
    process.env.LIBREDB_AGENT_ENABLED = "true";
    process.env.AUTH_SESSION_TTL_SECONDS = "86400";
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = `https://user:${SECRET}@kubernetes.default.svc`;
    const run = runPreflight();
    expect(run.exitCalls).toEqual([1]);
    expect(run.problems.map((problem) => problem.split(" ")[0])).toEqual([
      "GOVERNANCE_SOURCE",
      "ADMIN_PASSWORD",
      "OIDC_ROLE_CLAIM",
      "LIBREDB_AGENT_ENABLED",
      "AUTH_SESSION_TTL_SECONDS",
      "KUBERNETES_ACCESS_REVIEW_API_URL",
    ]);
    expect(run.banner).toContain("KUBERNETES_ACCESS_REVIEW switches the Kubernetes access review on");
    for (const secret of [SECRET, TOKEN, PASSWORD]) expect(run.banner).not.toContain(secret);
  });

  test("an empty password counts as unset, as it does for sign-in", () => {
    process.env.ADMIN_PASSWORD = "";
    process.env.USER_PASSWORD = "";
    expect(runPreflight().passed).toBe(true);
  });

  test("the switch's own spellings that turn MCP or the agent off pass", () => {
    process.env.LIBREDB_MCP_ENABLED = "false";
    process.env.LIBREDB_AGENT_ENABLED = " OFF ";
    expect(runPreflight().passed).toBe(true);
  });
});
