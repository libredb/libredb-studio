/**
 * Which comments are not comments (#373 review).
 *
 * Every other reader in `src/lib/sql` treats a comment as trivia, and is right to.
 * This one answers the opposite question: does this statement carry a comment the
 * ENGINE acts on? A hint block under `pg_hint_plan` is an optimizer directive, so
 * two statements that differ only in one are two different statements to the
 * planner — which is exactly what a canonical join must not merge.
 */

import { describe, test, expect } from "bun:test";
import { hasOptimizerHint } from "@/lib/sql/optimizer-hints";

describe("hasOptimizerHint", () => {
  test("an ordinary statement carries none", () => {
    expect(hasOptimizerHint("SELECT region, SUM(net_total) FROM orders GROUP BY region")).toBe(false);
  });

  test("an ordinary comment is still trivia", () => {
    expect(hasOptimizerHint("/* the monthly rollup */ SELECT 1")).toBe(false);
    expect(hasOptimizerHint("SELECT 1 -- the monthly rollup")).toBe(false);
  });

  test("a pg_hint_plan block hint is a directive", () => {
    expect(hasOptimizerHint("/*+ SeqScan(orders) */ SELECT * FROM orders")).toBe(true);
  });

  test("a hint anywhere in the statement counts, not only a leading one", () => {
    // `pg_hint_plan` reads the head of the statement, but Oracle's hints sit after
    // the leading keyword and a reader that only looked at position 0 would miss
    // them. The predicate is about presence, and presence is enough to refuse.
    expect(hasOptimizerHint("SELECT /*+ INDEX(o ix_orders) */ * FROM orders o")).toBe(true);
  });

  test("an Oracle line hint is a directive", () => {
    expect(hasOptimizerHint("SELECT --+ FULL(o)\n * FROM orders o")).toBe(true);
  });

  test("a MySQL executable comment is a directive", () => {
    // A comment opening with an exclamation mark is not a comment at all on MySQL
    // and MariaDB: the server executes its body. Nothing this milestone serves
    // reads one, and it is refused anyway rather than left for the engine that
    // arrives later.
    expect(hasOptimizerHint("SELECT /*!40001 SQL_NO_CACHE */ * FROM orders")).toBe(true);
  });

  test("the marker needs no space after it", () => {
    expect(hasOptimizerHint("SELECT 1 /*+SeqScan(orders)*/")).toBe(true);
  });

  test("a marker inside a literal or a quoted name is not a hint", () => {
    // The whole reason this reads spans instead of matching text: the characters
    // that open a hint are ordinary characters inside a string.
    expect(hasOptimizerHint("SELECT '/*+ SeqScan(orders) */' AS note")).toBe(false);
    expect(hasOptimizerHint('SELECT "/*+ SeqScan(orders) */" FROM t')).toBe(false);
  });

  test("a comment that only looks like one is not a hint", () => {
    expect(hasOptimizerHint("SELECT 1 /*-not-a-hint*/")).toBe(false);
    expect(hasOptimizerHint("SELECT 1 ---not-a-hint")).toBe(false);
  });

  test("an unterminated hint is still a hint", () => {
    // The span reader reports the unclosed run; refusing it is the safe direction,
    // and the statement guard refuses such text downstream anyway.
    expect(hasOptimizerHint("SELECT 1 /*+ SeqScan(orders)")).toBe(true);
  });

  test("empty text carries none", () => {
    expect(hasOptimizerHint("")).toBe(false);
  });
});
