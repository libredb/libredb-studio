import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import {
  type AgentCatalogKind,
  type AgentCatalogRead,
  AgentComposedSqlError,
} from "@/lib/agent/composed-sql-primitives";
import { engineServerDialect } from "@/lib/agent/languages/engines/server";
import { admitComposedStatement, agentQueryReadSqlInput, agentReadSqlInput } from "@/lib/db/operations/statement-guard";

/**
 * Elasticsearch's catalog read: the `SYS COLUMNS` command its overlay composes, and the row mapper that turns the
 * engine's JDBC-shaped answer into the column inventory, driven from what 9.1.4 answered each composed statement
 * (tests/fixtures/elasticsearch/9.1.4/catalog-read/, written by tests/live/elasticsearch-catalog-captures.ts).
 */

const catalogRead = (): AgentCatalogRead => {
  const read = engineServerDialect("elasticsearch").catalogRead;
  if (read === "unsupported") throw new Error("elasticsearch declares no catalog read");
  return read;
};

const refusal = (run: () => unknown): AgentComposedSqlError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentComposedSqlError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("the composed command", () => {
  test("is declared a command, frozen, with a mapper", () => {
    const read = catalogRead();
    expect(read.commandShaped).toBe(true);
    expect(typeof read.mapRows).toBe("function");
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.compose)).toBe(true);
  });

  test("reads every table's columns with SYS COLUMNS, and one table's with its name quoted", () => {
    expect(composeCatalogRead("elasticsearch", { kind: "columns" })).toBe("SYS COLUMNS");
    expect(composeCatalogRead("elasticsearch", {})).toBe("SYS COLUMNS");
    expect(composeCatalogRead("elasticsearch", { kind: "columns", table: "probe_shapes" })).toBe(
      'SYS COLUMNS "probe_shapes"',
    );
    // Trimmed like every selector, and a double quote doubled, the escape the engine reads inside a quoted name.
    expect(composeCatalogRead("elasticsearch", { kind: "columns", table: '  a"b ' })).toBe('SYS COLUMNS "a""b"');
  });

  test("each composed command is admitted by identity, and refused as model text", () => {
    for (const sql of ['SYS COLUMNS "probe_shapes"', "SYS COLUMNS"]) {
      expect(agentQueryReadSqlInput.safeParse({ sql, composed: admitComposedStatement(sql) }).success).toBe(true);
      expect(agentReadSqlInput.safeParse({ sql }).success).toBe(false);
    }
  });

  test.each([
    ["a wildcard", "probe_*"],
    ["a list", "probe_orders,probe_shapes"],
    ["a date-math expression", "<probe_orders>"],
    ["a remote cluster", "docker-cluster:probe_orders"],
    ["an exclusion", "-probe_orders"],
    ["an inclusion", "+probe_orders"],
    ["the every-index name", "_all"],
  ])("refuses %s, which the engine reads as an index expression rather than one name", (_label, table) => {
    const error = refusal(() => composeCatalogRead("elasticsearch", { kind: "columns", table }));
    expect(error.reasonCode).toBe("INVALID_SELECTOR");
    expect(error.message).toContain(table);
  });

  test("refuses a schema, which Elasticsearch SQL does not have", () => {
    const error = refusal(() => composeCatalogRead("elasticsearch", { kind: "columns", schema: "public" }));
    expect(error.reasonCode).toBe("SELECTOR_UNSUPPORTED_BY_DIALECT");
  });

  test("refuses a selector the shared validation refuses", () => {
    expect(refusal(() => composeCatalogRead("elasticsearch", { table: "a\\b" })).reasonCode).toBe("INVALID_SELECTOR");
  });

  test.each([
    ["relations", "foreign key"],
    ["indexes", "index object"],
    ["statistics", "row estimate"],
  ] as const)("refuses the %s kind, which the engine has nothing to answer", (kind: AgentCatalogKind, words) => {
    const error = refusal(() => composeCatalogRead("elasticsearch", { kind }));
    expect(error.reasonCode).toBe("SELECTOR_UNSUPPORTED_BY_DIALECT");
    expect(error.message).toContain(words);
  });
});

/** One capture of tests/fixtures/elasticsearch/9.1.4/catalog-read/. */
interface CatalogCapture {
  readonly version: string;
  readonly name: string;
  readonly request: { readonly body: { readonly query: string } };
  readonly status: number;
  readonly body: string;
}

const CAPTURE_DIR = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "../../../fixtures/elasticsearch/9.1.4/catalog-read",
);

const CAPTURES: ReadonlyMap<string, CatalogCapture> = new Map(
  readdirSync(CAPTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const capture = JSON.parse(readFileSync(posix.join(CAPTURE_DIR, file), "utf8")) as CatalogCapture;
      return [capture.name, capture] as const;
    }),
);

const capture = (name: string): CatalogCapture => {
  const found = CAPTURES.get(`catalog-read/${name}`);
  if (found === undefined) throw new Error(`no capture ${name}`);
  return found;
};

/** The engine's answer as the provider hands it on: one record per row, keyed by the declared column names. */
function engineRows(entry: CatalogCapture): Record<string, unknown>[] {
  const answer = JSON.parse(entry.body) as { columns: { name: string }[]; rows: unknown[][]; cursor?: string };
  expect(answer.cursor).toBeUndefined();
  return answer.rows.map((row) => Object.fromEntries(answer.columns.map((column, i) => [column.name, row[i]])));
}

const COLUMN_FIELDS = ["table_name", "column_name", "data_type", "is_nullable", "ordinal_position"];

describe("the row mapper, driven by 9.1.4's answers", () => {
  test("every capture is a 200 to exactly the statement the overlay composes", () => {
    expect([...CAPTURES.keys()].sort()).toEqual([
      "catalog-read/columns",
      "catalog-read/columns-alias",
      "catalog-read/columns-missing",
      "catalog-read/columns-table",
    ]);
    const composed: Record<string, string> = {
      columns: composeCatalogRead("elasticsearch", { kind: "columns" }),
      "columns-alias": composeCatalogRead("elasticsearch", { table: "probe_orders_alias" }),
      "columns-missing": composeCatalogRead("elasticsearch", { table: "zq_no_such_index" }),
      "columns-table": composeCatalogRead("elasticsearch", { table: "probe_shapes" }),
    };
    for (const [name, sql] of Object.entries(composed)) {
      const entry = capture(name);
      expect(entry.version).toBe("9.1.4");
      expect(entry.status).toBe(200);
      expect(entry.request.body.query).toBe(sql);
    }
  });

  test("one table's answer becomes its columns, in the engine's order and words", () => {
    const mapped = catalogRead().mapRows?.("columns", engineRows(capture("columns-table")));
    expect(mapped).toEqual({
      fields: COLUMN_FIELDS,
      rows: [
        {
          table_name: "probe_shapes",
          column_name: "address.city",
          data_type: "KEYWORD",
          is_nullable: "YES",
          ordinal_position: 2,
        },
        { table_name: "probe_shapes", column_name: "note", data_type: "TEXT", is_nullable: "YES", ordinal_position: 3 },
        {
          table_name: "probe_shapes",
          column_name: "note.keyword",
          data_type: "KEYWORD",
          is_nullable: "YES",
          ordinal_position: 4,
        },
      ],
    });
  });

  test("every table's answer keeps one row per engine row, each read off that row", () => {
    const rows = engineRows(capture("columns"));
    const mapped = catalogRead().mapRows?.("columns", rows);
    expect(mapped?.fields).toEqual(COLUMN_FIELDS);
    expect(mapped?.rows).toHaveLength(rows.length);
    expect(new Set(mapped?.rows.map((row) => row.table_name))).toEqual(
      new Set(
        ["probe_buckets", "probe_orders", "probe_orders_alias", "probe_shapes"].concat(
          rows.map((row) => String(row.TABLE_NAME)).filter((name) => name.startsWith(".ds-probe_stream-")),
        ),
      ),
    );
    mapped?.rows.forEach((row, i) => {
      expect(row).toEqual({
        table_name: rows[i]?.TABLE_NAME,
        column_name: rows[i]?.COLUMN_NAME,
        data_type: rows[i]?.TYPE_NAME,
        is_nullable: rows[i]?.IS_NULLABLE,
        ordinal_position: rows[i]?.ORDINAL_POSITION,
      });
    });
  });

  test("an alias answers its index's columns under its own name", () => {
    const mapped = catalogRead().mapRows?.("columns", engineRows(capture("columns-alias")));
    expect(mapped?.rows.length).toBeGreaterThan(0);
    for (const row of mapped?.rows ?? []) expect(row.table_name).toBe("probe_orders_alias");
    expect(mapped?.rows.map((row) => row.column_name)).toContain("customer");
  });

  test("a name the engine does not hold answers no columns, which maps to none", () => {
    expect(catalogRead().mapRows?.("columns", engineRows(capture("columns-missing")))).toEqual({
      fields: COLUMN_FIELDS,
      rows: [],
    });
  });

  test("a row missing a column maps that cell to null rather than inventing one", () => {
    expect(catalogRead().mapRows?.("columns", [{ TABLE_NAME: "t" }])).toEqual({
      fields: COLUMN_FIELDS,
      rows: [{ table_name: "t", column_name: null, data_type: null, is_nullable: null, ordinal_position: null }],
    });
  });
});
