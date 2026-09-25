/**
 * Opt-in live guard for #1033: does the type this provider reports still build DDL the server
 * that reported it accepts?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. `information_schema.COLUMNS` carries two
 * type columns. `DATA_TYPE` is the FAMILY - `varchar` for a `VARCHAR(20)`, `decimal` for a
 * `DECIMAL(12,2)`, `enum` whatever the values, `int` for an `INT UNSIGNED` - and `COLUMN_TYPE`
 * is the type AS DECLARED. The provider read the family, `ColumnSchema.type` carried it, and
 * the schema-diff migration generator interpolates that field verbatim, so every generated
 * `CREATE TABLE` and `ADD COLUMN` for a MySQL or MariaDB target lost every length. `varchar`
 * with no length is not a type on either engine.
 *
 * A mock cannot settle that. "The server accepts this statement" is a claim about the engine,
 * and a mock answers whatever its author already wrote. So this script asks the engine twice:
 * it replays the statement the generator produces, and it replays the statement the OLD
 * reading produced, and it requires the first to be accepted and the second to be REFUSED.
 * Without the second half a server that had started accepting a bare `varchar` would leave
 * this script green while the reading it guards had stopped mattering.
 *
 * It reads `app.column_types`, which `docker/mysql-init/01-object-fixture.sql` and
 * `docker/mariadb-init/01-object-fixture.sql` create with one column per part of a declaration
 * the family drops. It is NOT in `bun run test`: the runner excludes `tests/live/` by name
 * (`EXCLUDED` in `tests/runner/discover.ts`).
 *
 *   LIBREDB_LIVE_MYSQL_URLS=mysql://root:root@127.0.0.1:3306/app,mysql://root:root@127.0.0.1:3307/app \
 *     bun tests/live/mysql-column-type.ts
 *
 * Point it at DISPOSABLE servers, and include one of each family: MySQL 8.0.19 deprecated the
 * integer display width and stopped reporting it, so the two do not spell every declaration
 * the same way, and it CREATES and DROPS throwaway tables in the database the URL names.
 */
import mysql from "mysql2/promise";
import { MySQLProvider } from "../../src/lib/db/providers/sql/mysql";
import { diffSchemas } from "../../src/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "../../src/lib/schema-diff/migration-generator";
import type { StoredObject } from "../../src/lib/db/detailed-object";
import type { ColumnSchema, DatabaseConnection } from "../../src/lib/types";
import { splitStatements } from "../../src/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "../../src/lib/sql/grammar";

/** The fixture table this script reads, on both servers. */
const PROBE_TABLE = "column_types";

function urls(): string[] {
  const raw = process.env.LIBREDB_LIVE_MYSQL_URLS;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_MYSQL_URLS to a comma-separated list of disposable MySQL-wire URLs. " +
        "Include a MySQL and a MariaDB: they do not spell every declaration the same way.",
    );
  }
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/** The URL as this repo's own connection record, so the PROVIDER does the reading. */
function connectionOf(url: string): DatabaseConnection {
  const parsed = new URL(url);
  return {
    id: `live-${parsed.port || "3306"}`,
    name: `live ${parsed.host}`,
    type: "mysql",
    host: parsed.hostname,
    port: Number(parsed.port || "3306"),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    createdAt: new Date(),
  };
}

/** One throwaway CREATE, run and dropped, answering only whether the server took it. */
async function accepts(conn: mysql.Connection, table: string, columns: string): Promise<string | null> {
  try {
    await conn.query(`CREATE TABLE \`${table}\` (${columns})`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
}

/**
 * The generated migration, replayed at the server that supplied the columns.
 *
 * `diffSchemas` against an empty source is the CREATE TABLE path, and the table is renamed
 * first so the statement lands beside the fixture rather than on top of it.
 */
async function replayGenerated(
  conn: mysql.Connection,
  columns: readonly ColumnSchema[],
  table: string,
): Promise<string[]> {
  const target: StoredObject[] = [{ name: table, columns: [...columns], indexes: [] }];
  const sql = generateMigrationSQL(diffSchemas([], target), "mysql");
  const failures: string[] = [];
  let ran = 0;
  try {
    for (const statement of splitStatements(sql, resolveSqlGrammar("mysql"))) {
      // The generator puts a section comment IN FRONT of the statement and the splitter keeps
      // it, so the test skips leading comment lines rather than anchoring at the first
      // character. Anchoring there matched nothing and this half of the guard ran empty.
      const text = statement.sql
        .replace(/;\s*$/, "")
        .replace(/^(?:[ \t]*--[^\n]*\n)*/, "")
        .trim();
      if (!/^CREATE\s+TABLE/i.test(text)) continue;
      ran += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time is the point.
        await conn.query(text);
        console.log(`the generated CREATE TABLE was accepted:\n${text}`);
      } catch (error) {
        failures.push(
          `the generated CREATE TABLE was refused by the server that supplied its columns: ` +
            `${error instanceof Error ? error.message : String(error)}\n${text}`,
        );
      }
    }
  } finally {
    await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  // A run that replayed NOTHING would pass every assertion above, so it is a failure: the
  // generator emitted no CREATE TABLE, and this half of the guard measured nothing.
  if (ran === 0) failures.push(`the migration generator produced no CREATE TABLE to replay:\n${sql}`);
  return failures;
}

async function probeServer(url: string): Promise<string[]> {
  const failures: string[] = [];
  const provider = new MySQLProvider(connectionOf(url));
  const conn = await mysql.createConnection(url);
  try {
    const [versionRows] = await conn.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
    const version = String(versionRows[0]?.version ?? "unknown");
    console.log(`\n=== ${version} ===`);

    // What the catalog itself says, which is the only authority on what the provider should
    // have reported. Nothing below hardcodes a spelling.
    const [catalog] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS declared, DATA_TYPE AS family " +
        "FROM information_schema.COLUMNS " +
        `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${PROBE_TABLE}' ORDER BY ORDINAL_POSITION`,
    );
    if (catalog.length === 0) {
      failures.push(
        `${version}: app.${PROBE_TABLE} has no columns. Recreate the container: the init script only runs on a fresh data directory.`,
      );
      return failures;
    }

    await provider.connect();
    // The object surface addresses `[database, name]`, so a URL with no path has nothing to
    // address and is a mistake in the invocation rather than a finding about the server.
    const database = connectionOf(url).database;
    if (!database) throw new Error(`${url} names no database, and the object surface addresses [database, name].`);
    const single = await provider.describeObject([database, PROBE_TABLE], "table");
    const batch = await provider.describeObjects([database], "table");
    const bulk = batch.details.find((detail) => detail.path[1] === PROBE_TABLE);
    if (bulk === undefined) {
      failures.push(`${version}: describeObjects() did not describe ${PROBE_TABLE}.`);
      return failures;
    }

    // 1 and 2: both surfaces report the DECLARED type, and the family beside it.
    for (const [surface, columns] of [
      ["describeObject", single.columns],
      ["describeObjects", bulk.columns],
    ] as const) {
      const byName = new Map(columns.map((column) => [column.name, column]));
      for (const row of catalog) {
        const name = String(row.name);
        const declared = String(row.declared);
        const family = String(row.family);
        const got = byName.get(name);
        console.log(`${surface} ${name}: declared=${declared} family=${family} reported=${got?.type}`);
        if (got?.type !== declared) {
          failures.push(
            `${version}: ${surface}() reported ${name} as ${JSON.stringify(got?.type)}, and the server declares it ` +
              `${JSON.stringify(declared)}. \`ColumnSchema.type\` is the type a reader SEES and the schema-diff ` +
              `migration generator WRITES, so it must be COLUMN_TYPE.`,
          );
        }
        const wantBase = declared === family ? undefined : family;
        if (got?.baseType !== wantBase) {
          failures.push(
            `${version}: ${surface}() reported ${name} with baseType ${JSON.stringify(got?.baseType)}, expected ` +
              `${JSON.stringify(wantBase)}. The family is what a reader DECIDES on, and it is absent exactly where ` +
              `the server draws no distinction.`,
          );
        }
      }
    }

    // 3: the generated CREATE TABLE is accepted by this very server.
    failures.push(...(await replayGenerated(conn, single.columns, `libredb_type_replay_${process.pid}`)));

    // And the OLD reading is refused, so a green run means the reading still matters. The
    // family alone is what the provider used to report; `varchar` with no length is error 1064.
    const familyOnly = catalog.map((row) => `\`${String(row.name)}\` ${String(row.family)}`).join(", ");
    const refusal = await accepts(conn, `libredb_type_family_${process.pid}`, familyOnly);
    if (refusal === null) {
      failures.push(
        `${version}: the OLD reading built a CREATE TABLE this server ACCEPTED (${familyOnly}). ` +
          `This guard proves #1033 by the engine's refusal of a bare family, and the engine no longer refuses it, ` +
          `so the guard has stopped measuring anything and must be rewritten.`,
      );
    } else {
      console.log(`the family-only definition was refused, as it must be: ${refusal}`);
    }
  } finally {
    await provider.disconnect();
    await conn.end();
  }
  return failures;
}

const failures: string[] = [];
for (const url of urls()) {
  failures.push(...(await probeServer(url)));
}

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} column type reading(s) did not hold.`);
  process.exit(1);
}
console.log(
  "Both column reads report the type as declared with the family beside it, the generated CREATE TABLE was accepted " +
    "by the server that supplied its columns, and the family-only definition it replaces was refused.",
);
