/**
 * Opt-in live guard for #1139: does the type this provider reports still build DDL the server
 * that reported it accepts, and does that DDL create the SAME column?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. `ALL_TAB_COLUMNS.DATA_TYPE` is the type
 * without its length, precision or scale: `VARCHAR2` for a `VARCHAR2(20)`, `NUMBER` for a
 * `NUMBER(12,2)`, `CHAR` for a `CHAR(2)`. The provider read that column alone,
 * `ColumnSchema.type` carried it, and the schema-diff migration generator interpolates that
 * field verbatim. A bare `VARCHAR2`, `NVARCHAR2` or `RAW` is ORA-00906, so the generated
 * `CREATE TABLE` was refused. A bare `CHAR` or `NUMBER` was worse: it was accepted, and it
 * created a different column (`CHAR(1)`, an unconstrained `NUMBER`) without an error.
 *
 * A mock cannot settle either half. "The server accepts this statement" and "the server creates
 * this column from it" are claims about the engine. So this script asks the engine:
 *
 *  1. It reads the fixture table through the provider, both reads.
 *  2. It replays the generated `CREATE TABLE` at the same server and requires an accept.
 *  3. It compares the new table's `ALL_TAB_COLUMNS` rows with the fixture's, which catches a
 *     declaration that is accepted but creates a different column.
 *  4. It replays the definition the OLD reading produced and requires ORA-00906. Without this
 *     half, a server that had started to accept a bare `VARCHAR2` would leave this script green
 *     while the reading it guards had stopped mattering.
 *
 * Step 2 runs under `NLS_LENGTH_SEMANTICS = CHAR`. Under that setting a bare `VARCHAR2(20)` is
 * created with character length semantics, so a reading that left out `BYTE` would fail step 3
 * on the byte columns.
 *
 * It reads `APP.COLUMN_TYPES`, which `docker/oracle-init/01-object-fixture.sql` creates with one
 * column per row of the rule in `docs/providers/oracle.md` §7. It is NOT in `bun run test`: the
 * runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 *
 * THE VECTOR CASE (#1209). `VECTOR` is a 23ai type, and the compose image is 21c, so the fixture
 * cannot hold it. On 23ai or later this script creates its own vector table, runs steps 1 to 3
 * over it with `VECTOR_INFO` in the compared row, and requires that the `DATA_TYPE`-only
 * definition, which the server accepts, creates different columns. On an older server it prints
 * that it skipped the case. There, steps 1 to 4 also show that neither read fails on the
 * `VECTOR_INFO` column the server does not have.
 *
 * THE MODIFY CASE (#1240). Oracle refuses a nullability the column already has: a `MODIFY` that
 * restates ` NULL` on a nullable column is ORA-01451, and the column keeps its old type. On every
 * server, this script creates a source and a target table, reads both through the provider, and
 * replays the generated `ALTER TABLE ... MODIFY` statements at the source. Every statement must be
 * accepted, and the source must then have the target's `ALL_TAB_COLUMNS` rows, `NULLABLE`
 * included. As the control, it replays a type change that restates the unchanged nullability and
 * requires ORA-01451 for ` NULL` and ORA-01442 for ` NOT NULL`.
 *
 *   LIBREDB_LIVE_ORACLE_URL=oracle://app:Password123!@127.0.0.1:1521/XEPDB1 \
 *     bun tests/live/oracle-column-type.ts
 *
 * Point it at a DISPOSABLE server. It CREATES and DROPS throwaway tables in the schema of the
 * user the URL names.
 */
import oracledb from "oracledb";
import { OracleProvider } from "../../src/lib/db/providers/sql/oracle";
import { diffSchemas } from "../../src/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "../../src/lib/schema-diff/migration-generator";
import type { StoredObject } from "../../src/lib/db/detailed-object";
import type { ColumnSchema, DatabaseConnection } from "../../src/lib/types";
import { splitStatements } from "../../src/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "../../src/lib/sql/grammar";

/** The fixture table this script reads, in the connecting user's schema. */
const PROBE_TABLE = "COLUMN_TYPES";

/** The dictionary columns that say what a column IS. Two tables that agree on these agree on the column. */
const SHAPE_SQL = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, CHAR_LENGTH, CHAR_USED
         FROM USER_TAB_COLUMNS
         WHERE TABLE_NAME = :1
         ORDER BY COLUMN_ID`;

/** The same, plus `VECTOR_INFO`, which is the only column that holds a vector's format (#1209). */
const VECTOR_SHAPE_SQL = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, CHAR_LENGTH, CHAR_USED,
                VECTOR_INFO
         FROM USER_TAB_COLUMNS
         WHERE TABLE_NAME = :1
         ORDER BY COLUMN_ID`;

/**
 * The vector columns #1209 names: the bare type, a fixed dimension count and format, a free
 * dimension count, a BINARY format, and a sparse vector.
 */
const VECTOR_COLUMNS = [
  `"V_DEFAULT" VECTOR`,
  `"V_3_FLOAT32" VECTOR(3, FLOAT32)`,
  `"V_ANY_FLOAT64" VECTOR(*, FLOAT64)`,
  `"V_16_BINARY" VECTOR(16, BINARY)`,
  `"V_SPARSE" VECTOR(100, FLOAT32, SPARSE)`,
];

/** The same, plus `NULLABLE`, which the MODIFY case changes (#1240). */
const MODIFY_SHAPE_SQL = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, CHAR_LENGTH, CHAR_USED,
                NULLABLE
         FROM USER_TAB_COLUMNS
         WHERE TABLE_NAME = :1
         ORDER BY COLUMN_ID`;

/**
 * The MODIFY case (#1240), as source and target declarations of the same columns: a type change
 * on a nullable and on a NOT NULL column, with the nullability unchanged, and a nullability-only
 * change in each direction.
 */
const MODIFY_SOURCE_COLUMNS = [
  `"S" VARCHAR2(20)`,
  `"U" UROWID(100)`,
  `"N" VARCHAR2(20) NOT NULL`,
  `"TO_NOT_NULL" VARCHAR2(20)`,
  `"TO_NULL" VARCHAR2(20) NOT NULL`,
];
const MODIFY_TARGET_COLUMNS = [
  `"S" VARCHAR2(50)`,
  `"U" UROWID`,
  `"N" VARCHAR2(50) NOT NULL`,
  `"TO_NOT_NULL" VARCHAR2(20) NOT NULL`,
  `"TO_NULL" VARCHAR2(20)`,
];

/**
 * The type changes that restate an unchanged nullability, which is what the generator wrote
 * before #1240, and the refusal each one must meet.
 */
const RESTATED_NULLABILITY = [
  { statement: `MODIFY ("S" VARCHAR2(50 BYTE) NULL)`, refusal: "ORA-01451" },
  { statement: `MODIFY ("N" VARCHAR2(50 BYTE) NOT NULL)`, refusal: "ORA-01442" },
];

/** The first release with the `VECTOR` type is 23ai. `PRODUCT_COMPONENT_VERSION.VERSION_FULL` is `21.3.0.0.0` on 21c XE. */
const FIRST_VECTOR_MAJOR = 23;

function url(): URL {
  const raw = process.env.LIBREDB_LIVE_ORACLE_URL;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_ORACLE_URL to a disposable Oracle, for example " +
        "oracle://app:Password123!@127.0.0.1:1521/XEPDB1 against the database-compose.yml service.",
    );
  }
  return new URL(raw);
}

/** The URL as this repo's own connection record, so the PROVIDER does the reading. */
function connectionOf(parsed: URL): DatabaseConnection {
  return {
    id: "live-oracle",
    name: `live ${parsed.host}`,
    type: "oracle",
    host: parsed.hostname,
    port: Number(parsed.port || "1521"),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    createdAt: new Date(),
  };
}

type Row = Record<string, unknown>;

async function shape(conn: oracledb.Connection, table: string, sql = SHAPE_SQL): Promise<Row[]> {
  const result = await conn.execute(sql, [table], { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return (result.rows ?? []) as Row[];
}

async function dropQuietly(conn: oracledb.Connection, table: string): Promise<void> {
  try {
    await conn.execute(`DROP TABLE "${table}" PURGE`);
  } catch {
    // Not there, which is the state this wanted.
  }
}

/**
 * The generated migration, replayed at the server that supplied the columns, and the new
 * table's dictionary rows compared with the fixture's.
 *
 * `diffSchemas` against an empty source is the CREATE TABLE path, and the table is renamed
 * first so the statement lands beside the fixture rather than on top of it.
 */
async function replayGenerated(
  conn: oracledb.Connection,
  columns: readonly ColumnSchema[],
  table: string,
  original: readonly Row[],
  shapeSql = SHAPE_SQL,
): Promise<string[]> {
  const target: StoredObject[] = [{ name: table, columns: [...columns], indexes: [] }];
  const sql = generateMigrationSQL(diffSchemas([], target), "oracle");
  const failures: string[] = [];
  let ran = 0;
  await conn.execute("ALTER SESSION SET NLS_LENGTH_SEMANTICS = CHAR");
  try {
    for (const statement of splitStatements(sql, resolveSqlGrammar("oracle"))) {
      // The generator puts a header of comments and blank lines in front of the statement,
      // and node-oracledb answers ORA-00911 for a trailing terminator, so both are removed.
      const text = statement.sql
        .replace(/;\s*$/, "")
        .replace(/^(?:[ \t]*(?:--[^\n]*)?\n)*/, "")
        .trim();
      if (!/^CREATE\s+TABLE/i.test(text)) continue;
      ran += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time is the point.
        await conn.execute(text);
        console.log(`the generated CREATE TABLE was accepted:\n${text}`);
      } catch (error) {
        failures.push(
          `the generated CREATE TABLE was refused by the server that supplied its columns: ` +
            `${error instanceof Error ? error.message : String(error)}\n${text}`,
        );
      }
    }
    if (ran > 0 && failures.length === 0) {
      const replayed = await shape(conn, table, shapeSql);
      if (replayed.length !== original.length) {
        failures.push(`the replayed table has ${replayed.length} columns, and the fixture has ${original.length}.`);
      }
      let same = 0;
      for (const [index, want] of original.entries()) {
        const got = replayed[index];
        if (JSON.stringify(got) === JSON.stringify(want)) {
          same += 1;
          continue;
        }
        failures.push(
          `${String(want.COLUMN_NAME)} was created as a different column. Fixture ${JSON.stringify(want)}, ` +
            `replayed ${JSON.stringify(got)}.`,
        );
      }
      console.log(`${same} of ${original.length} replayed columns have the fixture's ALL_TAB_COLUMNS row.`);
    }
  } finally {
    await conn.execute("ALTER SESSION SET NLS_LENGTH_SEMANTICS = BYTE");
    await dropQuietly(conn, table);
  }
  // A run that replayed NOTHING would pass every assertion above, so it is a failure: the
  // generator emitted no CREATE TABLE, and this half of the guard measured nothing.
  if (ran === 0) failures.push(`the migration generator produced no CREATE TABLE to replay:\n${sql}`);
  return failures;
}

/** Step 1: both reads agree, and `baseType` is DATA_TYPE exactly where `type` differs from it. */
function checkReads(
  single: readonly ColumnSchema[],
  bulk: readonly ColumnSchema[] | undefined,
  original: readonly Row[],
): string[] {
  const failures: string[] = [];
  const dataType = new Map(original.map((row) => [String(row.COLUMN_NAME), String(row.DATA_TYPE)]));
  if (JSON.stringify(single) !== JSON.stringify(bulk)) {
    failures.push(
      `describeObject() and describeObjects() disagree:\n${JSON.stringify(single)}\n${JSON.stringify(bulk)}`,
    );
  }
  for (const column of single) {
    const family = dataType.get(column.name);
    console.log(`${column.name}: DATA_TYPE=${family} type=${column.type} baseType=${column.baseType}`);
    const wantBase = column.type === family ? undefined : family;
    if (column.baseType !== wantBase) {
      failures.push(
        `${column.name} has baseType ${JSON.stringify(column.baseType)}, expected ${JSON.stringify(wantBase)}. ` +
          `baseType is DATA_TYPE, and it is absent exactly where the declaration IS DATA_TYPE.`,
      );
    }
  }
  return failures;
}

/**
 * The vector case (#1209), on a server that has the `VECTOR` type.
 *
 * `VECTOR_INFO` is the only dictionary column that holds a vector's format, so it is in the
 * compared row. The control is different from the fixture's: a bare `VECTOR` is ACCEPTED, so
 * the `DATA_TYPE`-only definition is replayed and must create a different column for every
 * vector declared with a size.
 */
async function probeVectors(conn: oracledb.Connection, provider: OracleProvider, owner: string): Promise<string[]> {
  const version = await conn.execute("SELECT VERSION_FULL FROM PRODUCT_COMPONENT_VERSION", [], {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });
  const full = String(((version.rows ?? []) as Row[])[0]?.VERSION_FULL);
  if (Number(full.split(".")[0]) < FIRST_VECTOR_MAJOR) {
    console.log(
      `\nSKIPPED the VECTOR case: this server is ${full}, and the VECTOR type ` +
        `arrived in ${FIRST_VECTOR_MAJOR}ai. Both reads above ran without VECTOR_INFO.`,
    );
    return [];
  }

  const failures: string[] = [];
  const table = `LIBREDB_VECTOR_PROBE_${process.pid}`;
  console.log(`\n=== the VECTOR case, on ${table} ===`);
  try {
    // Create table with 5 test vector columns
    await conn.execute(`CREATE TABLE "${table}" (${VECTOR_COLUMNS.join(", ")})`);
    const original = await shape(conn, table, VECTOR_SHAPE_SQL);
    for (const row of original) console.log(`${String(row.COLUMN_NAME)}: VECTOR_INFO=${String(row.VECTOR_INFO)}`);

    const single = await provider.describeObject([owner, table], "table");
    const batch = await provider.describeObjects([owner], "table");
    const bulk = batch.details.find((detail) => detail.path[1] === table);
    failures.push(...checkReads(single.columns, bulk?.columns, original));
    for (const column of single.columns) {
      if (column.baseType !== "VECTOR") failures.push(`${column.name} read back as ${column.type}, without its size.`);
    }

    failures.push(
      ...(await replayGenerated(
        conn,
        single.columns,
        `LIBREDB_VECTOR_REPLAY_${process.pid}`,
        original,
        VECTOR_SHAPE_SQL,
      )),
    );

    // The control: the DATA_TYPE-only definition is accepted, and creates different columns.
    const familyOnly = `LIBREDB_VECTOR_FAMILY_${process.pid}`;
    try {
      await conn.execute(
        `CREATE TABLE "${familyOnly}" (${original.map((row) => `"${String(row.COLUMN_NAME)}" VECTOR`).join(", ")})`,
      );
      const created = await shape(conn, familyOnly, VECTOR_SHAPE_SQL);
      for (const [index, want] of original.entries()) {
        const got = created[index];
        if (want.COLUMN_NAME === "V_DEFAULT") continue;
        if (got?.VECTOR_INFO === want.VECTOR_INFO) {
          failures.push(
            `the DATA_TYPE-only definition created ${String(want.COLUMN_NAME)} with the declared VECTOR_INFO ` +
              `${String(want.VECTOR_INFO)}, so this control no longer shows what the VECTOR_INFO reading adds.`,
          );
        } else {
          console.log(
            `the DATA_TYPE-only definition created ${String(want.COLUMN_NAME)} as ${String(got?.VECTOR_INFO)}, ` +
              `not ${String(want.VECTOR_INFO)}, as it must.`,
          );
        }
      }
    } finally {
      await dropQuietly(conn, familyOnly);
    }
  } catch (error) {
    failures.push(`the VECTOR case could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await dropQuietly(conn, table);
  }
  return failures;
}

/**
 * The MODIFY case (#1240), on every server.
 *
 * The source and the target are real tables read through the provider, so the diff compares
 * the same `ColumnSchema` values a SchemaDiff run compares. The target's columns are diffed
 * under the source's name, and the generated `ALTER TABLE` statements run at the source.
 */
async function probeModify(conn: oracledb.Connection, provider: OracleProvider, owner: string): Promise<string[]> {
  const failures: string[] = [];
  const source = `LIBREDB_MODIFY_SOURCE_${process.pid}`;
  const target = `LIBREDB_MODIFY_TARGET_${process.pid}`;
  console.log(`\n=== the MODIFY case, on ${source} ===`);
  try {
    await conn.execute(`CREATE TABLE "${source}" (${MODIFY_SOURCE_COLUMNS.join(", ")})`);
    await conn.execute(`CREATE TABLE "${target}" (${MODIFY_TARGET_COLUMNS.join(", ")})`);
    const want = await shape(conn, target, MODIFY_SHAPE_SQL);
    const from = await provider.describeObject([owner, source], "table");
    const to = await provider.describeObject([owner, target], "table");
    const sql = generateMigrationSQL(
      diffSchemas(
        [{ name: source, columns: from.columns, indexes: [] }],
        [{ name: source, columns: to.columns, indexes: [] }],
      ),
      "oracle",
    );

    let ran = 0;
    for (const statement of splitStatements(sql, resolveSqlGrammar("oracle"))) {
      const text = statement.sql
        .replace(/;\s*$/, "")
        .replace(/^(?:[ \t]*(?:--[^\n]*)?\n)*/, "")
        .trim();
      if (!/^ALTER\s+TABLE/i.test(text)) continue;
      ran += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time is the point.
        await conn.execute(text);
        console.log(`the generated statement was accepted: ${text}`);
      } catch (error) {
        failures.push(
          `the generated statement was refused: ${error instanceof Error ? error.message : String(error)}\n${text}`,
        );
      }
    }
    if (ran !== MODIFY_SOURCE_COLUMNS.length) {
      failures.push(`the generator wrote ${ran} ALTER TABLE statements, not ${MODIFY_SOURCE_COLUMNS.length}:\n${sql}`);
    }

    const got = await shape(conn, source, MODIFY_SHAPE_SQL);
    let same = 0;
    for (const [index, row] of want.entries()) {
      if (JSON.stringify(got[index]) === JSON.stringify(row)) {
        same += 1;
        continue;
      }
      failures.push(
        `${String(row.COLUMN_NAME)} did not become the target column. Target ${JSON.stringify(row)}, ` +
          `migrated ${JSON.stringify(got[index])}.`,
      );
    }
    console.log(`${same} of ${want.length} migrated columns have the target's ALL_TAB_COLUMNS row.`);

    // The control: a type change that restates the unchanged nullability is refused.
    for (const { statement, refusal } of RESTATED_NULLABILITY) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time is the point.
        await conn.execute(`ALTER TABLE "${source}" ${statement}`);
        failures.push(
          `the restated nullability was ACCEPTED (${statement}). This guard proves #1240 by the engine's ` +
            `refusal, and the engine no longer refuses it, so the guard has stopped measuring anything.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(refusal)) failures.push(`${statement} was refused, but not with ${refusal}: ${message}`);
        else console.log(`the restated nullability was refused, as it must be: ${statement}: ${message}`);
      }
    }
  } catch (error) {
    failures.push(`the MODIFY case could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await dropQuietly(conn, source);
    await dropQuietly(conn, target);
  }
  return failures;
}

async function probe(): Promise<string[]> {
  const failures: string[] = [];
  const parsed = url();
  const connection = connectionOf(parsed);
  const owner = connection.user!.toUpperCase();
  const provider = new OracleProvider(connection);
  const pool = await oracledb.createPool({
    user: connection.user,
    password: connection.password,
    connectString: `${connection.host}:${connection.port}/${connection.database}`,
    poolMin: 0,
    poolMax: 1,
  });
  const conn = await pool.getConnection();
  try {
    const version = await conn.execute("SELECT BANNER_FULL FROM V$VERSION", [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const banner = ((version.rows ?? []) as Row[])[0]?.BANNER_FULL;
    console.log(`\n=== ${String(banner ?? "unknown").split("\n")[0]} ===`);

    const original = await shape(conn, PROBE_TABLE);
    if (original.length === 0) {
      failures.push(
        `${owner}.${PROBE_TABLE} has no columns. Recreate the container: the init script only runs on a fresh data directory.`,
      );
      return failures;
    }

    await provider.connect();
    const single = await provider.describeObject([owner, PROBE_TABLE], "table");
    const batch = await provider.describeObjects([owner], "table");
    const bulk = batch.details.find((detail) => detail.path[1] === PROBE_TABLE);
    if (bulk === undefined) {
      failures.push(`describeObjects() did not describe ${PROBE_TABLE}.`);
      return failures;
    }

    // 1: both reads agree, and `baseType` is DATA_TYPE exactly where `type` differs from it.
    failures.push(...checkReads(single.columns, bulk.columns, original));

    // 2 and 3: the generated CREATE TABLE is accepted, and it creates the same columns.
    failures.push(...(await replayGenerated(conn, single.columns, `LIBREDB_TYPE_REPLAY_${process.pid}`, original)));

    // 4: the OLD reading is refused, so a green run means the reading still matters.
    const familyOnly = original.map((row) => `"${String(row.COLUMN_NAME)}" ${String(row.DATA_TYPE)}`).join(", ");
    const refusedTable = `LIBREDB_TYPE_FAMILY_${process.pid}`;
    try {
      await conn.execute(`CREATE TABLE "${refusedTable}" (${familyOnly})`);
      failures.push(
        `the OLD reading built a CREATE TABLE this server ACCEPTED (${familyOnly}). This guard proves #1139 by ` +
          `the engine's refusal of a bare DATA_TYPE, and the engine no longer refuses it, so the guard has stopped ` +
          `measuring anything and must be rewritten.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ORA-00906"))
        failures.push(`the OLD reading was refused, but not with ORA-00906: ${message}`);
      else console.log(`the DATA_TYPE-only definition was refused, as it must be: ${message}`);
    } finally {
      await dropQuietly(conn, refusedTable);
    }

    failures.push(...(await probeVectors(conn, provider, owner)));
    failures.push(...(await probeModify(conn, provider, owner)));
  } finally {
    await provider.disconnect();
    await conn.close();
    await pool.close(0);
  }
  return failures;
}

const failures = await probe();

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} column type reading(s) did not hold.`);
  process.exit(1);
}
console.log(
  "Both column reads report the declaration with DATA_TYPE beside it, the generated CREATE TABLE was accepted " +
    "by the server that supplied its columns and created the same columns, and the DATA_TYPE-only definition it " +
    "replaces was refused with ORA-00906. On 23ai or later, the same holds for the VECTOR columns, whose " +
    "DATA_TYPE-only definition creates different columns. The generated MODIFY statements were accepted and " +
    "created the target columns, and a MODIFY that restates an unchanged nullability was refused.",
);
