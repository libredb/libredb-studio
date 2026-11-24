/**
 * The one lookup every binding of a declared function name goes through (src/lib/db/function-table.ts): Studio's
 * connection form table and its connection string table both bind a name with it, so the refusal sentence and the
 * own-property rule live once.
 */
import { describe, expect, test } from "bun:test";
import { boundFunction, type FunctionTable } from "@/lib/db/function-table";

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
