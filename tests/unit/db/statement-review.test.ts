import { describe, expect, test } from "bun:test";
import { AGENT_EXECUTION_ENGINES, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ExecutionProfileError, UnknownProviderError } from "@/lib/db/errors";
import { assertStatementsReviewed } from "@/lib/db/statement-review";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";

/**
 * The one core assertion every agent and MCP statement gate reads: an engine Studio's review record
 * (`AGENT_EXECUTION_ENGINES` in `src/lib/db/compatibility.ts`) does not list is refused by name, whatever its provider
 * implements. The refused set is computed from the shipped types minus the record, never written here, so an engine
 * added to either side is measured without an edit to this file.
 */

/** Settles a call and answers what it threw, or `null`, so the refusal is asserted after it settles. */
function thrownBy(call: () => void): unknown {
  try {
    call();
    return null;
  } catch (error) {
    return error;
  }
}

const unreviewed: readonly DatabaseType[] = SHIPPED_DATABASE_TYPES.filter(
  (type) => !AGENT_EXECUTION_ENGINES.includes(type),
);

describe("the review record of agent and MCP statements", () => {
  test("admits every engine on the review record", () => {
    for (const type of AGENT_EXECUTION_ENGINES) expect(thrownBy(() => assertStatementsReviewed(type))).toBeNull();
  });

  test("refuses by name, with a deny code of its own, every shipped type the record does not list", () => {
    expect(unreviewed.length).toBeGreaterThan(0);
    for (const type of unreviewed) {
      const error = thrownBy(() => assertStatementsReviewed(type));
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_ENGINE_NOT_REVIEWED");
      expect((error as ExecutionProfileError).message).toBe(
        `Provider type "${type}" is not on the review record of engines that run agent and MCP statements (AGENT_EXECUTION_ENGINES), so no statement is sent on it, whatever its provider implements`,
      );
    }
  });

  test("refuses a string that is not a type id by name before the record is read", () => {
    const error = thrownBy(() => assertStatementsReviewed("acmefoo" as DatabaseType));
    expect(error).toBeInstanceOf(UnknownProviderError);
    expect((error as UnknownProviderError).message).toBe(unknownTypeSentence("acmefoo"));
    expect((error as UnknownProviderError).typeId).toBe("acmefoo");
  });
});
