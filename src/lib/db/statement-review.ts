/**
 * The one core assertion of Studio's review record of the engines agent and MCP statements run on.
 *
 * `AGENT_EXECUTION_ENGINES` (src/lib/db/compatibility.ts) is that record. Every statement-sending gate reads it here at
 * run time: the provider factory's acquisition of a profile that sends statements, and the core read path
 * (`runReadOnlyReading` in src/lib/db/operations/read-only-statement.ts) that every agent, hand-over and MCP read-only
 * statement and every budgeted reading passes; plan mode's statistics read under `agent-operations` does not, as that
 * module's docblock says. A provider's `queryReadOnly` is required as well and is never enough: an engine
 * the record does not list is refused by name, whatever its provider implements.
 *
 * Its own module rather than a function in compatibility.ts, so that module stays type-only and client-safe; the
 * start of an agent run reads the record there with `includes` and imports no error class.
 */
import type { DatabaseType } from "@/lib/types";
import { AGENT_EXECUTION_ENGINES } from "./compatibility";
import { ExecutionProfileError } from "./errors";
import { assertDatabaseType } from "./type-id";

/**
 * Refuses, by name, an engine Studio's review record does not list, before any statement is sent on it.
 *
 * @throws {UnknownProviderError} When `type` is not a type id, before the record is read.
 * @throws {ExecutionProfileError} `PROFILE_ENGINE_NOT_REVIEWED`, when the record does not list `type`.
 */
export function assertStatementsReviewed(type: DatabaseType): void {
  assertDatabaseType(type);
  if (!AGENT_EXECUTION_ENGINES.includes(type)) {
    throw new ExecutionProfileError(
      `Provider type "${type}" is not on the review record of engines that run agent and MCP statements (AGENT_EXECUTION_ENGINES), so no statement is sent on it, whatever its provider implements`,
      "PROFILE_ENGINE_NOT_REVIEWED",
    );
  }
}
