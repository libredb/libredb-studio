/**
 * Opt-in live report for the db2-node defects the Db2 provider (#786) works around: is each
 * one still PRESENT in the installed driver, or GONE?
 *
 * WHY THIS EXISTS. The provider was measured against db2-node 1.0.22, and docs/providers/db2.md
 * lists the driver defects it contains (reported upstream as gurungabit/db2-node#12). Every
 * workaround is a bet that a defect is still there, so a driver bump starts here: run this
 * against the old and the new version and compare the lines. It drives db2-node directly, never
 * the provider, because the question is what the driver does on its own.
 *
 * It is a REPORT and exits 0 whatever it finds: one line per known issue,
 * `K<n> <short name>: PRESENT | GONE | ERROR <message>`, under a header naming the driver version
 * and the server's SERVICE_LEVEL. A row that covers several defects, as K16 does, names the ones
 * still present in brackets after PRESENT. The provider's own regressions are the job of
 * `tests/live/db2-live-check.ts`, which does fail.
 *
 * K10 aborts the whole process when it is present, so it runs in a child process. K14 leaves a
 * statement running on the server when it is present, so the probe forces that application off
 * afterwards. The temporary tables live in a scratch schema that is dropped at the end.
 *
 *   docker compose -f database-compose.yml up -d db2
 *   bun tests/live/db2-known-issues.ts
 *
 * DB2_HOST (127.0.0.1), DB2_PORT (50000), DB2_DATABASE (TESTDB), DB2_USER (db2inst1) and
 * DB2_PASSWORD default to the compose service. It is NOT in `bun run test`: the runner excludes
 * `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { Client, type ConnectionConfig } from "db2-node";

const BASE: ConnectionConfig = {
  host: process.env.DB2_HOST ?? "127.0.0.1",
  port: Number(process.env.DB2_PORT ?? 50000),
  database: process.env.DB2_DATABASE ?? "TESTDB",
  user: process.env.DB2_USER ?? "db2inst1",
  password: process.env.DB2_PASSWORD ?? "Password123!",
};
const SCHEMA = `LIBREDB_KI_${randomBytes(3).toString("hex").toUpperCase()}`;
const DUMMY = "FROM SYSIBM.SYSDUMMY1";

/** A probe that covers several defects names the ones still present in brackets. */
type Verdict = "PRESENT" | "GONE" | `PRESENT (${string})`;

async function open(extra: Partial<ConnectionConfig> = {}): Promise<Client> {
  const client = new Client({ ...BASE, ...extra });
  await client.connect();
  return client;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
}

/** Whether a call threw, and what it threw, without letting the throw escape. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function sqlCodes(error: unknown): string {
  const { sqlstate, sqlcode } = (error ?? {}) as { sqlstate?: string; sqlcode?: number };
  return `SQLSTATE=${sqlstate ?? "none"} SQLCODE=${sqlcode ?? "none"}`;
}

/** The first value of the first row, whatever the driver named its column. */
function first(result: { rows: Array<Record<string, unknown>> }): unknown {
  const row = result.rows[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

/** EBCDIC code page 037 for the characters a test password plausibly holds. */
function ebcdic037(text: string): Buffer | null {
  const bytes: number[] = [];
  const punctuation: Record<string, number> = {
    "!": 0x5a,
    "@": 0x7c,
    "#": 0x7b,
    $: 0x5b,
    _: 0x6d,
    "-": 0x60,
    ".": 0x4b,
  };
  for (const char of text) {
    const upper = char.toUpperCase();
    const lower = char !== upper;
    let byte: number | undefined;
    if (/[0-9]/.test(char)) byte = 0xf0 + Number(char);
    else if (/[A-I]/.test(upper)) byte = 0xc1 + upper.charCodeAt(0) - 65;
    else if (/[J-R]/.test(upper)) byte = 0xd1 + upper.charCodeAt(0) - 74;
    else if (/[S-Z]/.test(upper)) byte = 0xe2 + upper.charCodeAt(0) - 83;
    else byte = punctuation[char];
    if (byte === undefined) return null;
    bytes.push(lower ? byte - 0x40 : byte);
  }
  return Buffer.from(bytes);
}

const SLOW = `WITH T(N) AS (SELECT 1 ${DUMMY} UNION ALL SELECT N + 1 FROM T WHERE N < 15000000) SELECT COUNT(*) AS C FROM T`;

const probes: Array<[string, (c: Client) => Promise<Verdict>]> = [
  [
    "K1 non-ASCII text",
    async (c) => {
      const literal = "Grüße, 世界";
      const read = first(await c.query(`VALUES CAST('${literal}' AS VARCHAR(40))`));
      await c.query(`CREATE TABLE ${SCHEMA}.K1 (V VARCHAR(40))`);
      await c.query(`INSERT INTO ${SCHEMA}.K1 VALUES (?)`, ["héllo"]);
      const bound = first(await c.query(`SELECT V FROM ${SCHEMA}.K1`));
      return read !== literal || bound !== "héllo" ? "PRESENT" : "GONE";
    },
  ],
  [
    "K2 INTEGER beside DECFLOAT",
    async (c) => {
      const decfloat = await c.query(`SELECT 1 AS I, CAST(1 AS DECFLOAT(34)) AS D ${DUMMY}`);
      const boolean = await c.query(`SELECT 1 AS I, TRUE AS B ${DUMMY}`);
      return decfloat.rows[0]?.I !== 1 || boolean.rows[0]?.I !== 1 ? "PRESENT" : "GONE";
    },
  ],
  [
    "K3 BOOLEAN-only result drops rows",
    async (c) => {
      await c.query(`CREATE TABLE ${SCHEMA}.K3 (B BOOLEAN)`);
      await c.query(`INSERT INTO ${SCHEMA}.K3 VALUES (TRUE), (FALSE), (NULL)`);
      return (await c.query(`SELECT B FROM ${SCHEMA}.K3`)).rows.length !== 3 ? "PRESENT" : "GONE";
    },
  ],
  [
    "K4 SELECT * on a wide mixed-type table",
    async (c) => {
      const declared = Number(
        first(await c.query("SELECT COUNT(*) FROM SYSCAT.COLUMNS WHERE TABSCHEMA = 'APP' AND TABNAME = 'ALLTYPES'")),
      );
      const result = await c.query("SELECT * FROM APP.ALLTYPES");
      return result.rows.length === 0 || result.columns.length < declared ? "PRESENT" : "GONE";
    },
  ],
  [
    "K5 XML column with a NULL drops rows",
    async (c) => {
      await c.query(`CREATE TABLE ${SCHEMA}.K5 (ID INTEGER, X XML)`);
      await c.query(`INSERT INTO ${SCHEMA}.K5 VALUES (1, '<a>1</a>'), (2, NULL), (3, '<a>3</a>')`);
      return (await c.query(`SELECT ID, X FROM ${SCHEMA}.K5`)).rows.length !== 3 ? "PRESENT" : "GONE";
    },
  ],
  [
    "K6 BIGINT beyond 2^53",
    async (c) => {
      const exact = "9223372036854775807";
      const read = first(await c.query(`VALUES CAST(${exact} AS BIGINT)`));
      const bound = await attempt(() =>
        c.query(`SELECT 1 AS HIT ${DUMMY} WHERE CAST(${exact} AS BIGINT) = ?`, [exact]),
      );
      const boundHit = bound.ok && bound.value.rows.length === 1;
      return String(read) !== exact || typeof read === "number" || !boundHit ? "PRESENT" : "GONE";
    },
  ],
  [
    "K7 CLOB cannot be fetched",
    async (c) => {
      const result = await attempt(() => c.query("VALUES CAST('x' AS CLOB(1K))"));
      if (result.ok) return "GONE";
      console.log(`   K7 error: ${sqlCodes(result.error)} ${message(result.error)}`);
      return "PRESENT";
    },
  ],
  [
    "K8 TIMESTAMP(0) and TIMESTAMP(12) cannot be fetched",
    async (c) => {
      const zero = await attempt(() => c.query("VALUES CAST(CURRENT TIMESTAMP AS TIMESTAMP(0))"));
      const twelve = await attempt(() => c.query("VALUES CAST(CURRENT TIMESTAMP AS TIMESTAMP(12))"));
      return zero.ok && twelve.ok ? "GONE" : "PRESENT";
    },
  ],
  [
    "K9 bare CALL of ADMIN_CMD",
    async (c) => {
      const result = await attempt(() => c.query("CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE APP.ORDERS')"));
      if (result.ok) return "GONE";
      console.log(`   K9 error: ${sqlCodes(result.error)} ${message(result.error)}`);
      return "PRESENT";
    },
  ],
  [
    "K10 a JS bigint parameter aborts the process",
    async () => {
      const code = [
        `const { Client } = require("db2-node");`,
        `const c = new Client(${JSON.stringify(BASE)});`,
        `c.connect().then(() => c.query("SELECT ? AS V ${DUMMY}", [1n]))`,
        `.then(() => console.log("SURVIVED"), (e) => console.log("JSERROR " + e.message))`,
        `.finally(() => c.close().catch(() => {}));`,
      ].join("\n");
      const child = spawnSync(process.execPath, ["-e", code], {
        cwd: new URL("../..", import.meta.url).pathname,
        encoding: "utf8",
        timeout: 60_000,
      });
      // A rejected promise is the driver refusing the value, which is the fix; anything else
      // that ends the child is the abort.
      return /SURVIVED|JSERROR/.test(child.stdout ?? "") ? "GONE" : "PRESENT";
    },
  ],
  [
    "K11 password in cleartext on the wire without TLS",
    async () => {
      const ebcdic = ebcdic037(BASE.password);
      if (ebcdic === null) throw new Error("the password holds a character this probe cannot encode in EBCDIC");
      const utf8 = Buffer.from(BASE.password);
      let seen = Buffer.alloc(0);
      const proxy = net.createServer((socket) => {
        const upstream = net.connect(BASE.port ?? 50000, BASE.host);
        socket.on("data", (data) => {
          seen = Buffer.concat([seen, typeof data === "string" ? Buffer.from(data) : data]);
          upstream.write(data);
        });
        upstream.on("data", (data) => socket.write(data));
        socket.on("close", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
        socket.on("error", () => {});
        upstream.on("error", () => {});
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const { port } = proxy.address() as net.AddressInfo;
      try {
        const client = new Client({ ...BASE, host: "127.0.0.1", port });
        await client.connect();
        await client.query("VALUES 1");
        await client.close();
      } finally {
        proxy.close();
      }
      return seen.includes(ebcdic) || seen.includes(utf8) ? "PRESENT" : "GONE";
    },
  ],
  [
    "K12 currentSchema option is ignored",
    async () => {
      const client = await open({ currentSchema: "APP" });
      try {
        return String(first(await client.query("VALUES CURRENT SCHEMA"))).trim() !== "APP" ? "PRESENT" : "GONE";
      } finally {
        await client.close();
      }
    },
  ],
  [
    "K13 serverInfo productName is not the product",
    async (c) => ((await c.serverInfo()).productName.startsWith("DB2") ? "GONE" : "PRESENT"),
  ],
  [
    "K14 queryTimeout leaves the statement running on the server",
    async () => {
      const client = await open({ queryTimeout: 2000 });
      const handle = Number(first(await client.query("VALUES MON_GET_APPLICATION_HANDLE()")));
      await attempt(() => client.query(SLOW));
      const watcher = await open();
      try {
        const activity = await watcher.query(
          "SELECT ACTIVITY_STATE FROM TABLE(MON_GET_ACTIVITY(?, -2)) AS T WHERE ACTIVITY_STATE = 'EXECUTING'",
          [handle],
        );
        return activity.rows.length > 0 ? "PRESENT" : "GONE";
      } finally {
        await attempt(() => watcher.query(`BEGIN CALL SYSPROC.ADMIN_CMD('FORCE APPLICATION (${handle})'); END`));
        await watcher.close();
        await attempt(() => client.close());
      }
    },
  ],
  [
    "K15 duplicate column names collapse in a row",
    async (c) => {
      const result = await c.query(`SELECT 1 AS A, 2 AS A ${DUMMY}`);
      return Object.keys(result.rows[0] ?? {}).length < 2 ? "PRESENT" : "GONE";
    },
  ],
  [
    "K16 GRAPHIC, TIMESTAMP(12), Date and BOOLEAN binds",
    async (c) => {
      // Four defects under one row, so each is checked and the verdict names the ones left.
      await c.query(`CREATE TABLE ${SCHEMA}.K16 (ID INTEGER, G GRAPHIC(5), TS TIMESTAMP(12), B BOOLEAN)`);
      await c.query(`INSERT INTO ${SCHEMA}.K16 (ID) VALUES (1)`);
      const present: string[] = [];
      await c.query(`UPDATE ${SCHEMA}.K16 SET G = ? WHERE ID = 1`, ["ＡＢ"]);
      const hex = String(first(await c.query(`SELECT HEX(G) FROM ${SCHEMA}.K16`)));
      if (hex.includes("0000")) present.push("GRAPHIC padded with U+0000");
      const timestamp = await attempt(() =>
        c.query(`UPDATE ${SCHEMA}.K16 SET TS = ? WHERE ID = 1`, ["2026-01-01-00.00.00.000000000000"]),
      );
      if (!timestamp.ok) present.push("TIMESTAMP(12) refused");
      // The driver's types admit no Date; what it does with one that arrives anyway is the question.
      const when = new Date() as unknown as string;
      const date = await attempt(() => c.query(`UPDATE ${SCHEMA}.K16 SET TS = ? WHERE ID = 1`, [when]));
      if (!date.ok) present.push("Date refused");
      // Alone, a BOOLEAN bound as a string is accepted; beside another parameter it is not.
      const boolean = await attempt(() => c.query(`INSERT INTO ${SCHEMA}.K16 (ID, B) VALUES (?, ?)`, [2, "true"]));
      if (!boolean.ok) present.push("BOOLEAN in a parameter list");
      return present.length === 0 ? "GONE" : `PRESENT (${present.join(", ")})`;
    },
  ],
  [
    "K17 some driver errors carry no sqlstate",
    async (c) => {
      const result = await attempt(() => c.query("VALUES CAST(CURRENT TIMESTAMP AS TIMESTAMP(0))"));
      if (result.ok) throw new Error("the K8 statement no longer fails, so it cannot show the K17 shape");
      return (result.error as { sqlstate?: string }).sqlstate === undefined ? "PRESENT" : "GONE";
    },
  ],
  [
    "K18 a statement that starts with a comment is refused",
    async (c) => {
      const block = await attempt(() => c.query(`/* note */ VALUES 1`));
      const line = await attempt(() => c.query(`-- note\nVALUES 1`));
      return block.ok && line.ok ? "GONE" : "PRESENT";
    },
  ],
  [
    "K19 an UPDATE that matches no row reports a negative row count",
    async (c) => {
      await c.query(`CREATE TABLE ${SCHEMA}.K19 (ID INTEGER)`);
      const result = await c.query(`UPDATE ${SCHEMA}.K19 SET ID = 1 WHERE ID = 2`);
      return result.rowCount < 0 ? "PRESENT" : "GONE";
    },
  ],
  [
    "K20 a value truncated with a warning desynchronises the driver",
    async () => {
      // Its own connection: when the defect is present the stream is left in an unknown state.
      const client = await open();
      try {
        const result = await attempt(() => client.query(`VALUES CAST(REPEAT('x', 100) AS VARCHAR(10))`));
        return result.ok && first(result.value) === "xxxxxxxxxx" ? "GONE" : "PRESENT";
      } finally {
        await attempt(() => client.close());
      }
    },
  ],
  [
    "K21 a row wider than one DRDA block fails",
    async () => {
      // Twice on its own connection: measured failing on the first run and on the second.
      const client = await open();
      try {
        for (let run = 0; run < 2; run++) {
          const result = await attempt(() => client.query(`VALUES (REPEAT('a', 32672), REPEAT('b', 32672))`));
          if (!result.ok) return "PRESENT";
        }
        return "GONE";
      } finally {
        await attempt(() => client.close());
      }
    },
  ],
  [
    "K22 a bound DECIMAL out of range is stored wrong, with no error",
    async (c) => {
      // The same value as a literal is refused with SQLSTATE 22003; bound, 12345.67 was stored as 345.67.
      await c.query(`CREATE TABLE ${SCHEMA}.K22 (ID INTEGER, AMT DECIMAL(5,2))`);
      await c.query(`INSERT INTO ${SCHEMA}.K22 VALUES (1, 0)`);
      const update = await attempt(() => c.query(`UPDATE ${SCHEMA}.K22 SET AMT = ? WHERE ID = ?`, ["12345.67", 1]));
      if (!update.ok) return "GONE";
      const stored = String(first(await c.query(`SELECT VARCHAR(AMT) FROM ${SCHEMA}.K22`)));
      return stored === "12345.67" ? "GONE" : `PRESENT (stored ${stored})`;
    },
  ],
];

async function main(): Promise<void> {
  const driverVersion = (
    JSON.parse(readFileSync(new URL("../../node_modules/db2-node/package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
  const client = await open();
  const level = await attempt(() => client.query("SELECT SERVICE_LEVEL FROM SYSIBMADM.ENV_INST_INFO"));
  const serviceLevel = level.ok ? String(first(level.value)).trim() : `unknown (${message(level.error)})`;
  console.log(`db2-node ${driverVersion} against ${serviceLevel} at ${BASE.host}:${BASE.port}/${BASE.database}`);

  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  try {
    for (const [name, probe] of probes) {
      const outcome = await attempt(() => probe(client));
      console.log(`${name}: ${outcome.ok ? outcome.value : `ERROR ${message(outcome.error)}`}`);
    }
  } finally {
    for (const table of ["K1", "K3", "K5", "K16", "K19", "K22"])
      await attempt(() => client.query(`DROP TABLE ${SCHEMA}.${table}`));
    const dropped = await attempt(() => client.query(`DROP SCHEMA ${SCHEMA} RESTRICT`));
    if (!dropped.ok) console.log(`cleanup: schema ${SCHEMA} was left behind: ${message(dropped.error)}`);
    await client.close();
  }
}

await main();
