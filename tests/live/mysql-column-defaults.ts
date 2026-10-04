/**
 * Opt-in live guard for #795: does a real server still report column defaults the way the
 * provider's `CATALOG_DEFAULT_READING` says it does?
 *
 * It checks BOTH readings the provider publishes, because a column carries both. The value,
 * against `EXPECTED` below. And the SQL TEXT, by replaying each reported `COLUMN_DEFAULT`
 * back at the SAME server after the word `DEFAULT`: that is the reading the schema-diff
 * migration generator pastes, and `literal: "as-written"` is exactly the claim that it can
 * be pasted. Without the replay a server that stopped reporting pasteable SQL would leave
 * this script green.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The provider's reading rule is a claim
 * about what two ENGINES emit, and a mock answers whatever its author already thought of.
 * The first repair of this defect handled the doubled quote and not the escaping backslash,
 * and every mock in the suite agreed with it, because the same author wrote both.
 *
 * It reads `app.column_defaults`, which `docker/mysql-init/01-object-fixture.sql` and
 * `docker/mariadb-init/01-object-fixture.sql` create with one column per measured case. It
 * is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`).
 *
 *   LIBREDB_LIVE_MYSQL_URLS=mysql://root:pw@127.0.0.1:3306/app,mysql://root:pw@127.0.0.1:3307/app \
 *     bun tests/live/mysql-column-defaults.ts
 *
 * Point it at DISPOSABLE servers, and include one of each family: the whole point is that
 * they disagree.
 */
import mysql from "mysql2/promise";
import { unquoteLiteral } from "../../src/lib/sql/values";
import { portableDefaultSql, showCreateColumnDefaults } from "../../src/lib/db/providers/sql/mysql-show-create";

/** What each column must resolve to, whichever server reports it. */
const EXPECTED: Readonly<Record<string, string | undefined>> = {
  def_absent: undefined,
  def_not_null: undefined,
  def_null_string: "NULL",
  def_text: "abc",
  def_empty: "",
  def_quote: "it's",
  def_backslash: "a\\b",
  def_newline: "a\nb",
  def_number: "42",
  def_generated: undefined,
};

/**
 * The provider's rule, spelled here because `catalogDefault` is private to the provider
 * module and this script must not become a second implementation of the DECODING. The
 * literal decoding, which is the part that was wrong, comes from the shipped function.
 */
function readDefault(raw: string | null, extra: string | null, flavour: "mysql" | "mariadb"): string | undefined {
  if (raw === null) return undefined;
  if (extra !== null && ["STORED GENERATED", "VIRTUAL GENERATED"].includes(extra.trim().toUpperCase()))
    return undefined;
  if (flavour === "mysql") return raw;
  if (raw === "NULL") return undefined;
  return unquoteLiteral(raw, "mysql") ?? raw;
}

function urls(): string[] {
  const raw = process.env.LIBREDB_LIVE_MYSQL_URLS;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_MYSQL_URLS to a comma-separated list of disposable MySQL-wire URLs. " +
        "Include a MySQL and a MariaDB: they do not report a column default the same way.",
    );
  }
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Replay every reported `COLUMN_DEFAULT` at the server that reported it.
 *
 * `CATALOG_DEFAULT_READING` claims `literal: "as-written"` for this flavour, which is the
 * claim that the catalog text is valid SQL HERE, and `ColumnSchema.defaultExpression`
 * carries it to the migration generator on that basis. The only honest test of "valid SQL
 * for this engine" is the engine: create a throwaway table whose one column takes the
 * reported text as its default, and let the server rule.
 *
 * The column type comes from `COLUMN_TYPE` and not `DATA_TYPE`: `DATA_TYPE` drops the
 * length, so `varchar` alone would fail the CREATE for a reason that has nothing to do with
 * the default.
 */
async function replayDefaults(
  conn: mysql.Connection,
  version: string,
  rows: readonly mysql.RowDataPacket[],
): Promise<string[]> {
  const failures: string[] = [];
  let ordinal = 0;
  for (const row of rows) {
    if (row.raw === null) continue;
    const name = String(row.name);
    const raw = String(row.raw);
    const columnType = String(row.columnType);
    const table = `libredb_default_replay_${process.pid}_${ordinal++}`;
    try {
      await conn.query(`CREATE TABLE \`${table}\` (c ${columnType} DEFAULT ${raw})`);
      console.log(`${name}: replayed, the server accepted DEFAULT ${raw}`);
    } catch (error) {
      failures.push(
        `${version}: ${name} reported COLUMN_DEFAULT ${JSON.stringify(raw)}, and the SAME server refused it ` +
          `after the word DEFAULT on a ${columnType} column: ${error instanceof Error ? error.message : String(error)}. ` +
          `CATALOG_DEFAULT_READING in src/lib/db/providers/sql/mysql.ts claims literal: "as-written" for this ` +
          `flavour, and the schema-diff migration generator pastes that text, so one of the two must change.`,
      );
    } finally {
      // Always, including on the failure path: a rejected CREATE leaves nothing, but a later
      // failure in this loop must not leave the earlier tables behind.
      await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  }
  return failures;
}

/**
 * The #1031 cases, one column each: the defaults MySQL's catalog cannot spell as SQL. A
 * zero byte the catalog truncates to `0x`, backslash escapes `SHOW CREATE` writes in every
 * `sql_mode`, a latin1 column the hex rewrite must not reinterpret, a quoted number, and an
 * expression. Created here rather than in the init fixture, which the mock suite mirrors.
 */
const SHOW_CREATE_PROBE = `(
  bin   BINARY(4)    DEFAULT 0x00FF0A27,
  vbin  VARBINARY(8) DEFAULT 0x0027005C0D,
  zero  BINARY(3)    DEFAULT 0x000000,
  note  VARCHAR(20)  DEFAULT 'abc',
  path  VARCHAR(20)  DEFAULT 'a\\\\b',
  lat   VARCHAR(4)   CHARACTER SET latin1 DEFAULT 0x5CE9,
  qty   INT          DEFAULT 42,
  ex    VARCHAR(20)  DEFAULT (concat('x','y'))
)`;

/**
 * MySQL only (#1031): read each probe default out of `SHOW CREATE TABLE` with the shipped
 * reader, make it portable with the shipped rewrite, and replay that text on this server
 * under BOTH `sql_mode=''` and `NO_BACKSLASH_ESCAPES`. A replay passes when the server
 * accepts it AND a row inserted with defaults stores the source column's exact bytes: a text
 * that is accepted and stores other bytes is the silent failure this guards against.
 */
async function replayShowCreate(conn: mysql.Connection, version: string): Promise<string[]> {
  const failures: string[] = [];
  const source = `libredb_show_create_${process.pid}`;
  const replay = `libredb_show_create_replay_${process.pid}`;
  try {
    await conn.query(`CREATE TABLE \`${source}\` ${SHOW_CREATE_PROBE}`);
    await conn.query(`INSERT INTO \`${source}\` () VALUES ()`);
    const [columns] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, CHARACTER_SET_NAME AS charset " +
        "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [source],
    );
    const [[stored]] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT ${columns.map((c) => `HEX(\`${c.name}\`) AS \`${c.name}\``).join(", ")} FROM \`${source}\``,
    );
    const [[created]] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE \`${source}\``);
    const defaults = showCreateColumnDefaults(String(created["Create Table"]));
    if (defaults === undefined) {
      return [`${version}: showCreateColumnDefaults could not read ${String(created["Create Table"])}`];
    }
    for (const mode of ["", "NO_BACKSLASH_ESCAPES"]) {
      await conn.query("SET SESSION sql_mode = ?", [mode]);
      for (const column of columns) {
        const name = String(column.name);
        const text = defaults.get(name);
        if (text === undefined) {
          failures.push(`${version}: SHOW CREATE TABLE carried no DEFAULT for ${name}`);
          continue;
        }
        const sql = portableDefaultSql(text, String(column.dataType));
        const charset = column.charset === null ? "" : ` CHARACTER SET ${String(column.charset)}`;
        try {
          await conn.query(`CREATE TABLE \`${replay}\` (c ${String(column.columnType)}${charset} DEFAULT ${sql})`);
          await conn.query(`INSERT INTO \`${replay}\` () VALUES ()`);
          const [[row]] = await conn.query<mysql.RowDataPacket[]>(`SELECT HEX(c) AS c FROM \`${replay}\``);
          if (row.c !== stored[name]) {
            failures.push(
              `${version}: ${name} under sql_mode='${mode}': DEFAULT ${sql} stored ${String(row.c)}, the source stored ${String(stored[name])}`,
            );
          } else {
            console.log(`${name} under sql_mode='${mode}': DEFAULT ${sql} stored ${String(row.c)}, as the source did`);
          }
        } catch (error) {
          failures.push(
            `${version}: ${name} under sql_mode='${mode}': the server refused DEFAULT ${sql}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await conn.query(`DROP TABLE IF EXISTS \`${replay}\``);
        }
      }
    }
  } finally {
    await conn.query("SET SESSION sql_mode = DEFAULT");
    await conn.query(`DROP TABLE IF EXISTS \`${source}\``);
  }
  return failures;
}

async function probeServer(url: string): Promise<string[]> {
  const failures: string[] = [];
  const conn = await mysql.createConnection(url);
  try {
    const [versionRows] = await conn.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
    const version = String(versionRows[0]?.version ?? "unknown");
    const flavour = /mariadb/i.test(version) ? "mariadb" : "mysql";
    console.log(`\n=== ${version} (read as ${flavour}) ===`);

    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME AS name, COLUMN_DEFAULT AS raw, EXTRA AS extra, COLUMN_TYPE AS columnType " +
        "FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'column_defaults' ORDER BY ORDINAL_POSITION",
    );
    // An empty answer would pass every assertion below, so it is a failure and not a pass.
    if (rows.length === 0) {
      failures.push(
        `${version}: app.column_defaults has no columns. Recreate the container: the init script only runs on a fresh data directory.`,
      );
      return failures;
    }

    for (const row of rows) {
      const name = String(row.name);
      const raw = row.raw === null ? null : String(row.raw);
      const extra = row.extra === null ? null : String(row.extra);
      console.log(
        `${name}: raw=${raw === null ? "SQL NULL" : JSON.stringify(raw)} extra=${JSON.stringify(extra ?? "")}`,
      );
      if (!(name in EXPECTED)) continue;
      const want = EXPECTED[name];
      const got = readDefault(raw, extra, flavour);
      if (got !== want) {
        failures.push(
          `${version}: ${name} read as ${JSON.stringify(got)}, expected ${JSON.stringify(want)}. ` +
            `Raw COLUMN_DEFAULT was ${raw === null ? "SQL NULL" : JSON.stringify(raw)}, EXTRA ${JSON.stringify(extra ?? "")}. ` +
            `Either the engine changed what it emits or CATALOG_DEFAULT_READING in src/lib/db/providers/sql/mysql.ts is wrong.`,
        );
      }
    }

    if (flavour === "mariadb") {
      failures.push(...(await replayDefaults(conn, version, rows)));
    } else {
      // MySQL reports the VALUE, so replaying the catalog text would fail by the engine's own
      // rules. The SQL comes from `SHOW CREATE TABLE` on this flavour instead (#1031).
      failures.push(...(await replayShowCreate(conn, version)));
    }
  } finally {
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
  console.error(
    `\n${failures.length} column default reading(s) did not hold: a value read back wrong, or a catalog text this flavour reports as SQL was refused after DEFAULT.`,
  );
  process.exit(1);
}
console.log(
  "Every measured column default read back as its value, and every catalog text a flavour reports as SQL was accepted back after DEFAULT by the server that reported it.",
);
