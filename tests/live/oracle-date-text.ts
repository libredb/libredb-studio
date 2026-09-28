/**
 * Opt-in live guard for #1131: do `DATE` and the naive `TIMESTAMP` read as the WALL CLOCK
 * the server stored, in every process time zone, and is the `Date` they arrive as still the
 * thing that makes the conversion necessary?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. node-oracledb (Thin) builds the JS
 * `Date` for these two types by reading the stored wall clock IN THE PROCESS'S ZONE, so the
 * same row read from a process east or west of UTC came back as a different instant and
 * serialised as a different day - measured 2026-09-28, a `DATE '2026-09-01'` answered
 * 2026-08-31T21:00:00.000Z under TZ=Europe/Istanbul and the SQL INSERT export replayed it as
 * 2026-08-31. Whether the provider now answers with the wall clock the SERVER stored is a
 * claim about the engine and the driver together, and a mock answers whatever its author
 * already wrote. So this script asks the server for every value TWICE - once through the
 * provider, once through the engine's own `TO_CHAR` - and requires the two to be equal,
 * whatever `TZ` it is run under; run it under several zones (`TZ=UTC`,
 * `TZ=Europe/Istanbul`, `TZ=America/Los_Angeles`) and every printed value must not move. It
 * also reads the RAW driver value and requires it to still be the `Date` built from the
 * local wall clock (a TIMESTAMP(9)'s digits already cut to the three a `Date` keeps): the
 * day that stops being true, the conversion has stopped being the thing under test, and
 * this guard must be rewritten rather than deleted.
 *
 * `TIMESTAMP WITH TIME ZONE` is the negative control: it IS a real instant, so it must
 * still arrive as a `Date` and must still survive the SQL INSERT export round trip
 * unchanged.
 *
 * The fixtures' millisecond digits all end nonzero, so the provider's documented
 * trailing-zero trim (pinned by `result-export.test.ts` and `oracle-provider.test.ts`) has
 * nothing to do here and the engine's `FF3` mask can be the expected text verbatim.
 *
 * It creates and drops a throwaway table on the server it is pointed at
 * (`LIBREDB_NAIVE_<hex>`), the way `schema-diff-dialects.ts` does with its schemas.
 *
 *   docker run -d --name libredb-oracle-naive -e ORACLE_PASSWORD="$PROBE_PASSWORD" \
 *     -p 15211:1521 gvenzl/oracle-free:slim
 *   ORACLE_TEST_PORT=15211 ORACLE_TEST_PASSWORD="$PROBE_PASSWORD" bun tests/live/oracle-date-text.ts
 *
 * Point it at a DISPOSABLE server on localhost, supplying the password configured on its
 * container as `$PROBE_PASSWORD`: a credential has no default here, so none is written
 * down. The service defaults to `FREEPDB1` (what `gvenzl/oracle-free` creates); set
 * `ORACLE_TEST_SERVICE` for `XEPDB1` (`gvenzl/oracle-xe`), or `ORACLE_TEST_USER` for a
 * different admin user. It is NOT in `bun run test`: the runner excludes `tests/live/` by
 * name (`EXCLUDED` in `tests/runner/discover.ts`).
 */
import oracledb from "oracledb";
import { randomBytes } from "node:crypto";
import { OracleProvider } from "../../src/lib/db/providers/sql/oracle";
import { buildResultExport } from "../../src/lib/export/result-export";
import type { DatabaseConnection } from "../../src/lib/types";

/** The columns the provider's answer is compared against the engine's own text for. */
const GUARDED_COLUMNS = ["d", "ts", "ts3", "ts6", "ts9"] as const;
/** Per column, the engine mask that spells exactly what the provider claims. */
const ENGINE_MASK: Record<(typeof GUARDED_COLUMNS)[number], string> = {
  d: "YYYY-MM-DD HH24:MI:SS",
  ts: "YYYY-MM-DD HH24:MI:SS",
  ts3: "YYYY-MM-DD HH24:MI:SS.FF3",
  ts6: "YYYY-MM-DD HH24:MI:SS.FF3",
  ts9: "YYYY-MM-DD HH24:MI:SS.FF3",
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to a disposable Oracle's host port and its password.`);
  return value;
}

/**
 * The one member the hand-written `oracledb` declaration does not name, reached through a
 * local widening rather than by widening that declaration: the provider connects through a
 * POOL (`createPool`), and this raw read exists only here.
 */
const rawConnect = (
  oracledb as unknown as {
    getConnection(attributes: { user: string; password: string; connectString: string }): Promise<oracledb.Connection>;
  }
).getConnection;

async function probe(): Promise<string[]> {
  const failures: string[] = [];
  const port = Number(required("ORACLE_TEST_PORT"));
  const password = required("ORACLE_TEST_PASSWORD");
  const user = process.env.ORACLE_TEST_USER ?? "system";
  const service = process.env.ORACLE_TEST_SERVICE ?? "FREEPDB1";

  const raw = await rawConnect({ user, password, connectString: `127.0.0.1:${port}/${service}` });
  const table = `LIBREDB_NAIVE_${randomBytes(4).toString("hex").toUpperCase()}`;
  const copy = `${table}_CP`;
  const connection: DatabaseConnection = {
    id: "live-naive-dates",
    name: "live naive dates",
    type: "oracle",
    host: "127.0.0.1",
    port,
    serviceName: service,
    user,
    password,
    createdAt: new Date(),
  };
  const provider = new OracleProvider(connection);

  /** The engine's own text for every guarded column, read through `TO_CHAR` rather than a driver. */
  const engineTexts = async (source: string): Promise<Record<string, string>> => {
    const result = await raw.execute(
      `SELECT ${GUARDED_COLUMNS.map((column) => `TO_CHAR("${column}", '${ENGINE_MASK[column]}') AS "${column}"`).join(", ")},
              TO_CHAR("ts9", 'YYYY-MM-DD HH24:MI:SS.FF9') AS "ts9full"
       FROM ${source} WHERE "id" = 1`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows as unknown as Record<string, string>[])[0];
  };

  try {
    // Explicitly arrays: the provider's constructor pins the process-wide `oracledb.outFormat`
    // to OBJECT, and these raw reads must not inherit a format by accident.
    const banner = await raw.execute(`SELECT banner FROM v$version WHERE ROWNUM = 1`, [], {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
    });
    console.log(`=== ${String((banner.rows as unknown as string[][])[0][0])} ===`);
    console.log(
      `process TZ: ${process.env.TZ ?? "(unset)"} (resolved ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    );

    await raw.execute(
      `CREATE TABLE ${table} (
         "id" NUMBER(2) NOT NULL,
         "d" DATE,
         "ts" TIMESTAMP,
         "ts3" TIMESTAMP(3),
         "ts6" TIMESTAMP(6),
         "ts9" TIMESTAMP(9),
         "tstz" TIMESTAMP WITH TIME ZONE
       )`,
      [],
      { autoCommit: true },
    );
    await raw.execute(
      `INSERT INTO ${table} ("id", "d", "ts", "ts3", "ts6", "ts9", "tstz") VALUES (
         1,
         DATE '2026-09-01',
         TIMESTAMP '2026-09-01 10:30:00',
         TIMESTAMP '2026-09-01 10:30:00.123',
         TIMESTAMP '2026-09-01 10:30:00.123',
         TIMESTAMP '2026-09-01 10:30:00.123456789',
         TIMESTAMP '2026-09-01 10:30:00.123456 +05:30'
       )`,
      [],
      { autoCommit: true },
    );
    await raw.execute(`INSERT INTO ${table} ("id") VALUES (2)`, [], { autoCommit: true });
    // The replay target. The export quotes every column name, so the copy's columns are the
    // QUOTED lowercase identifiers the statements will address.
    await raw.execute(
      `CREATE TABLE ${copy} (
         "id" NUMBER(2) NOT NULL,
         "d" DATE,
         "ts" TIMESTAMP,
         "ts3" TIMESTAMP(3),
         "ts6" TIMESTAMP(6),
         "ts9" TIMESTAMP(9),
         "tstz" TIMESTAMP WITH TIME ZONE
       )`,
      [],
      { autoCommit: true },
    );

    // The RAW driver value, read WITHOUT the provider: the premise of the whole conversion.
    // Arrays explicitly, for the same reason as the banner above.
    const rawRow = (
      await raw.execute(`SELECT "d", "ts9", "tstz" FROM ${table} WHERE "id" = 1`, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
      })
    ).rows as unknown as unknown[][];
    const rawD = rawRow[0][0];
    const rawTs9 = rawRow[0][1];
    const rawTstz = rawRow[0][2];
    const engineFull = await engineTexts(table);
    console.log(
      `raw driver shapes: d ${rawD instanceof Date ? rawD.toISOString() : String(rawD)}, ` +
        `ts9 ${rawTs9 instanceof Date ? rawTs9.toISOString() : String(rawTs9)} ` +
        `(milliseconds ${rawTs9 instanceof Date ? rawTs9.getMilliseconds() : "n/a"}, engine FF9 prints ${JSON.stringify(engineFull.ts9full)})`,
    );
    if (!(rawD instanceof Date) || !(rawTs9 instanceof Date) || !(rawTstz instanceof Date)) {
      failures.push(
        "the driver no longer reads DATE/TIMESTAMP as a `Date` (or the zoned control stopped being one), so the " +
          "conversion this guard watches has stopped being the thing under test - rewrite the guard, do not delete it.",
      );
    } else {
      // The premise of the conversion, in full: the `Date` is built from the LOCAL wall
      // clock, so its local components are the stored value in EVERY zone, while its UTC
      // reading is the one that moved with the process. Both halves are required - the
      // conversion reads the local components, and the defect was their UTC serialisation.
      const local = [
        rawD.getFullYear(),
        rawD.getMonth(),
        rawD.getDate(),
        rawD.getHours(),
        rawD.getMinutes(),
        rawD.getSeconds(),
      ];
      if (local.join(",") !== "2026,8,1,0,0,0") {
        failures.push(
          `d: the raw driver \`Date\` no longer carries the stored wall clock in its LOCAL components ` +
            `(${local.join(",")}), so the premise of #1131's conversion has changed - rewrite the guard rather ` +
            "than delete it.",
        );
      }
      if (rawTs9.getMilliseconds() !== 123) {
        failures.push(
          `ts9: the raw driver \`Date\` no longer keeps the three milliseconds a \`Date\` can hold ` +
            `(${rawTs9.getMilliseconds()}), so the boundary the provider documents has moved - rewrite the guard.`,
        );
      }
    }

    // Through the provider, against the engine's own text.
    await provider.connect();
    const read = await provider.query(
      `SELECT "id", "d", "ts", "ts3", "ts6", "ts9", "tstz" FROM ${table} ORDER BY "id"`,
    );
    const texts = await engineTexts(table);
    const row = read.rows[0];
    for (const column of GUARDED_COLUMNS) {
      const expected = texts[column];
      const got = row[column];
      console.log(
        `${column}: engine TO_CHAR prints ${JSON.stringify(expected)}, the provider reads ${JSON.stringify(got)}`,
      );
      if (got !== expected) {
        failures.push(
          `${column}: the provider read ${JSON.stringify(got)} and the engine's own TO_CHAR prints ` +
            `${JSON.stringify(expected)}. #1131 is exactly the gap between those two.`,
        );
      }
    }

    // The negative control: a real instant, which must NOT become text.
    const providerTstz = row.tstz;
    console.log(
      `tstz: driver ${rawTstz instanceof Date ? rawTstz.toISOString() : String(rawTstz)}, ` +
        `provider ${providerTstz instanceof Date ? providerTstz.toISOString() : String(providerTstz)}`,
    );
    if (!(rawTstz instanceof Date) || !(providerTstz instanceof Date) || providerTstz.getTime() !== rawTstz.getTime()) {
      failures.push(
        "tstz: `TIMESTAMP WITH TIME ZONE` is a real instant and must keep arriving as the same `Date` the driver " +
          "builds; it was converted or moved.",
      );
    }

    // A NULL stays NULL, converter and all.
    const nulls = read.rows[1];
    for (const column of [...GUARDED_COLUMNS, "tstz"]) {
      if (nulls[column] !== null) {
        failures.push(
          `id 2 ${column}: a NULL column must stay null, the provider read ${JSON.stringify(nulls[column])}.`,
        );
      }
    }

    // The SQL INSERT export round trip: the file is generated from what the provider just
    // read, replayed into a copy of the table, and read back through the provider again.
    const exported = buildResultExport("sql-insert", {
      rows: read.rows,
      fields: read.fields,
      tabName: copy,
      dialect: "oracle",
      columnTypes: read.columnTypes,
    });
    for (const statement of exported.content.split("\n")) {
      const trimmed = statement.trim().replace(/;$/, "");
      if (trimmed !== "") await provider.query(trimmed);
    }

    const replayed = await provider.query(
      `SELECT "id", "d", "ts", "ts3", "ts6", "ts9", "tstz" FROM ${copy} ORDER BY "id"`,
    );
    const copyTexts = await engineTexts(copy);
    for (const column of GUARDED_COLUMNS) {
      const after = replayed.rows[0][column];
      console.log(
        `replayed ${column}: engine TO_CHAR prints ${JSON.stringify(copyTexts[column])}, the provider reads ${JSON.stringify(after)}`,
      );
      if (after !== texts[column]) {
        failures.push(
          `replayed ${column}: the SQL INSERT export replayed ${JSON.stringify(after)} where the original held ` +
            `${JSON.stringify(texts[column])} - a value that moves through its own export.`,
        );
      }
      if (copyTexts[column] !== texts[column]) {
        failures.push(
          `replayed ${column}: the replayed value differs on the server itself (TO_CHAR ${JSON.stringify(copyTexts[column])} ` +
            `vs ${JSON.stringify(texts[column])}).`,
        );
      }
    }
    const replayedTstz = replayed.rows[0].tstz;
    if (
      !(replayedTstz instanceof Date) ||
      !(providerTstz instanceof Date) ||
      replayedTstz.getTime() !== providerTstz.getTime()
    ) {
      failures.push("replayed tstz: the instant did not survive the export round trip unchanged.");
    }
  } finally {
    await provider.disconnect().catch(() => {});
    await raw.execute(`DROP TABLE ${copy}`).catch(() => {});
    await raw.execute(`DROP TABLE ${table}`).catch(() => {});
    await raw.close();
  }
  return failures;
}

const failures = await probe();

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} naive date/timestamp reading(s) did not hold.`);
  process.exit(1);
}
console.log(
  "Every naive value read as the wall clock the server stored (in this process's TZ), the zoned control stayed an " +
    "instant through the export round trip, and the raw driver value is still the locally-built `Date` the " +
    "conversion compensates for.",
);
