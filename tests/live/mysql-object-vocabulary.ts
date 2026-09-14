/**
 * Opt-in live guard for #789: does a real server produce a catalog type the MySQL provider has
 * no rule for?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The object surface maps
 * `information_schema.TABLES.TABLE_TYPE` and `information_schema.ROUTINES.ROUTINE_TYPE` onto
 * object kinds through `MYSQL_OBJECT_TYPES`. A spelling that table does not name is dropped by
 * the counting statement's `WHERE kind IS NOT NULL` and is also not bound by any listing, so
 * the count and the listing AGREE and the object is invisible in the tree. Every gate passes.
 * That is not hypothetical: the first version of this provider derived its vocabulary from a
 * `SELECT DISTINCT` over its own seeded fixture, MariaDB's `SYSTEM VERSIONED` was in no arm,
 * and a system-versioned table existed nowhere as far as the app was concerned.
 *
 * A unit test cannot close that, because the thing being checked is what the ENGINE can
 * produce, and a mock answers whatever the author already thought of. Only a live server can
 * tell you about the value nobody thought of. So this is a live check, and it runs:
 *
 *   - by hand, against a disposable server, with the command below;
 *   - in Task 27's live acceptance run (#789), which is where it belongs permanently.
 *
 * It is NOT in `bun run test` or `bun run test:ci`. `tests/run-core.sh` globs
 * `tests/unit tests/api tests/integration tests/hooks tests/security tests/evals`, so nothing
 * under `tests/live/` is collected, which is the same arrangement
 * `tests/live/schema-diff-dialects.ts` has.
 *
 * WHAT IT CAN AND CANNOT SEE, stated plainly because a guard nobody can calibrate is worse
 * than none. `SELECT DISTINCT` reports the spellings the server's DATA exhibits, not the
 * spellings its grammar can produce. So the fixtures in `docker/mysql-init/` and
 * `docker/mariadb-init/` deliberately hold one object of each spelling this provider knows
 * about, including a `WITH SYSTEM VERSIONING` table; pointed at a fixture missing a case, this
 * script is blind to that case. Its real job is the value NOBODY thought of, and it does that
 * job wherever it is pointed: at a fixture, or at a copy of a real database with a `TABLE_TYPE`
 * a future release added.
 *
 * One spelling a fixture can never carry is `TEMPORARY`. A temporary table belongs to the
 * session that created it, so an init script's one is gone before this script connects, and
 * this script's own connection would have to create one to see it. It is in
 * `CATALOG_TYPE_RULES.tables.excluded` with its reason, which is what keeps it recognised here.
 *
 * Run it against a MySQL and a MariaDB, because the two differ: MariaDB has three TABLE_TYPE
 * spellings MySQL has none of. A run against only one server is half a measurement.
 *
 *   LIBREDB_LIVE_MYSQL_URLS="mysql://root:root@127.0.0.1:33126/app,mysql://root:root@127.0.0.1:33127/app" \
 *     bun tests/live/mysql-object-vocabulary.ts
 *
 * The URLs must point at DISPOSABLE servers. This script only reads, but it reads every schema
 * on the server, so point it at a fixture rather than at anything that matters.
 *
 * It exits non-zero and names every unrecognised value, with the server that produced it. A
 * new spelling is then a decision to make, not a silence: map it in `MYSQL_OBJECT_TYPES`, or
 * exclude it in `CATALOG_TYPE_RULES` with the reason.
 */
import mysql from "mysql2/promise";
import { CATALOG_TYPE_RULES } from "../../src/lib/db/providers/sql/mysql";

/** One catalog's question and the column its answer arrives in. */
const PROBES = [
  {
    catalog: "tables" as const,
    column: "TABLE_TYPE",
    sql: "SELECT DISTINCT TABLE_TYPE AS value FROM information_schema.TABLES",
  },
  {
    catalog: "routines" as const,
    column: "ROUTINE_TYPE",
    sql: "SELECT DISTINCT ROUTINE_TYPE AS value FROM information_schema.ROUTINES",
  },
];

function urls(): string[] {
  const raw = process.env.LIBREDB_LIVE_MYSQL_URLS;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_MYSQL_URLS to a comma-separated list of disposable MySQL-wire URLs. " +
        "Include a MySQL and a MariaDB: they do not have the same TABLE_TYPE set.",
    );
  }
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/** Everything the provider has a rule for, whether it maps the value or excludes it. */
function recognised(catalog: "tables" | "routines"): Set<string> {
  const rules = CATALOG_TYPE_RULES[catalog];
  return new Set([...rules.modelled, ...Object.keys(rules.excluded)]);
}

/**
 * The subset assertion cannot be vacuous in either direction, so both emptinesses are checked
 * before any server is asked. An empty rule set would accept nothing and fail noisily; an empty
 * answer from a server would pass trivially, which is why the row count is asserted too.
 */
function assertRulesAreNonEmpty(): void {
  for (const probe of PROBES) {
    const rules = CATALOG_TYPE_RULES[probe.catalog];
    if (rules.modelled.length === 0) {
      throw new Error(`CATALOG_TYPE_RULES.${probe.catalog}.modelled is empty, so nothing is being checked`);
    }
    // A spelling in both halves is a contradiction rather than belt and braces: the CASE would
    // map it to a kind while the doc says it is deliberately dropped.
    const both = rules.modelled.filter((type) => type in rules.excluded);
    if (both.length > 0) {
      throw new Error(`${probe.catalog}: ${both.join(", ")} is both modelled and excluded`);
    }
  }
}

async function probeServer(url: string): Promise<string[]> {
  const failures: string[] = [];
  const conn = await mysql.createConnection(url);
  try {
    const [versionRows] = await conn.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
    const version = String(versionRows[0]?.version ?? "unknown");
    console.log(`\n=== ${version} ===`);

    for (const probe of PROBES) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(probe.sql);
      const values = rows.map((row) => String(row.value)).sort();
      // An engine with no routines at all answers zero rows here, which is a real state and
      // not a failure - but it is also not a measurement, so it is reported as such rather
      // than counted as a pass.
      console.log(`${probe.column}: ${values.length === 0 ? "(no rows, nothing measured)" : values.join(", ")}`);

      const known = recognised(probe.catalog);
      const unknown = values.filter((value) => !known.has(value));
      for (const value of unknown) {
        failures.push(
          `${version}: ${probe.column} '${value}' has no rule. ` +
            `Map it in MYSQL_OBJECT_TYPES or exclude it in CATALOG_TYPE_RULES.${probe.catalog}.excluded with the reason. ` +
            `A value with no rule is dropped from the COUNT and from the LISTING alike, so the object is invisible in the tree.`,
        );
      }
    }
  } finally {
    await conn.end();
  }
  return failures;
}

assertRulesAreNonEmpty();

const failures: string[] = [];
for (const url of urls()) {
  failures.push(...(await probeServer(url)));
}

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} unrecognised catalog type(s).`);
  process.exit(1);
}
console.log("Every catalog type every server reported has a rule.");
