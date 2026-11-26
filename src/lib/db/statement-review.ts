/**
 * The one core assertion of Studio's review record of the engines agent and MCP statements run on.
 *
 * `GRANTED_AGENT_EXECUTION_ENGINES` (src/lib/db/claim-grants.ts), the engines whose legacy row of the grant register
 * grants `agentExecution`, is that record. Every statement-sending gate reads it here at
 * run time: the provider factory's acquisition of a profile that sends statements, the core read path
 * (`runReadOnlyReading` in src/lib/db/operations/read-only-statement.ts) that every MCP read-only statement and every
 * budgeted reading passes, and the host core's read-only execute (`runReadOnlyExecute` in
 * src/lib/api/read-only-execute.ts) that every agent and hand-over statement passes; plan mode's statistics read under
 * `agent-operations` does not, as that module's docblock says. A provider's `queryReadOnly` is required as well and is
 * never enough: an engine the record does not list is refused by name, whatever its provider implements.
 *
 * Its own module rather than a function of the grant reader, so the browser-safe agent manifest, which opens the start
 * of an agent run, reads the list there with `includes` and loads no refusal of its own.
 */
import type { DatabaseType } from "@/lib/types";
import { GRANTED_AGENT_EXECUTION_ENGINES } from "./claim-grants";
import { StudioProfileRefusal } from "./errors";
import { assertDatabaseType } from "./type-id";

/**
 * Refuses, by name, an engine Studio's review record does not list, before any statement is sent on it.
 *
 * @throws {UnknownProviderError} When `type` is not a type id, before the record is read.
 * @throws {StudioProfileRefusal} `PROFILE_ENGINE_NOT_REVIEWED`, when the record does not list `type`.
 */
export function assertStatementsReviewed(type: DatabaseType): void {
  assertDatabaseType(type);
  if (!GRANTED_AGENT_EXECUTION_ENGINES.includes(type)) {
    throw new StudioProfileRefusal(
      `Provider type "${type}" is not on the review record of engines that run agent and MCP statements, so no statement is sent on it, whatever its provider implements`,
      "PROFILE_ENGINE_NOT_REVIEWED",
    );
  }
}
