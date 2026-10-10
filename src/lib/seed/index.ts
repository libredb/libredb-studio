import * as fs from "fs";
import { filterByRoles } from "./connection-filter";
import { getDiscoveredConnections } from "./discovery-loader";
import { isSampleEnabled, resolveSamplePath, buildSampleConnection } from "./libredb-sample";
import { loadOperatorSources } from "./operator-loader";
import type { OperatorEntry } from "./sources/types";
import {
  isSqliteSampleEnabled,
  resolveSqliteSamplePath,
  buildSqliteSampleConnection,
  getSqliteSampleSeedState,
  SQLITE_SAMPLE_SEED_ID,
} from "./sqlite-sample";
import type { ManagedConnection } from "./types";

export type { ManagedConnection } from "./types";
export { resetCache } from "./operator-loader";

/**
 * The operator entries these roles may see, in source order.
 *
 * The operator loader (operator-loader.ts) has resolved every `${NAME}` of a non-literal entry in its cache fill, and
 * a `${vault:...}` is left for `resolveConnection` to read when the connection is opened. An entry that fill read as
 * literal (every file-like entry while SEED_LITERAL_VALUES is on) carries the literal marker, which
 * `resolveConnection` honours by skipping Vault, so no value of it is resolved anywhere. The marker is set after
 * filterByRoles, because filterByRoles copies a fixed field list and SeedConnectionSchema strips an undeclared key,
 * so a marker set any earlier would not survive; filterByRoles builds a new object for every connection, so setting
 * it never reaches the loader's cache.
 */
function projectOperatorEntries(entries: readonly OperatorEntry[], roles: string[]): ManagedConnection[] {
  return entries.flatMap((entry) =>
    filterByRoles([entry.connection], roles).map((conn) =>
      entry.literal ? Object.assign(conn, { literal: true as const }) : conn,
    ),
  );
}

export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const operator = await loadOperatorSources();
  const fromOperators = projectOperatorEntries(operator.entries, roles);

  /*
    Discovered connections (CapRover auto-connect spec 9.5 and 9.7) come after the operator entries and before the
    built-in samples. They never pass through the operator loader's resolution: their values are the literal text
    another app on the platform network carries, so a `${NAME}` in them is not Studio's to resolve, and a plaintext
    password in them is not the operator's to be warned about. The literal marker is set here, after filterByRoles,
    for the reason projectOperatorEntries gives. getSeedConnectionByIdUnfiltered below does not include them, so the
    unfiltered lookup never confirms to a caller that a discovered id exists.

    A discovered connection whose id an operator source declares is dropped, whichever role the operator entry is
    for, and also when the fill dropped that entry for an undefined variable: declaredIds holds every id a source
    declared. The discovery loader applies the same rule when it recomputes, but its cache and the operator cache
    expire independently, so for up to one SEED_CACHE_TTL_MS it can still list an id an operator source has just
    gained, and the list would carry that id twice.
  */
  const discovered = filterByRoles(await getDiscoveredConnections(), roles)
    .filter((conn) => !operator.declaredIds.has(conn.seedId))
    .map((conn) => Object.assign(conn, { literal: true as const }));

  const out = [...fromOperators, ...discovered];

  /*
    The SQLite sample leads the built-ins, and the order is the point: a client with
    no persisted active connection selects the first of this list, so whichever sample
    comes first is what a brand-new administrator lands on. Agent mode executes statements on
    PostgreSQL, SQLite, DuckDB, SQL Server and MySQL; the LibreDB engine has no
    database-native read-only execution profile, so leading with it put every
    zero-config administrator on the one connection an agent run can never execute
    against. An operator's own seed config
    still leads both — those are already in `out`.

    In a test run, only consider a sample when its explicit path override is set, so
    an uncontrolled real ./data/sample.* cannot perturb unrelated suites.
    (NODE_ENV==='test' guard mirrors the existing pattern in src/lib/db/factory.ts.)
  */
  const sqliteSampleConsidered = process.env.NODE_ENV !== "test" || !!process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
  if (isSqliteSampleEnabled() && sqliteSampleConsidered && roles.includes("admin")) {
    try {
      if (fs.existsSync(resolveSqliteSamplePath())) {
        out.push(buildSqliteSampleConnection());
      }
    } catch {
      /* fs error -> omit the sample */
    }
  }

  const libredbSampleConsidered = process.env.NODE_ENV !== "test" || !!process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
  if (isSampleEnabled() && libredbSampleConsidered) {
    try {
      if (fs.existsSync(resolveSamplePath())) {
        out.push(buildSampleConnection());
      }
    } catch {
      /* fs error -> omit the sample */
    }
  }

  return out;
}

/**
 * Seed ids whose async seeding is still in flight — advertised by the managed
 * connections API so clients poll until the sample appears (or seeding ends).
 * Empty when nothing is seeding: embedded in platform, instrumentation never
 * runs, the state stays "idle", and clients never poll.
 */
export function getPendingSeeds(): string[] {
  if (isSqliteSampleEnabled() && getSqliteSampleSeedState() === "seeding") {
    return [SQLITE_SAMPLE_SEED_ID];
  }
  return [];
}

export async function getSeedConnectionById(seedId: string, roles: string[]): Promise<ManagedConnection | null> {
  const all = await getManagedConnections(roles);
  return all.find((c) => c.seedId === seedId) ?? null;
}

/** The operator entries only: no discovered connection and no sample, so a 403 never confirms a discovered id. */
export async function getSeedConnectionByIdUnfiltered(seedId: string): Promise<ManagedConnection | null> {
  const operator = await loadOperatorSources();
  const all = projectOperatorEntries(operator.entries, ["*", "admin", "user"]);
  return all.find((c) => c.seedId === seedId) ?? null;
}
