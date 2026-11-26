/**
 * The one core assertion of Studio's review record of the engines agent and MCP statements run on.
 *
 * Studio's review record is each engine's `agentExecution` grant, its row of the grant register, read here from the
 * engine's record (`servedEngineRecord` in src/lib/db/server-catalog.ts). Every statement-sending gate reads it here
 * at run time: the provider factory's acquisition of a profile that sends statements, the core read path
 * (`runReadOnlyReading` in src/lib/db/operations/read-only-statement.ts) that every MCP read-only statement and every
 * budgeted reading passes, and the host core's read-only execute (`runReadOnlyExecute` in
 * src/lib/api/read-only-execute.ts) that every agent and hand-over statement passes; plan mode's statistics read under
 * `agent-operations` does not, as that module's docblock says. A provider's `queryReadOnly` is required as well and is
 * never enough: an engine whose record does not grant agent execution is refused by name, whatever its provider
 * implements.
 *
 * Its own module rather than a function of the grant reader, so the browser-safe agent manifest, which opens the start
 * of an agent run, reads the same grant as the list `GRANTED_AGENT_EXECUTION_ENGINES` (src/lib/db/claim-grants.ts)
 * with `includes` and loads no refusal of its own.
 */
import type { DatabaseType } from "@/lib/types";
import { StudioProfileRefusal } from "./errors";
import { servedEngineRecord } from "./server-catalog";

/**
 * Refuses, by name, an engine whose record does not grant agent execution, before any statement is sent on it.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no engine the server knows, before any grant
 * is read.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {StudioProfileRefusal} `PROFILE_ENGINE_NOT_REVIEWED`, when the engine record does not grant agent execution.
 */
export function assertStatementsReviewed(type: DatabaseType): void {
  if (!servedEngineRecord(type).grants.agentExecution) {
    throw new StudioProfileRefusal(
      `Provider type "${type}" is not on the review record of engines that run agent and MCP statements, so no statement is sent on it, whatever its provider implements`,
      "PROFILE_ENGINE_NOT_REVIEWED",
    );
  }
}
