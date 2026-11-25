/**
 * The host's session capacity class of a connection (docs/providers/CONTRACT.md, clause C-66): whether its object tree
 * reads on the editor's session (`one`) or on a metadata session of the connection's own (`several`).
 *
 * The host decides it from Studio's own records and the connection's own fields, before any provider exists: never from
 * a built provider, whose declarations reach no gate (clause M-57), and never from a manifest, which has no member for
 * it. A connection serves one session where `SERVES_ONE_SESSION` (`./compatibility`) names a reason for its engine, the
 * census's reasons kept there, and where its database is in memory, one database per handle, as the file admission
 * reads the name (`namesInMemoryDatabase` in `./provider-files`). It serves several otherwise.
 *
 * The class decides sharing only and authorizes nothing: the provider factory reads it to choose which session a tree,
 * monitoring or health read, or a kill, runs on (`getOrCreateMetadataProvider` in `./factory`), and both sessions pass
 * the same checks.
 */
import type { DatabaseConnection } from "@/lib/types";
import { SERVES_ONE_SESSION } from "./compatibility";
import { namesInMemoryDatabase } from "./provider-files";
import { typeIdRow } from "./type-id";

/** Whether a connection's tree reads on the editor's session (`one`) or on a metadata session of its own. */
export type SessionCapacity = "one" | "several";

/**
 * The session capacity class of `connection`: `one` where Studio's record names a reason for its engine or its
 * database is in memory, `several` otherwise.
 *
 * @throws {UnknownProviderError} When the connection's type names no provider, before any record is read.
 * @throws {DatabaseConfigError} When the file it names is refused by name, as the file admission refuses it.
 */
export function sessionCapacity(connection: DatabaseConnection): SessionCapacity {
  if (typeIdRow(SERVES_ONE_SESSION, connection.type) !== null) return "one";
  return namesInMemoryDatabase(connection) ? "one" : "several";
}
