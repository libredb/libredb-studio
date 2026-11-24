import type { SeedCheck, SeedCheckedFields, SeedFieldRefusal } from "@/lib/db/connection-string/types";
import { readRootRefusals, readRootSentence } from "./agent-roots";

/**
 * The load's check of an OPC UA seed: its read roots, when it declares them, held to the grammar `readRootRefusals`
 * decides, one refusal per fragment at the field, with the element's index inside the sentence. Whether a root is on
 * the server is the server's to say, so it is decided on every read's own session, never from the file.
 */
function opcuaLoadRefusals(conn: SeedCheckedFields): readonly SeedFieldRefusal[] {
  if (conn.agentReadRoots === undefined) return [];
  return readRootRefusals(conn.agentReadRoots).map((refusal) => ({
    field: "agentReadRoots",
    sentence: readRootSentence(refusal),
  }));
}

/** `opcua`'s seed load check: the read roots checked at load. */
export const OPCUA_SEED_CHECK: SeedCheck = opcuaLoadRefusals;
