import { describe, expect, test } from "bun:test";
import { MAX_ER_RELATIONS, erDetailForWorkflow, renderErDiagram } from "@/lib/agent/er-diagram";
import type { AgentContextSnapshot } from "@/lib/agent/types";
import type { TableSchema } from "@/lib/types";

/**
 * The text ER artifact (#330 T3).
 *
 * The security property is asserted first and hardest: identifiers are QUOTED in
 * this notation rather than merely fenced. The fence says where the server stopped
 * talking; it does not stop a table named `orders -> secrets` from producing a line
 * that reads as a relation nobody has.
 */

const table = (name: string, overrides: Partial<TableSchema> = {}): TableSchema => ({
  name,
  columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
  indexes: [],
  ...overrides,
});

const snapshot = (tables: readonly TableSchema[]): AgentContextSnapshot => ({
  connectionId: "conn_1",
  fingerprint: "ctx_1",
  capturedAtMs: 1,
  tables,
});

/**
 * Every line that renders a relation.
 *
 * A relation is a LINE, and counting arrows would count the one inside a hostile
 * name — which is exactly the point being asserted: text in a quoted identifier is
 * not notation. Every relation line begins with a quoted identifier; the header, the
 * empty-schema sentence and the truncation note do not.
 */
const relationLines = (rendered: string): string[] =>
  rendered
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith('"'));

const ORDERS = table("orders", {
  columns: [
    { name: "id", type: "integer", nullable: false, isPrimary: true },
    { name: "customer_id", type: "integer", nullable: false, isPrimary: false },
  ],
  indexes: [{ name: "orders_customer_idx", columns: ["customer_id", "created_at"], unique: false }],
  foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
});

const WITH_CUSTOMERS = snapshot([ORDERS, table("customers")]);

describe("a hostile identifier cannot forge a relation", () => {
  test("a name carrying the separator is quoted, so it reads as one name", () => {
    const hostile = table('orders" -> "secrets', {
      foreignKeys: [{ columnName: "a", referencedTable: "customers", referencedColumn: "id" }],
    });

    const rendered = renderErDiagram(snapshot([hostile, table("customers")]), "minimal");

    // The embedded quote is doubled, exactly as SQL does it, so the forged
    // separator ends up visibly inside the quoted name.
    expect(rendered).toContain('"orders"" -> ""secrets"');
    // And there is exactly one relation, because a relation is a LINE. Counting
    // arrows would count the one inside the name — which is the point: it is text
    // in a quoted identifier, not notation.
    expect(relationLines(rendered)).toHaveLength(1);
  });

  test("every identifier in the output is delimited", () => {
    const rendered = renderErDiagram(WITH_CUSTOMERS, "medium");

    expect(rendered).toContain('"orders"."customer_id" -> "customers"."id"');
  });
});

describe("detail levels say more about each relation, never fewer relations", () => {
  test("minimal names the tables", () => {
    expect(renderErDiagram(WITH_CUSTOMERS, "minimal")).toContain('"orders" -> "customers"');
  });

  test("medium names the columns that join", () => {
    expect(renderErDiagram(WITH_CUSTOMERS, "medium")).toContain('"orders"."customer_id" -> "customers"."id"');
  });

  test("full adds what a reader judging the join needs: the keys and what leads an index", () => {
    const rendered = renderErDiagram(WITH_CUSTOMERS, "full");

    expect(rendered).toContain('primary key "id"');
    expect(rendered).toContain('indexed on "customer_id"');
  });

  test("full says plainly when a table has neither", () => {
    const bare = table("events", {
      columns: [{ name: "note", type: "text", nullable: true, isPrimary: false }],
      foreignKeys: [{ columnName: "note", referencedTable: "customers", referencedColumn: "id" }],
    });

    expect(renderErDiagram(snapshot([bare, table("customers")]), "full")).toContain("no primary key and no index");
  });

  test("every level shows every relation — a level is not a filter", () => {
    const many = snapshot([
      table("a", { foreignKeys: [{ columnName: "x", referencedTable: "b", referencedColumn: "id" }] }),
      table("b", { foreignKeys: [{ columnName: "y", referencedTable: "c", referencedColumn: "id" }] }),
      table("c"),
    ]);

    for (const detail of ["minimal", "medium", "full"] as const) {
      expect(relationLines(renderErDiagram(many, detail)), detail).toHaveLength(2);
    }
  });
});

describe("the edge of what the run read", () => {
  test("a target outside the inventory is marked rather than dropped", () => {
    // A real edge with a missing node. Dropping it would make the graph look
    // complete when the run simply had not read that far.
    const rendered = renderErDiagram(snapshot([ORDERS]), "minimal");

    expect(rendered).toContain('"orders" -> "customers"');
    expect(rendered).toContain("target not in this inventory");
  });

  test("a target inside it carries no such note", () => {
    expect(renderErDiagram(WITH_CUSTOMERS, "minimal")).not.toContain("not in this inventory");
  });

  test("SQLite's implicit primary-key reference is rendered as the words it stands for", () => {
    // `REFERENCES parent` with no column is legal and means the parent's key; the
    // parser answers a sentinel rather than a column name.
    const implicit = table("orders", {
      foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "(primary key)" }],
    });

    const rendered = renderErDiagram(snapshot([implicit, table("customers")]), "medium");

    expect(rendered).toContain('"customers" (primary key)');
    expect(rendered).not.toContain('"(primary key)"');
  });
});

describe("bounds and empty shapes", () => {
  test("a schema with no foreign keys says so, rather than showing an empty list", () => {
    const rendered = renderErDiagram(snapshot([table("a"), table("b")]), "minimal");

    expect(rendered).toContain("no table in this inventory declares a foreign key");
    // And it says the other possibility, because it is a real one.
    expect(rendered).toContain("enforced by the application");
  });

  test("a wide schema is truncated and says how much it left out", () => {
    const wide = snapshot([
      table("hub", {
        foreignKeys: Array.from({ length: MAX_ER_RELATIONS + 5 }, (_, index) => ({
          columnName: `c${index}`,
          referencedTable: `t${index}`,
          referencedColumn: "id",
        })),
      }),
    ]);

    const rendered = renderErDiagram(wide, "minimal");

    expect(relationLines(rendered)).toHaveLength(MAX_ER_RELATIONS);
    expect(rendered).toContain("5 further relation(s) omitted");
  });

  test("the same edge arriving twice is rendered once", () => {
    // PostgreSQL's catalog read returns a composite key as the cross product of its
    // sides (docs/BACKLOG.md B8), so a pair can genuinely arrive more than once.
    const duplicated = table("orders", {
      foreignKeys: [
        { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
        { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      ],
    });

    expect(relationLines(renderErDiagram(snapshot([duplicated, table("customers")]), "minimal"))).toHaveLength(1);
  });
});

describe("which level a workflow is given", () => {
  test("each workflow gets the detail its questions need", () => {
    expect(erDetailForWorkflow("investigation")).toBe("minimal");
    expect(erDetailForWorkflow("query-optimization")).toBe("medium");
    expect(erDetailForWorkflow("database-assessment")).toBe("full");
  });
});
