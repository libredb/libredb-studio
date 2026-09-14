import type { DatabaseConnection } from "@/lib/types";

/**
 * A digest of the SERVER a plan was built against, and NEVER of the connection's id (#789 Phase 3).
 *
 * MEASURED, `src/lib/seed/resolve-connection.ts:21-23` returns an inline connection object
 * verbatim, `id` included, and the browser drove it: a made-up id with different credentials
 * connected as them. So `connection.id` is a string the caller typed on the majority path, and
 * binding a plan to it would be vacuous for exactly the case the binding exists for.
 *
 * IT LIVES IN CORE rather than beside the plan token, because both sides need it: the PROVIDER
 * writes it onto the plan it issues, from the connection it was built with, and the ROUTE
 * recomputes it from the connection THIS request resolved and refuses a mismatch. That is the
 * enforce-rather-than-trust precedent `boundSourceDocument` already sets, and a fingerprint only
 * the provider could compute would be a field nobody checked.
 *
 * Length-framed, so two fields cannot slide across their boundary and answer the same digest for
 * two different servers. Stated as a limit rather than left to be discovered: it does not catch a
 * different server that answers on the same host and port.
 */
export async function connectionFingerprint(connection: DatabaseConnection): Promise<string> {
  const framed = [
    connection.type,
    connection.host ?? "",
    String(connection.port ?? ""),
    connection.database ?? "",
    connection.user ?? "",
  ]
    .map((value) => `${value.length}:${value}`)
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(framed));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
