import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { parseSqliteIndexDdl, parseSqliteTableDdl } from "@/lib/agent/sqlite-ddl";

/**
 * Reading SQLite's stored DDL back into an inventory (#329 T8).
 *
 * This parser exists because the agent path cannot ask SQLite for a structured
 * column list at all: the guard refuses every `pragma_*` table-valued function
 * (`composed-sql.ts` records why), so `sqlite_master.sql` — the engine's own
 * normalised copy of the `CREATE` statement — is the only column, key and index
 * source there is.
 *
 * Every fixture below is therefore round-tripped THROUGH a real engine: the test
 * creates the object, reads back what SQLite stored, and parses that. Parsing a
 * string this file wrote would prove the parser agrees with the test author; only
 * the engine's own text proves it agrees with SQLite.
 */

function storedDdl(statements: readonly string[], name: string): string {
  const database = new Database(":memory:");
  try {
    for (const statement of statements) database.run(statement);
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string };
    return row.sql;
  } finally {
    database.close();
  }
}

describe("parseSqliteTableDdl — columns", () => {
  test("reads name, type, nullability and primary-key membership from an inline declaration", () => {
    const ddl = storedDdl(
      ["CREATE TABLE orders (id INTEGER PRIMARY KEY, total NUMERIC(10, 2) NOT NULL, note TEXT)"],
      "orders",
    );

    expect(parseSqliteTableDdl(ddl).columns).toEqual([
      { name: "id", type: "INTEGER", nullable: true, isPrimary: true },
      { name: "total", type: "NUMERIC(10, 2)", nullable: false, isPrimary: false },
      { name: "note", type: "TEXT", nullable: true, isPrimary: false },
    ]);
  });

  test("reads a table-level primary key, including a composite one", () => {
    const ddl = storedDdl(
      ["CREATE TABLE line_items (order_id INTEGER, sku TEXT, qty INTEGER, PRIMARY KEY (order_id, sku))"],
      "line_items",
    );
    const columns = parseSqliteTableDdl(ddl).columns;

    expect(columns.filter((column) => column.isPrimary).map((column) => column.name)).toEqual(["order_id", "sku"]);
  });

  test("unquotes an identifier that needed quoting, so the inventory carries the real name", () => {
    const ddl = storedDdl(['CREATE TABLE "odd names" ("select" TEXT, [group] INTEGER, `order` REAL)'], "odd names");

    expect(parseSqliteTableDdl(ddl).columns.map((column) => column.name)).toEqual(["select", "group", "order"]);
  });

  test("a comma inside a type, a default or a check does not split a column", () => {
    const ddl = storedDdl(
      [
        "CREATE TABLE prices (id INTEGER, amount DECIMAL(10, 4) DEFAULT 0, label TEXT DEFAULT 'a, b', " +
          "CHECK (amount > 0 AND id IN (1, 2)))",
      ],
      "prices",
    );

    expect(parseSqliteTableDdl(ddl).columns.map((column) => column.name)).toEqual(["id", "amount", "label"]);
  });

  test("a NOT NULL written inside a string default does not make the column non-nullable", () => {
    const ddl = storedDdl(["CREATE TABLE notes (body TEXT DEFAULT 'not null yet')"], "notes");

    expect(parseSqliteTableDdl(ddl).columns[0]).toEqual({
      name: "body",
      type: "TEXT",
      nullable: true,
      isPrimary: false,
    });
  });

  test("a column with no declared type is reported without inventing one", () => {
    const ddl = storedDdl(["CREATE TABLE loose (anything, id INTEGER)"], "loose");

    expect(parseSqliteTableDdl(ddl).columns[0]).toEqual({
      name: "anything",
      type: "",
      nullable: true,
      isPrimary: false,
    });
  });

  test("a view's stored DDL yields no columns rather than a guessed list", () => {
    const ddl = storedDdl(
      ["CREATE TABLE orders (id INTEGER)", "CREATE VIEW recent AS SELECT id FROM orders WHERE id > (SELECT 1)"],
      "recent",
    );

    expect(parseSqliteTableDdl(ddl)).toEqual({ columns: [], foreignKeys: [], indexes: [] });
  });

  /**
   * The engine settles this one, against the expectation this test was written
   * with. A `CREATE TABLE … AS SELECT` looks like the case with no readable column
   * list — and it is not, because SQLite does not store the statement as written:
   * it stores a materialised `CREATE TABLE big(id INT)`. So the shape is
   * inventoried like any other, and the "no column list" path below can only be
   * reached by text that did not come from this engine.
   */
  test("a CREATE TABLE ... AS SELECT is inventoried, because SQLite stores a materialised column list", () => {
    const ddl = storedDdl(
      ["CREATE TABLE orders (id INTEGER, total REAL)", "CREATE TABLE big AS SELECT id FROM orders WHERE total > 1"],
      "big",
    );

    expect(ddl).toContain("(");
    expect(parseSqliteTableDdl(ddl).columns.map((column) => column.name)).toEqual(["id"]);
  });

  test("text that is not a CREATE statement at all is refused rather than half-read", () => {
    expect(parseSqliteTableDdl("")).toEqual({ columns: [], foreignKeys: [], indexes: [] });
    expect(parseSqliteTableDdl("SELECT 1")).toEqual({ columns: [], foreignKeys: [], indexes: [] });
    expect(parseSqliteTableDdl(undefined as unknown as string)).toEqual({ columns: [], foreignKeys: [], indexes: [] });
  });

  /**
   * Hand-written rather than engine-stored, and deliberately so: these are the
   * shapes a `sqlite_master` row could only carry if something other than this
   * engine wrote it, or if the text were truncated. Each must yield nothing rather
   * than a partial table.
   */
  test("a head with no column list after it yields nothing", () => {
    for (const ddl of ["CREATE TABLE ", "CREATE TABLE (id INTEGER)", "CREATE TABLE orders AS SELECT 1"]) {
      expect(parseSqliteTableDdl(ddl).columns, ddl).toEqual([]);
    }
  });

  test("reads a schema-qualified name and the optional IF NOT EXISTS", () => {
    const columns = parseSqliteTableDdl('CREATE TABLE IF NOT EXISTS main."odd table" (id INTEGER)').columns;

    expect(columns.map((column) => column.name)).toEqual(["id"]);
  });

  test("an unterminated quote or parenthesis is read to the end rather than throwing", () => {
    expect(parseSqliteTableDdl('CREATE TABLE "orders (id INTEGER)').columns).toEqual([]);
    expect(parseSqliteTableDdl("CREATE TABLE orders (id INTEGER").columns.map((column) => column.name)).toEqual(["id"]);
  });

  test("a doubled quote inside an identifier is one character of the name", () => {
    const columns = parseSqliteTableDdl('CREATE TABLE orders ("od""d" INTEGER)').columns;

    expect(columns.map((column) => column.name)).toEqual(['od"d']);
  });

  test("an item whose first token names nothing is skipped, not read as a column", () => {
    const columns = parseSqliteTableDdl("CREATE TABLE orders ('quoted', id INTEGER)").columns;

    expect(columns.map((column) => column.name)).toEqual(["id"]);
  });
});

describe("parseSqliteTableDdl — foreign keys", () => {
  test("reads an inline REFERENCES clause", () => {
    const ddl = storedDdl(
      [
        "CREATE TABLE customers (id INTEGER PRIMARY KEY)",
        "CREATE TABLE orders (id INTEGER, customer_id INTEGER REFERENCES customers (id))",
      ],
      "orders",
    );

    expect(parseSqliteTableDdl(ddl).foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
  });

  test("reads a table-level FOREIGN KEY clause, pairing the columns by position", () => {
    const ddl = storedDdl(
      [
        "CREATE TABLE parents (a INTEGER, b INTEGER, PRIMARY KEY (a, b))",
        "CREATE TABLE children (x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES parents (a, b))",
      ],
      "children",
    );

    expect(parseSqliteTableDdl(ddl).foreignKeys).toEqual([
      { columnName: "x", referencedTable: "parents", referencedColumn: "a" },
      { columnName: "y", referencedTable: "parents", referencedColumn: "b" },
    ]);
  });

  test("reads a named CONSTRAINT ... FOREIGN KEY the same way", () => {
    const ddl = storedDdl(
      [
        "CREATE TABLE customers (id INTEGER PRIMARY KEY)",
        "CREATE TABLE orders (id INTEGER, customer_id INTEGER, " +
          "CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE)",
      ],
      "orders",
    );

    expect(parseSqliteTableDdl(ddl).foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
  });

  test("an omitted referenced column is named as the implicit primary key, not guessed", () => {
    const ddl = storedDdl(
      [
        "CREATE TABLE customers (id INTEGER PRIMARY KEY)",
        "CREATE TABLE orders (customer_id INTEGER REFERENCES customers)",
      ],
      "orders",
    );

    expect(parseSqliteTableDdl(ddl).foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "(primary key)" },
    ]);
  });
});

describe("parseSqliteIndexDdl", () => {
  test("reads the indexed columns and whether the index is unique", () => {
    const ddl = storedDdl(
      ["CREATE TABLE orders (id INTEGER, total REAL, code TEXT)", "CREATE INDEX orders_total ON orders (total, id)"],
      "orders_total",
    );

    expect(parseSqliteIndexDdl(ddl)).toEqual({ columns: ["total", "id"], unique: false });
  });

  test("a unique index says so", () => {
    const ddl = storedDdl(
      ["CREATE TABLE orders (code TEXT)", "CREATE UNIQUE INDEX orders_code ON orders (code)"],
      "orders_code",
    );

    expect(parseSqliteIndexDdl(ddl)).toEqual({ columns: ["code"], unique: true });
  });

  test("collation and direction modifiers are dropped, the column name is not", () => {
    const ddl = storedDdl(
      [
        "CREATE TABLE orders (code TEXT, total REAL)",
        "CREATE INDEX orders_sorted ON orders (code COLLATE NOCASE ASC, total DESC)",
      ],
      "orders_sorted",
    );

    expect(parseSqliteIndexDdl(ddl)?.columns).toEqual(["code", "total"]);
  });

  test("a partial index's WHERE clause is not read as a column", () => {
    const ddl = storedDdl(
      ["CREATE TABLE orders (total REAL, open INTEGER)", "CREATE INDEX orders_open ON orders (total) WHERE open = 1"],
      "orders_open",
    );

    expect(parseSqliteIndexDdl(ddl)?.columns).toEqual(["total"]);
  });

  test("an expression index keeps the expression text rather than dropping the index", () => {
    const ddl = storedDdl(
      ["CREATE TABLE orders (code TEXT)", "CREATE INDEX orders_lower ON orders (lower(code))"],
      "orders_lower",
    );

    expect(parseSqliteIndexDdl(ddl)?.columns).toEqual(["lower(code)"]);
  });

  test("text carrying no column list is refused rather than reported as an index on nothing", () => {
    expect(parseSqliteIndexDdl("CREATE INDEX broken ON orders")).toBeNull();
    expect(parseSqliteIndexDdl("")).toBeNull();
  });
});

describe("parseSqliteTableDdl — constraint-created indexes (#502)", () => {
  /**
   * The measurement this whole group exists for: SQLite stores NO DDL for the index
   * it builds to enforce a `UNIQUE` constraint, so the composed index read — which
   * is `sql IS NOT NULL` — cannot see it, while `PRAGMA index_list` can. The agent
   * path cannot use a pragma at all (the statement guard refuses every `PRAGMA_`
   * word), which is why the table's own DDL is where these indexes come from.
   */
  test("SQLite stores no DDL for a UNIQUE constraint's index, so the composed read misses it", () => {
    const database = new Database(":memory:");
    try {
      database.run("CREATE TABLE parents (id INTEGER PRIMARY KEY)");
      database.run("CREATE TABLE kids (id INTEGER PRIMARY KEY, parent_id INTEGER UNIQUE REFERENCES parents (id))");

      const all = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
        sql: string | null;
      }[];
      expect(all).toEqual([{ name: "sqlite_autoindex_kids_1", sql: null }]);

      // The engine knows the index exists; the inventory the agent can compose does not.
      expect(database.prepare("PRAGMA index_list(kids)").all()).toHaveLength(1);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all()).toEqual(
        [],
      );
    } finally {
      database.close();
    }
  });

  test("an inline UNIQUE column yields one implicit index over that column", () => {
    const ddl = storedDdl(
      [
        "CREATE TABLE parents (id INTEGER PRIMARY KEY)",
        "CREATE TABLE kids (id INTEGER PRIMARY KEY, parent_id INTEGER UNIQUE REFERENCES parents (id))",
      ],
      "kids",
    );

    // Named for what created it, not as though the user had created an index: the
    // engine's own `sqlite_autoindex_kids_1` is not reproducible from the DDL (a
    // named `CONSTRAINT` does NOT lend the index its name, and the numbering counts
    // constraints this reader does not all model), so inventing it would be a guess.
    expect(parseSqliteTableDdl(ddl).indexes).toEqual([
      { name: "(unique constraint)", columns: ["parent_id"], unique: true },
    ]);
  });

  test("a table-level UNIQUE keeps its column ORDER, so a prefix test can use it", () => {
    const ddl = storedDdl(["CREATE TABLE kids (parent_id INTEGER, note TEXT, UNIQUE (parent_id, note))"], "kids");

    expect(parseSqliteTableDdl(ddl).indexes).toEqual([
      { name: "(unique constraint)", columns: ["parent_id", "note"], unique: true },
    ]);
  });

  test("a named CONSTRAINT … UNIQUE, and a quoted column, are read the same way", () => {
    const ddl = storedDdl(['CREATE TABLE kids ("odd name" INTEGER, CONSTRAINT uq_kids UNIQUE ("odd name"))'], "kids");

    expect(parseSqliteTableDdl(ddl).indexes).toEqual([
      { name: "(unique constraint)", columns: ["odd name"], unique: true },
    ]);
  });

  test("every UNIQUE constraint is reported, and nothing else is", () => {
    const ddl = storedDdl(
      ["CREATE TABLE kids (a INTEGER UNIQUE, b INTEGER, c INTEGER, CHECK (c > 0), UNIQUE (b, c))"],
      "kids",
    );

    expect(parseSqliteTableDdl(ddl).indexes.map((index) => index.columns)).toEqual([["a"], ["b", "c"]]);
  });

  test("a modifier on the constrained column is dropped, as it is for a user index", () => {
    // Measured against the engine: an EXPRESSION cannot appear here at all —
    // `UNIQUE (lower(a))` is refused with "expressions prohibited in PRIMARY KEY and
    // UNIQUE constraints" — so a modifier is the only thing that can follow the name,
    // and it is dropped exactly as `parseSqliteIndexDdl` drops it on a user index.
    const ddl = storedDdl(["CREATE TABLE kids (parent_id TEXT, UNIQUE (parent_id COLLATE NOCASE DESC))"], "kids");

    expect(parseSqliteTableDdl(ddl).indexes).toEqual([
      { name: "(unique constraint)", columns: ["parent_id"], unique: true },
    ]);
  });

  test("a PRIMARY KEY is NOT synthesised, and a plain column yields nothing", () => {
    // The primary key is read from the COLUMN inventory (`isPrimary`), and an
    // `INTEGER PRIMARY KEY` is the rowid itself with no index behind it — so an
    // index row for it would be an object that does not exist.
    const rowid = storedDdl(["CREATE TABLE kids (id INTEGER PRIMARY KEY, parent_id INTEGER)"], "kids");
    expect(parseSqliteTableDdl(rowid).indexes).toEqual([]);

    const composite = storedDdl(["CREATE TABLE kids (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID"], "kids");
    expect(parseSqliteTableDdl(composite).indexes).toEqual([]);
  });

  test("text that is not a CREATE TABLE yields no indexes either", () => {
    expect(parseSqliteTableDdl("CREATE VIEW v AS SELECT 1").indexes).toEqual([]);
  });
});
