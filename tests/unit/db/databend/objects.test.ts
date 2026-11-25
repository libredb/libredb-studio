import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import { secretForms, serverText } from "@/lib/db/utils/server-text";
import {
  DATABEND_OBJECT_SENTENCES,
  DATABEND_SURFACE_ROW_CUT,
  DATABEND_VERSION_SQL,
  countObjects,
  describeObject,
  describeObjects,
  type DatabendStatementRunner,
  listCatalogs,
  listDatabases,
  listObjects,
  readNoPasswordCaution,
  readObjectSource,
} from "@/lib/db/providers/sql/databend/objects";
import {
  DatabendError,
  type DatabendTruncation,
  type StatementOutcome,
} from "@/lib/db/providers/sql/databend/transport";
import { TEST_PASSWORD } from "../../../helpers/databend-node-transport";

/** The en dash and the em dash, built from their code points so this file holds neither. */
const DASHES = new RegExp("[\\u2013\\u2014]");

// Names holding a backtick, a quote and a backslash, and their exact quoted forms: a backtick
// identifier doubles the backtick and keeps the backslash, a literal doubles the quote and the
// backslash (design 5.1).
const CATALOG = "c`a'\\t";
const DATABASE = "d`b'\\y";
const OBJECT = "o`'\\z";
const C = "`c``a'\\t`";
const c = "'c`a''\\\\t'";
const D = "`d``b'\\y`";
const d = "'d`b''\\\\y'";
const O = "`o``'\\z`";
const o = "'o`''\\\\z'";
const CONTAINER = { catalog: CATALOG, database: DATABASE };

function outcome(
  columns: readonly (readonly [string, string])[],
  rows: readonly (readonly (string | null)[])[],
  truncated: DatabendTruncation | null = null,
): StatementOutcome {
  return {
    schema: columns.map(([name, type]) => ({ name, type })),
    rows,
    truncated,
    notices: [],
    hasResultSet: true,
    affect: null,
  };
}

/** A runner answering the given outcomes in order, recording every statement and row cut it was handed. */
function scripted(...answers: (StatementOutcome | Error)[]) {
  const calls: { sql: string; rowCut: number }[] = [];
  const runner: DatabendStatementRunner = async (sql, rowCut) => {
    calls.push({ sql, rowCut });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next as StatementOutcome;
  };
  return { runner, calls };
}

const COLUMN_SCHEMA = [
  ["column_name", "String"],
  ["data_type", "String"],
  ["is_nullable", "String"],
  ["default_kind", "String"],
  ["default_expression", "String"],
  ["comment", "String"],
] as const;

const BULK_SCHEMA = [
  ["object_name", "String"],
  ["column_name", "String"],
  ["data_type", "String"],
  ["is_nullable", "String"],
  ["default_kind", "String"],
  ["default_expression", "String"],
] as const;

describe("the quoted forms the statements are built from", () => {
  test("the identifier doubles the backtick and keeps the backslash; the literal doubles the quote and the backslash", () => {
    expect(C).toBe("`c``a'\\t`");
    expect(c).toBe("'c`a''\\\\t'");
    expect([...C].filter((ch) => ch === "\\")).toHaveLength(1);
    expect([...c].filter((ch) => ch === "\\")).toHaveLength(2);
  });
});

/** Each object kind and its `system.tables.table_type` spelling, in the order the count lists them. */
const SPELLINGS: Readonly<Record<string, string>> = {
  table: "BASE TABLE",
  view: "VIEW",
  materialized_view: "MATERIALIZED VIEW",
  dynamic_table: "DYNAMIC TABLE",
};
/** The one part id a definition document holds. */
const SOURCE_PART_ID = "definition";

/** The design 5.4 statements, written out for the names above; the tests below hold each surface to them. */
const TABLES = `FROM ${C}.system.tables WHERE catalog = ${c} AND database = ${d}`;
const INTERNAL = " AND name <> '_mv_source_row_id'";
const SQL = {
  catalogs: "SELECT name AS catalog_name FROM system.catalogs ORDER BY name",
  databases: `SELECT name AS database_name FROM ${C}.system.databases WHERE catalog = ${c} AND name NOT IN ('system', 'information_schema') ORDER BY name`,
  counts:
    "SELECT kind, count(*) AS object_count FROM (SELECT CASE table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' WHEN 'MATERIALIZED VIEW' THEN 'materialized_view' WHEN 'DYNAMIC TABLE' THEN 'dynamic_table' ELSE concat('unknown:', table_type) END AS kind " +
    `${TABLES}) AS objects GROUP BY kind`,
  objects: (kind: string) =>
    `SELECT name AS object_name, num_rows, data_compressed_size, comment ${TABLES} AND table_type = '${SPELLINGS[kind]}' ORDER BY name`,
  columns: (catalog: string, internal = "") =>
    `SELECT name AS column_name, data_type, is_nullable, default_kind, default_expression, comment FROM ${catalog}.system.columns WHERE database = ${d} AND \`table\` = ${o}${internal}`,
  indexes: `SELECT name AS index_name, \`type\` AS index_type, definition FROM default.system.indexes WHERE database = ${d} AND \`table\` = ${o} ORDER BY name`,
  names: (kind: string, bound?: number) =>
    `SELECT name AS object_name ${TABLES} AND table_type = '${SPELLINGS[kind]}' ORDER BY name${bound === undefined ? "" : ` LIMIT ${bound}`}`,
  bulk: (kind: string, bound?: number, internal = "") =>
    `SELECT \`table\` AS object_name, name AS column_name, data_type, is_nullable, default_kind, default_expression FROM ${C}.system.columns WHERE database = ${d}${internal} AND \`table\` IN (SELECT name ${TABLES} AND table_type = '${SPELLINGS[kind]}'${bound === undefined ? "" : ` ORDER BY name LIMIT ${bound}`})`,
};

/** The statements a read sends before its runner refuses the one after `answers`, whether or not the read fails. */
async function statementsOf(
  read: (runner: DatabendStatementRunner) => Promise<unknown>,
  ...answers: StatementOutcome[]
): Promise<string[]> {
  const { runner, calls } = scripted(...answers, new Error("no answer scripted"));
  await read(runner).catch(() => undefined);
  return calls.map((call) => call.sql);
}

describe("the design 5.4 statements, exactly, as each surface sends them", () => {
  test("the connect probe", () => {
    expect(DATABEND_VERSION_SQL).toBe("SELECT version() AS server_version");
  });

  test("the no_password caution read [X12]", async () => {
    expect(await statementsOf((runner) => readNoPasswordCaution(runner, "u`'\\"))).toEqual([
      "SELECT auth_type FROM default.system.users WHERE name = 'u`''\\\\'",
    ]);
  });

  test("listContainers at the top and under a catalog", async () => {
    expect(await statementsOf(listCatalogs)).toEqual([SQL.catalogs]);
    expect(await statementsOf((runner) => listDatabases(runner, CATALOG))).toEqual([SQL.databases]);
  });

  test("countObjects: one statement, the four spellings and an ELSE that keeps the unknown one", async () => {
    expect(await statementsOf((runner) => countObjects(runner, CONTAINER, []))).toEqual([SQL.counts]);
  });

  test("listObjects for each kind's table_type spelling", async () => {
    const kinds = Object.keys(SPELLINGS);
    const sent = await Promise.all(kinds.map((kind) => statementsOf((runner) => listObjects(runner, CONTAINER, kind))));
    expect(sent).toEqual(kinds.map((kind) => [SQL.objects(kind)]));
  });

  test("an undeclared kind is refused by name, with nothing sent", async () => {
    const { runner, calls } = scripted();
    await expect(listObjects(runner, CONTAINER, "stream")).rejects.toThrow(
      DATABEND_OBJECT_SENTENCES.unknownKind("stream"),
    );
    expect(calls).toEqual([]);
  });

  test("describeObject: the columns, and the indexes of the default catalog", async () => {
    expect(await statementsOf((runner) => describeObject(runner, CONTAINER, "table", OBJECT))).toEqual([
      SQL.columns(C),
    ]);
    const defaults = { catalog: "default", database: DATABASE };
    expect(
      await statementsOf(
        (runner) => describeObject(runner, defaults, "table", OBJECT),
        outcome(COLUMN_SCHEMA, [["id", "INT", "NO", "", "", ""]]),
      ),
    ).toEqual([SQL.columns("`default`"), SQL.indexes]);
  });

  test("describeObjects keeps the one-statement form L1 and L2 passed [X19], after the names it must describe", async () => {
    const view = outcome([["object_name", "String"]], [["v"]]);
    expect(await statementsOf((runner) => describeObjects(runner, CONTAINER, "view"), view)).toEqual([
      SQL.names("view"),
      SQL.bulk("view"),
    ]);
    expect(await statementsOf((runner) => describeObjects(runner, CONTAINER, "view", 5), view)).toEqual([
      SQL.names("view", 6),
      SQL.bulk("view", 6),
    ]);
  });

  test("a materialized view's internal _mv_source_row_id column is not described; a table's column of that name is", async () => {
    const one = outcome([["object_name", "String"]], [["m"]]);
    expect(await statementsOf((runner) => describeObject(runner, CONTAINER, "materialized_view", OBJECT))).toEqual([
      SQL.columns(C, INTERNAL),
    ]);
    expect(await statementsOf((runner) => describeObjects(runner, CONTAINER, "materialized_view", 2), one)).toEqual([
      SQL.names("materialized_view", 3),
      SQL.bulk("materialized_view", 3, INTERNAL),
    ]);
    expect(SQL.columns(C)).not.toContain(INTERNAL);
    expect(SQL.bulk("table")).not.toContain(INTERNAL);
  });

  test("readObjectSource: SHOW CREATE TABLE WITH QUOTED_IDENTIFIERS, and SHOW CREATE MATERIALIZED VIEW (L6)", async () => {
    const kinds = ["table", "view", "dynamic_table"];
    const sent = await Promise.all(
      kinds.map((kind) => statementsOf((runner) => readObjectSource(runner, CONTAINER, kind, OBJECT, []))),
    );
    expect(sent).toEqual(kinds.map(() => [`SHOW CREATE TABLE ${C}.${D}.${O} WITH QUOTED_IDENTIFIERS`]));
    expect(
      await statementsOf((runner) => readObjectSource(runner, CONTAINER, "materialized_view", OBJECT, [])),
    ).toEqual([`SHOW CREATE MATERIALIZED VIEW ${C}.${D}.${O}`]);
  });

  test("readObjectSource refuses an undeclared kind by name, with nothing sent", async () => {
    const { runner, calls } = scripted();
    await expect(readObjectSource(runner, CONTAINER, "stream", OBJECT, [])).rejects.toThrow(
      DATABEND_OBJECT_SENTENCES.unknownKind("stream"),
    );
    expect(calls).toEqual([]);
  });
});

describe("the no_password caution [X12]", () => {
  test("a no_password user gets the caution sentence", async () => {
    const { runner, calls } = scripted(outcome([["auth_type", "String"]], [["no_password"]]));
    expect(await readNoPasswordCaution(runner, "np")).toBe(DATABEND_OBJECT_SENTENCES.noPassword("np"));
    expect(calls).toEqual([
      { sql: "SELECT auth_type FROM default.system.users WHERE name = 'np'", rowCut: DATABEND_SURFACE_ROW_CUT },
    ]);
  });

  test("a password user, a missing row and a failed read are all no caution", async () => {
    const withPassword = scripted(outcome([["auth_type", "String"]], [["double_sha1_password"]]));
    expect(await readNoPasswordCaution(withPassword.runner, "u")).toBeNull();
    const noRow = scripted(outcome([["auth_type", "String"]], []));
    expect(await readNoPasswordCaution(noRow.runner, "u")).toBeNull();
    const failed = scripted(new DatabendError("statement", "denied", { code: 1063 }));
    expect(await readNoPasswordCaution(failed.runner, "u")).toBeNull();
  });
});

describe("containers", () => {
  test("catalogs are level 0 and `default` is the session default", async () => {
    const { runner, calls } = scripted(outcome([["catalog_name", "String"]], [["default"], ["iceberg"]]));
    expect(await listCatalogs(runner)).toEqual([
      { path: ["default"], name: "default", level: 0, isSessionDefault: true },
      { path: ["iceberg"], name: "iceberg", level: 0, isSessionDefault: false },
    ]);
    expect(calls[0].sql).toBe(SQL.catalogs);
  });

  test("databases are level 1 under their catalog, and the connection's database is the session default", async () => {
    const { runner, calls } = scripted(outcome([["database_name", "String"]], [["a"], ["b"]]));
    expect(await listDatabases(runner, CATALOG, "b")).toEqual([
      { path: [CATALOG, "a"], name: "a", level: 1, isSessionDefault: false },
      { path: [CATALOG, "b"], name: "b", level: 1, isSessionDefault: true },
    ]);
    expect(calls[0].sql).toBe(SQL.databases);
  });

  test("a cut container list is refused, never handed over as complete", async () => {
    const cut = { bound: "rows", limit: 100_000 } as const;
    const { runner } = scripted(outcome([["database_name", "String"]], [["a"]], cut));
    await expect(listDatabases(runner, CATALOG)).rejects.toThrow(
      DATABEND_OBJECT_SENTENCES.incomplete("database list", cut),
    );
  });
});

describe("countObjects", () => {
  test("every declared kind is counted, zero where the engine answered none", async () => {
    const { runner, calls } = scripted(
      outcome(
        [
          ["kind", "String"],
          ["object_count", "UInt64"],
        ],
        [
          ["table", "2"],
          ["materialized_view", "1"],
        ],
      ),
    );
    expect(await countObjects(runner, CONTAINER, [])).toEqual({
      table: { count: 2 },
      view: { count: 0 },
      materialized_view: { count: 1 },
      dynamic_table: { count: 0 },
    });
    expect(calls[0].sql).toBe(SQL.counts);
  });

  test("an unknown table_type is raised by name, never dropped", async () => {
    const { runner } = scripted(
      outcome(
        [
          ["kind", "String"],
          ["object_count", "UInt64"],
        ],
        [["unknown:STREAM TABLE", "1"]],
      ),
    );
    const failure = await countObjects(runner, CONTAINER, []).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as QueryError).message).toBe(DATABEND_OBJECT_SENTENCES.unknownTableType("STREAM TABLE"));
  });

  test("an unknown table_type passes serverText with the connection's forms and the refusal's cut (HASIM-D-5)", async () => {
    const password = TEST_PASSWORD;
    const forms = secretForms([password, `reader:${password}`]);
    const unknown = async (spelling: string) => {
      const { runner } = scripted(
        outcome(
          [
            ["kind", "String"],
            ["object_count", "UInt64"],
          ],
          [[`unknown:${spelling}`, "1"]],
        ),
      );
      return ((await countObjects(runner, CONTAINER, forms).catch((error: unknown) => error)) as QueryError).message;
    };
    expect(await unknown(`x ${password}`)).toBe(
      DATABEND_OBJECT_SENTENCES.unknownTableType(serverText(password, forms)),
    );
    expect(await unknown("T".repeat(400))).toBe(DATABEND_OBJECT_SENTENCES.unknownTableType(`${"T".repeat(300)}...`));
  });
});

describe("listObjects", () => {
  const LIST_SCHEMA = [
    ["object_name", "String"],
    ["num_rows", "Nullable(UInt64)"],
    ["data_compressed_size", "Nullable(UInt64)"],
    ["comment", "String"],
  ] as const;

  test("each row is an object under the container, with counts where the engine has them", async () => {
    const { runner, calls } = scripted(
      outcome(LIST_SCHEMA, [
        ["every_type", "4", "6127", ""],
        [OBJECT, null, null, "a view"],
      ]),
    );
    expect(await listObjects(runner, CONTAINER, "view")).toEqual([
      { path: [CATALOG, DATABASE, "every_type"], name: "every_type", kind: "view", rowCount: 4, sizeBytes: 6127 },
      { path: [CATALOG, DATABASE, OBJECT], name: OBJECT, kind: "view" },
    ]);
    expect(calls).toEqual([{ sql: SQL.objects("view"), rowCut: DATABEND_SURFACE_ROW_CUT }]);
  });

  test("a NULL num_rows is undefined, not zero", async () => {
    const { runner } = scripted(outcome(LIST_SCHEMA, [["v", null, "10", ""]]));
    const [listed] = await listObjects(runner, CONTAINER, "view");
    expect(listed.rowCount).toBeUndefined();
    expect("rowCount" in listed).toBe(false);
    expect(listed.sizeBytes).toBe(10);
  });

  // Measured on the pinned image: `every_type_mv` holds 4 rows, and its system.tables row says 0 rows and 0 bytes.
  test("a materialized view is listed with no row count or size, which system.tables reports as 0 for one", async () => {
    const { runner } = scripted(outcome(LIST_SCHEMA, [["every_type_mv", "0", "0", ""]]));
    const [listed] = await listObjects(runner, CONTAINER, "materialized_view");
    expect(listed).toEqual({
      path: [CATALOG, DATABASE, "every_type_mv"],
      name: "every_type_mv",
      kind: "materialized_view",
    });
  });

  test("a count past 2^53, which decodes as its text, is read as its nearest number, so not exact", async () => {
    const { runner } = scripted(outcome(LIST_SCHEMA, [["t", "18446744073709551615", "9007199254740993", ""]]));
    const [listed] = await listObjects(runner, CONTAINER, "table");
    expect(listed.rowCount).toBe(2 ** 64);
    // 2^53 + 1 has no double, so it reads as 2^53, one off.
    expect(listed.sizeBytes).toBe(2 ** 53);
  });

  test("an over-budget list refuses with its sentence [X05]", async () => {
    const cut = { bound: "bytes", limit: 16_777_216 } as const;
    const { runner } = scripted(outcome(LIST_SCHEMA, [["a", "1", "1", ""]], cut));
    await expect(listObjects(runner, CONTAINER, "table")).rejects.toThrow(
      DATABEND_OBJECT_SENTENCES.incomplete("object list", cut),
    );
  });
});

describe("describeObject", () => {
  test("columns in declared order, a default only where default_kind is set, no key, and the default catalog's indexes", async () => {
    const container = { catalog: "default", database: DATABASE };
    const { runner, calls } = scripted(
      outcome(COLUMN_SCHEMA, [
        ["id", "INT", "NO", "", "", ""],
        ["txt", "VARCHAR", "YES", "DEFAULT", "'x'", "note"],
      ]),
      outcome(
        [
          ["index_name", "String"],
          ["index_type", "String"],
          ["definition", "String"],
        ],
        [
          ["idx_txt", "INVERTED", `${OBJECT}(txt, id)tokenizer='chinese'`],
          ["odd", "NGRAM", "elsewhere(txt)"],
        ],
      ),
    );
    expect(await describeObject(runner, container, "table", OBJECT)).toEqual({
      path: ["default", DATABASE, OBJECT],
      columns: [
        { name: "id", type: "INT", nullable: false, isPrimary: false },
        { name: "txt", type: "VARCHAR", nullable: true, isPrimary: false, defaultValue: "'x'" },
      ],
      indexes: [
        { name: "idx_txt", columns: ["txt", "id"], unique: false },
        { name: "odd", columns: [], unique: false },
      ],
      foreignKeys: [],
    });
    expect(calls).toEqual([
      { sql: SQL.columns("`default`"), rowCut: DATABEND_SURFACE_ROW_CUT },
      { sql: SQL.indexes, rowCut: DATABEND_SURFACE_ROW_CUT },
    ]);
  });

  test("another catalog reads no indexes", async () => {
    const { runner, calls } = scripted(outcome(COLUMN_SCHEMA, [["id", "INT", "NO", "", "", ""]]));
    const detail = await describeObject(runner, CONTAINER, "table", OBJECT);
    expect(detail.indexes).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("an over-budget describe refuses with its sentence rather than return a cut column list [X05]", async () => {
    const cut = { bound: "cells", limit: 250_000 } as const;
    const { runner } = scripted(outcome(COLUMN_SCHEMA, [["id", "INT", "NO", "", "", ""]], cut));
    await expect(describeObject(runner, CONTAINER, "table", OBJECT)).rejects.toThrow(
      DATABEND_OBJECT_SENTENCES.incomplete("column list", cut),
    );
  });

  test("an object Databend lists no columns for, a view that no longer plans, is refused rather than described as empty", async () => {
    const { runner } = scripted(outcome(COLUMN_SCHEMA, []));
    await expect(describeObject(runner, CONTAINER, "view", OBJECT)).rejects.toThrow(
      DATABEND_OBJECT_SENTENCES.noColumns(OBJECT),
    );
  });
});

describe("describeObjects", () => {
  const NAME_SCHEMA = [["object_name", "String"]] as const;
  const names = (...list: string[]) =>
    outcome(
      NAME_SCHEMA,
      list.map((name) => [name]),
    );
  const rows = [
    ["a", "x", "INT", "NO", "", ""],
    ["a", "y", "VARCHAR", "YES", "DEFAULT", "'d'"],
    ["b", "x", "INT", "YES", "", ""],
    ["c", "z", "INT", "YES", "", ""],
  ];

  test("one statement for the whole kind, each object's columns grouped under its path", async () => {
    const { runner, calls } = scripted(names("a", "b", "c"), outcome(BULK_SCHEMA, rows));
    expect(await describeObjects(runner, CONTAINER, "table")).toEqual({
      details: [
        {
          path: [CATALOG, DATABASE, "a"],
          columns: [
            { name: "x", type: "INT", nullable: false, isPrimary: false },
            { name: "y", type: "VARCHAR", nullable: true, isPrimary: false, defaultValue: "'d'" },
          ],
          indexes: [],
          foreignKeys: [],
        },
        {
          path: [CATALOG, DATABASE, "b"],
          columns: [{ name: "x", type: "INT", nullable: true, isPrimary: false }],
          indexes: [],
          foreignKeys: [],
        },
        {
          path: [CATALOG, DATABASE, "c"],
          columns: [{ name: "z", type: "INT", nullable: true, isPrimary: false }],
          indexes: [],
          foreignKeys: [],
        },
      ],
    });
    expect(calls).toEqual([
      { sql: SQL.names("table"), rowCut: DATABEND_SURFACE_ROW_CUT },
      { sql: SQL.bulk("table"), rowCut: DATABEND_SURFACE_ROW_CUT },
    ]);
  });

  test("a caller's limit reads one object more, and its absence of a cut is said by truncated", async () => {
    const { runner, calls } = scripted(names("a", "b", "c"), outcome(BULK_SCHEMA, rows));
    const batch = await describeObjects(runner, CONTAINER, "table", 2);
    expect(batch.details.map((detail) => detail.path[2])).toEqual(["a", "b"]);
    expect(batch.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
    expect(calls.map((call) => call.sql)).toEqual([SQL.names("table", 3), SQL.bulk("table", 3)]);
  });

  test("a limit the kind fits under is not truncated", async () => {
    const { runner } = scripted(names("a", "b", "c"), outcome(BULK_SCHEMA, rows));
    const batch = await describeObjects(runner, CONTAINER, "table", 3);
    expect(batch.details).toHaveLength(3);
    expect(batch.truncated).toBeUndefined();
  });

  test("a cut inside a table drops the partly read object and sets truncated with the limit applied [X05]", async () => {
    const cut = { bound: "rows", limit: 3 } as const;
    const { runner } = scripted(names("a", "b", "c"), outcome(BULK_SCHEMA, rows.slice(0, 3), cut));
    const batch = await describeObjects(runner, CONTAINER, "table", 10);
    expect(batch.details.map((detail) => detail.path[2])).toEqual(["a"]);
    expect(batch.truncated).toEqual({ limit: 1, reason: DATABEND_OBJECT_SENTENCES.bulkCut(cut) });
  });

  test("an object listed with no columns, a view that no longer plans, is left out by name and counts toward the limit", async () => {
    const unbounded = scripted(names("a", "b", "broken", "c"), outcome(BULK_SCHEMA, rows));
    const all = await describeObjects(unbounded.runner, CONTAINER, "view");
    expect(all.details.map((detail) => detail.path[2])).toEqual(["a", "b", "c"]);
    expect(all.truncated).toEqual({ limit: 3, reason: DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(["broken"]) });

    const bounded = scripted(names("a", "b", "broken"), outcome(BULK_SCHEMA, rows.slice(0, 3)));
    const some = await describeObjects(bounded.runner, CONTAINER, "view", 2);
    expect(some.details.map((detail) => detail.path[2])).toEqual(["a", "b"]);
    expect(some.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });

    const both = scripted(names("broken", "c", "d"), outcome(BULK_SCHEMA, rows.slice(3)));
    const one = await describeObjects(both.runner, CONTAINER, "view", 2);
    expect(one.details.map((detail) => detail.path[2])).toEqual(["c"]);
    expect(one.truncated).toEqual({
      limit: 2,
      reason: `${callerBoundTruncationReason(2)}, and ${DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(["broken"])}`,
    });
  });

  test("a limit that is not a positive safe whole number is refused before any statement", async () => {
    await Promise.all(
      [0, -1, 1.5, Number.NaN, 1e21].map(async (limit) => {
        const { runner, calls } = scripted();
        await expect(describeObjects(runner, CONTAINER, "table", limit)).rejects.toThrow(
          DATABEND_OBJECT_SENTENCES.badLimit(limit),
        );
        expect(calls).toHaveLength(0);
      }),
    );
  });
});

describe("readObjectSource", () => {
  const SOURCE_SCHEMA = [
    ["Table", "String"],
    ["Create Table", "String"],
  ] as const;
  const DDL = 'CREATE TABLE "o" ("id" INT NULL) ENGINE=FUSE';
  const FORMS = secretForms([TEST_PASSWORD, `reader:${TEST_PASSWORD}`]);

  test("one complete, regenerated SQL part", async () => {
    const { runner, calls } = scripted(outcome(SOURCE_SCHEMA, [["o", DDL]]));
    expect(await readObjectSource(runner, CONTAINER, "table", OBJECT, FORMS)).toEqual({
      path: [CATALOG, DATABASE, OBJECT],
      kind: "table",
      parts: [
        {
          id: SOURCE_PART_ID,
          label: DATABEND_OBJECT_SENTENCES.sourceLabel,
          text: DDL,
          language: "sql",
          form: "complete",
          origin: "regenerated",
        },
      ],
    });
    expect(calls[0].sql).toBe(`SHOW CREATE TABLE ${C}.${D}.${O} WITH QUOTED_IDENTIFIERS`);
  });

  test("a caller's bound marks the part and leaves it complete", async () => {
    const { runner } = scripted(outcome(SOURCE_SCHEMA, [["o", DDL]]));
    const [part] = (await readObjectSource(runner, CONTAINER, "table", OBJECT, FORMS, 6)).parts;
    expect(part).toMatchObject({
      text: "CREATE",
      form: "complete",
      truncated: { limit: 6, reason: sourceBoundTruncationReason(6) },
    });
  });

  // The budget keeps or drops the one row whole, so what it reached is either the whole DDL or none of it: neither is
  // handed over, and a caller's bound is never applied to a text the provider did not read whole.
  test("a definition read the statement budget reached is refused naming the bound, never shown [X05]", async () => {
    const cut = { bound: "bytes", limit: 16_777_216 } as const;
    await Promise.all(
      [[["o", DDL]], []].map(async (rows) => {
        const { runner } = scripted(outcome(SOURCE_SCHEMA, rows, cut));
        const read = readObjectSource(runner, CONTAINER, "materialized_view", OBJECT, FORMS, 6);
        await expect(read).rejects.toBeInstanceOf(QueryError);
        await expect(read).rejects.toThrow(DATABEND_OBJECT_SENTENCES.incomplete("definition", cut));
      }),
    );
  });

  test("an answer with no definition text raises naming the object, never a part", async () => {
    await Promise.all(
      [[], [["o", "  "]], [["o", null]]].map(async (rows) => {
        const { runner } = scripted(outcome(SOURCE_SCHEMA, rows));
        const read = readObjectSource(runner, CONTAINER, "view", OBJECT, FORMS);
        await expect(read).rejects.toBeInstanceOf(QueryError);
        await expect(read).rejects.toThrow(`Databend answered no definition for "${OBJECT}".`);
      }),
    );
    expect(DATABEND_OBJECT_SENTENCES.noDefinition(OBJECT)).toBe(`Databend answered no definition for "${OBJECT}".`);
  });

  // The 1063 Databend answered on the pinned image when `studio_reader` read `studio_demo.notes`, for another user and
  // object. `SHOW CREATE` needs SELECT on the object, or for a materialized view on its source table, while a grant of
  // any other privilege lists the object in the tree (Databend's `privilege_access.rs` and `visibility_checker.rs`).
  const denied = (on: string) =>
    `Permission denied: privilege [Select] is required on ${on} for user 'analyst'@'%' with roles [public,analyst]`;

  test("a definition Databend refuses with 1063 is a part holding Databend's own words, never a raise", async () => {
    await Promise.all(
      [
        ["table", "'default'.'d'.'o'"],
        ["materialized_view", "'default'.'d'.'its_source'"],
      ].map(async ([kind, on]) => {
        const { runner } = scripted(new DatabendError("statement", denied(on), { code: 1063 }));
        const document = await readObjectSource(runner, CONTAINER, kind, OBJECT, FORMS, 6);
        expect(document).toEqual({
          path: [CATALOG, DATABASE, OBJECT],
          kind,
          parts: [{ id: SOURCE_PART_ID, label: DATABEND_OBJECT_SENTENCES.sourceLabel, unavailable: denied(on) }],
        });
        expect(Object.keys(document.parts[0]).sort()).toEqual(["id", "label", "unavailable"]);
      }),
    );
  });

  test("a 1063's words pass serverText with the connection's forms and are cut as a refusal's text is", async () => {
    const refusal = async (message: string) => {
      const { runner } = scripted(new DatabendError("statement", message, { code: 1063 }));
      const [part] = (await readObjectSource(runner, CONTAINER, "view", OBJECT, FORMS)).parts;
      return "unavailable" in part ? part.unavailable : part.text;
    };
    expect(await refusal(denied(`'${TEST_PASSWORD}'`))).toBe(serverText(TEST_PASSWORD, FORMS));
    expect(await refusal("D".repeat(400))).toBe(`${"D".repeat(300)}...`);
  });

  test("every other failure of the read raises: an object Databend does not hold, and a 1063 that is not its in-body error", async () => {
    await Promise.all(
      [
        new DatabendError("statement", "Unknown table 'o'", { code: 1025 }),
        new DatabendError("server", "Databend answered HTTP 500 before the statement finished: denied.", {
          code: 1063,
          status: 500,
        }),
      ].map(async (error) => {
        const { runner } = scripted(error);
        await expect(readObjectSource(runner, CONTAINER, "table", OBJECT, FORMS)).rejects.toBe(error);
      }),
    );
  });
});

describe("the sentences", () => {
  test("every bound names its unit", () => {
    expect(DATABEND_OBJECT_SENTENCES.bound({ bound: "rows", limit: 100_000 })).toBe("100,000 rows");
    expect(DATABEND_OBJECT_SENTENCES.bound({ bound: "cells", limit: 250_000 })).toBe("250,000 cells");
    expect(DATABEND_OBJECT_SENTENCES.bound({ bound: "bytes", limit: 16_777_216 })).toBe(
      "16,777,216 bytes of answer text",
    );
  });

  test("every refusal is one sentence without a dash", () => {
    const cut = { bound: "rows", limit: 5 } as const;
    const sentences = [
      DATABEND_OBJECT_SENTENCES.incomplete("object list", cut),
      DATABEND_OBJECT_SENTENCES.unknownTableType("X"),
      DATABEND_OBJECT_SENTENCES.unknownKind("x"),
      DATABEND_OBJECT_SENTENCES.badLimit(0),
      DATABEND_OBJECT_SENTENCES.noDefinition("v"),
      DATABEND_OBJECT_SENTENCES.noPassword("u"),
      DATABEND_OBJECT_SENTENCES.noColumns("v"),
    ];
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(sentence).not.toMatch(DASHES);
    }
    expect(DATABEND_OBJECT_SENTENCES.bulkCut(cut)).toMatch(/^the bulk column read /);
    expect(DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(["v"])).toBe(
      'Databend listed no columns for "v", as it does for a view that no longer plans, so it was left out',
    );
    expect(DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(["v", "w"])).toMatch(
      /^Databend listed no columns for "v", "w", .* so they were left out$/,
    );
  });
});
