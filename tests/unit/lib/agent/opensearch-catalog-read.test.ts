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
 * OpenSearch's catalog read: the `DESCRIBE TABLES` command its overlay composes, and the row mapper that turns the
 * engine's JDBC-shaped answer into the column inventory, driven from what 3.8.0 answered each composed statement
 * (tests/fixtures/opensearch/3.8.0/catalog-read/, written by tests/live/opensearch-catalog-captures.ts).
 */

const catalogRead = (): AgentCatalogRead => {
  const read = engineServerDialect("opensearch").catalogRead;
  if (read === "unsupported") throw new Error("opensearch declares no catalog read");
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

  test("reads one table's columns with its name as a string", () => {
    expect(composeCatalogRead("opensearch", { kind: "columns", table: "probe_shapes" })).toBe(
      "DESCRIBE TABLES LIKE 'probe_shapes'",
    );
    // Trimmed like every selector, and a single quote doubled, the escape 3.8.0 reads inside a string.
    expect(composeCatalogRead("opensearch", { kind: "columns", table: "  it's " })).toBe(
      "DESCRIBE TABLES LIKE 'it''s'",
    );
  });

  test.each([
    ["no selector", {}],
    ["the column kind with no table", { kind: "columns" }],
  ] as const)(
    "refuses %s, since every table's read resolves `*`, which reaches the dot-led indices",
    (_label, selector) => {
      const error = refusal(() => composeCatalogRead("opensearch", selector));
      expect(error.reasonCode).toBe("SELECTOR_UNSUPPORTED_BY_DIALECT");
      expect(error.message).toBe(
        "OpenSearch's every-table catalog read reaches the indices whose names start with a dot, so name a table instead",
      );
    },
  );

  test("the composed command is admitted by identity, and refused as model text", () => {
    const sql = "DESCRIBE TABLES LIKE 'probe_shapes'";
    expect(agentQueryReadSqlInput.safeParse({ sql, composed: admitComposedStatement(sql) }).success).toBe(true);
    expect(agentReadSqlInput.safeParse({ sql }).success).toBe(false);
  });

  test.each([
    ["a wildcard", "probe_*"],
    ["a LIKE wildcard, which the engine reads as one", "probe_order%"],
    ["a list", "probe_orders,probe_shapes"],
    ["a date-math expression", "<probe_orders>"],
    ["a remote cluster", "remote:probe_orders"],
    ["an exclusion", "-probe_orders"],
    ["an inclusion", "+probe_orders"],
    ["the every-index name", "_all"],
  ])("refuses %s, which the engine reads as an index expression rather than one name", (_label, table) => {
    const error = refusal(() => composeCatalogRead("opensearch", { kind: "columns", table }));
    expect(error.reasonCode).toBe("INVALID_SELECTOR");
    expect(error.message).toContain(table);
  });

  test("refuses a schema, which OpenSearch SQL does not have", () => {
    const error = refusal(() => composeCatalogRead("opensearch", { kind: "columns", schema: "public" }));
    expect(error.reasonCode).toBe("SELECTOR_UNSUPPORTED_BY_DIALECT");
  });

  test("refuses a selector the shared validation refuses", () => {
    expect(refusal(() => composeCatalogRead("opensearch", { table: "a\\b" })).reasonCode).toBe("INVALID_SELECTOR");
  });

  test.each([
    ["relations", "foreign key"],
    ["indexes", "index object"],
    ["statistics", "row estimate"],
  ] as const)("refuses the %s kind, which the engine has nothing to answer", (kind: AgentCatalogKind, words) => {
    const error = refusal(() => composeCatalogRead("opensearch", { kind }));
    expect(error.reasonCode).toBe("SELECTOR_UNSUPPORTED_BY_DIALECT");
    expect(error.message).toContain(words);
  });
});

/** One capture of tests/fixtures/opensearch/3.8.0/catalog-read/. */
interface CatalogCapture {
  readonly version: string;
  readonly name: string;
  readonly request: { readonly body: { readonly query: string } };
  readonly status: number;
  readonly body: string;
}

const CAPTURE_DIR = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "../../../fixtures/opensearch/3.8.0/catalog-read",
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
  const answer = JSON.parse(entry.body) as { schema: { name: string }[]; datarows: unknown[][]; cursor?: string };
  expect(answer.cursor).toBeUndefined();
  return answer.datarows.map((row) => Object.fromEntries(answer.schema.map((column, i) => [column.name, row[i]])));
}

const COLUMN_FIELDS = ["table_name", "column_name", "data_type", "is_nullable", "ordinal_position"];

describe("the row mapper, driven by 3.8.0's answers", () => {
  test("every capture answers exactly the statement the overlay composes", () => {
    expect([...CAPTURES.keys()].sort()).toEqual([
      "catalog-read/columns-alias",
      "catalog-read/columns-missing",
      "catalog-read/columns-table",
    ]);
    const composed: Record<string, readonly [string, number]> = {
      "columns-alias": [composeCatalogRead("opensearch", { table: "probe_orders_alias" }), 200],
      "columns-missing": [composeCatalogRead("opensearch", { table: "zq_no_such_index" }), 404],
      "columns-table": [composeCatalogRead("opensearch", { table: "probe_shapes" }), 200],
    };
    for (const [name, [sql, status]] of Object.entries(composed)) {
      const entry = capture(name);
      expect(entry.version).toBe("3.8.0");
      expect(entry.status).toBe(status);
      expect(entry.request.body.query).toBe(sql);
    }
  });

  test("one table's answer becomes its columns, in the engine's order and words", () => {
    const mapped = catalogRead().mapRows?.("columns", engineRows(capture("columns-table")));
    expect(mapped).toEqual({
      fields: COLUMN_FIELDS,
      rows: [
        ["items", "nested", 0],
        ["items.sku", "keyword", 1],
        ["note", "text", 2],
        ["address", "object", 3],
        ["address.city", "keyword", 4],
      ].map(([column_name, data_type, ordinal_position]) => ({
        table_name: "probe_shapes",
        column_name,
        data_type,
        is_nullable: "",
        ordinal_position,
      })),
    });
  });

  test("an alias answers its index's columns under its own name", () => {
    const mapped = catalogRead().mapRows?.("columns", engineRows(capture("columns-alias")));
    expect(mapped?.rows.map((row) => [row.table_name, row.column_name])).toEqual([
      ["probe_orders_alias", "total"],
      ["probe_orders_alias", "customer"],
      ["probe_orders_alias", "id"],
    ]);
  });

  test("a name the engine does not hold is the engine's missing-index fault, not an empty inventory", () => {
    const error = (JSON.parse(capture("columns-missing").body) as { error: { type: string } }).error;
    expect(error.type).toBe("IndexNotFoundException");
  });

  test("a row missing a column maps that cell to null rather than inventing one", () => {
    expect(catalogRead().mapRows?.("columns", [{ TABLE_NAME: "t" }])).toEqual({
      fields: COLUMN_FIELDS,
      rows: [{ table_name: "t", column_name: null, data_type: null, is_nullable: null, ordinal_position: null }],
    });
  });
});
