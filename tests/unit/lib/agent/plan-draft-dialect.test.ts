import { describe, expect, test } from "bun:test";
import { readPlanStatement } from "@/lib/agent/plan-draft";

/**
 * The unfenced reader's SQL cut is a dialect question, and it was asking it without one.
 *
 * `readPlanStatement(text, dialect)` already holds the connection's own dialect — it is
 * what `fencedBlock` checks a fence tag against, and its docblock talks about stamping
 * "the connection's own dialect" on an untagged fence. The second cut, the one that ends
 * an unfenced statement where the SQL ends, called `splitStatements(candidate)` with no
 * grammar, so it read every model's draft under the compatibility default.
 *
 * That is not a cosmetic inconsistency. Where a statement ENDS is exactly what the
 * grammar record decides, and the two answers differ on shipped engines: `//` is a line
 * comment in CQL and in ClickHouse (measured 2026-08-25 on Cassandra 5.0.9, ScyllaDB
 * 2026.2.4 and ClickHouse 26.7.1) and is code or an operator name everywhere else. So a
 * draft whose comment carried a `;` was cut at that `;` and the run recorded HALF the
 * statement as its deliverable — a shortfall reported against a model that wrote a
 * perfectly good statement.
 */
describe("the unfenced cut reads the connection's own dialect", () => {
  // ClickHouse first, because there the whole line is not merely one statement to the
  // splitter but a statement the server runs: measured on 26.7.1,
  // `SELECT 1 AS a // note; SELECT 999` answers `1` with no error, while
  // `SELECT 1; DROP TABLE nope` is refused with "Multi-statements are not allowed".
  test("a `//` comment carrying a semicolon does not end the statement on ClickHouse", () => {
    const text = "SELECT count() FROM events // rows; not a second statement";

    expect(readPlanStatement(text, "clickhouse")).toEqual({
      kind: "statement",
      sql: "SELECT count() FROM events // rows; not a second statement",
      tag: undefined,
    });
  });

  // The sharper shape, because the dialect-blind reading here does not merely keep too
  // much - it throws the FROM clause away and records `SELECT id` as what the run
  // delivered.
  test("a wrapped statement whose comment hides a semicolon survives on Cassandra", () => {
    const text = "SELECT id\nFROM probe.customers // note; DROP TABLE probe.customers";

    expect(readPlanStatement(text, "cassandra")).toEqual({
      kind: "statement",
      sql: "SELECT id\nFROM probe.customers // note; DROP TABLE probe.customers",
      tag: undefined,
    });
    // What the same text answered before the dialect reached the cut, kept as the
    // contrast rather than described: a deliverable missing its FROM clause.
    expect(readPlanStatement(text)).toEqual({ kind: "statement", sql: "SELECT id", tag: undefined });
  });

  // The other direction, and the reason this is a per-dialect fact rather than a widened
  // reading: `//` is an operator NAME in PostgreSQL (`SELECT 1 // 2` is "operator does
  // not exist: integer // integer" on 18, not a syntax error), so the `;` after it
  // really is where the statement ends and the tail really is a second one.
  test("a dialect without the form still ends the statement at that semicolon", () => {
    const text = "SELECT id FROM t // note; DROP TABLE t";

    expect(readPlanStatement(text, "postgres")).toEqual({
      kind: "statement",
      sql: "SELECT id FROM t // note",
      tag: undefined,
    });
  });

  // A draft with no dialect at all is what an untagged, connectionless call still gets,
  // and it keeps the compatibility default the rest of `lib/sql` applies - a decision,
  // pinned, not an absence.
  test("a call that names no dialect keeps the compatibility reading", () => {
    // The default's own hybrid `#` rule, asserted rather than assumed: a plainly-written
    // hash comment IS a comment there, so the `;` inside it is not a boundary and the
    // whole line is the draft. That is what a dialect-less call answered before this
    // threading and what it answers after.
    const hidden = "SELECT 1 # note; SELECT 2";

    expect(readPlanStatement(hidden)).toEqual({ kind: "statement", sql: hidden, tag: undefined });
    // And the operator-tailed spelling, which the same default reads as code - so there
    // the `;` is a boundary and the tail is a second statement.
    expect(readPlanStatement("SELECT meta #> '{a}'; SELECT 2")).toEqual({
      kind: "statement",
      sql: "SELECT meta #> '{a}'",
      tag: undefined,
    });
  });

  // The fenced path was already dialect-aware and must stay untouched by the threading:
  // a tag naming ANOTHER engine is still rejected, so the relaxed unfenced reading below
  // it is what answers.
  test("threading the dialect changes nothing about the fenced path", () => {
    const fenced = "```sql\nSELECT count() FROM events // rows; tail\n```";

    expect(readPlanStatement(fenced, "clickhouse")).toEqual({
      kind: "statement",
      sql: "SELECT count() FROM events // rows; tail",
      tag: "sql",
    });
  });
});
