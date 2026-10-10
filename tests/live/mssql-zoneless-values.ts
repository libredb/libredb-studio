/**
 * Opt-in live guard for #1132 and #1452: do `time`, `date`, `datetime2`, `datetime` and
 * `smalldatetime` read as the ENGINE'S OWN TEXT through the provider, and is the `Date` they
 * arrive as still the thing that makes the conversion necessary?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. `tedious` reads `time` as a
 * time-of-day on an invented 1970-01-01, `date` as UTC midnight, and `datetime2` as a
 * wall-clock reading mapped through UTC - all three as `Date`s, with a `time(7)`'s seven
 * digits cut to the three a `Date` keeps. Whether the provider now answers with the text
 * the ENGINE would print is a claim about the engine and the driver together, and a mock
 * answers whatever its author already wrote. So this script asks the server for every
 * value TWICE - once through the provider, once as the engine's own `CONVERT` text - and
 * requires the two to be equal. It also reads the RAW driver value and requires it to
 * still be the invented `Date` (with the sub-millisecond remainder the last four digits
 * ride on): the day that stops being true, the conversion has stopped being the thing
 * under test, and this guard must be rewritten rather than deleted.
 *
 * `datetimeoffset` is the negative control: it IS a real instant, so it must still arrive
 * as a `Date`, and a conversion that swallowed it too fails here.
 *
 * It creates and drops a throwaway DATABASE on the server it is pointed at
 * (`libredb_zoneless_<hex>`), the way `schema-diff-dialects.ts` does.
 *
 *   MSSQL_TEST_PORT=1433 MSSQL_TEST_PASSWORD="$PROBE_PASSWORD" bun tests/live/mssql-zoneless-values.ts
 *
 * Point it at a DISPOSABLE server on localhost, supplying the password configured on its
 * container as `$PROBE_PASSWORD`: a credential has no default here, so none is written down.
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`).
 */
import mssql from "mssql";
import { randomBytes } from "node:crypto";
import { MSSQLProvider } from "../../src/lib/db/providers/sql/mssql";
import type { DatabaseConnection } from "../../src/lib/types";

/** The declarations and scales under guard, one column each, fraction digits spelled out. */
const GUARDED_COLUMNS = ["t7", "t3", "t0", "d", "at7", "at0", "dt", "dtTick", "sdt"] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to a disposable SQL Server's port and sa password.`);
  return value;
}

async function probeServer(): Promise<string[]> {
  const failures: string[] = [];
  const port = Number(required("MSSQL_TEST_PORT"));
  const password = required("MSSQL_TEST_PASSWORD");
  const config = {
    server: "127.0.0.1",
    port,
    user: "sa",
    password,
    options: { trustServerCertificate: true, encrypt: false },
    pool: { min: 1, max: 1 },
  };
  const admin = await new mssql.ConnectionPool(config).connect();
  const database = `libredb_zoneless_${randomBytes(5).toString("hex")}`;
  const connection: DatabaseConnection = {
    id: "live-zoneless",
    name: "live zoneless values",
    type: "mssql",
    host: "127.0.0.1",
    port,
    database,
    user: "sa",
    password,
    createdAt: new Date(),
  };
  const provider = new MSSQLProvider(connection);
  let db: mssql.ConnectionPool | undefined;
  try {
    const version = String(
      Object.values((await admin.request().query("SELECT @@VERSION AS version")).recordset[0])[0],
    ).split("\n")[0];
    console.log(`=== ${version} ===`);
    await admin.request().query(`CREATE DATABASE [${database}]`);
    db = await new mssql.ConnectionPool({ ...config, database }).connect();
    await db.request().query(
      `CREATE TABLE dbo.zoneless (
         id INT NOT NULL,
         t7 TIME(7), t3 TIME(3), t0 TIME(0),
         d DATE,
         at7 DATETIME2(7), at0 DATETIME2(0),
         dt DATETIME, dtTick DATETIME, sdt SMALLDATETIME,
         dto DATETIMEOFFSET(7)
       );
       INSERT INTO dbo.zoneless VALUES (
         1,
         '10:30:00.1234567', '10:30:00.123', '10:30:00',
         '2026-09-01',
         '2026-09-01 10:30:00.1234567', '2026-09-01 10:30:00',
         '2026-09-01T10:30:00.123', '2026-09-01T23:59:59.998', '2026-09-01T10:30:29.999',
         '2026-09-01 10:30:00.1234567 +05:30'
       );`,
    );

    // The engine's own text, which is the only authority on what the provider must answer.
    // Nothing below hardcodes a spelling: the expected value of every guarded column IS the
    // server's own printed text, read through a conversion rather than through the driver.
    // `datetime` and `smalldatetime` name their style, because their DEFAULT one (0) prints
    // `Sep  1 2026 10:30AM`: 121 and 120 are the ODBC canonical texts, which are the ones
    // sqlcmd prints for those columns (#1452). The values are written in ISO 8601 with a `T`,
    // the one form those two types read the same under every SET DATEFORMAT.
    const engineTexts = (
      await db.request().query(
        `SELECT CONVERT(varchar(30), t7) AS t7, CONVERT(varchar(30), t3) AS t3, CONVERT(varchar(30), t0) AS t0,
                CONVERT(varchar(10), d) AS d, CONVERT(varchar(30), at7) AS at7, CONVERT(varchar(30), at0) AS at0,
                CONVERT(varchar(23), dt, 121) AS dt, CONVERT(varchar(23), dtTick, 121) AS dtTick,
                CONVERT(varchar(19), sdt, 120) AS sdt
         FROM dbo.zoneless`,
      )
    ).recordset[0] as Record<string, string>;

    // The same read WITHOUT the provider, which is the premise: the raw driver value.
    const rawRow = (await db.request().query(`SELECT t7, t3, t0, d, at7, at0, dt, dtTick, sdt, dto FROM dbo.zoneless`))
      .recordset[0] as Record<string, unknown>;
    console.log(
      `raw driver shapes: ${GUARDED_COLUMNS.map((column) => {
        const value = rawRow[column];
        return `${column} ${value instanceof Date ? value.toISOString() : String(value)}`;
      }).join(", ")}`,
    );

    await provider.connect();
    const read = await provider.query(`SELECT t7, t3, t0, d, at7, at0, dt, dtTick, sdt, dto FROM dbo.zoneless`);
    const row = read.rows[0];

    for (const column of GUARDED_COLUMNS) {
      const expected = String(engineTexts[column]);
      const got = row[column];
      console.log(`${column}: engine prints ${JSON.stringify(expected)}, the provider reads ${JSON.stringify(got)}`);
      if (got !== expected) {
        failures.push(
          `${column}: the provider read ${JSON.stringify(got)} and the engine's own CONVERT prints ` +
            `${JSON.stringify(expected)}. #1132 and #1452 are exactly the gap between those two.`,
        );
      }
    }

    // The negative control: a real instant, which must NOT become text.
    const rawInstant = rawRow.dto;
    const providerInstant = row.dto;
    console.log(
      `dto: driver ${rawInstant instanceof Date ? rawInstant.toISOString() : String(rawInstant)}, ` +
        `provider ${providerInstant instanceof Date ? providerInstant.toISOString() : String(providerInstant)}`,
    );
    if (
      !(rawInstant instanceof Date) ||
      !(providerInstant instanceof Date) ||
      providerInstant.getTime() !== rawInstant.getTime()
    ) {
      failures.push(
        "dto: `datetimeoffset` is a real instant and must keep arriving as the same `Date` the driver builds; " +
          "it was converted or moved.",
      );
    }

    // The premise of the conversion itself, so a driver change is diagnosed rather than
    // misread as a provider regression.
    const rawTime = rawRow.t7;
    const rawDelta = (rawTime as { nanosecondsDelta?: number }).nanosecondsDelta ?? 0;
    if (!(rawTime instanceof Date)) {
      failures.push(
        "t7: tedious no longer reads `time` as a `Date`, so the conversion this guard watches has stopped being " +
          "the thing under test - rewrite the guard, do not delete it.",
      );
    } else {
      console.log(`t7 raw: ${rawTime.toISOString()} with nanosecondsDelta ${rawDelta}`);
      if (rawTime.toISOString() !== "1970-01-01T10:30:00.123Z" || Math.abs(rawDelta - 0.0004567) > 1e-9) {
        failures.push(
          "t7: the raw driver value is no longer the invented 1970-01-01 `Date` carrying the sub-millisecond " +
            "remainder, so the premise of #1132's conversion has changed - rewrite the guard rather than delete it.",
        );
      }
    }
  } finally {
    await provider.disconnect().catch(() => {});
    await db?.close();
    await admin.request().query(`IF DB_ID('${database}') IS NOT NULL DROP DATABASE [${database}]`);
    await admin.close();
  }
  return failures;
}

const failures = await probeServer();

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} zoneless reading(s) did not hold.`);
  process.exit(1);
}
console.log(
  "Every zoneless value read as the engine's own text, datetimeoffset stayed an instant, and the raw driver value " +
    "is still the invented Date the conversion compensates for.",
);
