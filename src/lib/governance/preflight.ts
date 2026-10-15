/**
 * Boot-time governance preflight (spec 9.2).
 *
 * Governance mode makes the identity provider the only way to sign in and the governance source the only catalog of
 * connections. An environment that also sets a password, a launch secret, a seed file, a sample, custom connections,
 * the server's own Google identity, MCP or the agent contradicts it, and so does a governance setting that is missing
 * or invalid. Each would surface later, as a way around the grants or as a governance source that never loads while
 * the health check stays green. So with governance on, this check refuses to start instead, naming every variable to
 * fix in one banner and never quoting a secret.
 *
 * It reads each variable as written rather than asking the module that consumes it: under governance those modules
 * hold their feature off whatever the environment says, so asking them would hide the contradiction it reports.
 *
 * It also loads the keyring of `GOVERNANCE_PRIVATE_KEYS_FILE` (`keyring.ts`), which the process keeps, so the server
 * opens sealed credentials with exactly the keyring it checked here. A keyring that does not load is refused with
 * the file and the reason, and never with key material.
 *
 * Runs only on standalone boot, right after `verifyAuthEnvAtBoot()` in `src/instrumentation.ts`, and checks nothing
 * while governance is off, so a Studio without GOVERNANCE_SOURCE starts exactly as before.
 */
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import {
  governanceAllowedEngines,
  governanceEnabled,
  governanceMaxStalenessMs,
  governancePostgresSchema,
  governancePostgresUrl,
  governanceRefreshMs,
  governanceSource,
} from "@/lib/governance/config";
import { governanceInstanceId } from "@/lib/governance/instance";
import { governanceKeyring } from "@/lib/governance/keyring";

/** The spellings that switch custom connections off, as `src/lib/config/custom-connections.ts` reads them. */
const CUSTOM_CONNECTIONS_OFF = new Set(["false", "0", "off", "no"]);
/** The spellings that switch MCP (`src/lib/mcp/config.ts`) or the agent (`src/lib/agent/config.ts`) off. */
const SWITCH_OFF = new Set(["false", "off", "0"]);

const KNOWN_ENGINES: ReadonlySet<string> = new Set(SHIPPED_DATABASE_TYPES);

/** Whether a variable holds a value; an empty one counts as unset, as it does for every reader of these variables. */
const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

/** A value as the banner shows it. Only a variable that never holds a secret is ever shown. */
const shown = (value: string | undefined): string => (value === undefined ? "unset" : JSON.stringify(value));

/** Trimmed, stripped of one pair of matching surrounding quotes and lowercased, as custom-connections.ts reads it. */
function unquoted(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim().toLowerCase();
}

/** The message a reader refuses the environment with, or null when it accepts it. */
function refusalOf(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** An allowed engine Studio has no connection type for is a typo, and every row of the engine it meant is skipped. */
function unknownEnginesProblem(): string | null {
  const unknown = governanceAllowedEngines().filter((engine) => !KNOWN_ENGINES.has(engine));
  if (unknown.length === 0) return null;
  return `GOVERNANCE_ALLOWED_ENGINES names engines Studio has no connection type for: ${unknown.join(", ")}; list connection type ids such as postgres`;
}

/** Every reason this environment contradicts governance mode, each starting with the variable to fix. */
function governanceEnvProblems(): string[] {
  const problems: (string | null)[] = [];

  if (governanceSource() === "invalid") {
    problems.push(
      `GOVERNANCE_SOURCE is ${shown(process.env.GOVERNANCE_SOURCE)}: set it to postgres, or unset it to run without governance; any other value counts as on, so the server fails closed`,
    );
  }

  // Sign-in through the identity provider only, with the admin and user roles of its role claim.
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER !== "oidc") {
    problems.push(
      `NEXT_PUBLIC_AUTH_PROVIDER is ${shown(process.env.NEXT_PUBLIC_AUTH_PROVIDER)}: governance mode signs in through the identity provider only, so set it to oidc`,
    );
  }
  if (!process.env.OIDC_ROLE_CLAIM?.trim()) {
    problems.push(
      "OIDC_ROLE_CLAIM is empty: governance mode reads the admin and user roles from this ID token claim, such as libredb_roles",
    );
  }
  if (!(process.env.OIDC_USER_ROLES ?? "").split(",").some((role) => role.trim() !== "")) {
    problems.push(
      "OIDC_USER_ROLES is empty: governance mode refuses an account that holds neither role, so name the user role, such as user",
    );
  }
  for (const [name, value] of [
    ["ADMIN_PASSWORD", process.env.ADMIN_PASSWORD],
    ["USER_PASSWORD", process.env.USER_PASSWORD],
  ] as const) {
    if (isSet(value)) {
      problems.push(`${name} is set: governance mode signs in through the identity provider only, so unset it`);
    }
  }
  if (isSet(process.env.LAUNCH_TOKEN_SECRET)) {
    problems.push("LAUNCH_TOKEN_SECRET is set: governance mode has no launch sign-in, so unset it");
  }

  // Connections from the governance source only.
  const customConnections = unquoted(process.env.ALLOW_CUSTOM_CONNECTIONS ?? "");
  if (customConnections !== "" && !CUSTOM_CONNECTIONS_OFF.has(customConnections)) {
    problems.push(
      `ALLOW_CUSTOM_CONNECTIONS is ${shown(process.env.ALLOW_CUSTOM_CONNECTIONS)}: governance mode serves only the connections of the governance source, so set it to false or unset it`,
    );
  }
  for (const [name, value] of [
    ["LIBREDB_EMBEDDED_SAMPLE", process.env.LIBREDB_EMBEDDED_SAMPLE],
    ["SQLITE_EMBEDDED_SAMPLE", process.env.SQLITE_EMBEDDED_SAMPLE],
  ] as const) {
    if (isSet(value) && value !== "false") {
      problems.push(
        `${name} is ${shown(value)}: governance mode offers no sample connection, so set it to false or unset it`,
      );
    }
  }
  for (const [name, value] of [
    ["SEED_CONFIG_PATH", process.env.SEED_CONFIG_PATH],
    ["SEED_DISCOVERY_PATH", process.env.SEED_DISCOVERY_PATH],
  ] as const) {
    if (isSet(value)) {
      problems.push(`${name} is set: governance mode reads connections from the governance source only, so unset it`);
    }
  }
  for (const [name, value] of [
    ["BIGQUERY_SERVER_CREDENTIALS", process.env.BIGQUERY_SERVER_CREDENTIALS],
    ["FIRESTORE_SERVER_CREDENTIALS", process.env.FIRESTORE_SERVER_CREDENTIALS],
  ] as const) {
    if (value === "true") {
      problems.push(
        `${name} is "true": the server's own Google identity would stand in for the credential a grant selects, so unset it`,
      );
    }
  }

  // MCP and the agent do not run under governance in this version.
  for (const [name, value, feature] of [
    ["LIBREDB_MCP_ENABLED", process.env.LIBREDB_MCP_ENABLED, "MCP"],
    ["LIBREDB_AGENT_ENABLED", process.env.LIBREDB_AGENT_ENABLED, "the agent"],
  ] as const) {
    const switched = (value ?? "").trim().toLowerCase();
    if (switched !== "" && !SWITCH_OFF.has(switched)) {
      problems.push(
        `${name} is ${shown(value)}: this version does not run ${feature} under governance, so set it to false or unset it`,
      );
    }
  }

  // The governance settings: required ones present, and every one valid.
  problems.push(refusalOf(governancePostgresUrl), refusalOf(governanceInstanceId));
  if (!isSet(process.env.STORAGE_POSTGRES_SCHEMA)) {
    problems.push(
      "STORAGE_POSTGRES_SCHEMA is not set: governance mode keeps Studio's storage tables in a schema of their own, such as studio",
    );
  }
  problems.push(
    refusalOf(governancePostgresSchema),
    refusalOf(governanceRefreshMs),
    // Reports an invalid GOVERNANCE_REFRESH_MS as well, which the set below keeps once.
    refusalOf(governanceMaxStalenessMs),
    refusalOf(governanceAllowedEngines) ?? unknownEnginesProblem(),
    // Loads the keyring the server opens sealed credentials with, and keeps it for the life of the process.
    refusalOf(governanceKeyring),
  );

  return [...new Set(problems.filter((problem): problem is string => problem !== null))];
}

/**
 * Check the environment against governance mode before the server starts serving.
 *
 * Returns `true` when boot may continue, which it always may with governance off. Otherwise it prints one banner that
 * names every variable to fix and calls `process.exit(1)`; it also returns `false`, so the caller stops its remaining
 * boot work where `process.exit` is stubbed (tests).
 */
export function verifyGovernanceEnvAtBoot(): boolean {
  if (!governanceEnabled()) return true;
  const problems = governanceEnvProblems();
  if (problems.length === 0) return true;

  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: the environment contradicts governance mode",
      " GOVERNANCE_SOURCE switches governance on, and these variables have to change:",
      ...problems.map((problem) => `   - ${problem}`),
      " docs/GOVERNANCE.md lists every check under Studio configuration.",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}
