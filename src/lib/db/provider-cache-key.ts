import { connectionFingerprint } from "./connection-fingerprint";
import type { DatabaseConnection, WithTunnelFarEnd } from "@/lib/types";

/**
 * The key `providerCache` holds a live provider under, and why it is not `connection.id`
 * (GHSA-3wh2-8x78-jfw4).
 *
 * A cache key is an EQUALITY CLAIM: two callers answering the same key are told they may share
 * one open connection. `getOrCreateProvider` used to key on `connection.id`, and that id arrives
 * in the request body - `resolveConnection` in `src/lib/seed/resolve-connection.ts` returned an
 * inline `connection` verbatim, id included. So the equality claim was written by the caller.
 * Naming an id another session had open returned THAT session's provider, already authenticated
 * as them, with the sent credentials never compared; a `seed:` id is an operator-chosen slug and
 * is guessable, and the role filter that guards the `connectionId` path is not on the inline one.
 * Reproduced against the real sqlite driver before this existed, in
 * `tests/isolated/factory.test.ts` ("getOrCreateProvider cache isolation").
 *
 * So the key still carries the id, but the id is no longer the WHOLE of it. Three parts, framed
 * together so none can be forged on its own:
 *
 * - `connection.id`, which keeps the cache's existing per-record behaviour: two stored records
 *   naming the same server with the same credentials go on having a pool each, `removeProvider`
 *   goes on finding what it deletes, and nothing about reuse changes for honest callers. Keying
 *   it out entirely was tried first and is what a reader will reach for, so the measurement is
 *   recorded: three sqlite records differing only in `id` collapsed onto ONE entry, whose
 *   `connectionId` was whichever opened first, so deleting either of the other two left a live
 *   pool behind under a third record's name.
 * - {@link connectionFingerprint}, the server. Taken rather than re-derived, for the reason its
 *   own docblock gives for taking `connectionIdentity`'s field set: two hand-kept lists of the
 *   same fields drift, and that file already records the measurement this bug is another face of
 *   ("`connection.id` is a string the caller typed on the majority path"). A field added there
 *   narrows this key with it, which is the safe direction.
 * - {@link credentialDigest}, as whom. The fingerprint frames `user` because a different user is
 *   a different identity, but not `password`, because rotating a secret does not change which
 *   server you reach. For a CACHE key it must: a caller who sends the wrong password may not be
 *   handed a pool someone opened with the right one.
 *
 * WHY THE ID IS SAFE IN THE KEY. Reaching a cached entry now costs the victim's id AND their
 * server AND their credentials. The first is guessable and the second is often public; the third
 * is the one an attacker does not have, and holding it would let them open the connection
 * honestly anyway. So the forged id buys nothing, which is the whole of the fix.
 *
 * WHY `queryTimeout` IS NOT IN THE KEY, though the report suggests it. `getOrCreateProvider`
 * tears down a cached provider whose timeout differs from the request's, so a saved change
 * reaches the next query. Under the old key that was a denial of service: any caller could evict
 * a stranger's live connection by naming their id with a different number. It is not one now, and
 * for the reason above - the caller had to prove the credentials to reach the entry at all - so
 * the teardown keeps doing its job and stays where it is. Putting the timeout in the key would
 * instead leave the old provider connected until the 30-minute idle sweep, which is the behaviour
 * that change was written to avoid.
 *
 * THE ID ALSO SITS ON THE ENTRY, because the key is a digest and cannot be read back:
 * `removeProvider`, the idle sweep and `connectionStillServed` ask "which entries serve
 * connection X" and match on that field. `profiledProviderCache` has worked this way since #328
 * and is the shape copied here.
 *
 * WHAT IT DOES NOT CATCH, stated as a limit rather than left to be found: the same limit
 * `connectionFingerprint` states, a different server answering on the same host and port.
 */
export async function providerCacheKey(connection: DatabaseConnection & WithTunnelFarEnd): Promise<string> {
  const [server, credentials] = await Promise.all([connectionFingerprint(connection), credentialDigest(connection)]);
  // Length-framed like the two digests it joins: an id ending in a digit must not be able to
  // answer the same key as a shorter id followed by a longer fingerprint.
  return [connection.id, server, credentials].map((value) => `${value.length}:${value}`).join("");
}

/**
 * A digest of every secret and secondary identity that decides WHO a connection opens as.
 *
 * Length-framed before hashing, the way `connectionFingerprint` frames its ten fields and for the
 * same reason: without it, two fields can slide across their boundary and answer one digest for
 * two different credential sets.
 *
 * The criterion for a field belonging here is the mirror of the fingerprint's: changing this
 * field ALONE, with the others held equal, makes the connection authenticate as someone else or
 * be trusted differently by the server.
 *
 * - `password` is the connection's own secret. `connectionString` is NOT here because the
 *   fingerprint already frames it whole, credentials and all.
 * - `agentUser` and `agentPassword` are the least-privilege identity the execution profiles open
 *   as (#328). They are an identity, so a connection differing only in them must not be handed a
 *   pool opened as the privileged user.
 * - `ssl` decides both what the client PRESENTS (`clientCert`, `clientKey`, which are an
 *   authentication method on their own under PostgreSQL's `cert` auth) and what it TRUSTS
 *   (`mode`, `caCert`, `rejectUnauthorized`).
 * - The tunnel's SECRETS and `hostKeyFingerprint`. Its ROUTE is deliberately absent: `tunnelRoute`
 *   frames the four route values inside the fingerprint already, and this is the half that file
 *   explicitly leaves out as "a credential, not a route".
 */
async function credentialDigest(connection: DatabaseConnection): Promise<string> {
  const ssl = connection.ssl;
  const tunnel = connection.sshTunnel;
  const framed = [
    connection.password ?? "",
    connection.agentUser ?? "",
    connection.agentPassword ?? "",
    ssl?.mode ?? "",
    ssl?.caCert ?? "",
    ssl?.clientCert ?? "",
    ssl?.clientKey ?? "",
    ssl === undefined ? "" : String(ssl.rejectUnauthorized ?? ""),
    tunnel?.authMethod ?? "",
    tunnel?.password ?? "",
    tunnel?.privateKey ?? "",
    tunnel?.passphrase ?? "",
    tunnel?.hostKeyFingerprint ?? "",
  ]
    .map((value) => `${value.length}:${value}`)
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(framed));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
