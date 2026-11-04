import { describe, expect, test } from "bun:test";
import { hasUnreadableRun, isDangerousQuery } from "@/lib/sql/dangerous-query";

/**
 * The confirmation gate's own module, `src/lib/sql/dangerous-query.ts`.
 *
 * `hasUnreadableRun` is the one question the gate asks before it reads a keyword, and the safety dialog asks it again
 * to say why it is asking, so both read it here rather than each spelling it out.
 */
describe("hasUnreadableRun", () => {
  test("a literal that never closes is unreadable", () => {
    expect(hasUnreadableRun("SELECT 'abc", "postgres")).toBe(true);
  });

  test("a lone carriage return in a line comment is unreadable", () => {
    expect(hasUnreadableRun("SELECT 1 -- note\rDELETE FROM t", "postgres")).toBe(true);
  });

  test("a statement whose runs all close is readable", () => {
    expect(hasUnreadableRun("SELECT 1", "postgres")).toBe(false);
    expect(hasUnreadableRun("SELECT 1 -- note\r\nFROM t", "postgres")).toBe(false);
  });

  test("text that is not SQL is never read as SQL, so its escaped quote is no unreadable run", () => {
    const document = '{"collection":"users","operation":"find","filter":{"msg":"say \\"hi\\""}}';
    expect(hasUnreadableRun(document, "mongodb")).toBe(false);
    // The control: read as SQL, the same document's escaped quote is a literal that never closes.
    expect(hasUnreadableRun(document, "postgres")).toBe(true);
  });

  test("no type at all reads the text as SQL", () => {
    expect(hasUnreadableRun("SELECT 'abc")).toBe(true);
    expect(hasUnreadableRun("SELECT 1 -- note\rDELETE FROM t")).toBe(true);
    expect(hasUnreadableRun("SELECT 1")).toBe(false);
  });

  test("the gate asks about an unreadable run before it reads a keyword", () => {
    // Neither text names a write the gate could read, so only the unreadable run makes it ask.
    expect(isDangerousQuery("SELECT 'abc", "postgres")).toBe(true);
    expect(isDangerousQuery("SELECT 1 -- note\rFROM t", "postgres")).toBe(true);
    expect(isDangerousQuery("SELECT 1", "postgres")).toBe(false);
  });
});

describe("isDangerousQuery at the analyze route's bound of 1,000,000 units", () => {
  test("follows an EXPLAIN chain to the statement it executes", () => {
    // Read one call deeper per EXPLAIN, V8 ran out of stack a few thousand in. Bun's engine does not show that, so the
    // VS Code extension's query/target suite, which runs under Node, pins it too.
    expect(isDangerousQuery(`${"EXPLAIN ANALYZE ".repeat(62_500)}DELETE FROM t`, "postgres")).toBe(true);
    expect(isDangerousQuery(`${"EXPLAIN ANALYZE ".repeat(62_500)}SELECT 1`, "postgres")).toBe(false);
  });
});
