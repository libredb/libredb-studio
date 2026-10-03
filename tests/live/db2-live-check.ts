/**
 * Opt-in live check for the Db2 provider (#786): does a real `Db2Provider`, built the way the
 * factory builds it, answer every surface v1 ships against the compose fixture?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The unit tests drive the provider through a
 * fake driver seam, so they answer whatever the fake was told. Only the server can say that the
 * catalog SQL still reads SYSCAT the way the fixture was built, that a paged SELECT runs, that
 * RUNSTATS and REORG escape a quote and a blank inside a table name and refuse a view, that a
 * definition longer than one chunk reads whole and one over the bound reads as partial, that a
 * JS bigint parameter, alone or inside an array, is refused before it reaches db2-node (where it
 * aborts the process, K10 in `tests/live/db2-known-issues.ts`), and that `verify-ca` connects
 * with a PEM held as text.
 *
 * Unlike the known-issue report, this one FAILS: every check prints PASS or FAIL with the
 * verbatim error, and the process exits non-zero when any check failed.
 *
 *   docker compose -f database-compose.yml up -d db2
 *   bun tests/live/db2-live-check.ts
 *
 * DB2_HOST (127.0.0.1), DB2_PORT (50000), DB2_DATABASE (TESTDB), DB2_USER (db2inst1) and
 * DB2_PASSWORD default to the compose service, which loads `docker/db2-init/`. The TLS check
 * runs only when DB2_CA_FILE names the server's CA certificate (PEM); it connects with
 * `verify-ca` to DB2_TLS_HOST (172.17.0.2) on DB2_TLS_PORT (50001), and prints SKIP otherwise,
 * because the compose service has no TLS listener. It is NOT in `bun run test`: the runner
 * excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { Db2Provider } from "@/lib/db/providers/sql/db2";
import type { DatabaseObject } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const CONNECTION: DatabaseConnection = {
  id: "live-db2",
  name: "live db2",
  type: "db2",
  host: process.env.DB2_HOST ?? "127.0.0.1",
  port: Number(process.env.DB2_PORT ?? 50000),
  database: process.env.DB2_DATABASE ?? "TESTDB",
  user: process.env.DB2_USER ?? "db2inst1",
  password: process.env.DB2_PASSWORD ?? "Password123!",
  // The compose service has no TLS listener, so this connection takes the explicit opt-in that
  // the provider otherwise refuses a connection without TLS for (K11).
  allowInsecureAuth: true,
  createdAt: new Date(),
};

/**
 * A scratch schema for the two long views, created and dropped by this run: the fixture holds no
 * definition longer than one source chunk, and loading one there would only reach a fresh volume.
 */
const SCRATCH = `LIBREDB_LC_${randomBytes(3).toString("hex").toUpperCase()}`;

/** A view whose stored text is about `bytes` long: an IN list of numbers, all ASCII. */
function longViewSql(name: string, bytes: number): string {
  const values: string[] = [];
  for (let total = 0, n = 1; total < bytes; n++) {
    values.push(String(n));
    total += String(n).length + 2;
  }
  return `CREATE VIEW ${SCRATCH}.${name} AS SELECT ID FROM APP.ORDERS WHERE ID IN (${values.join(", ")})`;
}

let failures = 0;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${errorText(error)}`);
  }
}

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

function names(objects: readonly DatabaseObject[]): string[] {
  return objects.map((object) => object.name);
}

async function main(): Promise<void> {
  const provider = new Db2Provider(CONNECTION, {});

  await check("connect", () => provider.connect());

  await check("listContainers holds both fixture schemas", async () => {
    const containers = (await provider.listContainers()).map((container) => container.name);
    expect(containers.includes("APP") && containers.includes("REPORTING"), `got ${containers.join(", ")}`);
  });

  await check("countObjects counts APP's tables and views", async () => {
    const counts = await provider.countObjects(["APP"]);
    const count = (kind: string) => {
      const entry = counts[kind];
      return entry !== undefined && "count" in entry ? entry.count : -1;
    };
    expect(count("table") >= 5, `table count ${JSON.stringify(counts.table)}`);
    expect(count("view") >= 2, `view count ${JSON.stringify(counts.view)}`);
  });

  await check("listObjects lists tables in both schemas, quoted names included", async () => {
    const app = names(await provider.listObjects(["APP"], "table"));
    for (const expected of ["ORDERS", "CUSTOMERS", "Mixed Case", "O'Brien"]) {
      expect(app.includes(expected), `APP tables lack ${expected}: ${app.join(", ")}`);
    }
    const reporting = names(await provider.listObjects(["REPORTING"], "table"));
    expect(reporting.includes("DAILY"), `REPORTING tables lack DAILY: ${reporting.join(", ")}`);
  });

  await check("describeObject reads APP.ORDERS with its foreign key and index", async () => {
    const detail = await provider.describeObject(["APP", "ORDERS"], "table");
    const columns = detail.columns.map((column) => column.name);
    expect(columns.includes("ID") && columns.includes("CUSTOMER_ID"), `columns ${columns.join(", ")}`);
    expect(
      detail.foreignKeys.some((fk) => fk.columnName === "CUSTOMER_ID" && fk.referencedTable.endsWith("CUSTOMERS")),
      `foreign keys ${JSON.stringify(detail.foreignKeys)}`,
    );
    expect(
      detail.indexes.some((index) => index.name === "ORDERS_CUSTOMER_IX"),
      `indexes ${JSON.stringify(detail.indexes)}`,
    );
  });

  await check("readObjectSource reads a view's definition", async () => {
    const document = await provider.readObjectSource(["APP", "ORDER_SUMMARY"], "view");
    const part = document.parts[0];
    expect("text" in part && /SELECT/i.test(part.text), `first part ${JSON.stringify(part)}`);
  });

  await check("describeObject reads the materialized query table APP.ORDER_TOTALS", async () => {
    const detail = await provider.describeObject(["APP", "ORDER_TOTALS"], "materialized_query_table");
    expect(detail.columns.length > 0, `columns ${JSON.stringify(detail.columns)}`);
  });

  await check("setup: two long views in a scratch schema", async () => {
    await provider.query(`CREATE SCHEMA ${SCRATCH}`);
    // One chunk is 16336 bytes and the bound is two: one view needs the tail read, one is cut.
    await provider.query(longViewSql("LONG_VIEW", 20_000));
    await provider.query(longViewSql("HUGE_VIEW", 40_000));
  });

  await check("readObjectSource reads a definition longer than one chunk whole", async () => {
    const document = await provider.readObjectSource([SCRATCH, "LONG_VIEW"], "view");
    const part = document.parts[0];
    expect("text" in part, `first part ${JSON.stringify(part).slice(0, 300)}`);
    if (!("text" in part)) return;
    expect(part.form === "complete" && part.truncated === undefined, `form ${part.form}`);
    expect(
      part.text.length > 16_336 && /\)\s*$/.test(part.text),
      `${part.text.length} chars, ends ${part.text.slice(-40)}`,
    );
  });

  await check("readObjectSource reads a definition over the byte bound as partial, saying why", async () => {
    const document = await provider.readObjectSource([SCRATCH, "HUGE_VIEW"], "view");
    const part = document.parts[0];
    expect("text" in part, `first part ${JSON.stringify(part).slice(0, 300)}`);
    if (!("text" in part)) return;
    expect(part.form === "partial", `form ${part.form}`);
    expect(part.truncated?.limit === 32_672, `truncated ${JSON.stringify(part.truncated)}`);
    expect(part.text.length === 32_672, `${part.text.length} chars`);
  });

  await check("readObjectSource refuses an EXTERNAL function's body", async () => {
    const functions = await provider.listObjects(["APP"], "function");
    const external = functions.find((fn) => fn.name === "EXT_FN");
    expect(external !== undefined, `APP functions lack EXT_FN: ${names(functions).join(", ")}`);
    const document = await provider.readObjectSource(external!.path, "function");
    const part = document.parts[0];
    expect("unavailable" in part && part.unavailable.includes("EXTERNAL"), `first part ${JSON.stringify(part)}`);
  });

  await check("a paged SELECT returns the requested page", async () => {
    const prepared = provider.prepareQuery("SELECT ID FROM APP.ORDERS ORDER BY ID", { limit: 1, offset: 1 });
    expect(prepared.wasLimited, `not limited: ${prepared.query}`);
    const result = await provider.query(prepared.query);
    expect(
      result.rows.length === 1 && Number(result.rows[0]?.ID) === 2,
      `${prepared.query} gave ${JSON.stringify(result.rows)}`,
    );
  });

  for (const [operation, word] of [
    ["analyze", "RUNSTATS"],
    ["optimize", "REORG"],
  ] as const) {
    await check(`${word} runs on a table whose name holds a quote`, async () => {
      const result = await provider.runMaintenance(operation, "O'Brien", "APP");
      expect(result.success, result.message);
    });
    await check(`${word} runs on a table whose name holds a blank and lower case`, async () => {
      const result = await provider.runMaintenance(operation, "Mixed Case", "APP");
      expect(result.success, result.message);
    });
    await check(`${word} on a view is refused with DatabaseConfigError`, async () => {
      let refused: unknown;
      try {
        await provider.runMaintenance(operation, "ORDER_SUMMARY", "APP");
      } catch (error) {
        refused = error;
      }
      expect(refused instanceof DatabaseConfigError, `got ${refused === undefined ? "a result" : errorText(refused)}`);
    });
  }

  await check("getOverview answers the product version and the object counts", async () => {
    const overview = await provider.getOverview();
    expect(overview.version.startsWith("DB2 v"), `version ${overview.version}`);
    expect(overview.tableCount > 0, `overview ${JSON.stringify(overview)}`);
  });

  await check("getTableStats lists the fixture's tables and its materialized query table, no view", async () => {
    const names = (await provider.getTableStats()).map((row) => `${row.schemaName}.${row.tableName}`);
    for (const name of ["APP.ORDERS", "APP.O'Brien", "APP.Mixed Case", "APP.ORDER_TOTALS", "REPORTING.DAILY"]) {
      expect(names.includes(name), `${name} missing from ${JSON.stringify(names)}`);
    }
    expect(!names.includes("APP.ORDER_SUMMARY"), `the view APP.ORDER_SUMMARY is listed: ${JSON.stringify(names)}`);
  });

  await check("a JS bigint parameter is refused with QueryError and the process lives", async () => {
    let refused: unknown;
    try {
      await provider.query("SELECT CAST(? AS BIGINT) AS V FROM SYSIBM.SYSDUMMY1", [BigInt(2) ** BigInt(60)]);
    } catch (error) {
      refused = error;
    }
    expect(refused instanceof QueryError, `got ${refused === undefined ? "a result" : errorText(refused)}`);
    const after = await provider.query("VALUES 1");
    expect(after.rows.length === 1, "the connection did not answer after the refusal");
  });

  await check("a bigint inside an array parameter is refused with QueryError and the process lives", async () => {
    let refused: unknown;
    try {
      await provider.query("VALUES CAST(? AS VARCHAR(10))", [[BigInt(1)]]);
    } catch (error) {
      refused = error;
    }
    expect(refused instanceof QueryError, `got ${refused === undefined ? "a result" : errorText(refused)}`);
    const after = await provider.query("VALUES 1");
    expect(after.rows.length === 1, "the connection did not answer after the refusal");
  });

  await check("cleanup: the scratch schema is dropped", async () => {
    for (const view of ["LONG_VIEW", "HUGE_VIEW"]) {
      await provider.query(`DROP VIEW ${SCRATCH}.${view}`).catch(() => undefined);
    }
    await provider.query(`DROP SCHEMA ${SCRATCH} RESTRICT`);
  });

  await check("disconnect", () => provider.disconnect());

  const caFile = process.env.DB2_CA_FILE;
  if (caFile === undefined) {
    console.log("SKIP verify-ca over TLS: DB2_CA_FILE is not set");
  } else {
    await check("verify-ca over TLS with the CA held as PEM text", async () => {
      const tls = new Db2Provider(
        {
          ...CONNECTION,
          id: "live-db2-tls",
          host: process.env.DB2_TLS_HOST ?? "172.17.0.2",
          port: Number(process.env.DB2_TLS_PORT ?? 50001),
          ssl: { mode: "verify-ca", caCert: readFileSync(caFile, "utf8") },
        },
        {},
      );
      await tls.connect();
      try {
        const result = await tls.query("VALUES 1");
        expect(result.rows.length === 1, `VALUES 1 gave ${JSON.stringify(result.rows)}`);
      } finally {
        await tls.disconnect();
      }
    });
  }

  console.log(failures === 0 ? "db2 live check: all checks passed" : `db2 live check: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
