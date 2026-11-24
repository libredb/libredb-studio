/**
 * The one lookup every binding of a declared function name goes through (src/lib/db/function-table.ts): Studio's
 * connection form table, its connection string table, its grammar table and its SQL writing table all bind a name with
 * it, so the refusal sentence and the own-property rule live once, and the SQL writing table builds each slot's table
 * with `slotFunctionTable`.
 */
import { describe, expect, test } from "bun:test";
import { boundFunction, type FunctionTable, slotFunctionTable } from "@/lib/db/function-table";

const hint = (text: string) => `hint for ${text}`;
const TABLE: FunctionTable<(text: string) => string> = Object.freeze({
  snowflake: Object.freeze({ hostHint: hint }),
});

describe("boundFunction", () => {
  test("a name the table holds for the engine is bound, and any other name is refused by name, an inherited one included", () => {
    expect(boundFunction("snowflake", TABLE, "hostHint")).toBe(hint);
    expect(() => boundFunction("snowflake", TABLE, "hostHintV2")).toThrow(
      'snowflake names the function "hostHintV2", which Studio holds no function for.',
    );
    expect(() => boundFunction("postgres", TABLE, "hostHint")).toThrow(
      'postgres names the function "hostHint", which Studio holds no function for.',
    );
    expect(() => boundFunction("snowflake", TABLE, "toString")).toThrow(
      'snowflake names the function "toString", which Studio holds no function for.',
    );
    expect(() => boundFunction("constructor" as "snowflake", TABLE, "hostHint")).toThrow(
      'constructor names the function "hostHint", which Studio holds no function for.',
    );
  });
});

describe("slotFunctionTable", () => {
  test("a slot's table holds each engine's function under the slot's name, and nothing else", () => {
    const quoteForMysql = (name: string) => `\`${name}\``;
    const quoteForPostgres = (name: string) => `"${name}"`;
    const table = slotFunctionTable("quoteIdentifier", { mysql: quoteForMysql, postgres: quoteForPostgres });

    expect(Object.keys(table)).toEqual(["mysql", "postgres"]);
    expect(Object.keys(table.mysql ?? {})).toEqual(["quoteIdentifier"]);
    expect(Object.keys(table.postgres ?? {})).toEqual(["quoteIdentifier"]);
    expect(boundFunction("mysql", table, "quoteIdentifier")).toBe(quoteForMysql);
    expect(boundFunction("postgres", table, "quoteIdentifier")).toBe(quoteForPostgres);
    // No other name, an inherited one included, and no engine the record leaves out.
    expect(() => boundFunction("mysql", table, "escapeLiteral")).toThrow(
      'mysql names the function "escapeLiteral", which Studio holds no function for.',
    );
    expect(() => boundFunction("mysql", table, "toString")).toThrow(
      'mysql names the function "toString", which Studio holds no function for.',
    );
    expect(() => boundFunction("sqlite", table, "quoteIdentifier")).toThrow(
      'sqlite names the function "quoteIdentifier", which Studio holds no function for.',
    );
    // Frozen at both levels.
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.mysql)).toBe(true);
  });
});
