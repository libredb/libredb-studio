/**
 * The host's session capacity class of a connection (docs/providers/CONTRACT.md, clause C-66): whether its object tree
 * reads on the editor's session (`one`) or on a metadata session of the connection's own (`several`).
 *
 * The host decides it from Studio's own records and the connection's own fields, before any provider exists: never from
 * a built provider, whose declarations reach no gate (clause M-57), and never from a manifest, which has no member for
 * it. A connection serves one session where the `servesOneSession` grant of its engine record (`servedEngineRecord` in
 * `./server-catalog`) names a reason, the reason its row of the grant register names from Studio's census, and where its
 * database is in memory, one database per handle, as the file admission reads the name (`namesInMemoryDatabase` in
 * `./provider-files`), which only a connection of a legacy provider's record names: a provider package's connection
 * names no file Studio admits (clause C-109). It serves several otherwise.
 *
 * The class decides sharing only and authorizes nothing: the provider factory reads it to choose which session a tree,
 * monitoring or health read, or a kill, runs on (`getOrCreateMetadataProvider` and `getOrCreateMetadataSession` in
 * `./factory`), and both sessions pass the same checks.
 */
import { namesInMemoryDatabase } from "./provider-files";
import { type EngineConnection, offersLegacyProvider, servedEngineRecord } from "./server-catalog";

/** Whether a connection's tree reads on the editor's session (`one`) or on a metadata session of its own. */
export type SessionCapacity = "one" | "several";

/**
 * The session capacity class of `connection`: `one` where Studio's record names a reason for its engine or its
 * database is in memory, `several` otherwise.
 *
 * @throws {UnknownProviderError} When the connection's type is absent, not text, or names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {DatabaseConfigError} When the file it names is refused by name, as the file admission refuses it.
 */
export function sessionCapacity(connection: EngineConnection): SessionCapacity {
  const engine = servedEngineRecord(connection.type);
  if (engine.grants.servesOneSession !== null) return "one";
  return offersLegacyProvider(engine, connection) && namesInMemoryDatabase(connection) ? "one" : "several";
}
