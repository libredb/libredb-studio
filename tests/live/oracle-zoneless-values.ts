/**
 * Opt-in live guard for #1131: do Oracle `DATE` and `TIMESTAMP` read as the ENGINE'S OWN
 * wall clock through the provider, whatever time zone the Node process runs in, and does a
 * SQL INSERT export of that read replay into the same values?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. oracledb builds the `Date` for both
 * types by reading the stored fields as LOCAL time of the Node process, and every row path
 * used to serialise it as ISO UTC, so `DATE '2026-09-01'` read as `2026-08-31T21:00:00.000Z`
 * under TZ=Europe/Istanbul. Whether the provider now answers with the text the ENGINE would
 * print is a claim about the engine and the driver together, and a mock answers whatever
 * its author already wrote. So this script reads every value twice, once through the
 * provider and once as the server's own `TO_CHAR`, under three process zones, and requires
 * the two to be equal. It also reads the RAW driver value under Istanbul and requires it to
 * still be the shifted `Date`: the day that stops being true, the conversion has stopped
 * being the thing under test, and this guard must be rewritten rather than deleted.
 *
 * `TIMESTAMP WITH TIME ZONE` is the negative control: it IS an instant, so it must still
 * arrive as the `Date` the driver builds.
 *
 * The export half reads the two columns through the provider under Istanbul, puts the rows
 * through JSON the way `POST /api/db/query` does, builds the SQL INSERT export, replays it
 * into an empty copy of the table and lets the SERVER compare the copy against the source.
 *
 * It creates and drops two throwaway tables (`LIBREDB_ZL_<hex>` and `LIBREDB_ZL_<hex>_R`) in
 * the connecting user's schema.
 *
 *   docker run --rm -e ORACLE_PASSWORD="$PROBE_PASSWORD" -p 1521:1521 gvenzl/oracle-free:slim
 *   ORACLE_TEST_PORT=1521 ORACLE_TEST_PASSWORD="$PROBE_PASSWORD" bun tests/live/oracle-zoneless-values.ts
 *
 * `ORACLE_TEST_SERVICE` defaults to `FREEPDB1` and `ORACLE_TEST_USER` to `system`. Point it
 * at a DISPOSABLE server on localhost: a credential has no default here, so none is written
 * down. It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED`
 * in `tests/runner/discover.ts`).
 */
import oracledb from "oracledb";
import { randomBytes } from "node:crypto";
import { OracleProvider } from "../../src/lib/db/providers/sql/oracle";
import { buildResultExport } from "../../src/lib/export/result-export";
import type { DatabaseConnection } from "../../src/lib/types";

const ZONES = ["UTC", "Europe/Istanbul", "America/Los_Angeles"] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to a disposable Oracle's port and password.`);
  return value;
}

/** `TO_CHAR(..., 'FF3')` always prints three digits; the provider trims them as the engine prints a fraction. */
function trimFraction(text: string): string {
  return text
    .trim()
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

async function probeServer(): Promise<string[]> {
  const failures: string[] = [];
  const port = Number(required("ORACLE_TEST_PORT"));
  const password = required("ORACLE_TEST_PASSWORD");
  const user = process.env.ORACLE_TEST_USER ?? "system";
  const serviceName = process.env.ORACLE_TEST_SERVICE ?? "FREEPDB1";
  const table = `LIBREDB_ZL_${randomBytes(4).toString("hex").toUpperCase()}`;
  const replay = `${table}_R`;
  const connection: DatabaseConnection = {
    id: "live-zoneless",
    name: "live zoneless values",
    type: "oracle",
    host: "127.0.0.1",
    port,
    serviceName,
    user,
    password,
    createdAt: new Date(),
  };
  const admin = await oracledb.createPool({
    user,
    password,
    connectString: `127.0.0.1:${port}/${serviceName}`,
    poolMin: 1,
    poolMax: 1,
  });
  const conn = await admin.getConnection();
  const run = (sql: string) => conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
  try {
    const version = (await run(`SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`)).rows?.[0] as { BANNER: string };
    console.log(`=== ${version.BANNER} ===`);
    await run(`CREATE TABLE ${table} (id NUMBER, d DATE, ts TIMESTAMP(6), ttz TIMESTAMP(6) WITH TIME ZONE)`);
    await run(
      `INSERT INTO ${table} VALUES (1, DATE '2026-09-01', TIMESTAMP '2026-09-01 10:30:00',
         TIMESTAMP '2026-09-01 10:30:00 +03:00')`,
    );
    await run(
      `INSERT INTO ${table} VALUES (2, TO_DATE('2026-08-24 10:11:12', 'YYYY-MM-DD HH24:MI:SS'),
         TIMESTAMP '2026-09-01 10:30:00.345', NULL)`,
    );
    await run(
      `INSERT INTO ${table} VALUES (3, TO_DATE('-0044-03-15 00:00:00', 'SYYYY-MM-DD HH24:MI:SS'),
         TIMESTAMP '2026-09-01 10:30:00.5', NULL)`,
    );
    await run(`INSERT INTO ${table} VALUES (4, NULL, NULL, NULL)`);

    // The engine's own text, which is the only authority on what the provider must answer.
    const engineRows = (
      await run(
        `SELECT id, TO_CHAR(d, 'SYYYY-MM-DD HH24:MI:SS') AS d, TO_CHAR(ts, 'SYYYY-MM-DD HH24:MI:SS.FF3') AS ts
         FROM ${table} ORDER BY id`,
      )
    ).rows as { ID: number; D: string | null; TS: string | null }[];
    const expected = new Map(
      engineRows.map((row) => [
        row.ID,
        { D: row.D === null ? null : row.D.trim(), TS: row.TS === null ? null : trimFraction(row.TS) },
      ]),
    );

    // The premise, read WITHOUT the provider: under Istanbul the driver's own `Date` for
    // `DATE '2026-09-01'` is still the previous evening in UTC.
    process.env.TZ = "Europe/Istanbul";
    const raw = (await run(`SELECT d, ttz FROM ${table} WHERE id = 1`)).rows?.[0] as { D: unknown; TTZ: unknown };
    console.log(
      `raw driver DATE under Europe/Istanbul: ${raw.D instanceof Date ? raw.D.toISOString() : String(raw.D)}`,
    );
    if (!(raw.D instanceof Date) || raw.D.toISOString() !== "2026-08-31T21:00:00.000Z") {
      failures.push(
        "premise: the raw driver DATE under Europe/Istanbul is no longer the shifted `Date`, so the conversion " +
          "#1131 added has stopped being the thing under test - rewrite the guard rather than delete it.",
      );
    }

    for (const zone of ZONES) {
      process.env.TZ = zone;
      const provider = new OracleProvider(connection);
      try {
        // TZ is process-wide, so each zone is read before the next one is set.
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await provider.connect();
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const read = await provider.query(`SELECT id, d, ts, ttz FROM ${table} ORDER BY id`);
        for (const row of read.rows as Record<string, unknown>[]) {
          const want = expected.get(Number(row.ID));
          for (const column of ["D", "TS"] as const) {
            const got = row[column];
            console.log(
              `${zone} id=${row.ID} ${column}: engine ${JSON.stringify(want?.[column])}, provider ${JSON.stringify(got)}`,
            );
            if (got !== want?.[column]) {
              failures.push(
                `${zone} id=${row.ID} ${column}: the provider read ${JSON.stringify(got)} and the engine's own ` +
                  `TO_CHAR prints ${JSON.stringify(want?.[column])}. #1131 is exactly the gap between those two.`,
              );
            }
          }
        }
        // The negative control: a real instant, which must NOT become text.
        const instant = (read.rows as Record<string, unknown>[])[0].TTZ;
        console.log(`${zone} ttz: ${instant instanceof Date ? instant.toISOString() : String(instant)}`);
        if (!(instant instanceof Date) || instant.toISOString() !== "2026-09-01T07:30:00.000Z") {
          failures.push(`${zone} ttz: TIMESTAMP WITH TIME ZONE is an instant and must stay the driver's Date.`);
        }
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- TZ is process-wide, so each zone's provider closes before the next.
        await provider.disconnect().catch(() => {});
      }
    }

    // The export half, under a zone east of UTC, over JSON as `POST /api/db/query` hands it on.
    // There the old export quoted the shifted ISO text, and Oracle refused it with ORA-01861.
    process.env.TZ = "Europe/Istanbul";
    await run(`CREATE TABLE ${replay} AS SELECT id, d, ts FROM ${table} WHERE 1 = 0`);
    const provider = new OracleProvider(connection);
    try {
      await provider.connect();
      const read = await provider.query(`SELECT id, d, ts FROM ${table} ORDER BY id`);
      const file = buildResultExport("sql-insert", {
        rows: JSON.parse(JSON.stringify(read.rows)) as Record<string, unknown>[],
        fields: read.fields,
        tabName: replay,
        dialect: "oracle",
        columnTypes: read.columnTypes,
      });
      console.log(`export:\n${file.content}`);
      for (const statement of file.content.split("\n")) {
        // oxlint-disable-next-line no-await-in-loop -- one connection runs the replay statements in order.
        await run(statement.replace(/;$/, ""));
      }
    } finally {
      await provider.disconnect().catch(() => {});
    }
    const compared = (
      await run(
        `SELECT s.id,
                CASE WHEN s.d = r.d OR (s.d IS NULL AND r.d IS NULL) THEN 'EQUAL' ELSE 'DIFF' END AS d_eq,
                CASE WHEN s.ts = r.ts OR (s.ts IS NULL AND r.ts IS NULL) THEN 'EQUAL' ELSE 'DIFF' END AS ts_eq
         FROM ${table} s LEFT JOIN ${replay} r ON r.id = s.id ORDER BY s.id`,
      )
    ).rows as { ID: number; D_EQ: string; TS_EQ: string }[];
    for (const row of compared) {
      console.log(`replayed id=${row.ID}: D ${row.D_EQ}, TS ${row.TS_EQ}`);
      if (row.D_EQ !== "EQUAL" || row.TS_EQ !== "EQUAL") {
        failures.push(
          `replay id=${row.ID}: the server compared the replayed row and found D ${row.D_EQ}, TS ${row.TS_EQ}.`,
        );
      }
    }
  } finally {
    await run(`DROP TABLE ${replay} PURGE`).catch(() => {});
    await run(`DROP TABLE ${table} PURGE`).catch(() => {});
    await conn.close();
    await admin.close(0);
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
  "DATE and TIMESTAMP read as the engine's own text in every zone, TIMESTAMP WITH TIME ZONE stayed an instant, " +
    "the export replayed to the same values, and the raw driver value is still the shifted Date the conversion " +
    "compensates for.",
);
