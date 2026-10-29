/**
 * The Kubernetes access review's boot preflight (src/lib/kubernetes-access/preflight.ts, docs/SECURITY.md control 1.12).
 *
 * With `KUBERNETES_ACCESS_REVIEW` on, or set to a value Studio does not know, an environment that contradicts the
 * review refuses to start, naming every variable to fix in one banner and never quoting a secret: governance beside
 * it, a sign-in that is neither OIDC nor openshift, a password, a role claim, the bearer channel, MCP or the agent
 * switched on, a session longer than 900 seconds, a setting of the review that is missing or invalid, and a token or
 * CA file that cannot be used. With the review off it checks nothing. openshift sign-in always runs the review: it
 * refuses an explicit off, drops the session bound and the ServiceAccount token and CA checks, and refuses the
 * ServiceAccount backend's API, token and CA settings.
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
  "KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO",
  "OPENSHIFT_API_URL",
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
  { variable: "NEXT_PUBLIC_AUTH_PROVIDER", value: "OIDC", says: 'NEXT_PUBLIC_AUTH_PROVIDER is "OIDC"' },
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
    says: "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT and KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO are both unset",
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
    expect(run.banner).toContain(" KUBERNETES_ACCESS_REVIEW switches the Kubernetes access review on, and these");
    for (const secret of [SECRET, TOKEN, PASSWORD]) expect(run.banner).not.toContain(secret);
  });

  test("an operator install names its LibreDBStudio resource instead, and naming both or an invalid one stops the boot", () => {
    delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT;
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "libredb-studio/libredb-studio";
    expect(runPreflight().passed).toBe(true);
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "libredb-studio";
    expect(runPreflight().problems).toEqual([
      "KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO must name Studio's LibreDBStudio resource as <namespace>/<name>, such as libredb-studio/libredb-studio",
    ]);
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "libredb-studio/libredb-studio";
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "libredb-studio/libredb-studio";
    expect(runPreflight().problems).toEqual([
      "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT and KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO are both set: name Studio's Deployment for a Helm install or its LibreDBStudio resource for an operator install, not both",
    ]);
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

describe("verifyAccessReviewEnvAtBoot, in openshift sign-in mode", () => {
  /** An openshift-mode install: the review on by the mode, no ServiceAccount backend setting, the default session. */
  function openShift(): void {
    for (const key of KEYS) delete process.env[key];
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "os-lab-studio/studio";
  }

  test("an openshift-mode install passes, silently, with no token or CA file and the switch unset", () => {
    openShift();
    expect(runPreflight()).toEqual({ passed: true, exitCalls: [], banner: "", problems: [] });
  });

  test("runs with the switch unset: the review is on by the mode", () => {
    openShift();
    process.env.ADMIN_PASSWORD = PASSWORD;
    const run = runPreflight();
    expect(run.problems).toEqual([
      "ADMIN_PASSWORD is set: with the access review on, every sign-in goes through the identity provider and its reviews, and a Studio admin is whoever may update Studio's Deployment or LibreDBStudio resource, so unset it",
    ]);
    expect(run.banner).toContain(" openshift sign-in always runs the Kubernetes access review, and these");
    expect(run.banner).not.toContain(PASSWORD);
  });

  test.each(["off", "false", "0", " OFF "])("refuses KUBERNETES_ACCESS_REVIEW=%p, an explicit off", (value) => {
    openShift();
    process.env.KUBERNETES_ACCESS_REVIEW = value;
    expect(runPreflight().problems).toEqual([
      `KUBERNETES_ACCESS_REVIEW is ${JSON.stringify(value)}: openshift sign-in always reviews database access and admin rights with the signed-in user's own token, so unset it or set it to on`,
    ]);
  });

  test.each(["enabled", "yes", "maybe"])(
    "refuses KUBERNETES_ACCESS_REVIEW=%p, a value it does not know, with the advice of this mode",
    (value) => {
      openShift();
      process.env.KUBERNETES_ACCESS_REVIEW = value;
      const run = runPreflight();
      expect(run.problems).toEqual([
        `KUBERNETES_ACCESS_REVIEW is ${JSON.stringify(value)}: openshift sign-in always reviews database access and admin rights with the signed-in user's own token, so unset it or set it to on`,
      ]);
      // OIDC mode's advice would offer off, which this mode refuses.
      expect(run.banner).not.toContain("off, false or 0");
    },
  );

  test.each(["", "  ", "on", "true"])("takes KUBERNETES_ACCESS_REVIEW=%p, empty counting as unset", (value) => {
    openShift();
    process.env.KUBERNETES_ACCESS_REVIEW = value;
    expect(runPreflight().passed).toBe(true);
  });

  test("keeps no 900-second bound: the session lasts as openshift sign-in sets it", () => {
    openShift();
    process.env.AUTH_SESSION_TTL_SECONDS = "28800";
    expect(runPreflight().passed).toBe(true);
  });

  test.each([
    "KUBERNETES_ACCESS_REVIEW_API_URL",
    "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH",
    "KUBERNETES_ACCESS_REVIEW_CA_PATH",
  ])("refuses %p, a ServiceAccount backend setting, when it is set", (name) => {
    openShift();
    process.env[name] = "  ";
    expect(runPreflight().passed).toBe(true);
    process.env[name] = name.endsWith("API_URL") ? "https://kubernetes.default.svc" : path.join(dir, "token");
    expect(runPreflight().problems).toEqual([
      `${name} is set: openshift sign-in reviews with the signed-in user's own token through OPENSHIFT_API_URL and OPENSHIFT_API_CA_FILE, so unset it`,
    ]);
  });

  test("still refuses what contradicts the review, naming every problem in one banner", () => {
    openShift();
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    process.env.GOVERNANCE_SOURCE = "postgres";
    process.env.OIDC_ROLE_CLAIM = "groups";
    process.env.LIBREDB_MCP_ENABLED = "true";
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "list";
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "61";
    process.env.KUBERNETES_ACCESS_REVIEW_CA_PATH = path.join(dir, "ca.crt");
    delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT;
    const run = runPreflight();
    expect(run.exitCalls).toEqual([1]);
    expect(run.problems.map((problem) => problem.split(" ")[0])).toEqual([
      "KUBERNETES_ACCESS_REVIEW",
      "GOVERNANCE_SOURCE",
      "OIDC_ROLE_CLAIM",
      "LIBREDB_MCP_ENABLED",
      "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
      "KUBERNETES_ACCESS_REVIEW_SIGN_IN",
      "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
      "KUBERNETES_ACCESS_REVIEW_CA_PATH",
    ]);
  });

  test("names a sign-in mode that is neither oidc nor openshift with the reworded message", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    expect(runPreflight().problems).toEqual([
      `NEXT_PUBLIC_AUTH_PROVIDER is "local": the access review asks about the person an OIDC or openshift sign-in gives a session, so set it to oidc or openshift`,
    ]);
  });
});
