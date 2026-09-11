import { describe, expect, test } from "bun:test";
import { MAX_ER_CHARS, erDetailForWorkflow, renderErDiagram } from "@/lib/agent/er-diagram";
import type { AgentContextSnapshot, AgentInventoryObject } from "@/lib/agent/types";
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

/**
 * The inventory a run actually carries, which is NOT `TableSchema[]`.
 *
 * `AgentContextSnapshot.objects` is `AgentInventoryObject[]`: every field readonly, and
 * `path` and `kind` beside the flat reading's fields. Typing this helper as `TableSchema[]`
 * was harmless only while every fixture here was a bare flat table; a fixture carrying the
 * address segments a real object read supplies does not assign to it.
 */
const snapshot = (tables: readonly AgentInventoryObject[]): AgentContextSnapshot => ({
  connectionId: "conn_1",
  fingerprint: "ctx_1",
  capturedAtMs: 1,
  objects: tables,
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

  test("a name carrying a LINE BREAK cannot become a second line", () => {
    // Both reference engines permit a newline inside a quoted identifier, so doubling
    // the quote alone left a name able to produce what read as an extra relation —
    // defeating the "a relation is a line" reading this file's assertions rest on.
    // Found by review on #347.
    const hostile = table('a"\n"orders" -> "secrets', {
      foreignKeys: [{ columnName: "x", referencedTable: "customers", referencedColumn: "id" }],
    });

    const rendered = renderErDiagram(snapshot([hostile, table("customers")]), "minimal");

    expect(relationLines(rendered)).toHaveLength(1);
    expect(rendered).toContain("\\n");
  });

  test("every other control character is escaped too, not passed through", () => {
    const hostile = table("a\u0007b\tc\rd", {
      foreignKeys: [{ columnName: "x", referencedTable: "customers", referencedColumn: "id" }],
    });

    const rendered = renderErDiagram(snapshot([hostile, table("customers")]), "minimal");

    expect(rendered).toContain("a\\x07b\\tc\\rd");
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

/**
 * The spelling a PROVIDER writes a foreign key target in, against the ADDRESS an entry
 * carries (#789).
 *
 * Every fixture above is bare on both sides, which is the one shape no engine produces
 * once the object surface has named the entries: a target is spelled by whichever provider
 * read the key, in its own flat dialect, and each of them qualifies LESS than the address.
 * Measured in the providers rather than derived from what makes this file pass:
 * `postgres.ts` strips `public.` from a same-schema target, `mysql.ts` emits the bare table
 * name against a `database.table` address, and `mssql.ts` strips the object's own schema
 * from a `catalog.schema.table` one. Compared to the address as strings, EVERY same-schema
 * key on those three engines reads as pointing outside the inventory it is sitting in.
 */
describe("a foreign key target is resolved against the address, not compared to it", () => {
  const entry = (name: string, path: readonly string[], overrides: Partial<AgentInventoryObject> = {}) => ({
    name,
    path,
    columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
    indexes: [],
    ...overrides,
  });

  test("PostgreSQL's public schema: a stripped target still finds the object it names", () => {
    // `postgres.ts` composes `referencedTable` without the `public.` qualifier, and the
    // object read addresses the same table `public.customers`.
    const rendered = renderErDiagram(
      snapshot([
        entry("public.orders", ["public", "orders"], {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
        }),
        entry("public.customers", ["public", "customers"]),
      ]),
      "minimal",
    );

    expect(rendered).not.toContain("not in this inventory");
    // Rendered by the ADDRESS the inventory listed, because that is the name the model is
    // being asked to write statements against.
    expect(rendered).toContain('"public.orders" -> "public.customers"');
  });

  test("MySQL: a bare target against a database-qualified address", () => {
    const rendered = renderErDiagram(
      snapshot([
        entry("app.orders", ["app", "orders"], {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
        }),
        entry("app.customers", ["app", "customers"]),
      ]),
      "medium",
    );

    expect(rendered).not.toContain("not in this inventory");
    expect(rendered).toContain('"app.orders"."customer_id" -> "app.customers"."id"');
  });

  test("SQL Server: a schema-qualified target against a catalog-qualified address", () => {
    // `mssql.ts` strips the object's OWN schema, so a cross-schema key keeps two segments
    // while the address carries three.
    const rendered = renderErDiagram(
      snapshot([
        entry("shop.dbo.orders", ["shop", "dbo", "orders"], {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "sales.customers", referencedColumn: "id" }],
        }),
        entry("shop.sales.customers", ["shop", "sales", "customers"]),
      ]),
      "minimal",
    );

    expect(rendered).not.toContain("not in this inventory");
    expect(rendered).toContain('"shop.dbo.orders" -> "shop.sales.customers"');
  });

  test("a same-container key is resolved IN that container, the way the engine resolves it", () => {
    // Measured on MySQL holding `app` and `app_test`: `app.orders` declares a key spelled
    // bare, both databases hold a `customers`, and the rank alone tied them. The engine
    // itself reads an unqualified target in the referencing object's own database, and the
    // referencing object is right here, so the diagram reads it the same way. Before the
    // tie-breaker this line carried "this run cannot say which" for every same-database
    // foreign key on any server holding a second database with the same table in it.
    const rendered = renderErDiagram(
      snapshot([
        entry("app.orders", ["app", "orders"], {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
        }),
        entry("app.customers", ["app", "customers"]),
        entry("app_test.customers", ["app_test", "customers"]),
      ]),
      "minimal",
    );

    expect(rendered).toContain('"app.orders" -> "app.customers"');
    expect(rendered).not.toContain("more than one object in this inventory is spelled that way");
  });

  test("two objects answering one spelling are not guessed between, and are not called missing either", () => {
    // The refusal that matters as much as the match: picking one of these would assert a
    // relation the database may not have. Saying "not in this inventory" would be false
    // about an inventory holding both. The referencing object's container breaks a tie it
    // is a party to and nothing else: `warehouse` holds neither candidate, so this stays a
    // refusal, and that is the direction the tie-breaker must not move in.
    const rendered = renderErDiagram(
      snapshot([
        entry("warehouse.orders", ["warehouse", "orders"], {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
        }),
        entry("app.customers", ["app", "customers"]),
        entry("archive.customers", ["archive", "customers"]),
      ]),
      "minimal",
    );

    expect(rendered).toContain("more than one object in this inventory is spelled that way");
    expect(rendered).not.toContain("target not in this inventory");
    // The provider's own spelling is kept, since this run cannot say which address it meant.
    expect(rendered).toContain('"warehouse.orders" -> "customers"');
  });

  test("the most qualified match wins outright rather than being made ambiguous", () => {
    // A two-segment spelling that one address equals and another merely ends with. The
    // equal one is the answer; treating them as rivals would phantom a key that is exact.
    const rendered = renderErDiagram(
      snapshot([
        entry("sales.orders", ["sales", "orders"], {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "sales.customers", referencedColumn: "id" }],
        }),
        entry("sales.customers", ["sales", "customers"]),
        entry("warehouse.sales.customers", ["warehouse", "sales", "customers"]),
      ]),
      "minimal",
    );

    expect(rendered).toContain('"sales.orders" -> "sales.customers"');
    expect(rendered).not.toContain("not in this inventory");
    expect(rendered).not.toContain("more than one object");
  });

  test("a target nothing answers to is still the edge of what the run read", () => {
    const rendered = renderErDiagram(
      snapshot([
        entry("app.orders", ["app", "orders"], {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
        }),
      ]),
      "minimal",
    );

    expect(rendered).toContain("target not in this inventory");
  });

  test("an entry that never reached the object surface is addressed by the name it has", () => {
    // The composed catalog path carries no `path`: its entries are one qualified string,
    // and a stripped target has to resolve against that too. The dot split is the last
    // resort stated in `inventory-address.ts`, not the rule.
    const rendered = renderErDiagram(
      snapshot([
        table("public.orders", {
          foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
        }),
        table("public.customers"),
      ]),
      "minimal",
    );

    expect(rendered).not.toContain("not in this inventory");
    expect(rendered).toContain('"public.orders" -> "public.customers"');
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

/*
  The three-way distinction an empty relations read has to keep.

  A zero-row read is three different facts wearing one shape, and the run was licensed
  to pick the wrong one: an investigation over the seeded dvdrental answered "there are
  no declared foreign key constraints between tables in the database", confidently,
  citing a snapshot that genuinely contained nothing because the role could not see the
  18 keys `pg_constraint` holds. The read itself is fixed elsewhere
  (`composePostgresRelations`); what is asserted here is that the TEXT stops licensing
  the negative, since any role can be narrower than the database it reads.

  One test per arm, and each names what the block SAYS rather than what it omits: an
  assertion that the false sentence is absent would keep passing if this whole rendering
  were deleted.
*/
describe("an empty read, an absent concept and a real graph are told apart", () => {
  const EMPTY = snapshot([table("a"), table("b")]);

  /*
    #414. The arm is driven from the provider's own capability rather than from the
    connection's type, which `CLAUDE.md` forbids outside a provider class: MongoDB,
    Redis, LibreDB, Druid, ClickHouse and Couchbase all reach here, and a type check at
    this call site is how six would have been listed and the seventh forgotten. On those
    six there is no construct to decline, so the (c) sentence is wrong here too — a read
    limit is not what is being reported.
  */
  test("(a) an engine with no foreign-key concept says nothing could have been found", () => {
    const rendered = renderErDiagram(EMPTY, "minimal", { engineDeclaresForeignKeys: false });

    expect(rendered).toContain("this engine does not declare foreign keys at all");
    expect(rendered).toContain("nothing of that kind here for a reading to have found or missed");
    // Not the read-limit sentence: on these six engines there is no read to have missed.
    expect(rendered).not.toContain("not the same as there being none");
  });

  test("(b) an engine that has them and a read that found rows reports the rows", () => {
    const rendered = renderErDiagram(WITH_CUSTOMERS, "minimal", { engineDeclaresForeignKeys: true });

    expect(relationLines(rendered)).toEqual(['"orders" -> "customers"']);
    expect(rendered).not.toContain("not the same as there being none");
    expect(rendered).not.toContain("does not declare foreign keys at all");
  });

  /*
    Both values take this arm, and that is the point of the loop: `declaresForeignKeys`
    is optional on the published `ProviderCapabilities`, so an absent flag is a provider
    that has decided nothing — and the honest sentence is the one that claims least,
    which is the right thing to say about an engine nobody has ruled on.
  */
  test("(c) an engine that has them and a read that found none refuses to assert the negative", () => {
    for (const declares of [undefined, true]) {
      const rendered = renderErDiagram(EMPTY, "minimal", {
        ...(declares === undefined ? {} : { engineDeclaresForeignKeys: declares }),
      });
      const because = String(declares);

      // What it says: the read's limit, the reason, and the instruction that follows.
      expect(rendered, because).toContain("No foreign key was read for any table in this inventory");
      expect(rendered, because).toContain("not the same as there being none");
      expect(rendered, because).toContain("a role narrower than the database reads an empty graph");
      expect(rendered, because).toContain("do not report that this database has no foreign keys");
      expect(rendered, because).toContain("inferred from names rather than declared");
      // And only then the negatives: neither of the other two arms' sentences.
      expect(rendered, because).not.toContain("does not declare foreign keys at all");
      expect(rendered, because).not.toContain("declares a foreign key.");
    }
  });
});

describe("bounds and empty shapes", () => {
  /*
    #414, second finding. An engine that declares no foreign keys is usually one whose
    inventory rows are not tables either, so the two sentences above named something the
    reader was never shown: a Redis run was told "no table in this inventory" over a list
    of key patterns. The noun comes from the provider's own `ProviderLabels` — the
    product has always had the right word and only the browser was being told it.
  */
  test("the block names the rows what this engine calls them, in the header and in both empty sentences", () => {
    const noun = { singular: "key pattern", plural: "key patterns" };
    const rows = snapshot([table("user:*"), table("order:*")]);

    const cannotDeclare = renderErDiagram(rows, "minimal", { engineDeclaresForeignKeys: false, noun });
    expect(cannotDeclare).toContain("Relations between the 2 key pattern(s) in this inventory");
    expect(cannotDeclare).toContain("Whatever relates these key patterns to each other");
    expect(cannotDeclare).not.toContain("table");

    const readNone = renderErDiagram(rows, "minimal", { noun });
    expect(readNone).toContain("No foreign key was read for any key pattern in this inventory");
    expect(readNone).not.toContain("any table in this inventory");
  });

  /*
    And the default, which is what keeps every SQL engine's block byte-identical: a
    caller that passes no noun gets the base provider's own word.
  */
  test("a caller that declares no noun still says table", () => {
    expect(renderErDiagram(snapshot([table("a")]), "minimal")).toContain(
      "Relations between the 1 table(s) in this inventory",
    );
  });

  test("a relation that exists is still drawn, whatever the capability says", () => {
    const rendered = renderErDiagram(WITH_CUSTOMERS, "minimal", { engineDeclaresForeignKeys: false });

    expect(rendered).toContain('"orders" -> "customers"');
    expect(rendered).not.toContain("does not declare foreign keys at all");
  });

  test("a wide schema is bounded by CHARACTERS, and says how much it left out", () => {
    // A count of edges is not a bound on a prompt: one long identifier can amplify a
    // single line far past a ceiling that sixty short ones would fit inside. Found by
    // review on #347.
    const wide = snapshot([
      table("hub", {
        foreignKeys: Array.from({ length: 200 }, (_, index) => ({
          columnName: `column_number_${index}_with_a_long_name`,
          referencedTable: `target_table_number_${index}_with_a_long_name`,
          referencedColumn: "id",
        })),
      }),
    ]);

    const rendered = renderErDiagram(wide, "medium");

    expect(rendered.length).toBeLessThanOrEqual(MAX_ER_CHARS);
    expect(rendered).toMatch(/\d+ further relation\(s\) omitted/);
  });

  test("a single identifier long enough to blow the bound cannot", () => {
    const huge = snapshot([
      table("a", {
        foreignKeys: [{ columnName: "x".repeat(MAX_ER_CHARS * 2), referencedTable: "b", referencedColumn: "id" }],
      }),
    ]);

    expect(renderErDiagram(huge, "medium").length).toBeLessThanOrEqual(MAX_ER_CHARS);
  });

  test("the same edge arriving twice is rendered once", () => {
    // PostgreSQL's catalog read returns a composite key as the cross product of its
    // sides (#463), so a pair can genuinely arrive more than once.
    const duplicated = table("orders", {
      foreignKeys: [
        { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
        { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      ],
    });

    expect(relationLines(renderErDiagram(snapshot([duplicated, table("customers")]), "minimal"))).toHaveLength(1);
  });
});

describe("a pairing this inventory cannot know is not invented", () => {
  /**
   * PostgreSQL's catalog read returns a composite foreign key as the cross product
   * of its sides (#463): `FOREIGN KEY (x, y) REFERENCES p(a, b)`
   * arrives as four edges, of which two are false. Rendering them as exact joins
   * would have this block assert a relation the database does not have — the very
   * thing the quoting exists to prevent. Found by review on #347.
   */
  const COMPOSITE = snapshot([
    table("orders", {
      foreignKeys: [
        { columnName: "x", referencedTable: "parents", referencedColumn: "a" },
        { columnName: "x", referencedTable: "parents", referencedColumn: "b" },
        { columnName: "y", referencedTable: "parents", referencedColumn: "a" },
        { columnName: "y", referencedTable: "parents", referencedColumn: "b" },
      ],
    }),
    table("parents"),
  ]);

  test("the false pairings of a cross-product read are never rendered as joins", () => {
    const rendered = renderErDiagram(COMPOSITE, "medium");

    expect(relationLines(rendered)).toHaveLength(1);
    expect(rendered).not.toContain('"x" -> "parents"."b"');
    expect(rendered).not.toContain('"y" -> "parents"."a"');
  });

  test("the columns are still named, because they are true — only the pairing is unknown", () => {
    const rendered = renderErDiagram(COMPOSITE, "medium");

    expect(rendered).toContain('"orders" ("x", "y") -> "parents" ("a", "b")');
    expect(rendered).toContain("cannot pair the columns");
  });

  test("at minimal, the pair reads as one relation and still says the pairing is unknown", () => {
    const rendered = renderErDiagram(COMPOSITE, "minimal");

    expect(rendered).toContain('"orders" -> "parents"  [several keys or one composite key');
  });

  test("an ambiguous group pointing outside the inventory keeps that note too", () => {
    const rendered = renderErDiagram(
      snapshot([
        table("orders", {
          foreignKeys: [
            { columnName: "x", referencedTable: "gone", referencedColumn: "a" },
            { columnName: "y", referencedTable: "gone", referencedColumn: "b" },
          ],
        }),
      ]),
      "medium",
    );

    expect(rendered).toContain("target not in this inventory");
  });

  test("at full, an ambiguous group still carries what leads an index", () => {
    const rendered = renderErDiagram(COMPOSITE, "full");

    expect(rendered).toContain("cannot pair the columns");
    expect(rendered).toContain('primary key "id"');
  });

  test("two relations between DIFFERENT pairs stay two exact lines", () => {
    // The grouping is by table pair, so it must not swallow ordinary edges.
    const rendered = renderErDiagram(
      snapshot([
        table("orders", {
          foreignKeys: [
            { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
            { columnName: "region_id", referencedTable: "regions", referencedColumn: "id" },
          ],
        }),
        table("customers"),
        table("regions"),
      ]),
      "medium",
    );

    expect(relationLines(rendered)).toHaveLength(2);
    expect(rendered).not.toContain("cannot pair the columns");
  });
});

describe("which level a workflow is given", () => {
  test("each workflow gets the detail its questions need", () => {
    expect(erDetailForWorkflow("investigation")).toBe("minimal");
    expect(erDetailForWorkflow("query-optimization")).toBe("medium");
    expect(erDetailForWorkflow("database-assessment")).toBe("full");
    // An analysis joins a fact table to its dimensions, so WHICH columns join is the
    // part it needs; how each key is indexed is the assessment's question, not this
    // one's.
    expect(erDetailForWorkflow("data-analysis")).toBe("medium");
  });
});
