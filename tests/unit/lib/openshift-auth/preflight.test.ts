import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openShiftAuthEnvProblems, strayOpenShiftVariables } from "@/lib/openshift-auth/preflight";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const SECRET = "client-secret-not-a-real-token";
const KEYS = [
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "OPENSHIFT_OAUTH_CLIENT_ID",
  "OPENSHIFT_OAUTH_TOKEN_FILE",
  "OPENSHIFT_API_URL",
  "OPENSHIFT_API_CA_FILE",
  "OPENSHIFT_PUBLIC_URL",
  "NEXT_PUBLIC_BASE_PATH",
  "ADMIN_PASSWORD",
  "USER_PASSWORD",
  "OIDC_ROLE_CLAIM",
  "OIDC_ADMIN_ROLES",
  "OIDC_USER_ROLES",
  "OIDC_ROLE_PREFIX",
  "LIBREDB_MCP_ENABLED",
  "LIBREDB_AGENT_ENABLED",
] as const;

let dir: string;
let tokenFile: string;
let caFile: string;
let saved: Record<string, string | undefined>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openshift-preflight-"));
  tokenFile = join(dir, "oauth-client-token");
  caFile = join(dir, "ca.crt");
  writeFileSync(tokenFile, SECRET);
  writeFileSync(caFile, loadTlsFixtures().ca);
  mkdirSync(join(dir, "a-directory"));
  writeFileSync(join(dir, "empty"), "");
  writeFileSync(join(dir, "not-a-certificate"), "plain text\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
  process.env.OPENSHIFT_OAUTH_CLIENT_ID = "system:serviceaccount:os-lab-studio:studio";
  process.env.OPENSHIFT_OAUTH_TOKEN_FILE = tokenFile;
  process.env.OPENSHIFT_API_CA_FILE = caFile;
  process.env.OPENSHIFT_PUBLIC_URL = "https://studio.apps.example.com";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/**
 * The single problem one changed variable causes, the variable restored after; no problem quotes a secret, a path or a
 * value long enough to be one (a switch value such as `on` is a plain word of the message).
 */
function onlyProblem(name: string, value: string): string {
  const before = process.env[name];
  process.env[name] = value;
  try {
    const problems = openShiftAuthEnvProblems();
    expect(problems, `${name}=${value}`).toHaveLength(1);
    const [problem] = problems;
    expect(problem.startsWith(`${name} `), problem).toBe(true);
    for (const leaked of [SECRET, dir, value.trim()]) {
      if (leaked.length >= 8) expect(problem).not.toContain(leaked);
    }
    return problem;
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

describe("openShiftAuthEnvProblems", () => {
  test("a complete configuration has no problem", () => {
    expect(openShiftAuthEnvProblems()).toEqual([]);
    process.env.ADMIN_PASSWORD = "";
    process.env.USER_PASSWORD = "";
    process.env.OIDC_ROLE_CLAIM = "  ";
    process.env.LIBREDB_MCP_ENABLED = "false";
    process.env.LIBREDB_AGENT_ENABLED = " OFF ";
    expect(openShiftAuthEnvProblems()).toEqual([]);
    process.env.LIBREDB_AGENT_ENABLED = "0";
    expect(openShiftAuthEnvProblems()).toEqual([]);
  });

  test("each invalid variable of the configuration is one problem", () => {
    onlyProblem("OPENSHIFT_OAUTH_CLIENT_ID", "serviceaccount:x:y");
    onlyProblem("OPENSHIFT_PUBLIC_URL", "http://studio.apps.example.com");
    onlyProblem("OPENSHIFT_API_URL", "http://kubernetes.default.svc");
    onlyProblem("OPENSHIFT_OAUTH_TOKEN_FILE", "relative/token");
  });

  test("each required variable left unset is one problem", () => {
    for (const name of ["OPENSHIFT_OAUTH_CLIENT_ID", "OPENSHIFT_PUBLIC_URL", "OPENSHIFT_OAUTH_TOKEN_FILE"]) {
      const value = process.env[name] as string;
      delete process.env[name];
      const problems = openShiftAuthEnvProblems();
      expect(problems, name).toHaveLength(1);
      expect(problems[0].startsWith(`${name} `)).toBe(true);
      process.env[name] = value;
    }
  });

  test("a missing, unreadable or empty token file is one problem", () => {
    for (const file of [join(dir, "missing"), join(dir, "a-directory"), join(dir, "empty")]) {
      const problem = onlyProblem("OPENSHIFT_OAUTH_TOKEN_FILE", file);
      expect(problem).toContain("missing, unreadable or empty");
    }
  });

  test("a missing, unreadable or certificate-free CA file is one problem", () => {
    for (const file of [join(dir, "missing"), join(dir, "a-directory"), join(dir, "not-a-certificate")]) {
      onlyProblem("OPENSHIFT_API_CA_FILE", file);
    }
  });

  test("a password, a role claim variable or a switched-on MCP or agent is one problem each", () => {
    onlyProblem("ADMIN_PASSWORD", "not-a-real-password-admin");
    onlyProblem("USER_PASSWORD", "not-a-real-password-user");
    for (const name of ["OIDC_ROLE_CLAIM", "OIDC_ADMIN_ROLES", "OIDC_USER_ROLES", "OIDC_ROLE_PREFIX"]) {
      onlyProblem(name, " groups ");
    }
    onlyProblem("LIBREDB_MCP_ENABLED", "true");
    onlyProblem("LIBREDB_AGENT_ENABLED", "on");
  });

  test("every problem is listed at once", () => {
    process.env.ADMIN_PASSWORD = "not-a-real-password-admin";
    process.env.OPENSHIFT_PUBLIC_URL = "";
    process.env.LIBREDB_MCP_ENABLED = "yes";
    expect(openShiftAuthEnvProblems()).toHaveLength(3);
  });
});

describe("strayOpenShiftVariables", () => {
  test("names each identity variable set outside openshift mode", () => {
    for (const mode of ["local", "oidc", ""]) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      expect(strayOpenShiftVariables()).toEqual([
        "OPENSHIFT_OAUTH_CLIENT_ID",
        "OPENSHIFT_OAUTH_TOKEN_FILE",
        "OPENSHIFT_PUBLIC_URL",
      ]);
    }
  });

  test("ignores an unset or blank variable and the two defaulted ones", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.OPENSHIFT_OAUTH_CLIENT_ID;
    process.env.OPENSHIFT_OAUTH_TOKEN_FILE = " ";
    process.env.OPENSHIFT_API_URL = "https://kubernetes.default.svc";
    expect(strayOpenShiftVariables()).toEqual(["OPENSHIFT_PUBLIC_URL"]);
  });

  test("is empty in openshift mode", () => {
    expect(strayOpenShiftVariables()).toEqual([]);
  });
});
