/**
 * Databend provider, end to end over the captures (design 9; plan D13).
 *
 * The real provider, HTTP transport, answer reader, decoder, object surface and error table all run; only the server
 * is fake. The fake is the recording query server of `tests/helpers/databend-fixtures.ts`, handed to the provider in
 * place of the shared `createNodeTransport`, so every request goes through the transport's seam and is answered from
 * what the pinned server answered. Time is injected (`transportDeps`), so no deadline fires unless a test fires it.
 * `mock.module()` is not used.
 *
 * The captures were taken on 2026-10-08 by tests/live/databend-evidence.ts from the `databend-http` fixture of
 * docker/databend/README.md (`tests/fixtures/databend/local-2026-10-08-v1.2.951-nightly/manifest.json`):
 * datafuselabs/databend:v1.2.951-nightly@sha256:f63585cae3e096d62580ad51d92abd2f64b57b196af3b51cb01ecae381ec874b,
 * every scenario the plan runs on the local target, `insert` (an INSERT into a table that outlives its session) and
 * `final-kill` (the kill that follows a page of a finalized statement) among them.
 *
 * A statement is answered by its text, not by its position. What is BUILT rather than captured: the connect caution's
 * `auth_type` read and every object-surface read (`system.catalogs`, `system.databases`, `system.tables`,
 * `system.columns`, `system.indexes`, the view's `SHOW CREATE` and the absent table's 1025), which the harness does
 * not ask. Each built answer is what the same provider statement answered on the same image and fixture on 2026-10-08
 * (the provider's own run of `assertObjectSurface` against it), with the statement text exactly as sent; the
 * fixture's objects are docker/databend/fixture.jsonl's. Two captured answers stand for a provider statement the
 * harness asked in a shorter form: version.json answers the connect probe (`SELECT version() AS server_version`), and
 * show-create-materialized-view.json answers the catalog-qualified `SHOW CREATE MATERIALIZED VIEW`, which answered
 * the same DDL in that run.
 *
 * Every provider a test builds is disconnected after it, so no permit of the process-wide `databend` limiter is left
 * held for the next test. The last test reads which captured exchanges the others replayed, so it runs only after all
 * of them: run alone or after a failure, it names the tests whose replays it lacks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, QueryCancelledError, QueryError } from "@/lib/db/errors";
import { DatabendProvider } from "@/lib/db/providers/sql/databend";
import { DATABEND_DEFAULT_SESSION_LIMIT, databendSessionsSql } from "@/lib/db/providers/sql/databend/introspect";
import type { DatabaseProvider } from "@/lib/db/types";
import { DATABEND_ERROR_SENTENCES } from "@/lib/db/providers/sql/databend/errors";
import { TEMP_TABLES_DROPPED, TRANSACTION_ENDED } from "@/lib/db/providers/sql/databend/session";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import {
  capturedSql,
  DATABEND_CAPTURE_RUNS,
  databendCaptureFiles,
  databendReplay,
  HELD,
  loadDatabendCapture,
  loadDatabendManifest,
  type ReplayAnswer,
  type ReplayedRequest,
} from "../../helpers/databend-fixtures";
import {
  scriptedNodeTransport,
  TEST_START,
  TEST_USER,
  testConnection,
  transportDeps,
} from "../../helpers/databend-node-transport";

// ============================================================================
// The fixture's answers
// ============================================================================

type Fields = Readonly<Record<string, unknown>>;

const text = (name: string, type = "String") => ({ name, type });

/** Rows of `system.columns` as the column reads project them: name, type, nullability, no default, no comment. */
function columnRows(columns: readonly (readonly [string, string, "YES" | "NO"])[], comment: boolean): string[][] {
  return columns.map(([name, type, nullable]) => [name, type, nullable, "", "", ...(comment ? [""] : [])]);
}

/** `every_type`'s columns as `system.columns` reports them (fixture.jsonl, measured 2026-10-08). */
const EVERY_TYPE_COLUMNS: readonly (readonly [string, string, "YES" | "NO"])[] = [
  ["id", "INT", "NO"],
  ["i8", "TINYINT", "YES"],
  ["i16", "SMALLINT", "YES"],
  ["i32", "INT", "YES"],
  ["i64", "BIGINT", "YES"],
  ["u8", "TINYINT UNSIGNED", "YES"],
  ["u64", "BIGINT UNSIGNED", "YES"],
  ["f32", "FLOAT", "YES"],
  ["f64", "DOUBLE", "YES"],
  ["dec", "DECIMAL(38, 10)", "YES"],
  ["flag", "BOOLEAN", "YES"],
  ["txt", "VARCHAR", "YES"],
  ["bin", "BINARY", "YES"],
  ["d", "DATE", "YES"],
  ["ts", "TIMESTAMP", "YES"],
  ["v", "VARIANT", "YES"],
  ["arr", "ARRAY(INT32)", "YES"],
  ["m", "MAP(STRING, INT32)", "YES"],
  ["tup", "TUPLE(1 INT32, 2 STRING)", "YES"],
  ["bm", "BITMAP", "YES"],
  ["u16", "SMALLINT UNSIGNED", "YES"],
  ["u32", "INT UNSIGNED", "YES"],
  ["iv", "INTERVAL", "YES"],
  ["g", "GEOMETRY", "YES"],
  ["gg", "GEOGRAPHY", "YES"],
  ["vec", "VECTOR(2)", "YES"],
  ["tz", "TIMESTAMPTZ", "YES"],
];
const WIDE_COLUMNS = Array.from(
  { length: 60 },
  (_, index) => [`c${String(index + 1).padStart(2, "0")}`, "INT", "YES"] as const,
);
const VIEW_COLUMNS = [
  ["id", "INT", "NO"],
  ["txt", "VARCHAR", "YES"],
  ["flag", "BOOLEAN", "YES"],
] as const;
const MV_COLUMNS = [
  ["id", "INT", "NO"],
  ["txt", "VARCHAR", "YES"],
] as const;

const COLUMN_SCHEMA = [
  text("column_name"),
  text("data_type"),
  text("is_nullable"),
  text("default_kind"),
  text("default_expression"),
  text("comment"),
];
const BULK_SCHEMA = [text("object_name"), ...COLUMN_SCHEMA.slice(0, 5)];
const LIST_SCHEMA = [
  text("object_name"),
  text("num_rows", "Nullable(UInt64)"),
  text("data_compressed_size", "Nullable(UInt64)"),
  text("comment"),
];
const SOURCE_SCHEMA = [text("Table"), text("Create Table")];

/** `every_type`'s DDL as `SHOW CREATE TABLE ... WITH QUOTED_IDENTIFIERS` answered it (measured 2026-10-08). */
const EVERY_TYPE_DDL = [
  'CREATE TABLE "every_type" (',
  '  "id" INT NOT NULL,',
  '  "i8" TINYINT NULL,',
  '  "i16" SMALLINT NULL,',
  '  "i32" INT NULL,',
  '  "i64" BIGINT NULL,',
  '  "u8" TINYINT UNSIGNED NULL,',
  '  "u64" BIGINT UNSIGNED NULL,',
  '  "f32" FLOAT NULL,',
  '  "f64" DOUBLE NULL,',
  '  "dec" DECIMAL(38, 10) NULL,',
  '  "flag" BOOLEAN NULL,',
  '  "txt" VARCHAR NULL,',
  '  "bin" BINARY NULL,',
  '  "d" DATE NULL,',
  '  "ts" TIMESTAMP NULL,',
  '  "v" VARIANT NULL,',
  '  "arr" ARRAY(INT NULL) NULL,',
  '  "m" MAP(VARCHAR NOT NULL, INT NULL) NULL,',
  '  "tup" TUPLE(1 INT NULL, 2 VARCHAR NULL) NULL,',
  '  "bm" BITMAP NULL,',
  '  "u16" SMALLINT UNSIGNED NULL,',
  '  "u32" INT UNSIGNED NULL,',
  '  "iv" INTERVAL NULL,',
  '  "g" GEOMETRY NULL,',
  '  "gg" GEOGRAPHY NULL,',
  '  "vec" VECTOR(2) NULL,',
  '  "tz" TIMESTAMPTZ NULL',
  ") ENGINE=FUSE",
].join("\n");
const INDEX_ANSWER: Fields = { schema: [text("index_name"), text("index_type"), text("definition")], data: [] };

const IN_DEMO = "FROM `default`.system.tables WHERE catalog = 'default' AND database = 'libredb_demo'";
const COLUMNS_IN_DEMO = "FROM `default`.system.columns WHERE database = 'libredb_demo'";
const BULK =
  "SELECT `table` AS object_name, name AS column_name, data_type, is_nullable, default_kind, default_expression";
const DETAIL = "SELECT name AS column_name, data_type, is_nullable, default_kind, default_expression, comment";
const INDEXES =
  "SELECT name AS index_name, `type` AS index_type, definition FROM default.system.indexes WHERE database = 'libredb_demo' AND `table` =";
const MV_FILTER = " AND name <> '_mv_source_row_id'";

const bulkRows = (object: string, columns: readonly (readonly [string, string, "YES" | "NO"])[]) =>
  columnRows(columns, false).map((row) => [object].concat(row));
const TABLE_BULK = [...bulkRows("every_type", EVERY_TYPE_COLUMNS), ...bulkRows("wide_60", WIDE_COLUMNS)];

/** The `table_type` spelling each kind is listed under. */
const KIND_TYPES = {
  table: "BASE TABLE",
  view: "VIEW",
  materialized_view: "MATERIALIZED VIEW",
  dynamic_table: "DYNAMIC TABLE",
} as const;
const NAMES: Readonly<Record<keyof typeof KIND_TYPES, string[]>> = {
  table: ["every_type", "wide_60"],
  view: ["every_type_view"],
  materialized_view: ["every_type_mv"],
  dynamic_table: [],
};
const LISTED: Readonly<Record<keyof typeof KIND_TYPES, (string | null)[][]>> = {
  table: [
    ["every_type", "4", "6127", ""],
    ["wide_60", "1", "8788", ""],
  ],
  view: [["every_type_view", null, null, ""]],
  materialized_view: [["every_type_mv", "0", "0", ""]],
  dynamic_table: [],
};

const PROBE_SQL = "SELECT version() AS server_version";
const authTypeSql = (user: string) => `SELECT auth_type FROM default.system.users WHERE name = '${user}'`;
const DATABASES_SQL =
  "SELECT name AS database_name FROM `default`.system.databases WHERE catalog = 'default' AND name NOT IN ('system', 'information_schema') ORDER BY name";
const MV_SOURCE_SQL = "SHOW CREATE MATERIALIZED VIEW `default`.`libredb_demo`.`every_type_mv`";
const ABSENT_SOURCE_SQL = "SHOW CREATE TABLE `default`.`libredb_demo`.`no_such_table` WITH QUOTED_IDENTIFIERS";

/** Every object-surface statement the provider sends for libredb_demo, and the answer the fixture gave it. */
function surfaceAnswers(): Map<string, Fields> {
  const answers = new Map<string, Fields>([
    [
      "SELECT name AS catalog_name FROM system.catalogs ORDER BY name",
      { schema: [text("catalog_name")], data: [["default"]] },
    ],
    [DATABASES_SQL, { schema: [text("database_name")], data: [["default"], ["libredb_demo"], ["studio_demo"]] }],
    [
      `SELECT kind, count(*) AS object_count FROM (SELECT CASE table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' WHEN 'MATERIALIZED VIEW' THEN 'materialized_view' WHEN 'DYNAMIC TABLE' THEN 'dynamic_table' ELSE concat('unknown:', table_type) END AS kind ${IN_DEMO}) AS objects GROUP BY kind`,
      {
        schema: [text("kind"), text("object_count", "UInt64")],
        data: [
          ["table", "2"],
          ["view", "1"],
          ["materialized_view", "1"],
        ],
      },
    ],
    [
      `${DETAIL} ${COLUMNS_IN_DEMO} AND \`table\` = 'every_type'`,
      { schema: COLUMN_SCHEMA, data: columnRows(EVERY_TYPE_COLUMNS, true) },
    ],
    [
      `${DETAIL} ${COLUMNS_IN_DEMO} AND \`table\` = 'every_type_view'`,
      { schema: COLUMN_SCHEMA, data: columnRows(VIEW_COLUMNS, true) },
    ],
    [
      `${DETAIL} ${COLUMNS_IN_DEMO} AND \`table\` = 'every_type_mv'${MV_FILTER}`,
      { schema: COLUMN_SCHEMA, data: columnRows(MV_COLUMNS, true) },
    ],
    [`${INDEXES} 'every_type' ORDER BY name`, INDEX_ANSWER],
    [`${INDEXES} 'every_type_view' ORDER BY name`, INDEX_ANSWER],
    [`${INDEXES} 'every_type_mv' ORDER BY name`, INDEX_ANSWER],
    [
      "SHOW CREATE TABLE `default`.`libredb_demo`.`every_type` WITH QUOTED_IDENTIFIERS",
      {
        schema: SOURCE_SCHEMA,
        data: [["every_type", EVERY_TYPE_DDL]],
      },
    ],
    [
      "SHOW CREATE TABLE `default`.`libredb_demo`.`every_type_view` WITH QUOTED_IDENTIFIERS",
      {
        schema: SOURCE_SCHEMA,
        data: [
          [
            "every_type_view",
            "CREATE VIEW `libredb_demo`.`every_type_view` AS SELECT id, txt, flag FROM libredb_demo.every_type",
          ],
        ],
      },
    ],
    [
      ABSENT_SOURCE_SQL,
      {
        state: "Failed",
        error: { code: 1025, message: "Unknown table 'no_such_table'" },
        schema: SOURCE_SCHEMA,
        data: [],
      },
    ],
  ]);
  for (const [kind, type] of Object.entries(KIND_TYPES) as [keyof typeof KIND_TYPES, string][]) {
    const where = `${IN_DEMO} AND table_type = '${type}'`;
    const names = { schema: [text("object_name")], data: NAMES[kind].map((name) => [name]) };
    answers.set(`SELECT name AS object_name, num_rows, data_compressed_size, comment ${where} ORDER BY name`, {
      schema: LIST_SCHEMA,
      data: LISTED[kind],
    });
    answers.set(`SELECT name AS object_name ${where} ORDER BY name`, names);
    answers.set(`SELECT name AS object_name ${where} ORDER BY name LIMIT 2`, names);
    const filter = kind === "materialized_view" ? MV_FILTER : "";
    const bulk = {
      schema: BULK_SCHEMA,
      data:
        kind === "table"
          ? TABLE_BULK
          : kind === "view"
            ? bulkRows("every_type_view", VIEW_COLUMNS)
            : kind === "materialized_view"
              ? bulkRows("every_type_mv", MV_COLUMNS)
              : [],
    };
    answers.set(`${BULK} ${COLUMNS_IN_DEMO}${filter} AND \`table\` IN (SELECT name ${where})`, bulk);
    answers.set(
      `${BULK} ${COLUMNS_IN_DEMO}${filter} AND \`table\` IN (SELECT name ${where} ORDER BY name LIMIT 2)`,
      bulk,
    );
  }
  return answers;
}

const SURFACE = surfaceAnswers();

/**
 * The connect and surface reads: the probe from version.json, the materialized view's source from
 * show-create-materialized-view.json, the rest built, the caution's `auth_type` as the fixture's user answered it.
 */
function connectAnswer(sql: string): ReplayAnswer | undefined {
  if (sql === PROBE_SQL) return { capture: "version", index: 0 };
  if (sql === MV_SOURCE_SQL) return { capture: "show-create-materialized-view", index: 0 };
  if (sql === authTypeSql(TEST_USER))
    return { built: { schema: [text("auth_type")], data: [["double_sha1_password"]] } };
  const built = SURFACE.get(sql);
  return built === undefined ? undefined : { built };
}

/** A user statement answered by the first exchange of the capture that posted exactly it. */
function userStatement(scenario: string, index = 0): Record<string, ReplayAnswer> {
  return { [capturedSql(scenario, index)]: { capture: scenario, index } };
}

// ============================================================================
// The harness
// ============================================================================

const opened: DatabendProvider[] = [];
/** Every captured exchange a test replayed, for the last test. */
const replayed = new Set<string>();
/** The tests whose replays the last test reads, and those of them that ran to the end. */
const flows: string[] = [];
const finished = new Set<string>();

/** A test that replays captures: the census below counts what it served once it has passed. */
function flow(title: string, body: () => Promise<void>): void {
  flows.push(title);
  test(title, async () => {
    await body();
    finished.add(title);
  });
}

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((provider) => provider.disconnect()));
});

/**
 * A provider over the replay: `statements` answers user statements first, the connect and surface reads otherwise.
 * `overrides` go onto the loopback test connection.
 */
function replay(
  statements: Readonly<Record<string, ReplayAnswer>> = {},
  {
    overrides = {},
    hold,
    role,
    answer,
  }: {
    readonly overrides?: Record<string, unknown>;
    readonly hold?: (request: ReplayedRequest) => boolean;
    readonly role?: string;
    readonly answer?: (sql: string) => ReplayAnswer | undefined;
  } = {},
) {
  const server = databendReplay({
    answer: answer ?? ((sql) => (Object.hasOwn(statements, sql) ? statements[sql] : connectAnswer(sql))),
    hold,
    role,
  });
  const time = transportDeps(scriptedNodeTransport());
  const provider = new DatabendProvider(
    testConnection(overrides),
    { queryTimeout: 60_000 },
    { ...time.deps, createNodeTransport: server.factory },
  );
  opened.push(provider);
  const record = () => {
    for (const label of server.served()) replayed.add(label);
  };
  return { provider, server, time, record };
}

/** The requests after the connect: everything from the first one whose statement is `sql`. */
function after(requests: readonly ReplayedRequest[], sql: string): ReplayedRequest[] {
  return requests.slice(requests.findIndex((request) => request.sql === sql));
}

/** The `session` object a statement POST carried. */
function sessionOf(request: ReplayedRequest): {
  readonly database?: string;
  readonly settings: Record<string, string>;
} {
  const session = request.body?.session;
  if (session === undefined) throw new Error(`${request.method} ${request.capturePath} carried no session`);
  return session as { readonly database?: string; readonly settings: Record<string, string> };
}

const paths = (requests: readonly ReplayedRequest[]) =>
  requests.map((request) => `${request.method} ${request.capturePath}`);

/** The method and path of each exchange of a capture, as the capture names them. */
const capturePaths = (scenario: string, indexes: readonly number[]) =>
  indexes.map((index) => {
    const { request } = loadDatabendCapture(scenario).exchanges[index];
    return `${request.method} ${request.path}`;
  });

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

/** Yields to the event loop until `ready()` holds; a real zero-length wait, never a deadline. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !ready(); turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each turn yields once, then reads the condition again.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(ready()).toBe(true);
}

test("the header names the image and the date the manifest records", () => {
  const manifest = loadDatabendManifest();
  expect(`${manifest.image} ${manifest.capturedAt}`).toBe(
    "datafuselabs/databend:v1.2.951-nightly@sha256:f63585cae3e096d62580ad51d92abd2f64b57b196af3b51cb01ecae381ec874b 2026-10-08",
  );
});

describe("Databend v1.2.951-nightly, replayed", () => {
  flow("connect probes and reads its caution; the object surface meets the fleet's contract", async () => {
    const { provider, server, record } = replay();
    await provider.connect();
    expect(paths(server.requests)).toEqual([
      "POST /v1/query",
      "GET /v1/query/<query-1>/final",
      "POST /v1/query",
      "GET /v1/query/<built-1>/final",
    ]);
    expect(server.requests.map((request) => request.servedBy)).toEqual(["version#0", "version#1", "built", "built"]);
    // A double_sha1_password user is no caution.
    expect(provider.connectWarnings()).toEqual([]);

    await assertObjectSurface(provider, {
      containers: [["default"]],
      container: ["default", "libredb_demo"],
      kinds: { table: 2, view: 1, materialized_view: 1, dynamic_table: 0 },
      sampleObject: { path: ["default", "libredb_demo", "every_type"], kind: "table" },
      absentSource: { path: ["default", "libredb_demo", "no_such_table"], kind: "table" },
      emptyKinds: {
        dynamic_table:
          "The fixture (docker/databend/fixture.jsonl) creates no dynamic table yet: a fixture shortfall, not a limit of the engine.",
      },
      noAbstainingKinds: true,
    });
    expect(server.unanswered()).toEqual([]);
    // Every statement Studio wrote itself pinned the provider settings, and each was closed by its final link.
    const posted = server.requests.filter((request) => request.sql !== undefined);
    for (const request of posted) {
      expect(sessionOf(request).settings).toMatchObject({
        http_json_result_mode: "display",
        sql_dialect: "PostgreSQL",
        timezone: "UTC",
      });
    }
    expect(server.requests.filter((request) => request.path.endsWith("/final"))).toHaveLength(posted.length);
    record();
  });

  flow("the materialized view's source is the DDL SHOW CREATE MATERIALIZED VIEW answers", async () => {
    const { provider, server, record } = replay();
    await provider.connect();
    const document = await provider.readObjectSource(["default", "libredb_demo", "every_type_mv"], "materialized_view");
    expect(document.parts).toEqual([
      {
        id: "definition",
        label: "Definition",
        text: "CREATE MATERIALIZED VIEW `libredb_demo`.`every_type_mv` (`id`, `txt`) AS SELECT id, txt FROM libredb_demo.every_type",
        language: "sql",
        form: "complete",
        origin: "regenerated",
      },
    ]);
    expect(paths(after(server.requests, MV_SOURCE_SQL))).toEqual(capturePaths("show-create-materialized-view", [0, 1]));
    record();
  });

  flow("SHOW CREATE TABLE typed in the editor answers the table and its DDL as a result", async () => {
    const { provider, server, record } = replay(userStatement("show-create-every-type"));
    await provider.connect();
    const sql = capturedSql("show-create-every-type", 0);
    const result = await provider.query(sql);
    expect(paths(after(server.requests, sql))).toEqual(capturePaths("show-create-every-type", [0, 1]));
    expect(result.fields).toEqual(["Table", "Create Table"]);
    expect(result.rows[0].Table).toBe("every_type");
    // The editor's statement pins no quoting, so the names come back bare.
    expect(String(result.rows[0]["Create Table"])).toStartWith("CREATE TABLE every_type (\n  id INT NOT NULL,");
    record();
  });

  flow("a read: every_type decodes every type the fixture holds", async () => {
    const { provider, server, record } = replay(userStatement("every-type"));
    await provider.connect();
    const sql = capturedSql("every-type", 0);
    const result = await provider.query(sql);
    expect(paths(after(server.requests, sql))).toEqual(capturePaths("every-type", [0, 1]));
    expect(result.fields).toEqual(EVERY_TYPE_COLUMNS.map(([name]) => name));
    expect(result.rowCount).toBe(4);
    expect(result.warnings).toBeUndefined();
    const [first, , third, fourth] = result.rows;
    // An integer past 2^53 stays exact.
    expect(String(first.i64)).toBe("9007199254740993");
    expect(String(first.u64)).toBe("18446744073709551615");
    expect(first.txt).toBe("plain");
    expect(third.txt).toBe('it\'s \\ a "quote"');
    expect(Object.values(fourth).filter((value) => value !== null)).toEqual([4]);
    record();
  });

  flow("paging: select-pages follows next_uri page by page and closes with the final link", async () => {
    const { provider, server, record } = replay(userStatement("select-pages"));
    await provider.connect();
    const sql = capturedSql("select-pages", 0);
    const result = await provider.query(sql);
    expect(paths(after(server.requests, sql))).toEqual(capturePaths("select-pages", [0, 1, 2, 3]));
    expect(result.rowCount).toBe(25);
    expect(result.rows.map((row) => String(row.number))).toEqual(Array.from({ length: 25 }, (_, n) => String(n)));
    expect(result.pagination).toBeUndefined();
    record();
  });

  flow("a write: DDL runs in a session of its own, whose logout drops the temporary table it made", async () => {
    const { provider, server, record } = replay(userStatement("ddl"));
    await provider.connect();
    const sql = capturedSql("ddl", 0);
    const result = await provider.query(sql);
    expect(paths(after(server.requests, sql))).toEqual(capturePaths("ddl", [0, 1, 2]));
    expect(result.fields).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.warnings).toEqual([{ message: TEMP_TABLES_DROPPED }]);
    record();
  });

  flow("DML: the inserted count is the rowCount, from the one row Databend answers it in", async () => {
    const { provider, server, record } = replay(userStatement("insert"));
    await provider.connect();
    const insert = capturedSql("insert", 0);
    const result = await provider.query(insert);
    // A table that outlives the session needs no keep-alive, so no logout follows.
    expect(paths(after(server.requests, insert))).toEqual(capturePaths("insert", [0, 1]));
    expect(result.fields).toEqual(["number of rows inserted"]);
    expect(result.rowCount).toBe(3);
    expect(result.warnings).toBeUndefined();
    record();
  });

  flow("a statement the harness sent in a session Studio has already logged out is not replayed", async () => {
    const { provider, server, record } = replay({ ...userStatement("dml", 0), ...userStatement("dml", 2) });
    await provider.connect();
    const create = capturedSql("dml", 0);
    expect((await provider.query(create)).warnings).toEqual([{ message: TEMP_TABLES_DROPPED }]);
    expect(paths(after(server.requests, create))).toEqual(capturePaths("dml", [0, 1, 4]));
    // The harness inserted into its temporary table in the same session; Studio's CREATE ended that session, and a
    // server answers an INSERT in a new one with 1025 Unknown table, never with dml#2's count.
    const insert = capturedSql("dml", 2);
    await rejection(provider.query(insert));
    expect(after(server.requests, insert)[0].servedBy).toBeNull();
    expect(server.served()).not.toContain("dml#2");
    record();
  });

  flow("temp-table-logout: the logout ends the session, so the next statement does not see the table", async () => {
    const { provider, server, record } = replay({
      ...userStatement("temp-table-logout", 0),
      ...userStatement("temp-table-logout", 5),
    });
    await provider.connect();
    const create = await provider.query(capturedSql("temp-table-logout", 0));
    expect(create.warnings).toEqual([{ message: TEMP_TABLES_DROPPED }]);
    expect(paths(after(server.requests, capturedSql("temp-table-logout", 0)))).toEqual(
      capturePaths("temp-table-logout", [0, 1, 4]),
    );

    // The harness sent this SELECT after its logout, so its 1025 is what a statement in a new session meets too.
    const select = capturedSql("temp-table-logout", 5);
    const failure = await rejection(provider.query(select));
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toContain('Unknown table "default"."default".ev_temp');
    // `--> SQL:1:15` is the table name in `SELECT a FROM ev_temp`.
    expect((failure as QueryError).position).toBe(15);
    // The failed answer names its final link, which the harness did not follow.
    expect(server.unanswered()).toEqual(["GET /v1/query/<query-11>/final"]);
    record();
  });

  flow("error-position: an in-body error is a QueryError at the position its caret names", async () => {
    const { provider, server, record } = replay(userStatement("error-position"));
    await provider.connect();
    const sql = capturedSql("error-position", 0);
    const failure = await rejection(provider.query(sql));
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toContain("unexpected `FRM`, expecting end of input");
    expect((failure as QueryError).position).toBe(10);
    expect(sql.slice(9, 12)).toBe("FRM");
    expect(paths(after(server.requests, sql))).toEqual(capturePaths("error-position", [0, 1]));
    record();
  });

  flow("BEGIN is rolled back with the session it echoed, and no endOpenQueryTransaction exists", async () => {
    const { provider, server, record } = replay({
      ...userStatement("begin", 0),
      ROLLBACK: { capture: "begin", index: 2 },
    });
    // The engine has no transaction to leave open over this connection: the provider ends any a statement opens.
    const surface: DatabaseProvider = provider;
    expect(surface.endOpenQueryTransaction).toBeUndefined();
    expect(provider.getCapabilities().supportsTransactions).toBe(false);
    await provider.connect();
    const result = await provider.query("BEGIN");
    expect(result.warnings).toEqual([{ message: TRANSACTION_ENDED }]);
    // The ROLLBACK's answer no longer needs keep-alive, so no logout follows it.
    const sent = after(server.requests, "BEGIN");
    expect(paths(sent)).toEqual(capturePaths("begin", [0, 1, 2, 3]));
    const begun = JSON.parse(JSON.stringify(loadDatabendCapture("begin").exchanges[0].response.body)) as {
      session: Record<string, unknown>;
    };
    const rollback = sent[2].body as { session: Record<string, unknown> };
    expect(Object.keys(rollback.session).sort()).toEqual(Object.keys(begun.session).sort());
    expect(rollback.session.txn_state).toBe("Active");
    record();
  });

  flow(
    "session-echo: the request carries the connection's database, and the server echoes the result mode",
    async () => {
      const { provider, server, record } = replay(userStatement("session-echo"), {
        overrides: { database: "libredb_demo" },
      });
      await provider.connect();
      expect(server.requests.map((request) => request.sql)).toContain(DATABASES_SQL);
      expect(provider.connectWarnings()).toEqual([]);
      const sql = capturedSql("session-echo", 0);
      const result = await provider.query(sql);
      const [request] = after(server.requests, sql);
      expect(sessionOf(request).database).toBe("libredb_demo");
      // The harness pinned Europe/Istanbul for this capture, not Studio's UTC, so `now()` is not read here.
      expect(result.rows[0]["current_database()"]).toBe("libredb_demo");
      // The echo names http_json_result_mode=display, so no version-floor warning (I6).
      expect(result.warnings).toBeUndefined();
      // need_keep_alive is false, so no logout follows.
      expect(paths(after(server.requests, sql))).toEqual(capturePaths("session-echo", [0, 1]));
      record();
    },
  );

  flow("reader: the least-privilege user reads through its own role, with no role warning", async () => {
    const reader = capturedSql("reader", 0);
    const { provider, server, record } = replay(
      {},
      {
        role: "studio_ro",
        answer: (sql) => {
          if (sql === reader) return { capture: "reader", index: 0 };
          // The probe as the reader ran it: the role is the reader's own, as reader.json echoes it.
          if (sql === PROBE_SQL) return { built: { schema: [text("server_version")], data: [["v1.2.951-nightly"]] } };
          return connectAnswer(sql);
        },
      },
    );
    await provider.connect();
    const result = await provider.query(reader);
    expect(result.rows).toEqual([{ "current_user()": "'<user-2>'@'%'", "current_role()": "studio_ro", "COUNT(*)": 4 }]);
    expect(result.warnings).toBeUndefined();
    expect(paths(after(server.requests, reader))).toEqual(capturePaths("reader", [0, 1]));
    record();
  });

  flow("auth-401: a refused password is sent once, then the latch refuses it with no request", async () => {
    const { provider, server, record } = replay({}, { answer: () => ({ capture: "auth-401", index: 0 }) });
    const refused = await rejection(provider.connect());
    expect(refused).toBeInstanceOf(AuthenticationError);
    expect(refused.message).toBe(
      `${DATABEND_ERROR_SENTENCES.signInRefused} Authentication failed: incorrect password.`,
    );
    // No kill, ROLLBACK or logout: each would carry the refused credential again.
    expect(paths(server.requests)).toEqual(["POST /v1/query"]);

    const latched = await rejection(provider.connect());
    expect(latched).toBeInstanceOf(AuthenticationError);
    const at = new Date(TEST_START).toISOString().slice(0, 16).replace("T", " ");
    const until = new Date(TEST_START + 15 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
    expect(latched.message).toBe(DATABEND_ERROR_SENTENCES.latched(at, until));
    expect(server.requests).toHaveLength(1);
    record();
  });

  flow("kill: a cancel aborts the long poll and the kill is acknowledged", async () => {
    const sql = capturedSql("kill", 0);
    const { provider, server, record } = replay(userStatement("kill"), {
      hold: (request) => request.method === "GET" && request.path.includes("/page/"),
    });
    await provider.connect();
    const running = rejection(provider.query(sql, undefined, "run-1"));
    await until(() => server.requests.some((request) => request.servedBy === HELD));
    expect(await provider.cancelQuery("run-1")).toBe(true);
    expect(await running).toBeInstanceOf(QueryCancelledError);
    // Studio aborts its own page, so it never asks a page after its kill as the harness did.
    expect(paths(after(server.requests, sql))).toEqual(capturePaths("kill", [0, 2, 1]));
    expect(after(server.requests, sql).map((request) => request.servedBy)).toEqual(["kill#0", HELD, "kill#1"]);
    record();
  });

  flow("final: a page of a statement the server already closed is its error, and Studio sends the kill", async () => {
    const sql = capturedSql("final-kill", 0);
    const { provider, server, record } = replay(userStatement("final-kill"));
    await provider.connect();
    const failure = await rejection(provider.query(sql));
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.message).toContain("Databend answered HTTP 400 before the statement finished");
    expect(failure.message).toContain("is closed for finalized");
    // Studio never sends this final itself: the 400 stands for a statement some other party closed, and the kill
    // Studio sends then is acknowledged as the pinned server acknowledged it.
    expect(paths(after(server.requests, sql))).toEqual(capturePaths("final-kill", [0, 2, 3]));
    expect(server.unanswered()).toEqual([]);
    record();
  });

  flow("a running statement counts as active and an aborting one as other", async () => {
    const sessionsSql = databendSessionsSql(DATABEND_DEFAULT_SESSION_LIMIT);
    const { provider } = replay(
      {},
      {
        answer: (sql) => {
          if (sql !== sessionsSql) return connectAnswer(sql);
          return {
            built: {
              schema: [
                text("session_id"),
                text("query_id"),
                text("user_name"),
                text("host", "Nullable(String)"),
                text("database_name"),
                text("command"),
                text("query_text"),
                text("created_time", "Timestamp"),
                text("elapsed_seconds", "UInt64"),
              ],
              data: [
                [
                  "5c00e52f-34c2-4cab-8ba8-c1f1121157bf",
                  "q-query",
                  "studio_reader",
                  "172.20.0.1",
                  "libredb_demo",
                  "Query",
                  "SELECT 1",
                  "2026-10-07 22:58:07.375243",
                  "3",
                ],
                [
                  "6d11f63a-45d3-5dbc-9cb9-d2e2232268c0",
                  "q-abort",
                  "studio_reader",
                  "172.20.0.1",
                  "libredb_demo",
                  "Aborting",
                  "SELECT 2",
                  "2026-10-07 22:58:08.375243",
                  "1",
                ],
              ],
            },
          };
        },
      },
    );
    await provider.connect();
    expect((await provider.getActiveSessions()).map((session) => [session.state, session.activity])).toEqual([
      ["active", "active"],
      ["aborting", "other"],
    ]);
  });

  test("every captured exchange is replayed, except the ones Studio's flow never asks for", () => {
    const missing = flows.filter((title) => !finished.has(title));
    if (missing.length > 0) {
      throw new Error(
        `The census reads the replays of every test above, so it runs with the whole file; these did not pass: ${missing.join("; ")}`,
      );
    }
    const expected = DATABEND_CAPTURE_RUNS.flatMap((run) => {
      const manifest = loadDatabendManifest(run);
      // Every capture file of a run is a scenario of its manifest, and every scenario has its file.
      expect(databendCaptureFiles(run)).toEqual(manifest.scenarios.map((scenario) => scenario.name).sort());
      return manifest.scenarios.flatMap((scenario) => {
        expect(loadDatabendCapture(scenario.name).exchanges).toHaveLength(scenario.exchanges);
        return Array.from({ length: scenario.exchanges }, (_, index) => `${scenario.name}#${index}`);
      });
    });
    const notAsked = {
      // Each statement runs in its own session and the ROLLBACK's answer no longer needs keep-alive.
      "begin#4": "logout",
      // need_keep_alive is false, so no logout follows.
      "session-echo#2": "logout",
      // Studio aborts its own page when it cancels.
      "kill#2": "page after the kill",
      // Studio finalizes early only when a statement budget cuts a result, which 25 rows never reach.
      "final#1": "final before the last page",
      "final-kill#1": "final before the last page",
      // final-kill holds the same flow and the kill that follows it.
      "final#0": "the statement of final-kill",
      "final#2": "the page of final-kill",
      // The harness sent these in the session Studio logs out after the CREATE, so a server could not answer them.
      "dml#2": "insert into a dropped temporary table",
      "dml#3": "its final",
      "temp-table-logout#2": "insert into a dropped temporary table",
      "temp-table-logout#3": "its final",
    };
    expect(expected.filter((label) => !replayed.has(label)).sort()).toEqual(Object.keys(notAsked).sort());
  });
});
