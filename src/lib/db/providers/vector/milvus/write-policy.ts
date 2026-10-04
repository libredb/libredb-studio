/**
 * The Milvus provider's server-side read-only decision, the etcd split:
 * guard.ts is the browser's verdict on a console text, and this module is what the server enforces.
 *
 * Pure and server-side only. Every console route of v1 is a read, so the only state changes Studio sends are Load
 * and Release, through the admin-only maintenance route; read-only mode refuses both before any request, in etcd's
 * sentences, which name where the mode was set: the operator's seed, the connection's own toggle, or the agent's
 * execution profile.
 */
import type { MilvusReadOnlySource } from "./connection-options";

const READ_ONLY_SENTENCES: Readonly<Record<MilvusReadOnlySource, string>> = {
  seed: "This connection is read-only (set in the operator's seed file).",
  connection: "This connection is read-only: turn off Read-only in its settings to write.",
  "execution-profile": "This run opens the connection read-only (agent execution profile).",
};

/** The three sentences, etcd's unchanged. */
export function readOnlySentence(source: MilvusReadOnlySource): string {
  return READ_ONLY_SENTENCES[source];
}

/** The refusal of a state change on a read-only connection, or undefined when the connection is not read-only. */
export function refuseReadOnly(context: { readonly readOnly?: MilvusReadOnlySource }): string | undefined {
  return context.readOnly === undefined ? undefined : readOnlySentence(context.readOnly);
}
