import type { EngineGrants } from "@/lib/db/claim-grants";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseType } from "@/lib/types";
import type { McpReach } from "../context";
import { MCP_READ_ONLY_ANNOTATIONS } from "../output";

/**
 * The hints `inspect_schema` carries on one token's `tools/list` (#2252, part 3).
 *
 * A metadata read on an engine whose record grants `metadataReadChangesState` changes state the engine keeps, so a
 * token that reaches one is told `readOnlyHint: false` with `destructiveHint: false`; every other token, and the full
 * handler, which no plain `tools/list` reaches, keep the read-only hints. `idempotentHint` stays unset, since a
 * repeated call extends the state the first one started. Read from the grant of each reached type's engine record
 * (`servedEngineRecord`), never a type-id branch. A reach is built from the connections MCP can serve, which leaves out
 * a type that names no provider (FND-1); every reach member's grant is read before the hints are answered, so a member
 * that names no engine is refused whatever comes before it.
 */

const STATE_CHANGING_READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const);

/**
 * The hints for a token that reaches `reach`, or the read-only hints without one; `grantsOf`, the reader of an engine's
 * grants, defaults to the engine record's and is injectable for the tests.
 *
 * @throws {UnknownProviderError} When a reach member names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming a reach member's engine was refused at boot.
 */
export function metadataReadAnnotations(
  reach?: McpReach,
  grantsOf: (type: DatabaseType) => Pick<EngineGrants, "metadataReadChangesState"> = (type) =>
    servedEngineRecord(type).grants,
): typeof MCP_READ_ONLY_ANNOTATIONS | typeof STATE_CHANGING_READ_ANNOTATIONS {
  if (reach === undefined) return MCP_READ_ONLY_ANNOTATIONS;
  const grants = [...reach].map((type) => grantsOf(type));
  return grants.some((grant) => grant.metadataReadChangesState)
    ? STATE_CHANGING_READ_ANNOTATIONS
    : MCP_READ_ONLY_ANNOTATIONS;
}
