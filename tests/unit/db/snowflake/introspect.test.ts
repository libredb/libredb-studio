import { describe, expect, test } from "bun:test";
import { INVENTORY_PAIR_LIMIT, INVENTORY_TRUNCATION_REASON } from "@/lib/db/inventory-bounds";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import {
  connectCautions,
  connectStatement,
  countObjects,
  describeObject,
  describeObjects,
  getHealth,
  listDatabases,
  listObjects,
  listSchemas,
  quoteIdent,
  readObjectSource,
  type SchemaColumnsMemo,
  SNOWFLAKE_INTROSPECT_SENTENCES,
  SNOWFLAKE_KIND_IDS,
  SNOWFLAKE_SHOW_PAGE_ROWS,
  SNOWFLAKE_TREE_PAGE_LIMIT,
  warehouseRow,
} from "@/lib/db/providers/sql/snowflake/introspect";
import type { SnowflakeResult } from "@/lib/db/providers/sql/snowflake/statements";
import { SNOWFLAKE_QUERY_TAGS } from "@/lib/db/providers/sql/snowflake/statements";
import { fakeRunner, namedRows, type RunnerCall, showResult } from "../../../helpers/snowflake-runner";

const SCHEMA = ["SALES", "PUBLIC"] as const;
const IN_SCHEMA = 'IN SCHEMA "SALES"."PUBLIC"';
const names = (rows: readonly { readonly name: string }[]) => rows.map((row) => row.name);
const onlyShow = (calls: readonly RunnerCall[]) => expect(calls.every((call) => /^SHOW /.test(call.sql))).toBe(true);

/** A pageable listing of `total` rows named `T00001` upwards, each page starting after its `FROM` cursor. */
function pagedNames(total: number, column = "name") {
  return (sql: string) => {
    const cursor = /FROM '([^']*)'$/.exec(sql)?.[1];
    const start = cursor === undefined ? 1 : Number(cursor.slice(1)) + 1;
    const count = Math.max(0, Math.min(SNOWFLAKE_SHOW_PAGE_ROWS, total - start + 1));
    return showResult([column], namedRows("T", start, count));
  };
}

describe("the constants", () => {
  test("pin the page size, the tree's page limit and the ten kinds in order", () => {
    expect(SNOWFLAKE_SHOW_PAGE_ROWS).toBe(10_000);
    expect(SNOWFLAKE_TREE_PAGE_LIMIT).toBe(5);
    expect([...SNOWFLAKE_KIND_IDS]).toEqual([
      "table",
      "view",
      "stream",
      "task",
      "sequence",
      "stage",
      "file-format",
      "pipe",
      "function",
      "procedure",
    ]);
  });

  test("the cap sentences", () => {
    expect(SNOWFLAKE_INTROSPECT_SENTENCES.treeCap).toBe(
      "Snowflake has more than 50,000 objects of this kind here; Studio shows the first 50,000 by name.",
    );
    // The floor is Studio's own LIMIT 10000: the trial answered SHOW TERSE OBJECTS with all 10,250 rows without one.
    expect(SNOWFLAKE_INTROSPECT_SENTENCES.countFloor).toBe(
      "Studio counts at most 10,000 objects here, so this is a floor.",
    );
    // No listing without paging shows a cap sentence: the tree drops its stop, and the inventory reads only paged kinds.
    expect(Object.keys(SNOWFLAKE_INTROSPECT_SENTENCES)).not.toContain("silentCap");
    expect(SNOWFLAKE_INTROSPECT_SENTENCES.secureView).toBe(
      "Snowflake hides a secure view's definition from roles that do not own it.",
    );
  });

  test("quoteIdent always quotes and doubles a quote", () => {
    expect(quoteIdent("orders")).toBe('"orders"');
    expect(quoteIdent('my"db')).toBe('"my""db"');
  });
});

describe("listObjects", () => {
  const STATEMENTS: Record<string, string> = {
    table: `SHOW TABLES ${IN_SCHEMA} LIMIT 10000`,
    view: `SHOW VIEWS ${IN_SCHEMA} LIMIT 10000`,
    stream: `SHOW STREAMS ${IN_SCHEMA} LIMIT 10000`,
    task: `SHOW TASKS ${IN_SCHEMA} LIMIT 10000`,
    sequence: `SHOW SEQUENCES ${IN_SCHEMA}`,
    stage: `SHOW STAGES ${IN_SCHEMA}`,
    "file-format": `SHOW FILE FORMATS ${IN_SCHEMA}`,
    pipe: `SHOW PIPES ${IN_SCHEMA}`,
    function: `SHOW USER FUNCTIONS ${IN_SCHEMA}`,
    procedure: `SHOW PROCEDURES ${IN_SCHEMA}`,
  };

  for (const kind of SNOWFLAKE_KIND_IDS) {
    test(`${kind}: one statement, tagged tree`, async () => {
      const { run, calls } = fakeRunner([
        [/^SHOW /, () => showResult(["name", "arguments"], [["X", "X() RETURN NUMBER"]])],
      ]);
      const objects = await listObjects(run, SCHEMA, kind);
      expect(calls).toEqual([{ sql: STATEMENTS[kind], tag: SNOWFLAKE_QUERY_TAGS.tree }]);
      expect(objects.map((object) => object.kind)).toEqual([kind]);
    });
  }

  test("quotes both container segments, doubling a quote", async () => {
    const { run, calls } = fakeRunner([[/^SHOW /, () => showResult(["name"], [])]]);
    await listObjects(run, ['my"db', "s"], "view");
    expect(calls[0].sql).toBe('SHOW VIEWS IN SCHEMA "my""db"."s" LIMIT 10000');
  });

  test("a kind without paging sends no LIMIT and no second page, and keeps every row past 10,000", async () => {
    const { run, calls } = fakeRunner([[/^SHOW /, () => showResult(["name"], namedRows("S", 1, 10_250))]]);
    const objects = await listObjects(run, SCHEMA, "sequence");
    expect(calls.map((call) => call.sql)).toEqual([`SHOW SEQUENCES ${IN_SCHEMA}`]);
    expect(objects).toHaveLength(10_250);
  });

  test("pages with the FROM cursor and drops the repeated boundary row", async () => {
    // Page 2 repeats page 1's last name, page 3 repeats page 2's. The trial's FROM starts after its name, so this
    // answer is built to hold the read to dropping a repeat should one come.
    const answer = (sql: string) => {
      const cursor = /FROM '([^']*)'$/.exec(sql)?.[1];
      if (cursor === undefined) return showResult(["name"], namedRows("T", 1, 10_000));
      if (cursor === "T10000") return showResult(["name"], namedRows("T", 10_000, 10_000));
      return showResult(["name"], namedRows("T", 19_999, 6));
    };
    const { run, calls } = fakeRunner([[/^SHOW TABLES /, answer]]);
    const objects = await listObjects(run, SCHEMA, "table");
    expect(calls.map((call) => call.sql)).toEqual([
      `SHOW TABLES ${IN_SCHEMA} LIMIT 10000`,
      `SHOW TABLES ${IN_SCHEMA} LIMIT 10000 FROM 'T10000'`,
      `SHOW TABLES ${IN_SCHEMA} LIMIT 10000 FROM 'T19999'`,
    ]);
    expect(objects).toHaveLength(20_004);
    expect(new Set(names(objects)).size).toBe(20_004);
    expect(objects.at(-1)?.name).toBe("T20004");
  });

  test("a page that does not move the cursor stops the listing", async () => {
    const { run, calls } = fakeRunner([[/^SHOW TABLES /, () => showResult(["name"], namedRows("T", 1, 10_000))]]);
    const objects = await listObjects(run, SCHEMA, "table");
    expect(calls).toHaveLength(2);
    expect(objects).toHaveLength(10_000);
  });

  test("a tree listing stops after five pages, 50,000 rows", async () => {
    const { run, calls } = fakeRunner([[/^SHOW TABLES /, pagedNames(80_000)]]);
    const objects = await listObjects(run, SCHEMA, "table");
    expect(calls).toHaveLength(SNOWFLAKE_TREE_PAGE_LIMIT);
    expect(objects).toHaveLength(50_000);
  });

  test("an overloaded function is two objects with two paths carrying the argument types", async () => {
    const { run } = fakeRunner([
      [
        /^SHOW USER FUNCTIONS /,
        () =>
          showResult(
            ["name", "arguments"],
            [
              ["F", "F(NUMBER) RETURN NUMBER"],
              ["F", "F(VARCHAR, ARRAY) RETURN VARCHAR"],
            ],
          ),
      ],
    ]);
    const objects = await listObjects(run, SCHEMA, "function");
    expect(objects).toEqual([
      { path: ["SALES", "PUBLIC", "F(NUMBER)"], name: "F", kind: "function" },
      { path: ["SALES", "PUBLIC", "F(VARCHAR, ARRAY)"], name: "F", kind: "function" },
    ]);
  });

  test("a procedure's segment keeps nested parentheses and a name holding one", async () => {
    const { run } = fakeRunner([
      [
        /^SHOW PROCEDURES /,
        () => showResult(["name", "arguments"], [["P(1)", "P(1)(VECTOR(FLOAT, 3)) RETURN TABLE (A NUMBER)"]]),
      ],
    ]);
    const [object] = await listObjects(run, SCHEMA, "procedure");
    expect(object.path).toEqual(["SALES", "PUBLIC", "P(1)(VECTOR(FLOAT, 3))"]);
  });

  test("the built-in procedures SHOW PROCEDURES IN SCHEMA also answers are left out", async () => {
    // The trial (Snowflake 10.37.100, 2026-10-12) answered 34 built-in SYSTEM$ procedures with is_builtin Y and an
    // empty schema_name in a schema that holds none of its own (tree-show).
    const { run } = fakeRunner([
      [
        /^SHOW PROCEDURES /,
        () =>
          showResult(
            ["name", "schema_name", "is_builtin", "arguments"],
            [
              ["SYSTEM$CLASSIFY", "", "Y", "SYSTEM$CLASSIFY(VARCHAR, OBJECT) RETURN OBJECT"],
              ["LOAD", "PUBLIC", "N", "LOAD(VARCHAR) RETURN VARCHAR"],
            ],
          ),
      ],
    ]);
    const objects = await listObjects(run, SCHEMA, "procedure");
    expect(objects.map((object) => object.path.join("."))).toEqual(["SALES.PUBLIC.LOAD(VARCHAR)"]);
  });

  test("a routine whose arguments Studio cannot read is refused by name", async () => {
    const { run } = fakeRunner([[/^SHOW USER FUNCTIONS /, () => showResult(["name", "arguments"], [["G", "G"]])]]);
    await expect(listObjects(run, SCHEMA, "function")).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.unreadableArguments("G"),
    );
  });

  test("a routine whose closing parentheses never balance is refused by name", async () => {
    const { run } = fakeRunner([
      [/^SHOW USER FUNCTIONS /, () => showResult(["name", "arguments"], [["H", "H)) RETURN NUMBER"]])],
    ]);
    await expect(listObjects(run, SCHEMA, "function")).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.unreadableArguments("H"),
    );
  });

  test("a table's flags become its status, and rows its count when it is a whole number", async () => {
    const columns = [
      "name",
      "kind",
      "rows",
      "bytes",
      "is_external",
      "is_dynamic",
      "is_iceberg",
      "is_hybrid",
      "is_event",
    ];
    const { run } = fakeRunner([
      [
        /^SHOW TABLES /,
        () =>
          showResult(columns, [
            ["PLAIN", "TABLE", "12", "4096", "N", "N", "N", "N", "N"],
            ["SCRATCH", "TRANSIENT", "0", "0", "N", "N", "N", "N", "N"],
            ["TEMP", "TEMPORARY", "3", "0", "N", "Y", "N", "Y", "N"],
            ["EXT", "TABLE", null, "0", "Y", "N", "N", "N", "N"],
            ["ICE", "TABLE", "-1", "0", "N", "N", "Y", "N", "Y"],
          ]),
      ],
    ]);
    const objects = await listObjects(run, SCHEMA, "table");
    expect(objects).toEqual([
      { path: ["SALES", "PUBLIC", "PLAIN"], name: "PLAIN", kind: "table", rowCount: 12 },
      { path: ["SALES", "PUBLIC", "SCRATCH"], name: "SCRATCH", kind: "table", status: "transient", rowCount: 0 },
      {
        path: ["SALES", "PUBLIC", "TEMP"],
        name: "TEMP",
        kind: "table",
        status: "temporary, dynamic, hybrid",
        rowCount: 3,
      },
      { path: ["SALES", "PUBLIC", "EXT"], name: "EXT", kind: "table", status: "external" },
      { path: ["SALES", "PUBLIC", "ICE"], name: "ICE", kind: "table", status: "iceberg, event" },
    ]);
  });

  test("a view's materialized and secure flags become its status", async () => {
    const { run } = fakeRunner([
      [
        /^SHOW VIEWS /,
        () =>
          showResult(
            ["name", "is_materialized", "is_secure"],
            [
              ["V", "false", "false"],
              ["MV", "true", "true"],
            ],
          ),
      ],
    ]);
    const objects = await listObjects(run, SCHEMA, "view");
    expect(objects).toEqual([
      { path: ["SALES", "PUBLIC", "V"], name: "V", kind: "view" },
      { path: ["SALES", "PUBLIC", "MV"], name: "MV", kind: "view", status: "materialized, secure" },
    ]);
  });

  test("an unknown kind is refused before anything is sent", async () => {
    const { run, calls } = fakeRunner([]);
    await expect(listObjects(run, SCHEMA, "index")).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.unknownKind("index"),
    );
    expect(calls).toEqual([]);
  });
});

describe("countObjects", () => {
  const terse = (kinds: readonly string[]) => () =>
    showResult(
      ["created_on", "name", "kind", "database_name", "schema_name"],
      kinds.map((kind, index) => ["", `O${index}`, kind, "SALES", "PUBLIC"]),
    );

  test("sends one SHOW TERSE OBJECTS and counts tables and views only", async () => {
    const { run, calls } = fakeRunner([
      [
        /^SHOW TERSE OBJECTS /,
        terse(["TABLE", "TRANSIENT", "TEMPORARY", "VIEW", "MATERIALIZED_VIEW", "VIEW", "OTHER"]),
      ],
    ]);
    const counts = await countObjects(run, SCHEMA);
    expect(calls).toEqual([{ sql: `SHOW TERSE OBJECTS ${IN_SCHEMA} LIMIT 10000`, tag: SNOWFLAKE_QUERY_TAGS.tree }]);
    expect(counts).toEqual({ table: { count: 3 }, view: { count: 3 } });
  });

  test("exactly 10,000 rows makes each count a floor", async () => {
    const kinds = Array.from({ length: 10_000 }, (_, index) => (index < 4_000 ? "TABLE" : "VIEW"));
    const { run } = fakeRunner([[/^SHOW TERSE OBJECTS /, terse(kinds)]]);
    const sampledFrom = SNOWFLAKE_INTROSPECT_SENTENCES.countFloor;
    expect(await countObjects(run, SCHEMA)).toEqual({
      table: { count: 4_000, sampledFrom },
      view: { count: 6_000, sampledFrom },
    });
  });

  test("an empty schema counts zero of each", async () => {
    const { run } = fakeRunner([[/^SHOW TERSE OBJECTS /, terse([])]]);
    expect(await countObjects(run, SCHEMA)).toEqual({ table: { count: 0 }, view: { count: 0 } });
  });
});

describe("containers", () => {
  test("databases page with the cursor and mark the configured one after the fold", async () => {
    const { run, calls } = fakeRunner([
      [/^SHOW DATABASES /, () => showResult(["name"], [["ANALYTICS"], ["SALES"], ["sales"]])],
    ]);
    const containers = await listDatabases(run, "sales");
    expect(calls).toEqual([{ sql: "SHOW DATABASES LIMIT 10000", tag: SNOWFLAKE_QUERY_TAGS.tree }]);
    expect(containers).toEqual([
      { path: ["ANALYTICS"], name: "ANALYTICS", level: 0, isSessionDefault: false },
      { path: ["SALES"], name: "SALES", level: 0, isSessionDefault: true },
      { path: ["sales"], name: "sales", level: 0, isSessionDefault: false },
    ]);
  });

  test("a quoted configured database matches its exact name", async () => {
    const { run } = fakeRunner([[/^SHOW DATABASES /, () => showResult(["name"], [["SALES"], ["sales"]])]]);
    const containers = await listDatabases(run, '"sales"');
    expect(containers.map((container) => container.isSessionDefault)).toEqual([false, true]);
  });

  test("no configured database marks none", async () => {
    const { run } = fakeRunner([[/^SHOW DATABASES /, () => showResult(["name"], [["SALES"]])]]);
    expect((await listDatabases(run, undefined))[0].isSessionDefault).toBe(false);
  });

  test("databases page past 10,000", async () => {
    const { run, calls } = fakeRunner([[/^SHOW DATABASES /, pagedNames(10_002)]]);
    const containers = await listDatabases(run, undefined);
    expect(calls.map((call) => call.sql)).toEqual([
      "SHOW DATABASES LIMIT 10000",
      "SHOW DATABASES LIMIT 10000 FROM 'T10000'",
    ]);
    expect(containers).toHaveLength(10_002);
  });

  test("schemas are read in one database, never the account, and mark the configured schema", async () => {
    const { run, calls } = fakeRunner([
      [/^SHOW SCHEMAS /, () => showResult(["name"], [["INFORMATION_SCHEMA"], ["PUBLIC"]])],
    ]);
    const containers = await listSchemas(run, 'my"db', "public");
    expect(calls).toEqual([{ sql: 'SHOW SCHEMAS IN DATABASE "my""db" LIMIT 10000', tag: SNOWFLAKE_QUERY_TAGS.tree }]);
    expect(containers).toEqual([
      { path: ['my"db', "INFORMATION_SCHEMA"], name: "INFORMATION_SCHEMA", level: 1, isSessionDefault: false },
      { path: ['my"db', "PUBLIC"], name: "PUBLIC", level: 1, isSessionDefault: true },
    ]);
  });
});

describe("every statement the tree sends is a SHOW (SR18)", () => {
  test("over every listing, the count and both container levels", async () => {
    const { run, calls } = fakeRunner([
      [/^SHOW /, () => showResult(["name", "arguments"], [["X", "X() RETURN NUMBER"]])],
    ]);
    await listDatabases(run, undefined);
    await listSchemas(run, "SALES", undefined);
    await countObjects(run, SCHEMA);
    // oxlint-disable-next-line no-await-in-loop -- one kind at a time keeps the recorded order.
    for (const kind of SNOWFLAKE_KIND_IDS) await listObjects(run, SCHEMA, kind);
    expect(calls).toHaveLength(13);
    onlyShow(calls);
  });
});

const WAREHOUSE_COLUMNS = ["name", "state", "size", "running", "queued", "auto_resume"];
const warehouses =
  (...rows: (string | null)[][]) =>
  () =>
    showResult(WAREHOUSE_COLUMNS, rows);

describe("the connect statement and its cautions", () => {
  test("a Warehouse is read with SHOW WAREHOUSES LIKE, its quote and backslash escaped", () => {
    expect(connectStatement("a'b\\c")).toBe("SHOW WAREHOUSES LIKE 'a''b\\\\c'");
    expect(connectStatement("STUDIO_WH")).toBe("SHOW WAREHOUSES LIKE 'STUDIO_WH'");
  });

  test("a quoted Warehouse is matched by its name without the quotes", () => {
    expect(connectStatement('"My WH"')).toBe("SHOW WAREHOUSES LIKE 'My WH'");
    expect(connectStatement('"a""b"')).toBe(`SHOW WAREHOUSES LIKE 'a"b'`);
  });

  test("an empty Warehouse sends SHOW DATABASES LIMIT 1", () => {
    expect(connectStatement(undefined)).toBe("SHOW DATABASES LIMIT 1");
    expect(connectStatement("")).toBe("SHOW DATABASES LIMIT 1");
  });

  test("the LIKE wildcard never answers another warehouse's row", () => {
    const both = warehouses(
      ["AXB", "STARTED", "X-Small", "0", "0", "true"],
      ["A_B", "SUSPENDED", "Small", "0", "0", "true"],
    )();
    expect(warehouseRow(both, "A_B")?.name).toBe("A_B");
    expect(warehouseRow(both, "a_b")?.name).toBe("A_B");
    const other = warehouses(["AXB", "STARTED", "X-Small", "0", "0", "true"])();
    expect(warehouseRow(other, "A_B")).toBeNull();
    expect(connectCautions(other, "A_B", "STUDIO_RO")).toEqual([
      { message: SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow("A_B", "STUDIO_RO") },
    ]);
  });

  test("a quoted name picks the row named exactly that", () => {
    const answer = warehouses(
      ["MY WH", "STARTED", "X-Small", "0", "0", "true"],
      ["My WH", "STARTED", "X-Small", "0", "0", "true"],
    )();
    expect(warehouseRow(answer, '"My WH"')).toBe(answer.rows[1]);
  });

  test("the three cautions, exactly", () => {
    expect(SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow("WH", "R")).toBe(
      "Snowflake shows no warehouse named WH to role R. Check the name, and that the role has USAGE on it.",
    );
    expect(SNOWFLAKE_INTROSPECT_SENTENCES.notResuming("WH")).toBe(
      "Warehouse WH is suspended and does not resume on its own, so queries fail until someone resumes it.",
    );
    expect(SNOWFLAKE_INTROSPECT_SENTENCES.emptyWarehouse).toBe(
      "Warehouse is empty, so queries use the user's default warehouse and fail if the user has none. Browsing works without one.",
    );
  });

  test("a suspended warehouse that does not resume is a caution; one that does, or is running, is none", () => {
    const row = (state: string, autoResume: string) => warehouses(["WH", state, "X-Small", "0", "0", autoResume])();
    expect(connectCautions(row("SUSPENDED", "false"), "wh", "R")).toEqual([
      { message: SNOWFLAKE_INTROSPECT_SENTENCES.notResuming("wh") },
    ]);
    expect(connectCautions(row("SUSPENDED", "true"), "wh", "R")).toEqual([]);
    expect(connectCautions(row("STARTED", "false"), "wh", "R")).toEqual([]);
  });

  test("an empty Warehouse is always a caution", () => {
    const databases = showResult(["name"], [["SALES"]]);
    expect(connectCautions(databases, undefined, "R")).toEqual([
      { message: SNOWFLAKE_INTROSPECT_SENTENCES.emptyWarehouse },
    ]);
  });
});

const TABLE_PATH = ["SALES", "PUBLIC", "ORDERS"] as const;
const QUALIFIED = '"SALES"."PUBLIC"."ORDERS"';
const COLUMN_COLUMNS = ["table_name", "schema_name", "column_name", "data_type", "null?"];
const column = (table: string, name: string, dataType: object): string[] => [
  table,
  "PUBLIC",
  name,
  JSON.stringify(dataType),
  "true",
];
const ORDER_COLUMNS = [
  column("ORDERS", "ID", { type: "FIXED", precision: 38, scale: 0, nullable: false }),
  column("ORDERS", "NOTE", { type: "TEXT", length: 16, byteLength: 64, nullable: true, fixed: false }),
  column("ORDERS", "AT", { type: "TIMESTAMP_NTZ", precision: 0, scale: 9, nullable: true }),
  column("ORDERS", "RATE", { type: "REAL", nullable: true }),
  column("ORDERS", "BODY", { type: "VARIANT", nullable: true }),
];

describe("describeObject", () => {
  const script = (hybrid: string) =>
    fakeRunner([
      [/^SHOW COLUMNS IN /, () => showResult(COLUMN_COLUMNS, ORDER_COLUMNS)],
      [/^SHOW PRIMARY KEYS /, () => showResult(["table_name", "column_name", "key_sequence"], [["ORDERS", "ID", "1"]])],
      [
        /^SHOW TABLES LIKE /,
        () =>
          showResult(
            ["name", "is_hybrid"],
            [
              ["ORDERSX", "Y"],
              ["ORDERS", hybrid],
            ],
          ),
      ],
      [/^SHOW INDEXES /, () => showResult(["name", "is_unique", "columns"], [["BY_NOTE", "Y", "[NOTE, AT]"]])],
    ]);

  test("a table: its columns, primary key and catalog row, tagged describe", async () => {
    const { run, calls } = script("N");
    const detail = await describeObject(run, TABLE_PATH, "table");
    expect(calls).toEqual([
      { sql: `SHOW COLUMNS IN TABLE ${QUALIFIED}`, tag: SNOWFLAKE_QUERY_TAGS.describe },
      { sql: `SHOW PRIMARY KEYS IN TABLE ${QUALIFIED}`, tag: SNOWFLAKE_QUERY_TAGS.describe },
      { sql: `SHOW TABLES LIKE 'ORDERS' ${IN_SCHEMA}`, tag: SNOWFLAKE_QUERY_TAGS.describe },
    ]);
    expect(detail).toEqual({
      path: [...TABLE_PATH],
      columns: [
        { name: "ID", type: "NUMBER(38,0)", nullable: false, isPrimary: true },
        { name: "NOTE", type: "VARCHAR(16)", nullable: true, isPrimary: false },
        { name: "AT", type: "TIMESTAMP_NTZ(9)", nullable: true, isPrimary: false },
        { name: "RATE", type: "FLOAT", nullable: true, isPrimary: false },
        { name: "BODY", type: "VARIANT", nullable: true, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    });
  });

  test("a hybrid table, picked by its exact name, also reads its indexes", async () => {
    const { run, calls } = script("Y");
    const detail = await describeObject(run, TABLE_PATH, "table");
    expect(calls.at(-1)).toEqual({ sql: `SHOW INDEXES IN TABLE ${QUALIFIED}`, tag: SNOWFLAKE_QUERY_TAGS.describe });
    expect(detail.indexes).toEqual([{ name: "BY_NOTE", columns: ["NOTE", "AT"], unique: true }]);
  });

  test("the LIKE wildcard's other match is never read as the table's row", async () => {
    // ORDERSX is hybrid, ORDERS is not.
    const { run, calls } = script("N");
    await describeObject(run, TABLE_PATH, "table");
    expect(calls.some((call) => call.sql.startsWith("SHOW INDEXES"))).toBe(false);
  });

  test("a view: its columns only", async () => {
    const { run, calls } = script("N");
    const detail = await describeObject(run, ["SALES", "PUBLIC", "V"], "view");
    expect(calls).toEqual([{ sql: 'SHOW COLUMNS IN VIEW "SALES"."PUBLIC"."V"', tag: SNOWFLAKE_QUERY_TAGS.describe }]);
    expect(detail.columns.every((entry) => !entry.isPrimary)).toBe(true);
  });

  test("a kind without columns answers none and sends nothing", async () => {
    const { run, calls } = fakeRunner([]);
    expect(await describeObject(run, ["SALES", "PUBLIC", "S"], "stream")).toEqual({
      path: ["SALES", "PUBLIC", "S"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(calls).toEqual([]);
  });

  test("an unknown kind is refused", async () => {
    const { run } = fakeRunner([]);
    await expect(describeObject(run, TABLE_PATH, "index")).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.unknownKind("index"),
    );
  });
});

/**
 * The 26 columns of the trial's EVERY_TYPE table (Snowflake 10.37.100, 2026-10-12): each column's `data_type` cell
 * exactly as SHOW COLUMNS answered it, and the type DESCRIBE TABLE answered for the same column, the catalog spelling.
 */
const CAPTURED_TYPES: readonly (readonly [string, string, string])[] = [
  ["ID", '{"type":"FIXED","precision":38,"scale":0,"nullable":false}', "NUMBER(38,0)"],
  ["N38", '{"type":"FIXED","precision":38,"scale":0,"nullable":true}', "NUMBER(38,0)"],
  ["N_SCALED", '{"type":"FIXED","precision":38,"scale":10,"nullable":true}', "NUMBER(38,10)"],
  ["I", '{"type":"FIXED","precision":38,"scale":0,"nullable":true}', "NUMBER(38,0)"],
  ["F", '{"type":"REAL","nullable":true}', "FLOAT"],
  ["DF", '{"type":"DECFLOAT","precision":38,"nullable":true}', "DECFLOAT(38)"],
  ["VC", '{"type":"TEXT","length":100,"byteLength":400,"nullable":true,"fixed":false}', "VARCHAR(100)"],
  ["CH", '{"type":"TEXT","length":3,"byteLength":12,"nullable":true,"fixed":false}', "VARCHAR(3)"],
  ["BIN", '{"type":"BINARY","length":8388608,"byteLength":8388608,"nullable":true,"fixed":true}', "BINARY(8388608)"],
  ["B", '{"type":"BOOLEAN","nullable":true}', "BOOLEAN"],
  ["D", '{"type":"DATE","nullable":true}', "DATE"],
  ["T", '{"type":"TIME","precision":0,"scale":9,"nullable":true}', "TIME(9)"],
  ["TS_NTZ", '{"type":"TIMESTAMP_NTZ","precision":0,"scale":9,"nullable":true}', "TIMESTAMP_NTZ(9)"],
  ["TS_LTZ", '{"type":"TIMESTAMP_LTZ","precision":0,"scale":9,"nullable":true}', "TIMESTAMP_LTZ(9)"],
  ["TS_TZ", '{"type":"TIMESTAMP_TZ","precision":0,"scale":9,"nullable":true}', "TIMESTAMP_TZ(9)"],
  ["V", '{"type":"VARIANT","nullable":true}', "VARIANT"],
  ["O", '{"type":"OBJECT","nullable":true}', "OBJECT"],
  ["A", '{"type":"ARRAY","nullable":true}', "ARRAY"],
  [
    "SO",
    '{"type":"OBJECT","nullable":true,"fields":[{"fieldName":"city","fieldType":{"type":"TEXT","length":16777216,"byteLength":67108864,"nullable":true,"fixed":false}},{"fieldName":"zip","fieldType":{"type":"FIXED","precision":38,"scale":0,"nullable":true}}]}',
    "OBJECT(city VARCHAR(16777216), zip NUMBER(38,0))",
  ],
  [
    "SA",
    '{"type":"ARRAY","nullable":true,"elementType":{"type":"FIXED","precision":38,"scale":0,"nullable":true}}',
    "ARRAY(NUMBER(38,0))",
  ],
  [
    "M",
    '{"type":"MAP","nullable":true,"keyType":{"type":"TEXT","length":16777216,"byteLength":67108864,"nullable":false,"fixed":false},"valueType":{"type":"FIXED","precision":38,"scale":0,"nullable":true}}',
    "MAP(VARCHAR(16777216), NUMBER(38,0))",
  ],
  ["GEOG", '{"type":"GEOGRAPHY","outputType":"OBJECT","nullable":true}', "GEOGRAPHY"],
  ["GEOM", '{"type":"GEOMETRY","outputType":"OBJECT","nullable":true}', "GEOMETRY"],
  ["U", '{"type":"UUID","nullable":true}', "UUID"],
  [
    "VEC",
    '{"type":"VECTOR","nullable":true,"vectorElementType":{"type":"REAL","nullable":false},"dimension":3}',
    "VECTOR(FLOAT, 3)",
  ],
  ["FL", '{"type":"FILE","outputType":"OBJECT","nullable":true}', "FILE"],
];

describe("a column's type in catalog spelling, built from SHOW COLUMNS' data_type", () => {
  test("every captured data_type reads as DESCRIBE TABLE spells it, column by column", async () => {
    const rows = CAPTURED_TYPES.map(([name, dataType]) => ["EVERY_TYPE", "PROBE", name, dataType, "true"]);
    const { run } = fakeRunner([[/^SHOW COLUMNS IN /, () => showResult(COLUMN_COLUMNS, rows)]]);
    const detail = await describeObject(run, ["STUDIO_DEMO", "PROBE", "EVERY_TYPE"], "view");
    expect(detail.columns.map((entry) => [entry.name, entry.type])).toEqual(
      CAPTURED_TYPES.map(([name, , spelled]) => [name, spelled]),
    );
  });

  test("a type whose parameters are absent or unreadable is spelled by its name alone", async () => {
    const shapes: readonly (readonly [object, string])[] = [
      [{ type: "FIXED" }, "NUMBER"],
      [{ type: "FIXED", precision: 10 }, "NUMBER"],
      [{ type: "REAL" }, "FLOAT"],
      [{ type: "DECFLOAT" }, "DECFLOAT"],
      [{ type: "TEXT" }, "VARCHAR"],
      [{ type: "BINARY" }, "BINARY"],
      [{ type: "TIME" }, "TIME"],
      [{ type: "TIMESTAMP_TZ" }, "TIMESTAMP_TZ"],
      [{ type: "OBJECT", fields: [] }, "OBJECT"],
      [{ type: "OBJECT", fields: [{ fieldName: "a" }] }, "OBJECT"],
      [{ type: "OBJECT", fields: [{ fieldName: 1, fieldType: { type: "DATE" } }] }, "OBJECT"],
      [{ type: "OBJECT", fields: "x" }, "OBJECT"],
      [{ type: "ARRAY", elementType: "x" }, "ARRAY"],
      [{ type: "ARRAY", elementType: {} }, "ARRAY"],
      [{ type: "MAP", keyType: { type: "TEXT" } }, "MAP"],
      [{ type: "VECTOR", vectorElementType: { type: "FIXED", precision: 38, scale: 0 } }, "VECTOR"],
      [{ type: "VECTOR", dimension: 3 }, "VECTOR"],
      [{ type: "GEOGRAPHY", outputType: "OBJECT" }, "GEOGRAPHY"],
      [{}, ""],
    ];
    const rows = shapes.map(([dataType], index) => ["T", "PUBLIC", `C${index}`, JSON.stringify(dataType), "true"]);
    const { run } = fakeRunner([[/^SHOW COLUMNS IN /, () => showResult(COLUMN_COLUMNS, rows)]]);
    const detail = await describeObject(run, ["SALES", "PUBLIC", "T"], "view");
    expect(detail.columns.map((entry) => entry.type)).toEqual(shapes.map(([, spelled]) => spelled));
  });
});

function mapMemo(): SchemaColumnsMemo & { readonly entries: Map<string, SnowflakeResult> } {
  const entries = new Map<string, SnowflakeResult>();
  return { entries, get: (key) => entries.get(key), set: (key, result) => void entries.set(key, result) };
}

describe("describeObjects", () => {
  const schemaColumns = (rows: string[][]) => () => showResult(COLUMN_COLUMNS, rows);
  const id = (table: string) => column(table, "ID", { type: "FIXED", precision: 38, scale: 0, nullable: false });

  test("a kind other than table and view answers no details and sends nothing", async () => {
    const { run, calls } = fakeRunner([]);
    for (const kind of SNOWFLAKE_KIND_IDS.filter((entry) => entry !== "table" && entry !== "view")) {
      // oxlint-disable-next-line no-await-in-loop -- one kind at a time keeps the recorded order.
      expect(await describeObjects(run, SCHEMA, kind, undefined, mapMemo())).toEqual({ details: [] });
    }
    expect(calls).toEqual([]);
  });

  test("names from the listing, columns from one SHOW COLUMNS IN SCHEMA, tagged inventory", async () => {
    const { run, calls } = fakeRunner([
      [/^SHOW TABLES /, tables("A", "B")],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([id("A"), id("B"), id("V")])],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", undefined, mapMemo());
    expect(calls).toEqual([
      { sql: `SHOW TABLES ${IN_SCHEMA} LIMIT 10000`, tag: SNOWFLAKE_QUERY_TAGS.inventory },
      { sql: `SHOW COLUMNS ${IN_SCHEMA}`, tag: SNOWFLAKE_QUERY_TAGS.inventory },
    ]);
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["SALES", "PUBLIC", "A"],
      ["SALES", "PUBLIC", "B"],
    ]);
    expect(batch.details[0].columns).toEqual([{ name: "ID", type: "NUMBER(38,0)", nullable: false, isPrimary: false }]);
    expect(batch.truncated).toBeUndefined();
  });

  test("the memo shares one SHOW COLUMNS IN SCHEMA between table and view", async () => {
    const { run, calls } = fakeRunner([
      [/^SHOW TABLES /, tables("A")],
      [/^SHOW VIEWS /, tables("V")],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([id("A"), id("V")])],
    ]);
    const memo = mapMemo();
    const tableBatch = await describeObjects(run, SCHEMA, "table", undefined, memo);
    const viewBatch = await describeObjects(run, SCHEMA, "view", undefined, memo);
    expect(calls.filter((call) => call.sql.startsWith("SHOW COLUMNS"))).toHaveLength(1);
    expect(tableBatch.details.map((detail) => detail.path.at(-1))).toEqual(["A"]);
    expect(viewBatch.details.map((detail) => detail.path.at(-1))).toEqual(["V"]);
  });

  test("a caller's limit bounds the objects and says so in the shared sentence", async () => {
    const { run } = fakeRunner([
      [/^SHOW TABLES /, tables("A", "B", "C")],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([id("A"), id("B"), id("C")])],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", 2, mapMemo());
    expect(batch.details).toHaveLength(2);
    expect(batch.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
  });

  test("with no caller limit the inventory bound applies", async () => {
    const { run } = fakeRunner([
      [/^SHOW TABLES /, () => showResult(["name"], namedRows("T", 1, 5_001))],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([])],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", undefined, mapMemo());
    expect(batch.truncated?.reason).toContain(INVENTORY_TRUNCATION_REASON);
  });

  test("a bad limit is refused before anything is sent", async () => {
    const { run, calls } = fakeRunner([]);
    await expect(describeObjects(run, SCHEMA, "table", 0, mapMemo())).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.badLimit(0),
    );
    expect(calls).toEqual([]);
  });

  test("a listed object with no column rows is left out by name", async () => {
    const { run } = fakeRunner([
      [/^SHOW VIEWS /, tables("BROKEN", "OK")],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([id("OK")])],
    ]);
    const batch = await describeObjects(run, SCHEMA, "view", undefined, mapMemo());
    expect(batch.details.map((detail) => detail.path.at(-1))).toEqual(["OK"]);
    expect(batch.truncated).toEqual({ limit: 1, reason: SNOWFLAKE_INTROSPECT_SENTENCES.noColumns(["BROKEN"]) });
  });

  test("exactly 10,000 column rows falls back to one SHOW COLUMNS per listed table", async () => {
    const full = Array.from({ length: 10_000 }, (_, index) => id(`X${index}`));
    const { run, calls } = fakeRunner([
      [/^SHOW TABLES /, tables("A", "B")],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns(full)],
      [/^SHOW COLUMNS IN TABLE "SALES"."PUBLIC"."A"$/, schemaColumns([id("A")])],
      [/^SHOW COLUMNS IN TABLE "SALES"."PUBLIC"."B"$/, schemaColumns([id("B")])],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", undefined, mapMemo());
    expect(calls.slice(2)).toEqual([
      { sql: `SHOW COLUMNS IN TABLE "SALES"."PUBLIC"."A"`, tag: SNOWFLAKE_QUERY_TAGS.inventory },
      { sql: `SHOW COLUMNS IN TABLE "SALES"."PUBLIC"."B"`, tag: SNOWFLAKE_QUERY_TAGS.inventory },
    ]);
    expect(batch.details.map((detail) => detail.path.at(-1))).toEqual(["A", "B"]);
    expect(batch.truncated).toBeUndefined();
  });

  test("the per-table fallback stops at the pair limit and names Studio's bound", async () => {
    const full = Array.from({ length: 10_000 }, (_, index) => id(`X${index}`));
    const { run, calls } = fakeRunner([
      [/^SHOW TABLES /, () => showResult(["name"], namedRows("T", 1, INVENTORY_PAIR_LIMIT + 1))],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns(full)],
      [/^SHOW COLUMNS IN TABLE /, (sql) => schemaColumns([id(/"([^"]+)"$/.exec(sql)?.[1] ?? "")])()],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", undefined, mapMemo());
    expect(calls.filter((call) => call.sql.startsWith("SHOW COLUMNS IN TABLE"))).toHaveLength(INVENTORY_PAIR_LIMIT);
    expect(batch.details).toHaveLength(INVENTORY_PAIR_LIMIT);
    expect(batch.truncated).toEqual({ limit: INVENTORY_PAIR_LIMIT, reason: SNOWFLAKE_INTROSPECT_SENTENCES.pairCap });
    expect(SNOWFLAKE_INTROSPECT_SENTENCES.pairCap).toBe(
      "Snowflake answered a full 10,000-row column listing for this schema, so Studio read the columns of the first 1,000 objects one at a time",
    );
  });

  test("a caller limit above the pair limit keeps the caller-bound sentence beside the pair limit's", async () => {
    const full = Array.from({ length: 10_000 }, (_, index) => id(`X${index}`));
    const limit = INVENTORY_PAIR_LIMIT + 500;
    const { run } = fakeRunner([
      [/^SHOW TABLES /, () => showResult(["name"], namedRows("T", 1, limit + 100))],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns(full)],
      [/^SHOW COLUMNS IN TABLE /, (sql) => schemaColumns([id(/"([^"]+)"$/.exec(sql)?.[1] ?? "")])()],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", limit, mapMemo());
    expect(batch.details).toHaveLength(INVENTORY_PAIR_LIMIT);
    expect(batch.truncated?.limit).toBe(INVENTORY_PAIR_LIMIT);
    expect(batch.truncated?.reason).toContain(callerBoundTruncationReason(limit));
    expect(batch.truncated?.reason).toContain(SNOWFLAKE_INTROSPECT_SENTENCES.pairCap);
  });

  test("a listing stopped at the tree cap is reported", async () => {
    const answer = (sql: string) => {
      const cursor = /FROM '([^']*)'$/.exec(sql)?.[1];
      const start = cursor === undefined ? 1 : Number(cursor.slice(1)) + 1;
      return showResult(["name"], namedRows("T", start, SNOWFLAKE_SHOW_PAGE_ROWS));
    };
    const { run } = fakeRunner([
      [/^SHOW TABLES /, answer],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([id("T00001")])],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", 60_000, mapMemo());
    expect(batch.truncated?.reason).toContain(SNOWFLAKE_INTROSPECT_SENTENCES.treeCap);
  });

  for (const inclusive of [false, true]) {
    for (const total of [SNOWFLAKE_SHOW_PAGE_ROWS, 2 * SNOWFLAKE_SHOW_PAGE_ROWS]) {
      test(`a listing of exactly ${total.toLocaleString("en-US")} is whole when FROM is ${inclusive ? "inclusive" : "exclusive"}`, async () => {
        const answer = (sql: string) => {
          const cursor = /FROM '([^']*)'$/.exec(sql)?.[1];
          const start = cursor === undefined ? 1 : Number(cursor.slice(1)) + (inclusive ? 0 : 1);
          const count = Math.max(0, Math.min(SNOWFLAKE_SHOW_PAGE_ROWS, total - start + 1));
          return showResult(["name"], namedRows("T", start, count));
        };
        const { run } = fakeRunner([
          [/^SHOW TABLES /, answer],
          [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([id("T00001")])],
        ]);
        const batch = await describeObjects(run, SCHEMA, "table", 60_000, mapMemo());
        expect(batch.truncated?.reason).not.toContain(SNOWFLAKE_INTROSPECT_SENTENCES.stalled);
        expect(batch.truncated?.reason).not.toContain(SNOWFLAKE_INTROSPECT_SENTENCES.treeCap);
        const objects = await listObjects(fakeRunner([[/^SHOW TABLES /, answer]]).run, SCHEMA, "table");
        expect(objects).toHaveLength(total);
        expect(new Set(names(objects)).size).toBe(total);
      });
    }
  }

  test("a page past the cursor holding a row that does not move it is still the stalled sentence", async () => {
    const answer = (sql: string) =>
      /FROM '/.test(sql)
        ? showResult(["name"], [["T10000"], ["T00002"]])
        : showResult(["name"], namedRows("T", 1, SNOWFLAKE_SHOW_PAGE_ROWS));
    const { run } = fakeRunner([
      [/^SHOW TABLES /, answer],
      [/^SHOW COLUMNS IN SCHEMA /, schemaColumns([id("T00001")])],
    ]);
    const batch = await describeObjects(run, SCHEMA, "table", 60_000, mapMemo());
    expect(batch.truncated?.reason).toContain(SNOWFLAKE_INTROSPECT_SENTENCES.stalled);
  });
});

describe("readObjectSource", () => {
  const views =
    (...rows: (string | null)[][]) =>
    () =>
      showResult(["name", "is_secure", "text"], rows);

  test("a view's text from SHOW VIEWS LIKE, picked by its exact name", async () => {
    const { run, calls } = fakeRunner([
      [
        /^SHOW VIEWS LIKE /,
        views(["AXB", "false", "CREATE VIEW AXB AS SELECT 2"], ["A_B", "false", "CREATE VIEW A_B AS SELECT 1"]),
      ],
    ]);
    const document = await readObjectSource(run, ["SALES", "PUBLIC", "A_B"], "view");
    expect(calls).toEqual([{ sql: `SHOW VIEWS LIKE 'A_B' ${IN_SCHEMA}`, tag: SNOWFLAKE_QUERY_TAGS.source }]);
    expect(document).toEqual({
      path: ["SALES", "PUBLIC", "A_B"],
      kind: "view",
      parts: [
        {
          id: "definition",
          label: "Definition",
          text: "CREATE VIEW A_B AS SELECT 1",
          language: "sql",
          form: "complete",
          origin: "stored",
        },
      ],
    });
  });

  test("a secure view the role does not own is the sentence, not an empty text", async () => {
    const { run } = fakeRunner([[/^SHOW VIEWS LIKE /, views(["S", "true", ""])]]);
    const document = await readObjectSource(run, ["SALES", "PUBLIC", "S"], "view");
    expect(document.parts).toEqual([
      { id: "definition", label: "Definition", unavailable: SNOWFLAKE_INTROSPECT_SENTENCES.secureView },
    ]);
  });

  test("a view Snowflake does not show is refused by name", async () => {
    const { run } = fakeRunner([[/^SHOW VIEWS LIKE /, views(["AXB", "false", "x"])]]);
    await expect(readObjectSource(run, ["SALES", "PUBLIC", "A_B"], "view")).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.notShown("A_B"),
    );
  });

  test("a routine segment whose closing parenthesis opens no group is quoted whole", async () => {
    const { run, calls } = fakeRunner([[/^SELECT GET_DDL/, () => showResult(["GET_DDL"], [["CREATE FUNCTION ..."]])]]);
    await readObjectSource(run, ["SALES", "PUBLIC", "F)"], "function");
    expect(calls.map((call) => call.sql)).toEqual([`SELECT GET_DDL('FUNCTION', '"SALES"."PUBLIC"."F)"')`]);
  });

  test("a function's GET_DDL names its argument types", async () => {
    const { run, calls } = fakeRunner([
      [/^SELECT GET_DDL/, () => showResult(["GET_DDL"], [["CREATE FUNCTION F ..."]])],
    ]);
    const document = await readObjectSource(run, ["SALES", "PUBLIC", "F(NUMBER, VARCHAR)"], "function");
    expect(calls).toEqual([
      {
        sql: `SELECT GET_DDL('FUNCTION', '"SALES"."PUBLIC"."F"(NUMBER, VARCHAR)')`,
        tag: SNOWFLAKE_QUERY_TAGS.source,
      },
    ]);
    expect(document.parts[0]).toEqual({
      id: "definition",
      label: "Definition",
      text: "CREATE FUNCTION F ...",
      language: "sql",
      form: "complete",
      origin: "regenerated",
    });
  });

  test("each other kind's GET_DDL type, and a quote in a name doubled", async () => {
    const expected: Record<string, string> = {
      table: "TABLE",
      stream: "STREAM",
      task: "TASK",
      sequence: "SEQUENCE",
      "file-format": "FILE_FORMAT",
      pipe: "PIPE",
      procedure: "PROCEDURE",
    };
    for (const [kind, type] of Object.entries(expected)) {
      const name = kind === "procedure" ? "P(FLOAT)" : "it's";
      const { run, calls } = fakeRunner([[/^SELECT GET_DDL/, () => showResult(["X"], [["DDL"]])]]);
      // oxlint-disable-next-line no-await-in-loop -- one kind at a time keeps the recorded order.
      await readObjectSource(run, ["SALES", "PUBLIC", name], kind);
      const object = kind === "procedure" ? '"P"(FLOAT)' : "\"it''s\"";
      expect(calls[0].sql).toBe(`SELECT GET_DDL('${type}', '"SALES"."PUBLIC".${object}')`);
    }
  });

  test("a caller's bound marks the part truncated", async () => {
    const { run } = fakeRunner([[/^SELECT GET_DDL/, () => showResult(["X"], [["CREATE TABLE T (A INT)"]])]]);
    const document = await readObjectSource(run, ["SALES", "PUBLIC", "T"], "table", 6);
    const [part] = document.parts;
    expect("text" in part && part.text).toBe("CREATE");
    expect("truncated" in part && part.truncated?.limit).toBe(6);
  });

  test("an empty definition is refused by name", async () => {
    const { run } = fakeRunner([[/^SELECT GET_DDL/, () => showResult(["X"], [[""]])]]);
    await expect(readObjectSource(run, ["SALES", "PUBLIC", "T"], "table")).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.noDefinition("T"),
    );
  });

  test("a stage declares no source, and nothing is sent", async () => {
    const { run, calls } = fakeRunner([]);
    await expect(readObjectSource(run, ["SALES", "PUBLIC", "ST"], "stage")).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.noSource("stage"),
    );
    expect(calls).toEqual([]);
  });
});

describe("getHealth", () => {
  test("sends the connect statement, tagged health, and claims no connection count", async () => {
    const { run, calls } = fakeRunner([
      [/^SHOW WAREHOUSES /, warehouses(["WH", "SUSPENDED", "X-Small", "0", "0", "true"])],
    ]);
    const health = await getHealth(run, "wh");
    expect(calls).toEqual([{ sql: "SHOW WAREHOUSES LIKE 'wh'", tag: SNOWFLAKE_QUERY_TAGS.health }]);
    expect(health).toEqual({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
    expect("activeConnections" in health).toBe(false);
  });

  test("with Warehouse empty it sends SHOW DATABASES LIMIT 1", async () => {
    const { run, calls } = fakeRunner([[/^SHOW DATABASES /, () => showResult(["name"], [["SALES"]])]]);
    await getHealth(run, undefined);
    expect(calls).toEqual([{ sql: "SHOW DATABASES LIMIT 1", tag: SNOWFLAKE_QUERY_TAGS.health }]);
  });
});

describe("every describe, inventory and health statement is a SHOW (SR18)", () => {
  test("only a non-view's source sends the one SELECT", async () => {
    const { run, calls } = fakeRunner([
      [/^SHOW WAREHOUSES /, warehouses(["WH", "STARTED", "X-Small", "0", "0", "true"])],
      [/^SHOW COLUMNS IN /, () => showResult(COLUMN_COLUMNS, ORDER_COLUMNS)],
      [/^SHOW PRIMARY KEYS /, () => showResult(["column_name"], [])],
      [/^SHOW TABLES LIKE /, () => showResult(["name", "is_hybrid"], [["ORDERS", "Y"]])],
      [/^SHOW INDEXES /, () => showResult(["name", "is_unique", "columns"], [])],
      [
        /^SHOW VIEWS LIKE /,
        () => showResult(["name", "is_secure", "text"], [["V", "false", "CREATE VIEW V AS SELECT 1"]]),
      ],
      [/^SHOW (TABLES|VIEWS) /, tables("ORDERS")],
      [/^SELECT GET_DDL/, () => showResult(["X"], [["DDL"]])],
    ]);
    await getHealth(run, "WH");
    await describeObject(run, TABLE_PATH, "table");
    await describeObject(run, TABLE_PATH, "view");
    const memo = mapMemo();
    await describeObjects(run, SCHEMA, "table", undefined, memo);
    await describeObjects(run, SCHEMA, "view", undefined, memo);
    await readObjectSource(run, ["SALES", "PUBLIC", "V"], "view");
    onlyShow(calls);
    await readObjectSource(run, TABLE_PATH, "table");
    expect(calls.filter((call) => !/^SHOW /.test(call.sql)).map((call) => call.sql)).toEqual([
      `SELECT GET_DDL('TABLE', '${QUALIFIED}')`,
    ]);
  });
});

function tables(...names: string[]) {
  return () =>
    showResult(
      ["name"],
      names.map((name) => [name]),
    );
}
