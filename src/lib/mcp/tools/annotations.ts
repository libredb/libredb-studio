import { MCP_METADATA_READ_CHANGES_STATE } from "@/lib/db/compatibility";
import type { ManagedConnection } from "@/lib/seed";
import type { McpReach } from "../context";
import { MCP_READ_ONLY_ANNOTATIONS } from "../output";

/**
 * The hints `inspect_schema` carries on one token's `tools/list` (#2252, part 3).
 *
 * A metadata read on an engine whose `MCP_METADATA_READ_CHANGES_STATE` row is true changes state the engine keeps,
 * so a token that reaches one is told `readOnlyHint: false` with `destructiveHint: false`; every other token, and the
 * full handler, which no plain `tools/list` reaches, keep the read-only hints. `idempotentHint` stays unset, since a
 * repeated call extends the state the first one started. Read from the record by the reached types, never a type-id
 * branch.
 */

const STATE_CHANGING_READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const);

/** The hints for a token that reaches `reach`, or the read-only hints without one; `changesState` is injectable for the tests. */
export function metadataReadAnnotations(
  reach?: McpReach,
  changesState: Readonly<Record<ManagedConnection["type"], boolean>> = MCP_METADATA_READ_CHANGES_STATE,
): typeof MCP_READ_ONLY_ANNOTATIONS | typeof STATE_CHANGING_READ_ANNOTATIONS {
  if (reach === undefined) return MCP_READ_ONLY_ANNOTATIONS;
  return [...reach].some((type) => changesState[type]) ? STATE_CHANGING_READ_ANNOTATIONS : MCP_READ_ONLY_ANNOTATIONS;
}
