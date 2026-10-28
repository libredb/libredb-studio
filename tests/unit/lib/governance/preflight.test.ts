/**
 * The governance boot preflight (docs/GOVERNANCE.md#boot-checks).
 *
 * With `GOVERNANCE_SOURCE` set, an environment that also configures another way to sign in or another source of
 * connections contradicts governance mode, and so does a governance setting that is missing or invalid. The
 * preflight refuses to start on any of them with one banner that names every variable to fix, and never prints a
 * secret. With `GOVERNANCE_SOURCE` unset it checks nothing, so a Studio without governance starts as before.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { customConnectionsAllowed } from "@/lib/config/custom-connections";
import { governanceEnabled, governanceSource } from "@/lib/governance/config";
import { resetGovernanceKeyring } from "@/lib/governance/keyring";
import { verifyGovernanceEnvAtBoot } from "@/lib/governance/preflight";
import { readMcpSwitch } from "@/lib/mcp/config";
import { keyringFileOf, removeKeyringFiles, testKey, writeKeyringFile } from "../../../helpers/governance/keyring-file";

/** Recognisable on sight as test values; the banner must never carry one. */
const PASSWORD = "example-only-password-in-a-test";
const LAUNCH_SECRET = "example-only-launch-secret-in-a-test-0123456789";
const URL_SECRET = "example-only-url-password";

/** The keyring of the install below: two private keys, drawn fresh, so no key text is checked in. */
const KEYRING_KEYS = [testKey(), testKey()];
const KEYRING_FILE = keyringFileOf(...KEYRING_KEYS);

/**
 * A governance install as docs/GOVERNANCE.md#studio-configuration describes it: everything the preflight requires,
 * nothing it refuses.
 */
const GOVERNED: Readonly<Record<string, string>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: `postgresql://libredb_studio:${URL_SECRET}@db.internal:5432/libredb?sslmode=verify-full`,
  GOVERNANCE_INSTANCE_ID: "libredb-studio",
  GOVERNANCE_PRIVATE_KEYS_FILE: KEYRING_FILE,
  STORAGE_POSTGRES_SCHEMA: "studio",
  NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
  OIDC_ROLE_CLAIM: "libredb_roles",
  OIDC_USER_ROLES: "user",
};

/** Unset in a governance install. tests/setup.ts sets the two passwords for every other test file. */
const UNSET = [
  "ADMIN_PASSWORD",
  "USER_PASSWORD",
  "LAUNCH_TOKEN_SECRET",
  "ALLOW_CUSTOM_CONNECTIONS",
  "LIBREDB_EMBEDDED_SAMPLE",
  "SQLITE_EMBEDDED_SAMPLE",
  "SEED_CONFIG_PATH",
  "SEED_DISCOVERY_PATH",
  "SEED_KUBERNETES_DISCOVERY_PATH",
  "OIDC_ROLE_PREFIX",
  "BIGQUERY_SERVER_CREDENTIALS",
  "FIRESTORE_SERVER_CREDENTIALS",
  "LIBREDB_MCP_ENABLED",
  "LIBREDB_AGENT_ENABLED",
  "GOVERNANCE_POSTGRES_SCHEMA",
  "GOVERNANCE_REFRESH_MS",
  "GOVERNANCE_MAX_STALENESS_MS",
  "GOVERNANCE_ALLOWED_ENGINES",
] as const;

const KEYS = [...Object.keys(GOVERNED), ...UNSET];

let saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved = {};
  for (const key of KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(GOVERNED)) process.env[key] = value;
  for (const key of UNSET) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) setEnv(key, saved[key]);
  resetGovernanceKeyring();
});

afterAll(() => {
  removeKeyringFiles();
});

interface Run {
  readonly passed: boolean;
  readonly exitCalls: Array<number | undefined>;
  readonly banner: string;
  /** The banner's problem lines, without their bullet. */
  readonly problems: string[];
  /** Every line the boot wrote to the console, the banner included. */
  readonly log: string;
}

/**
 * Runs the preflight as a fresh boot would, with process.exit stubbed, so a refusal cannot take the test runner down.
 * The keyring is read once per process, so it is forgotten first.
 */
function runPreflight(): Run {
  resetGovernanceKeyring();
  const originalExit = process.exit;
  const exitCalls: Array<number | undefined> = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code);
  }) as unknown as typeof process.exit;
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const otherSpies = (["debug", "info", "log", "warn"] as const).map((method) =>
    spyOn(console, method).mockImplementation(() => {}),
  );
  try {
    const passed = verifyGovernanceEnvAtBoot();
    // Read before mockRestore(): bun clears the recorded calls on restore.
    const banner = errorSpy.mock.calls.flat().join("\n");
    const log = [errorSpy, ...otherSpies].flatMap((spy) => spy.mock.calls.flat()).join("\n");
    const problems = banner
      .split("\n")
      .filter((line) => line.startsWith("   - "))
      .map((line) => line.slice("   - ".length));
    return { passed, exitCalls, banner, problems, log };
  } finally {
    process.exit = originalExit;
    errorSpy.mockRestore();
    for (const spy of otherSpies) spy.mockRestore();
  }
}

/** One refused value per condition of docs/GOVERNANCE.md#boot-checks, and per kind of invalid GOVERNANCE_* value. */
const REFUSED: readonly { readonly variable: string; readonly value: string | undefined }[] = [
  { variable: "NEXT_PUBLIC_AUTH_PROVIDER", value: "local" },
  { variable: "NEXT_PUBLIC_AUTH_PROVIDER", value: undefined },
  { variable: "OIDC_ROLE_CLAIM", value: undefined },
  { variable: "OIDC_ROLE_CLAIM", value: "  " },
  { variable: "OIDC_USER_ROLES", value: undefined },
  { variable: "OIDC_USER_ROLES", value: " , " },
  { variable: "ALLOW_CUSTOM_CONNECTIONS", value: "true" },
  { variable: "ALLOW_CUSTOM_CONNECTIONS", value: "yes" },
  { variable: "ALLOW_CUSTOM_CONNECTIONS", value: "maybe" },
  { variable: "LIBREDB_EMBEDDED_SAMPLE", value: "true" },
  { variable: "LIBREDB_EMBEDDED_SAMPLE", value: "FALSE" },
  { variable: "SQLITE_EMBEDDED_SAMPLE", value: "true" },
  { variable: "SQLITE_EMBEDDED_SAMPLE", value: " false" },
  { variable: "SEED_CONFIG_PATH", value: "/app/config/seed-connections.yaml" },
  { variable: "SEED_DISCOVERY_PATH", value: "/app/discovery/services.json" },
  { variable: "SEED_KUBERNETES_DISCOVERY_PATH", value: "/var/run/libredb/kubernetes-discovery/export.json" },
  { variable: "OIDC_ROLE_PREFIX", value: "team-" },
  { variable: "ADMIN_PASSWORD", value: PASSWORD },
  { variable: "USER_PASSWORD", value: PASSWORD },
  { variable: "LAUNCH_TOKEN_SECRET", value: LAUNCH_SECRET },
  { variable: "BIGQUERY_SERVER_CREDENTIALS", value: "true" },
  { variable: "FIRESTORE_SERVER_CREDENTIALS", value: "true" },
  { variable: "LIBREDB_MCP_ENABLED", value: "true" },
  { variable: "LIBREDB_MCP_ENABLED", value: "yes" },
  { variable: "LIBREDB_AGENT_ENABLED", value: "on" },
  { variable: "LIBREDB_AGENT_ENABLED", value: "enabled" },
  { variable: "GOVERNANCE_POSTGRES_URL", value: undefined },
  { variable: "GOVERNANCE_POSTGRES_URL", value: `mysql://root:${URL_SECRET}@db.internal/libredb` },
  { variable: "STORAGE_POSTGRES_SCHEMA", value: undefined },
  { variable: "GOVERNANCE_INSTANCE_ID", value: undefined },
  { variable: "GOVERNANCE_INSTANCE_ID", value: "libredb studio" },
  { variable: "GOVERNANCE_POSTGRES_SCHEMA", value: "Bridge" },
  { variable: "GOVERNANCE_REFRESH_MS", value: "999" },
  { variable: "GOVERNANCE_MAX_STALENESS_MS", value: "3600001" },
  { variable: "GOVERNANCE_MAX_STALENESS_MS", value: "10000" },
  { variable: "GOVERNANCE_ALLOWED_ENGINES", value: "," },
  { variable: "GOVERNANCE_ALLOWED_ENGINES", value: "postgres,postgress" },
  { variable: "GOVERNANCE_PRIVATE_KEYS_FILE", value: undefined },
  { variable: "GOVERNANCE_PRIVATE_KEYS_FILE", value: path.join(path.dirname(KEYRING_FILE), "absent.json") },
];

describe("governance/preflight verifyGovernanceEnvAtBoot", () => {
  test("a governance install as docs/GOVERNANCE.md configures it passes, silently", () => {
    const run = runPreflight();
    expect(run.passed).toBe(true);
    expect(run.exitCalls).toEqual([]);
    expect(run.banner).toBe("");
  });

  test("with GOVERNANCE_SOURCE unset it checks nothing, whatever else is set", () => {
    delete process.env.GOVERNANCE_SOURCE;
    for (const variable of KEYS) delete process.env[variable];
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.ALLOW_CUSTOM_CONNECTIONS = "true";
    process.env.LIBREDB_MCP_ENABLED = "true";
    process.env.GOVERNANCE_REFRESH_MS = "not a number";

    const run = runPreflight();
    expect(governanceEnabled()).toBe(false);
    expect(run.passed).toBe(true);
    expect(run.exitCalls).toEqual([]);
    expect(run.banner).toBe("");
  });

  test("each refused variable stops the boot with a banner that names it, one case per condition", () => {
    // Every variable of docs/GOVERNANCE.md#boot-checks, and every GOVERNANCE_* setting but the switch, which the next
    // test covers.
    expect(new Set(REFUSED.map((refused) => refused.variable)).size).toBe(25);
    for (const { variable, value } of REFUSED) {
      setEnv(variable, value);
      const run = runPreflight();
      const label = `${variable}=${JSON.stringify(value)}`;
      expect(run.passed, label).toBe(false);
      expect(run.exitCalls, label).toEqual([1]);
      expect(run.banner, label).toContain("LibreDB Studio cannot start");
      // Exactly this condition, named first on its line.
      expect(run.problems, label).toHaveLength(1);
      expect(run.problems[0]?.startsWith(`${variable} `), `${label}: ${run.problems[0]}`).toBe(true);
      setEnv(variable, variable in GOVERNED ? GOVERNED[variable] : undefined);
    }
  });

  test("GOVERNANCE_SOURCE=postgress stops the boot as invalid and governanceEnabled() is true", () => {
    process.env.GOVERNANCE_SOURCE = "postgress";
    expect(governanceSource()).toBe("invalid");
    expect(governanceEnabled()).toBe(true);

    const run = runPreflight();
    expect(run.passed).toBe(false);
    expect(run.exitCalls).toEqual([1]);
    expect(run.problems).toHaveLength(1);
    expect(run.problems[0]).toStartWith('GOVERNANCE_SOURCE is "postgress"');
    expect(run.problems[0]).toContain("postgres");
  });

  test("an invalid GOVERNANCE_SOURCE is checked like postgres, so every other contradiction is named with it", () => {
    process.env.GOVERNANCE_SOURCE = "on";
    process.env.ADMIN_PASSWORD = PASSWORD;
    const run = runPreflight();
    expect(run.exitCalls).toEqual([1]);
    expect(run.problems.map((problem) => problem.split(" ")[0])).toEqual(["GOVERNANCE_SOURCE", "ADMIN_PASSWORD"]);
  });

  test("every contradiction is named in one banner, so one restart can fix them all", () => {
    for (const key of Object.keys(GOVERNED)) if (key !== "GOVERNANCE_SOURCE") delete process.env[key];
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.LIBREDB_MCP_ENABLED = "true";
    process.env.GOVERNANCE_REFRESH_MS = "100";

    const run = runPreflight();
    expect(run.exitCalls).toEqual([1]);
    expect(run.problems.map((problem) => problem.split(" ")[0]).sort()).toEqual(
      [
        "ADMIN_PASSWORD",
        "GOVERNANCE_INSTANCE_ID",
        "GOVERNANCE_POSTGRES_URL",
        "GOVERNANCE_PRIVATE_KEYS_FILE",
        "GOVERNANCE_REFRESH_MS",
        "LIBREDB_MCP_ENABLED",
        "NEXT_PUBLIC_AUTH_PROVIDER",
        "OIDC_ROLE_CLAIM",
        "OIDC_USER_ROLES",
        "STORAGE_POSTGRES_SCHEMA",
      ].sort(),
    );
  });

  test("the banner never carries a password, a launch secret or the governance URL", () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.USER_PASSWORD = `${PASSWORD}-user`;
    process.env.LAUNCH_TOKEN_SECRET = LAUNCH_SECRET;
    process.env.GOVERNANCE_POSTGRES_URL = `postgres-ish://libredb_studio:${URL_SECRET}@db.internal/libredb`;

    const run = runPreflight();
    expect(run.problems).toHaveLength(4);
    expect(run.banner).not.toContain(PASSWORD);
    expect(run.banner).not.toContain(LAUNCH_SECRET);
    expect(run.banner).not.toContain(URL_SECRET);
    expect(run.banner).not.toContain("db.internal");
  });

  test("a keyring file that does not load stops the boot naming GOVERNANCE_PRIVATE_KEYS_FILE", () => {
    const [first, second] = KEYRING_KEYS;
    const short = randomBytes(31).toString("base64url");
    const material = [first.text, second.text, short, first.raw.toString("hex"), second.raw.toString("hex")];
    const missing = path.join(path.dirname(KEYRING_FILE), "absent.json");
    const cases: readonly { readonly file: string | undefined; readonly reason: string }[] = [
      { file: undefined, reason: "is not set" },
      { file: missing, reason: `${JSON.stringify(missing)} cannot be read (ENOENT)` },
      // A directory, whose error code is EISDIR on Linux and may differ on another platform.
      { file: path.dirname(KEYRING_FILE), reason: "cannot be read (E" },
      { file: writeKeyringFile(`{"version":1,"keys":["${first.text}"`), reason: "is not valid JSON" },
      { file: writeKeyringFile({ version: 2, keys: [first.text] }), reason: "is keyring version 2" },
      { file: writeKeyringFile({ version: 1, keys: [] }), reason: "holds no keys" },
      {
        file: keyringFileOf(...Array.from({ length: 17 }, () => testKey())),
        reason: "holds 17 keys, more than the limit of 16",
      },
      { file: writeKeyringFile({ version: 1, keys: [first.text, short] }), reason: "holds key 2 of 31 bytes" },
      {
        file: writeKeyringFile({ version: 1, keys: [first.text, second.text, first.text] }),
        reason: `holds keys 1 and 3 with the same key id ${first.kid}`,
      },
    ];
    for (const { file, reason } of cases) {
      setEnv("GOVERNANCE_PRIVATE_KEYS_FILE", file);
      const run = runPreflight();
      expect(run.passed, reason).toBe(false);
      expect(run.exitCalls, reason).toEqual([1]);
      expect(run.problems, reason).toHaveLength(1);
      expect(run.problems[0], reason).toStartWith("GOVERNANCE_PRIVATE_KEYS_FILE ");
      expect(run.problems[0], reason).toContain(reason);
      // Never key material, in the banner or anywhere else the boot printed.
      for (const text of material) expect(run.log, reason).not.toContain(text);
    }
  });

  test("a two-key keyring boots, and the boot log names both kids and no key text", () => {
    const run = runPreflight();
    expect(run.passed).toBe(true);
    expect(run.exitCalls).toEqual([]);
    expect(run.banner).toBe("");
    for (const key of KEYRING_KEYS) {
      expect(run.log).toContain(key.kid);
      expect(run.log).not.toContain(key.text);
      expect(run.log).not.toContain(key.raw.toString("hex"));
      expect(run.log).not.toContain(key.raw.toString("base64"));
    }
  });

  test("the values that leave a refused feature off pass", () => {
    const accepted: Readonly<Record<string, readonly string[]>> = {
      ALLOW_CUSTOM_CONNECTIONS: ["", "  ", "false", "0", "off", "no", " Off ", "'false'", '"NO"'],
      LIBREDB_EMBEDDED_SAMPLE: ["", "false"],
      SQLITE_EMBEDDED_SAMPLE: ["", "false"],
      SEED_CONFIG_PATH: [""],
      SEED_DISCOVERY_PATH: [""],
      SEED_KUBERNETES_DISCOVERY_PATH: [""],
      OIDC_ROLE_PREFIX: [""],
      ADMIN_PASSWORD: [""],
      USER_PASSWORD: [""],
      LAUNCH_TOKEN_SECRET: [""],
      // Exactly what the providers read as on is refused: they enable server credentials for "true" only.
      BIGQUERY_SERVER_CREDENTIALS: ["", "false", "TRUE"],
      FIRESTORE_SERVER_CREDENTIALS: ["", "false", "1"],
      LIBREDB_MCP_ENABLED: ["", "false", "off", "0", " OFF "],
      LIBREDB_AGENT_ENABLED: ["", "false", "off", "0", " False "],
      OIDC_USER_ROLES: ["user", "user, analyst"],
      GOVERNANCE_POSTGRES_SCHEMA: ["", "bridge", "governance"],
      GOVERNANCE_REFRESH_MS: ["1000", "120000"],
      GOVERNANCE_MAX_STALENESS_MS: ["30000", "3600000"],
      GOVERNANCE_ALLOWED_ENGINES: ["", "postgres", "postgres, clickhouse"],
    };
    for (const [variable, values] of Object.entries(accepted)) {
      for (const value of values) {
        process.env[variable] = value;
        const run = runPreflight();
        expect(run.problems, `${variable}=${JSON.stringify(value)}`).toEqual([]);
        expect(run.passed, `${variable}=${JSON.stringify(value)}`).toBe(true);
      }
      setEnv(variable, variable in GOVERNED ? GOVERNED[variable] : undefined);
    }
  });

  test("the preflight reads each switch with the spellings its own reader uses", () => {
    // Asked with governance off, the readers answer from the environment alone, which is what the preflight checks.
    delete process.env.GOVERNANCE_SOURCE;
    const governed = (variable: string, value: string): boolean => {
      process.env.GOVERNANCE_SOURCE = "postgres";
      process.env[variable] = value;
      const passed = runPreflight().passed;
      delete process.env.GOVERNANCE_SOURCE;
      return passed;
    };

    for (const value of ["false", "0", "off", "no", " OFF ", "'no'"]) {
      process.env.ALLOW_CUSTOM_CONNECTIONS = value;
      expect(customConnectionsAllowed(), value).toBe(false);
      expect(governed("ALLOW_CUSTOM_CONNECTIONS", value), value).toBe(true);
    }
    for (const value of ["true", "1", "on", "yes", " On "]) {
      process.env.ALLOW_CUSTOM_CONNECTIONS = value;
      expect(customConnectionsAllowed(), value).toBe(true);
      expect(governed("ALLOW_CUSTOM_CONNECTIONS", value), value).toBe(false);
    }
    delete process.env.ALLOW_CUSTOM_CONNECTIONS;

    for (const value of ["", "false", "off", "0", " Off "]) {
      process.env.LIBREDB_MCP_ENABLED = value;
      expect(readMcpSwitch().state, value).toBe("off");
      expect(governed("LIBREDB_MCP_ENABLED", value), value).toBe(true);
    }
    for (const value of ["true", "on", "1", "yes", "enabled"]) {
      process.env.LIBREDB_MCP_ENABLED = value;
      expect(readMcpSwitch().state, value).not.toBe("off");
      expect(governed("LIBREDB_MCP_ENABLED", value), value).toBe(false);
    }
  });
});
