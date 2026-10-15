/**
 * The governance switch and the settings Studio reads with it (spec 9.2, appendix B.1).
 *
 * `GOVERNANCE_SOURCE=postgres` switches governance mode on: the governance source a control plane publishes becomes
 * Studio's only catalog of connections and grants (docs/GOVERNANCE.md). Unset or empty leaves it off, and Studio
 * behaves exactly as it does without this module. Any other value counts as on too, so a typo fails closed: the boot
 * preflight (`preflight.ts`) refuses to start on it, and a module that asks `governanceEnabled()` holds its feature
 * off.
 *
 * Each reader reads the environment on every call, and throws an Error that names its variable when the value is
 * invalid instead of falling back to a default. The module reads nothing but the environment and imports no Node
 * built-in, because `src/proxy.ts` and the npm package reach it.
 */
import { readSchemaName } from "@/lib/storage/schema-name";

/** Off, on with the PostgreSQL governance source, or set to a value Studio does not know, which counts as on. */
export type GovernanceSource = "off" | "postgres" | "invalid";

export function governanceSource(): GovernanceSource {
  const value = process.env.GOVERNANCE_SOURCE;
  if (value === undefined || value === "") return "off";
  return value === "postgres" ? "postgres" : "invalid";
}

/** True under governance, and for an invalid `GOVERNANCE_SOURCE` too, so the server fails closed. */
export function governanceEnabled(): boolean {
  return governanceSource() !== "off";
}

// One template literal per message, never a concatenation across lines: bun's line coverage under-counts the
// continuation lines of a message built that way.
const URL_MISSING_MESSAGE =
  "GOVERNANCE_POSTGRES_URL is not set: governance mode reads its governance source through it, as a postgresql:// URL for Studio's own role";
const URL_INVALID_MESSAGE =
  "GOVERNANCE_POSTGRES_URL is not a postgresql:// or postgres:// URL: give the governance source's address in that form";

const POSTGRES_URL_PROTOCOLS = new Set(["postgresql:", "postgres:"]);

/**
 * The URL of the governance source, for Studio's own role. Governance requires it. The value carries a password, so
 * no message quotes it.
 */
export function governancePostgresUrl(): string {
  const value = process.env.GOVERNANCE_POSTGRES_URL;
  if (value === undefined || value === "") throw new Error(URL_MISSING_MESSAGE);
  if (!POSTGRES_URL_PROTOCOLS.has(URL.parse(value)?.protocol ?? "")) throw new Error(URL_INVALID_MESSAGE);
  return value;
}

/**
 * The schema the contract lives in when `GOVERNANCE_POSTGRES_SCHEMA` is unset. `contract.ts` publishes the same name
 * as `DEFAULT_GOVERNANCE_SCHEMA`, but it imports node:crypto, so this module keeps a copy that its tests pin to it.
 */
const SCHEMA_DEFAULT = "bridge";

/** The schema of the governance source: `bridge` unless `GOVERNANCE_POSTGRES_SCHEMA` names another. */
export function governancePostgresSchema(): string {
  return readSchemaName("GOVERNANCE_POSTGRES_SCHEMA", SCHEMA_DEFAULT);
}

const REFRESH_MS_MIN = 1000;
const REFRESH_MS_MAX = 600000;
const REFRESH_MS_DEFAULT = 30000;
const MAX_STALENESS_MS_MAX = 3600000;
const MAX_STALENESS_MS_DEFAULT = 120000;

/** A set value as whole milliseconds, NaN when it is not a plain whole number, or undefined when unset or blank. */
function milliseconds(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * How often Studio reloads the snapshot when no notification arrives: `GOVERNANCE_REFRESH_MS`, whole milliseconds
 * from 1000 to 600000, 30000 by default.
 */
export function governanceRefreshMs(): number {
  const raw = process.env.GOVERNANCE_REFRESH_MS;
  const ms = milliseconds(raw) ?? REFRESH_MS_DEFAULT;
  if (!(ms >= REFRESH_MS_MIN && ms <= REFRESH_MS_MAX)) {
    throw new Error(
      `GOVERNANCE_REFRESH_MS must be a whole number of milliseconds from ${REFRESH_MS_MIN} to ${REFRESH_MS_MAX}, got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/**
 * How old the snapshot may grow while reloads fail before data routes answer 503: `GOVERNANCE_MAX_STALENESS_MS`,
 * whole milliseconds from `GOVERNANCE_REFRESH_MS` to 3600000, 120000 by default. A default below a longer refresh
 * interval is refused like a set value, rather than raised to it.
 */
export function governanceMaxStalenessMs(): number {
  const raw = process.env.GOVERNANCE_MAX_STALENESS_MS;
  const set = milliseconds(raw);
  const ms = set ?? MAX_STALENESS_MS_DEFAULT;
  if (!(ms <= MAX_STALENESS_MS_MAX)) {
    throw new Error(
      `GOVERNANCE_MAX_STALENESS_MS must be a whole number of milliseconds from GOVERNANCE_REFRESH_MS to ${MAX_STALENESS_MS_MAX}, got ${JSON.stringify(raw)}`,
    );
  }
  const refreshMs = governanceRefreshMs();
  if (ms < refreshMs) {
    const subject =
      set === undefined
        ? `GOVERNANCE_MAX_STALENESS_MS is unset, and its default ${ms}`
        : `GOVERNANCE_MAX_STALENESS_MS ${ms}`;
    throw new Error(
      `${subject} is below GOVERNANCE_REFRESH_MS ${refreshMs}: set it from ${refreshMs} to ${MAX_STALENESS_MS_MAX}`,
    );
  }
  return ms;
}

/** The engines a governance install admits when `GOVERNANCE_ALLOWED_ENGINES` is unset. */
const ALLOWED_ENGINES_DEFAULT: readonly string[] = Object.freeze([
  "postgres",
  "mysql",
  "mssql",
  "oracle",
  "mongodb",
  "redis",
]);

/** The shape of a Studio connection type id, which the contract's CHECK on `connections_v1.engine` enforces. */
const ENGINE_ID = /^[a-z][a-z0-9]{0,31}$/;

/**
 * The connection type ids governance admits: `GOVERNANCE_ALLOWED_ENGINES` as a comma list, trimmed, with empty
 * entries dropped and each engine kept once, or the six engines of a governance install when unset or blank. An
 * engine that opens a local file is never admitted, whatever this list says (docs/GOVERNANCE.md, row admission).
 */
export function governanceAllowedEngines(): readonly string[] {
  const raw = process.env.GOVERNANCE_ALLOWED_ENGINES;
  if (raw === undefined || raw.trim() === "") return ALLOWED_ENGINES_DEFAULT;
  const engines = [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
  ];
  if (engines.length === 0 || !engines.every((engine) => ENGINE_ID.test(engine))) {
    throw new Error(
      `GOVERNANCE_ALLOWED_ENGINES must list Studio connection type ids such as postgres, separated by commas, got ${JSON.stringify(raw)}`,
    );
  }
  return engines;
}
