import { describe, expect, test } from "bun:test";
import { resolveUpdateTarget, selectsPlainColumn } from "@/lib/sql/update-target";

// Inline grid editing writes `UPDATE <table> SET ...`, and this decides what `<table>`
// may be. It used to be the tab's title, which is free text and outlives the query it was
// created for: where the title named another real table carrying the same key column, the
// write landed there and nothing said so (#881). The rule now is that the rows' own query
// names the table or nobody does.
//
// The shapes below are not hypotheses. Every WRONG-TABLE row is an input that made an
// earlier draft of this module answer with a real table the query does not read — the
// same defect as #881, reached through the reader instead of through the tab title.

const table = (sql: string, type?: Parameters<typeof resolveUpdateTarget>[1]) => {
  const target = resolveUpdateTarget(sql, type);
  return target.kind === "table" ? target.table : `REFUSED: ${target.reason}`;
};

const refused = (sql: string, type?: Parameters<typeof resolveUpdateTarget>[1]) =>
  resolveUpdateTarget(sql, type).kind === "refused";

describe("resolveUpdateTarget", () => {
  describe("the table a single-table SELECT reads", () => {
    test("reads a plain select", () => {
      expect(table("SELECT * FROM users")).toBe("users");
      expect(table("select id, name from users where id = 1")).toBe("users");
    });

    test("keeps a schema-qualified name whole", () => {
      expect(table("SELECT * FROM public.users")).toBe("public.users");
      expect(table("SELECT * FROM catalog.public.users")).toBe("catalog.public.users");
    });

    test("drops an alias", () => {
      expect(table("SELECT u.id FROM users u ORDER BY u.id")).toBe("users");
      expect(table("SELECT * FROM users AS u")).toBe("users");
      expect(table("SELECT * FROM public.users AS u WHERE u.id = 1")).toBe("public.users");
    });

    test("reads across newlines, comments and a trailing semicolon", () => {
      expect(table("SELECT *\n  FROM orders\n WHERE total > 10;")).toBe("orders");
      expect(table("-- the day's orders\nSELECT * FROM orders")).toBe("orders");
      expect(table("SELECT * FROM orders /* only the big ones */ WHERE total > 10")).toBe("orders");
    });

    test("keeps the quoting the query itself used", () => {
      // The app's own generated query quotes a name that needs it, and an engine that
      // needed the quotes needs them in the UPDATE too. Handing the reference back
      // exactly as written is what serves a mixed-case PostgreSQL table and a lowercase
      // Oracle one at once, without this module deciding to quote anything.
      expect(table(`SELECT * FROM "Orders"`)).toBe(`"Orders"`);
      expect(table(`SELECT * FROM "public"."Orders" WHERE id = 1`)).toBe(`"public"."Orders"`);
      expect(table("SELECT * FROM `orders` LIMIT 50", "mysql")).toBe("`orders`");
      expect(table("SELECT TOP 50 * FROM [dbo].[users]", "mssql")).toBe("[dbo].[users]");
      expect(table(`SELECT * FROM public."Orders"`)).toBe(`public."Orders"`);
    });

    test("reads the shapes the app's own table-click generates", () => {
      expect(table("SELECT * FROM users LIMIT 50;")).toBe("users");
      expect(table("SELECT * FROM users FETCH FIRST 50 ROWS ONLY", "oracle")).toBe("users");
      expect(table("SELECT TOP 50 * FROM users;", "mssql")).toBe("users");
    });

    test("is not fooled by a table named after a clause keyword", () => {
      // The clause words are matched as WORDS, so a table whose name merely starts with
      // one is an ordinary table: `limits` is not `LIMIT`.
      expect(table("SELECT * FROM limits")).toBe("limits");
      expect(table("SELECT * FROM offsets WHERE id = 1")).toBe("offsets");
      expect(table("SELECT * FROM public.window_events")).toBe("public.window_events");
      expect(table("SELECT * FROM join_log")).toBe("join_log");
      expect(table("SELECT * FROM union_members")).toBe("union_members");
    });
  });

  describe("a FROM that is not the statement's own", () => {
    // Everything inside parentheses belongs to a subquery or to a function's arguments.
    // Reading those as the statement's FROM is how an ordinary single-table query gets
    // refused, and in one case how a COLUMN became the write target.
    test("ignores a subquery in WHERE", () => {
      expect(table("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)")).toBe("users");
      expect(table("SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.uid = users.id)")).toBe(
        "users",
      );
    });

    test("ignores FROM used as a function argument", () => {
      expect(table("SELECT EXTRACT(YEAR FROM created_at) AS y, id FROM orders")).toBe("orders");
      expect(table("SELECT SUBSTRING(name FROM 1 FOR 3) AS s, id FROM users")).toBe("users");
      expect(table("SELECT TRIM(BOTH ' ' FROM name) AS n, id FROM users")).toBe("users");
    });

    test("refuses a select-list subquery spelled without the word SELECT", () => {
      // `(TABLE t)` is a complete query on PostgreSQL and MySQL, `(FROM t)` is one on
      // DuckDB, and all three declare inline row editing. Measured on each: the column the
      // subquery supplies sits in the grid beside this statement's, the reader answered the
      // base table, and editing that cell overwrote a table that was never on screen. A
      // reader looking for the word SELECT sees none of them.
      expect(refused("SELECT p.id, (TABLE onecol) AS note FROM products p")).toBe(true);
      expect(refused("SELECT p.id, (FROM onecol) AS note FROM products p")).toBe(true);
      expect(refused("SELECT p.id, ((TABLE onecol)) AS note FROM products p")).toBe(true);
      expect(refused("SELECT p.id, (VALUES (1)) AS n FROM products p")).toBe(true);
      // And wherever it sits. Measured on PostgreSQL 16: each of these reads two tables,
      // the grid shows the OTHER table's value, and the write went to the base table.
      expect(
        refused("SELECT p.id, COALESCE(p.note, (SELECT o.note FROM orders o LIMIT 1)) AS note FROM products p"),
      ).toBe(true);
      expect(refused("SELECT p.id, (p.note || (SELECT o.note FROM orders o LIMIT 1)) AS note FROM products p")).toBe(
        true,
      );
      expect(refused("SELECT p.id, (CASE WHEN true THEN (SELECT o.note FROM orders o) END) AS n FROM products p")).toBe(
        true,
      );
      expect(refused("SELECT p.id, COALESCE(p.note, (TABLE onecol)) AS note FROM products p")).toBe(true);
      // And inside a subscript, whose contents are code rather than a name. Measured on
      // PostgreSQL 16 and DuckDB 1.5: each reads the other table and supplied the grid's
      // column, while the reader answered the base table.
      expect(
        refused("SELECT p.id, ARRAY[(SELECT o.note FROM orders o LIMIT 1)] AS note FROM products p", "postgres"),
      ).toBe(true);
      expect(
        refused("SELECT p.id, (ARRAY[(SELECT o.note FROM orders o LIMIT 1)])[1] AS note FROM products p", "postgres"),
      ).toBe(true);
      expect(refused("SELECT p.id, [(SELECT o.note FROM orders o LIMIT 1)] AS note FROM products p", "duckdb")).toBe(
        true,
      );
      // What follows the word is what tells a query from a column that happens to share
      // its name. Measured: `values` is a legal bare column on PostgreSQL 16 and DuckDB
      // 1.5.5, and `with` on SQLite 3.51, so asking about the word alone refused three
      // queries that read one table.
      expect(refused("SELECT p.id, (VALUES (1)) AS n FROM products p")).toBe(true);
      expect(refused("SELECT p.id, (WITH x AS (SELECT 1) SELECT 1) AS n FROM products p")).toBe(true);
      expect(table("SELECT coalesce(values, '') AS c, id FROM users", "postgres")).toBe("users");
      expect(table("SELECT coalesce(values, '') AS c, id FROM users", "duckdb")).toBe("users");
      expect(table("SELECT coalesce(with, '') AS c, id FROM users", "sqlite")).toBe("users");
      // A word that opens a query on DuckDB is an ordinary column name elsewhere, so it is
      // only asked about there.
      expect(refused("SELECT p.id, (PIVOT orders ON k USING max(note)) AS n FROM products p", "duckdb")).toBe(true);
      expect(table("SELECT coalesce(show, '') AS s, id FROM users", "postgres")).toBe("users");
      expect(table("SELECT CAST(show AS text) AS c, id FROM users", "postgres")).toBe("users");
      expect(table("SELECT max(unnest) AS s, id FROM users", "postgres")).toBe("users");
      // An ordinary array literal is not a query, and still reads.
      expect(table("SELECT ARRAY[1, 2] AS a, id FROM users", "postgres")).toBe("users");
      expect(table("SELECT tags[1] AS t, id FROM users", "postgres")).toBe("users");
      // DuckDB's own complete queries, which do not start with SELECT either.
      expect(refused("SELECT p.id, (PIVOT orders ON k USING max(note)) AS n FROM products p", "duckdb")).toBe(true);
      expect(refused("SELECT p.id, (UNPIVOT orders ON a, b) AS n FROM products p", "duckdb")).toBe(true);
      // What tells those from an expression is the first thing inside the group, so an
      // ordinary parenthesised expression or function call still reads.
      expect(table("SELECT (a + b) AS s, id FROM users")).toBe("users");
      expect(table("SELECT coalesce(a, b) AS s, id FROM users")).toBe("users");
    });

    test("refuses a subquery in the SELECT LIST, which supplies a column of its own", () => {
      // Measured on PostgreSQL 16: the grid's `note` column came from `orders`, the reader
      // answered `products`, and editing that cell overwrote `products.note` with a value
      // the user had typed for `orders`. A subquery in WHERE is a different thing - it
      // filters, it supplies no column - and it sits after the FROM, which is what tells
      // the two apart.
      expect(refused("SELECT id, (SELECT count(*) FROM orders) AS n FROM users")).toBe(true);
      expect(
        refused("SELECT p.id, (SELECT o.note FROM orders o WHERE o.product_id = p.id LIMIT 1) AS note FROM products p"),
      ).toBe(true);
      // The WHERE form still reads, because nothing it returns is on screen.
      expect(table("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)")).toBe("users");
    });
  });

  describe("literals and comments are never read as structure", () => {
    test("a keyword inside a string is data", () => {
      expect(table("SELECT * FROM notes WHERE body = 'join orders on x'")).toBe("notes");
      expect(table("SELECT * FROM notes WHERE body = 'a union b'")).toBe("notes");
      expect(table("SELECT * FROM notes WHERE body = 'select 1 from other'")).toBe("notes");
    });

    test("refuses a literal whose closing quote sits behind a backslash", () => {
      // The dialects disagree about `'\'`: PostgreSQL reads a complete literal holding a
      // backslash, MySQL an escaped quote that leaves the literal open. `spans.ts` reports
      // the run as undeterminable rather than taking a side, and undeterminable is a
      // refusal here. It has to be: a reader that guessed "escaped" ran past the real
      // closing quote and took a `from` inside a LATER string for the statement's own,
      // answering with a real table the query never reads.
      expect(refused(String.raw`SELECT '\' AS z, * FROM users WHERE x = 'from evil where y = 1'`)).toBe(true);
      expect(refused(String.raw`SELECT 'a\' AS z, * FROM secrets WHERE note = 'from public_view where 1=1'`)).toBe(
        true,
      );
    });

    test("an apostrophe inside a dollar-quoted body is data", () => {
      expect(table("SELECT $$it's$$ AS note, * FROM users WHERE x = 'from evil where 1=1'")).toBe("users");
    });

    test("a nested block comment closes where PostgreSQL closes it", () => {
      expect(refused("/* a /* b */ from evil */ SELECT 1")).toBe(true);
    });

    test("reads the comment forms the named dialect has", () => {
      // `#` is a comment on MySQL and an operator on PostgreSQL; `//` is a comment on
      // ClickHouse and CQL and nowhere else. The dialect decides, not this file.
      expect(table("SELECT * FROM users # JOIN orders\nWHERE id = 1", "mysql")).toBe("users");
      expect(refused("SELECT * FROM users # JOIN orders\nWHERE id = 1", "postgres")).toBe(true);
    });

    test("refuses a statement that ends inside a quote or a comment", () => {
      expect(refused("SELECT * FROM users WHERE name = 'unclosed")).toBe(true);
      expect(refused("SELECT * FROM users /* unclosed")).toBe(true);
    });
  });

  describe("the shapes whose rows have no single base table", () => {
    test("refuses APPLY, which brings in a second table without a comma or the word JOIN", () => {
      // Measured on SQL Server 2022: `SELECT * FROM products limit CROSS APPLY orders o`
      // reads BOTH tables - `limit` stands as a bare alias there, which ended the table
      // reference early - and the grid showed a column from each. Neither the comma scan
      // nor the JOIN scan could see it, and an edit to the second table's cell was written
      // into the first. Oracle has the same clause.
      expect(refused("SELECT * FROM products limit CROSS APPLY orders o", "mssql")).toBe(true);
      expect(refused("SELECT * FROM products p CROSS APPLY dbo.tvf(p.id) f", "mssql")).toBe(true);
      expect(refused("SELECT * FROM products p OUTER APPLY (SELECT TOP 1 note FROM orders) o", "mssql")).toBe(true);
      expect(refused("SELECT * FROM tprod FOR SYSTEM_TIME AS OF '2099-01-01' CROSS APPLY (SELECT 1) o", "mssql")).toBe(
        true,
      );
    });

    test("refuses a dash run that is only a comment on some engines", () => {
      // MySQL and MariaDB need a whitespace character after the second dash. Measured on
      // MySQL 8.4.11: `WHERE qty=5--1 UNION SELECT id, note FROM zord` returns the OTHER
      // table's row, because `--1` is two minus signs there and the rest of the line is
      // code. The reader read a comment where the engine reads a UNION, and answered the
      // base table - so an edit to a cell `zord` supplied was written into `zprod`.
      expect(refused("SELECT id, note FROM zprod WHERE qty=5--1 UNION SELECT id, note FROM zord", "mysql")).toBe(true);
      expect(
        refused("SELECT p.id, p.qty--1 AS q, (SELECT o.note FROM zord o LIMIT 1) AS note FROM zprod p", "mysql"),
      ).toBe(true);
      // And the whitespace has to be the ENGINE's, not JavaScript's. `\\s` also matches
      // U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF;
      // measured on MariaDB 11.8.9 - which arrives through this same `mysql` id - every one
      // of those is an identifier character, so the dash run is code there and the statement
      // below reads two tables while a reader trusting `\\s` answers one.
      for (const codePoint of [0x00a0, 0x1680, 0x2000, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
        const separator = String.fromCodePoint(codePoint);
        expect(
          refused(`SELECT id, note FROM zprod WHERE qty <> 5--${separator}ZZ UNION SELECT id, note FROM zord`, "mysql"),
        ).toBe(true);
      }
      // A space or a control character is the engine's own set, and each of those is a
      // comment there.
      for (const codePoint of [0x20, 0x09, 0x0b, 0x0c]) {
        const separator = String.fromCodePoint(codePoint);
        expect(table(`SELECT id FROM products --${separator}not orders\nWHERE id = 1`, "mysql")).toBe("products");
      }

      // With the whitespace it is a comment there too, and on every other engine the space
      // is not required at all - measured on PostgreSQL 16, SQL Server 2022, SQLite 3.51
      // and DuckDB 1.5.5.
      expect(table("SELECT id FROM products -- not orders\nWHERE id = 1", "mysql")).toBe("products");
      expect(table("SELECT id FROM products --\tnot orders\nWHERE id = 1", "mysql")).toBe("products");
      expect(table("SELECT id FROM products WHERE qty = 5--1\n", "postgres")).toBe("products");
    });

    test("refuses a comment that ends in a different place on different engines", () => {
      // PostgreSQL and SQL Server end a `--` comment at a bare carriage return; MySQL,
      // MariaDB, SQLite and DuckDB run on to the newline. Measured: the same text reads
      // two tables on the first pair and one on the second, so the span this reader was
      // handed is not the span the engine will read.
      expect(refused("SELECT orders.note FROM products -- x\r, orders")).toBe(true);
      // An ordinary line comment is still a comment - and so is one from a file written on
      // Windows: a CR that is only the one before the newline ends the comment in the same
      // place everywhere, and refusing those would refuse every CRLF file that has one.
      expect(table("SELECT * FROM products -- , orders\nWHERE id = 1")).toBe("products");
      expect(table("SELECT * FROM products -- the note\r\nWHERE id = 1")).toBe("products");
    });

    test("does not call an empty terminator a second statement", () => {
      expect(table("SELECT * FROM users;;")).toBe("users");
      expect(refused("SELECT * FROM users; DROP TABLE users")).toBe(true);
    });

    test("refuses a join, however it is spelled", () => {
      expect(refused("SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id")).toBe(true);
      expect(refused("SELECT * FROM users LEFT OUTER JOIN orders ON orders.user_id = users.id")).toBe(true);
      expect(refused("SELECT * FROM users NATURAL JOIN orders")).toBe(true);
      expect(refused("SELECT * FROM users CROSS JOIN orders")).toBe(true);
      // MySQL's, and MySQL offers row editing: a text search for `JOIN` finds no word
      // boundary inside `STRAIGHT_JOIN` and let a two-table read through as one.
      expect(refused("SELECT * FROM users STRAIGHT_JOIN orders ON orders.uid = users.id", "mysql")).toBe(true);
    });

    test("refuses a comma-separated FROM", () => {
      expect(refused("SELECT * FROM users, orders WHERE orders.user_id = users.id")).toBe(true);
    });

    test("refuses a subquery, a VALUES list and a table function in FROM", () => {
      expect(refused("SELECT * FROM (SELECT * FROM users) t")).toBe(true);
      expect(refused("SELECT * FROM (VALUES (1), (2)) AS t(n)")).toBe(true);
      expect(refused("SELECT * FROM generate_series(1, 10) AS n")).toBe(true);
    });

    test("refuses a common table expression", () => {
      expect(refused("WITH recent AS (SELECT * FROM users) SELECT * FROM recent")).toBe(true);
    });

    test("refuses a set operation", () => {
      expect(refused("SELECT id FROM users UNION SELECT id FROM admins")).toBe(true);
      expect(refused("SELECT id FROM users UNION ALL SELECT id FROM admins")).toBe(true);
      expect(refused("SELECT id FROM users EXCEPT SELECT id FROM admins")).toBe(true);
      expect(refused("SELECT id FROM users INTERSECT SELECT id FROM admins")).toBe(true);
      expect(refused("SELECT id FROM users MINUS SELECT id FROM admins", "oracle")).toBe(true);
      // And only there: `minus` is an ordinary column name on every other engine.
      expect(table("SELECT minus, id FROM users", "postgres")).toBe("users");
    });

    test("refuses a word standing where the table stands", () => {
      // `FROM ONLY products` reads as a table named ONLY aliased `products`, which is
      // #881 exactly: a real table named by the wrong word. It cannot be told apart from
      // a table genuinely called `only`, so both refuse.
      expect(refused("SELECT * FROM ONLY products WHERE id = 1")).toBe(true);
      expect(refused("SELECT * FROM LATERAL unnest(a)")).toBe(true);
    });

    test("refuses a single-table query whose later clause names a column ending in _join", () => {
      // The join test matches an identifier ENDING in `_join`, because `STRAIGHT_JOIN` has
      // no word boundary before `JOIN`. The price is this: one table, refused.
      expect(refused("SELECT * FROM logs ORDER BY last_join")).toBe(true);
    });

    test("refuses a table reference longer than a name and its alias", () => {
      expect(refused("SELECT * FROM orders@remote")).toBe(true);
      expect(refused("SELECT * FROM users u v w")).toBe(true);
    });

    test("reads a sampled or qualified table, which is still one table's rows", () => {
      // The scans that look for a second table run over everything after FROM, so ending
      // the NAME at one of these words cannot hide anything - which is what lets them stay
      // on the list and these two ordinary queries be read rather than refused.
      expect(table("SELECT * FROM users TABLESAMPLE SYSTEM (10)")).toBe("users");
      expect(table("SELECT * FROM t QUALIFY row_number() OVER () = 1")).toBe("t");
    });

    test("refuses a comma hiding behind a word that can be an alias", () => {
      // Measured: `SELECT product_id, orders.note FROM products for, orders` is a legal
      // cross join on SQLite 3.51, and `note` comes from `orders` — so reading `for` as the
      // FOR clause put the comma out of sight and answered `products`, and an edit to that
      // cell overwrote a table it did not come from. MySQL 8.4 does the same with `offset`.
      expect(refused("SELECT product_id, orders.note FROM products for, orders")).toBe(true);
      expect(refused("SELECT * FROM products offset, orders")).toBe(true);
      expect(refused("SELECT * FROM products fetch, orders")).toBe(true);
      expect(refused("SELECT * FROM products window, orders")).toBe(true);
      expect(refused("SELECT * FROM products AS offset, orders")).toBe(true);
    });

    test("refuses an executable comment, which only the engine runs", () => {
      // Measured on MySQL 8.4.11 and MariaDB 13.0.2: each of these is a TWO-table read on
      // the engine that owns the form and an ordinary comment everywhere else, so a reader
      // that skips them is reading a different statement than the one that will run.
      expect(refused("SELECT count(*) FROM products /*! , orders */", "mysql")).toBe(true);
      expect(refused("SELECT count(*) FROM products /*!80000 , orders */", "mysql")).toBe(true);
      expect(refused("SELECT count(*) FROM products /*! STRAIGHT_JOIN orders ON 1=1 */", "mysql")).toBe(true);
      // MariaDB's own second spelling. It reaches this code through the `mysql` type id,
      // which is the documented way to connect to a MariaDB server, and `mariadb-dump`
      // writes it - so a pasted dump carries it without anyone choosing to.
      expect(refused("SELECT count(*) FROM products /*M! , orders */", "mysql")).toBe(true);
      expect(refused("SELECT count(*) FROM products /*M!100000 , orders */", "mysql")).toBe(true);
      expect(refused("SELECT count(*) FROM products /*M! STRAIGHT_JOIN orders ON 1=1 */", "mysql")).toBe(true);
      // Lowercase `/*m!` is a plain comment on both engines, and an ordinary block comment
      // is a comment everywhere.
      expect(table("SELECT count(*) FROM products /*m! , orders */", "mysql")).toBe("products");
      expect(table("SELECT count(*) FROM products /* , orders */", "mysql")).toBe("products");
      // The text only counts as code where it IS code: inside a literal it is a value.
      expect(table("SELECT * FROM products WHERE note = '/*! , orders */'", "mysql")).toBe("products");
    });

    test("says which of the two it could not read", () => {
      const unterminated = resolveUpdateTarget("SELECT * FROM users /* unclosed");
      const executable = resolveUpdateTarget("SELECT * FROM users /*! , orders */");
      expect(unterminated.kind === "refused" && unterminated.reason).toContain("cannot find where");
      expect(executable.kind === "refused" && executable.reason).toContain("run as code");
    });

    test("refuses a join hiding behind a word that can be an alias", () => {
      // All three read two tables on PostgreSQL 16 and answered with one of them, because
      // the join sat past the point where the table reference was assumed to end.
      expect(refused("SELECT count(*) FROM products TABLESAMPLE SYSTEM (10) JOIN orders ON true")).toBe(true);
      expect(refused("SELECT count(*) FROM products TABLESAMPLE SYSTEM (10), orders")).toBe(true);
      expect(refused("SELECT count(*) FROM products qualify JOIN orders ON true")).toBe(true);
    });

    test("reads MySQL's two-argument LIMIT, and still refuses the alias it could hide", () => {
      // `LIMIT 0, 50` is the everyday MySQL and MariaDB paging idiom and it reads one
      // table, so ending the comma scan at ORDER and GROUP alone refused a query the tab
      // title read correctly - inline editing went from working to refused on those tabs.
      //
      // `LIMIT` cannot join ORDER and GROUP on the strength of the word: it is a
      // NON-RESERVED word on Oracle and can stand as a bare alias, which is the shape
      // that hides a comma. What tells the two apart is not the word but what FOLLOWS
      // it. An alias that hides a table comma is followed by that comma, and a real
      // LIMIT clause never is. `(` is excluded with the comma, because a derived column
      // list (`FROM products limit (a, b), orders`) holds its own commas below the top
      // level and would put the one that matters out of the scan.
      expect(table("SELECT * FROM users LIMIT 0, 50", "mysql")).toBe("users");
      expect(table("SELECT * FROM users limit 0, 50", "sqlite")).toBe("users");
      expect(refused("SELECT * FROM products limit, orders")).toBe(true);
      expect(refused("SELECT * FROM products AS limit, orders")).toBe(true);
      expect(refused("SELECT * FROM products limit (a, b), orders")).toBe(true);
      // The paginated forms the app itself generates carry no comma and still read.
      expect(table("SELECT * FROM users LIMIT 500 OFFSET 500", "mysql")).toBe("users");
    });

    test("still reads a single table when a later clause carries commas", () => {
      // The comma scan ends at the first clause that legitimately holds a list, so a list
      // in ORDER BY or GROUP BY is not read as a second table. HAVING is not one of them:
      // it carries no top-level comma of its own in valid SQL.
      expect(table("SELECT * FROM users ORDER BY name, id")).toBe("users");
      expect(table("SELECT city, count(*) FROM users GROUP BY city, country")).toBe("users");
      expect(table("SELECT city, count(*) FROM users GROUP BY city HAVING count(*) > 1 ORDER BY city, country")).toBe(
        "users",
      );
      // And the paginated shapes the app itself generates still read, since none of them
      // carries a comma at all.
      expect(table("SELECT * FROM users LIMIT 10 OFFSET 20")).toBe("users");
      expect(table("SELECT * FROM users FETCH FIRST 50 ROWS ONLY", "oracle")).toBe("users");
      expect(table("SELECT * FROM users FOR UPDATE")).toBe("users");
    });
  });

  describe("statements that are not a single SELECT", () => {
    test("refuses a write, whatever it returns", () => {
      // Each of these produced a table name before, and in every case it was not the
      // table whose rows the grid is showing.
      expect(refused("INSERT INTO audit SELECT * FROM staging RETURNING *")).toBe(true);
      expect(refused("UPDATE a SET x = b.x FROM b WHERE a.id = b.id RETURNING *")).toBe(true);
      expect(refused("DELETE FROM users WHERE id = 1 RETURNING *")).toBe(true);
    });

    test("refuses more than one statement in the tab", () => {
      expect(refused("SELECT * FROM users; DROP TABLE users")).toBe(true);
      expect(refused("SELECT 1; SELECT * FROM users")).toBe(true);
    });

    test("refuses text that is not SQL at all", () => {
      // The same editor carries MongoDB documents and Redis commands, and this reader is
      // handed whatever is in the tab.
      expect(refused('{ "collection": "users", "operation": "find" }')).toBe(true);
      expect(refused("HGETALL users:1")).toBe(true);
      expect(refused("get users:1")).toBe(true);
      expect(refused("")).toBe(true);
    });

    test("refuses a SELECT that reads no table", () => {
      expect(refused("SELECT 1")).toBe(true);
      expect(refused("SELECT now()")).toBe(true);
    });
  });

  describe("names that cannot be written into a statement", () => {
    test("refuses an unquoted name that is not a bare identifier", () => {
      // An unquoted part goes into the UPDATE as-is, so it has to be a name. Quoting it
      // instead would change its case semantics and break a lowercase Oracle table.
      expect(refused("SELECT * FROM müşteriler")).toBe(true);
      expect(refused("SELECT * FROM 9lives")).toBe(true);
    });

    test("refuses a dangling qualifier", () => {
      expect(refused("SELECT * FROM public. WHERE id = 1")).toBe(true);
    });

    test("refuses text that does not parse", () => {
      // The editor holds whatever the user has typed so far, and half a statement is the
      // ordinary state of one being written. None of these has a table to name, and a
      // reader that answered anyway would be guessing at text nobody has finished.
      expect(refused("SELECT * FROM")).toBe(true);
      expect(refused("SELECT * FROM WHERE id = 1")).toBe(true);
      expect(refused("SELECT * FROM users FROM orders")).toBe(true);
    });
  });

  // Every reason below is shown to a person as "<reason>. Edit the SQL manually." — so
  // each one has to be true of THEIR query, not merely true of the rule that fired. The
  // wide scans are deliberately wider than the shape they look for, which is what keeps a
  // join or a comma from hiding behind a word that can be an alias; where they fire
  // outside the table reference, the honest claim is that a second table cannot be ruled
  // out, not that there is one.
  describe("the reason a person is shown", () => {
    const reason = (sql: string, type?: Parameters<typeof resolveUpdateTarget>[1]) => {
      const target = resolveUpdateTarget(sql, type);
      return target.kind === "refused" ? target.reason : `RESOLVED: ${target.table}`;
    };

    test("does not claim a join it cannot be sure of", () => {
      // A real join and a column named `last_join` in an ORDER BY get the SAME sentence,
      // and that is the point: this reader cannot tell them apart, so it says what it did
      // rather than asserting a join the second query does not have.
      const joined = reason("SELECT * FROM users u JOIN orders o ON o.user_id = u.id");
      const named = reason("SELECT * FROM logs ORDER BY last_join");
      expect(joined).toContain("reads to this editor as a second table");
      expect(named).toBe(joined);
      expect(named).not.toContain("joins tables");
    });

    test("does not claim a second table it cannot be sure of", () => {
      // Same shape: `FROM users, orders` really does read two tables and PostgreSQL's
      // `FOR UPDATE OF a, b` really does not, and the comma is the only thing this reader
      // sees. (MySQL's `LIMIT 10, 20` used to stand here; it now resolves, because what
      // follows `LIMIT` tells its comma apart from a table list - see the LIMIT test.)
      const two = reason("SELECT * FROM users, orders");
      const forUpdate = reason("SELECT * FROM t FOR UPDATE OF a, b", "postgres");
      expect(two).toContain("could separate two tables");
      expect(forUpdate).toBe(two);
    });

    test("does not tell a DuckDB FROM-first query it is not a SELECT", () => {
      expect(reason("FROM products SELECT *")).not.toContain("not one");
      expect(reason("FROM products SELECT *")).toContain("FROM-first");
    });

    test("names the set operation for what it is", () => {
      // `SELECT * EXCEPT (id) FROM t` drops a column on DuckDB and ClickHouse, and
      // `SELECT a FROM t EXCEPT (SELECT a FROM u)` combines two queries. Both spell the
      // word followed by a paren, so the message says only what is true of both.
      // On every engine that reaches this reader the word means one thing: ClickHouse's
      // column exclusion cannot get here, and DuckDB spells that `EXCLUDE`.
      expect(reason("SELECT a FROM products EXCEPT (SELECT a FROM orders)")).toContain("combines more than one query");
      expect(reason("SELECT id FROM users EXCEPT SELECT id FROM admins")).toContain("combines more than one query");
    });

    test("does not call a closed comment unclosed", () => {
      expect(reason("SELECT * FROM users /*! , orders */", "mysql")).toContain("run as code");
      // And the one it really cannot find the end of says only that: a `'a\\'` literal is
      // closed on PostgreSQL and open on MySQL, so "unclosed" would be taking a side.
      expect(reason("SELECT * FROM users /* unclosed")).toContain("cannot find where");
    });

    test("does not tell a CTE it is not a SELECT", () => {
      expect(reason("WITH recent AS (SELECT * FROM users) SELECT * FROM recent")).not.toContain("not one");
      expect(reason("WITH recent AS (SELECT * FROM users) SELECT * FROM recent")).toContain("intermediate result");
      expect(reason("DELETE FROM users WHERE id = 1")).toContain("not one");
    });

    test("does not call a real table an absent one", () => {
      // `9lives` is a legal unquoted table on MySQL and `#tmp` a real local temp table on
      // SQL Server. Neither is one this editor will write unquoted, which is a fact about
      // the editor - saying the query names no table would be a claim about the query.
      expect(reason("SELECT * FROM 9lives", "mysql")).toContain("not a name this editor can write");
      expect(reason("SELECT * FROM #tmp", "mssql")).toContain("not a name this editor can write");
    });

    test("does not tell an empty tab it is not a SELECT", () => {
      expect(reason("")).toContain("no statement here to read");
      expect(reason("   \n  -- just a note\n")).toContain("no statement here to read");
    });
  });

  test("gives the caller a reason it can put in front of a person", () => {
    const target = resolveUpdateTarget("SELECT * FROM users u JOIN orders o ON o.user_id = u.id");
    expect(target.kind).toBe("refused");
    if (target.kind === "refused") {
      expect(target.reason).toMatch(/^[A-Z"]/);
      expect(target.reason).not.toMatch(/[.]$/);
      expect(target.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("selectsPlainColumn", () => {
  // The key an inline edit writes against is picked by NAME off the result's field list, and
  // a name is not a provenance. Measured against PostgreSQL 16: `SELECT ROW_NUMBER() OVER
  // (ORDER BY product_name) AS product_id, product_name FROM products` puts 1, 2, 3 in a
  // column called `product_id`, `products` really has a `product_id`, and the two UPDATEs
  // that followed wrote to two rows that were never on screen - reported as accepted.

  test("a star means every field is the table's own", () => {
    expect(selectsPlainColumn("SELECT * FROM products", "product_id")).toBe(true);
    expect(selectsPlainColumn("SELECT p.* FROM products p", "product_id")).toBe(true);
  });

  test("a plain reference is the column, qualified or not", () => {
    expect(selectsPlainColumn("SELECT product_id, sku FROM products", "product_id")).toBe(true);
    expect(selectsPlainColumn("SELECT p.product_id, p.sku FROM products p", "product_id")).toBe(true);
    expect(selectsPlainColumn('SELECT "Id", name FROM users', "Id")).toBe(true);
    // An alias that names the column it already names changes nothing.
    expect(selectsPlainColumn("SELECT product_id AS product_id FROM products", "product_id")).toBe(true);
  });

  test("an expression wearing the column's name is not the column", () => {
    expect(
      selectsPlainColumn(
        "SELECT ROW_NUMBER() OVER (ORDER BY product_name) AS product_id, product_name FROM products",
        "product_id",
      ),
    ).toBe(false);
    expect(selectsPlainColumn("SELECT 1 AS id, name FROM users", "id")).toBe(false);
    expect(selectsPlainColumn("SELECT count(*) AS id FROM users", "id")).toBe(false);
  });

  test("an alias that renames another column is not the column either", () => {
    // Shorter to write and the same defect: the WHERE would carry sku's value.
    expect(selectsPlainColumn("SELECT sku AS product_id, product_name FROM products", "product_id")).toBe(false);
    expect(selectsPlainColumn("SELECT p.sku AS product_id FROM products p", "product_id")).toBe(false);
  });

  test("an alias without the word AS is still an alias", () => {
    // `SELECT sku product_id FROM products` is the same rename with the keyword left out,
    // and every engine that offers inline editing accepts it.
    expect(selectsPlainColumn("SELECT sku product_id, product_name FROM products", "product_id")).toBe(false);
    expect(selectsPlainColumn("SELECT product_id product_id FROM products", "product_id")).toBe(true);
  });

  test("a multiplication is not a star", () => {
    // The hole an adversarial review found: reading any `*` in the item as a star let the
    // whole check be skipped by writing `* 1`. Measured live - the UPDATEs then wrote two
    // products that were never on screen.
    expect(
      selectsPlainColumn(
        "SELECT ROW_NUMBER() OVER (ORDER BY product_name) * 1 AS product_id, product_name FROM products",
        "product_id",
      ),
    ).toBe(false);
    expect(selectsPlainColumn("SELECT product_name, 2 * 1 AS product_id FROM products", "product_id")).toBe(false);
  });

  test("a later item renaming over a star wins, because that is what the driver hands over", () => {
    // Two fields of the same name reach the row object as one, and the LAST one written is
    // the value the grid reads - measured on node-postgres.
    expect(
      selectsPlainColumn("SELECT p.*, ROW_NUMBER() OVER (ORDER BY x) AS product_id FROM products p", "product_id"),
    ).toBe(false);
    expect(selectsPlainColumn("SELECT product_id, sku AS product_id FROM products", "product_id")).toBe(false);
    // And the other way round: the rename comes first, the real column last.
    expect(selectsPlainColumn("SELECT sku AS product_id, product_id FROM products", "product_id")).toBe(true);
  });

  test("row-count keywords are not part of the list", () => {
    expect(selectsPlainColumn("SELECT DISTINCT product_id, sku FROM products", "product_id")).toBe(true);
    expect(selectsPlainColumn("SELECT ALL product_id, sku FROM products", "product_id")).toBe(true);
    expect(selectsPlainColumn("SELECT DISTINCT ON (sku) product_id, sku FROM products", "product_id")).toBe(true);
  });

  test("a reference can carry its schema as well as its table", () => {
    expect(selectsPlainColumn("SELECT public.products.product_id FROM public.products", "product_id")).toBe(true);
    expect(selectsPlainColumn("SELECT p.product_id product_id FROM products p", "product_id")).toBe(true);
  });

  test("a column the select list does not produce at all is refused", () => {
    expect(selectsPlainColumn("SELECT sku, product_name FROM products", "product_id")).toBe(false);
  });

  test("a statement this reader cannot take apart is refused rather than guessed at", () => {
    expect(selectsPlainColumn("SELECT id FROM users /* unclosed", "id")).toBe(false);
    expect(selectsPlainColumn("UPDATE products SET sku = 'x'", "product_id")).toBe(false);
  });
});
