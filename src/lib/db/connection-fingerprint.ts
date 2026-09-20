import { TUNNEL_FAR_END } from "@/lib/types";
import type { DatabaseConnection, SSHTunnelConfig, WithTunnelFarEnd } from "@/lib/types";

/**
 * The bastion's ROUTE, length-framed inside its own field so a tunnel's four values cannot slide
 * across each other any more than the outer ten can.
 *
 * The field set is `connectionIdentity`'s in `src/lib/agent/context-snapshot.ts`, taken deliberately
 * rather than re-derived, so this repository's two connection identities cannot drift apart: its
 * docblock already states the rule this seal needed, that the same `db:5432` reached through two
 * different bastions is two different databases.
 *
 * The tunnel's SECRETS are out on the rule the database password already follows, rotating a
 * credential changes who may reach the machine and never which machine it is, and so is
 * `hostKeyFingerprint`, which records what this connection TRUSTS rather than where it goes.
 *
 * `enabled` is in because the tunnel branch in `getOrCreateProvider`
 * (`src/lib/db/factory.ts:565`) tests exactly that flag: a switched-off tunnel is not a route at
 * all, and an absent `sshTunnel` frames to the empty string, which no present tunnel can produce.
 *
 * EXPORTED FOR THE TUNNEL POOL, which keys a forward on this exact string (`poolKey` in
 * `src/lib/ssh/tunnel.ts`). Taken rather than re-derived, and for the reason this function already
 * takes `connectionIdentity`'s field set: the pool must never hand one record's provider a forward
 * opened for a route this seal calls a different server, and two hand-kept lists of the same four
 * fields drift. Adding a field here narrows the pool key with it, which is the safe direction.
 */
export function tunnelRoute(tunnel: SSHTunnelConfig | undefined): string {
  if (tunnel === undefined) return "";
  return [String(tunnel.enabled), tunnel.host, String(tunnel.port), tunnel.username]
    .map((value) => `${value.length}:${value}`)
    .join("");
}

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
 *
 * WHY TEN FIELDS AND NOT FIVE. The first five (`type`, `host`, `port`, `database`, `user`) were
 * the whole frame until an external review of PR #831 asked what a connection reaches when it
 * carries a URI. The criterion for a field belonging here is not that the field exists, it is
 * that changing that field ALONE, with the other nine held equal, sends the same sealed plan to
 * a different server, a different database or a different namespace. Each of the four additions
 * was checked against the code that opens the connection, and the check REPRODUCED before it was
 * fixed: two connections differing only in `connectionString` answered the same digest.
 *
 * The TENTH field arrived one round later, and how it was missed is worth recording: the first
 * audit walked `DatabaseConnection`'s fields one by one and never consulted this repository's OTHER
 * connection identity, `connectionIdentity` in `src/lib/agent/context-snapshot.ts`, which had the
 * answer written down already. Two connections differing only in `sshTunnel` answered
 * `2dedca1a0ad45abdfb01427f0e1df3130e59617c5658058cbcf4852297f888c7` on both sides.
 *
 * - `connectionString` OVERRIDES the field-by-field form outright and is not merged with it.
 *   `src/lib/db/providers/sql/postgres.ts:2070-2074` returns `{ ...baseConfig, connectionString }`
 *   and never reaches the `host`/`port`/`user`/`database` branch below it. The same shape is at
 *   `mysql.ts:1948-1951` (`uri`), `oracle.ts:1521-1522`, `sqlite.ts:1175-1178`,
 *   `document/mongodb.ts:794-795`, `libsql/index.ts:116-120`, `clickhouse/index.ts:402-422` and
 *   `document/couchbase/index.ts:478`. PostgreSQL is the LIVE population: it declares two editable
 *   kinds.
 * - `schema` is Trino's session schema and is sent as the `X-Trino-Schema` submission header
 *   (`trino/http-transport.ts:710` and `:885`), which is what an UNQUALIFIED name in the applied
 *   statement resolves against. Trino declares an editable kind, so this population is live too.
 *   The normal path is qualified: measured on Trino 476, `SHOW CREATE FUNCTION` answers
 *   `memory.app.plus_one`, so the case needs a user edit that drops the qualification, which the
 *   pane cannot stop and the seal is not entitled to assume away.
 * - `serviceName` is Oracle's connect-string tail, `oracle.ts:1527-1536` building
 *   `host:port/serviceName`, so it selects WHICH DATABASE on that listener.
 * - `sshTunnel` is the ROUTE and not a credential. `getOrCreateProvider`
 *   (`src/lib/db/factory.ts:565-572`) REWRITES `host` and `port` to the tunnel's local endpoint
 *   before the provider is constructed, so with a tunnel enabled the bastion, and not the record's
 *   own `host`, decides which machine the sealed statement reaches. Only the four route values are
 *   framed, by `tunnelRoute` above. Live under the day-one editable set: any of the three engines
 *   can carry one.
 * - `instanceName` is a MSSQL NAMED INSTANCE, `mssql.ts:1652-1655`, resolved by the SQL Server
 *   Browser to a different server process, typically on a port that is not the one in the record.
 *
 * WHICH `host` AND `port`, AND WHY IT IS THE FAR END (X23). That same rewrite made the tunnelled
 * population unable to edit anything at all: the provider framed `127.0.0.1:<ephemeral>` and the
 * route framed the record's own address, so the compare at `edit-plan/route.ts` could never be
 * equal and 100 percent of tunnelled connections were refused with no sentence saying why. So the
 * factory attaches the far end under {@link TUNNEL_FAR_END} and this walk frames THAT when it is
 * there - the forward's own far end, which is the record's pre-rewrite endpoint whenever the two
 * agree and is the authority when they do not (D86, below). The local endpoint is deliberately NOT
 * in the frame: it is an ephemeral port on a loopback interface, which is a property of this
 * process and not of the server.
 *
 * It does not relax the compare itself. Both sides still frame one concrete address, the bastion is
 * still framed separately by `tunnelRoute`, and a provider built through a tunnel WITHOUT the
 * marker still answers the local endpoint and is still refused - fail closed, never "equal if we
 * cannot tell". What stops a caller deciding the digest with it is in {@link TUNNEL_FAR_END}'s
 * docblock: the key is a symbol, so no stored or posted connection can carry one.
 *
 * WHICH FAR END, AND WHY IT IS THE FORWARD'S AND NOT THE RECORD'S (D86). The marker is read off
 * the tunnel: `TunnelInfo` carries the `remoteHost` and `remotePort` the forward was opened for,
 * and the factory frames those. It used to be the address the factory ASKED the bastion to
 * forward to, while `createSSHTunnel` pooled by connection id alone, so a provider that reused a
 * pooled tunnel opened for a DIFFERENT address sealed the record's claimed far end, the route
 * recomputed the same value, and the plan verified for a machine the statement never reached - a
 * case the pre-X23 digest refused by accident rather than by a check. Measured against the live
 * bastion on 2026-09-15, and closed on both sides: the pool now keys on the far end AND on
 * `tunnelRoute` of the record's own `sshTunnel`, so a request for an address nothing is forwarding
 * to, or for a route nothing was opened through, opens its own forward. The pool key frames the
 * route with the function above for that reason: a forward can only be reused by a record this
 * seal calls the SAME server, which is what makes the marker's address the whole difference.
 *
 * Every provider path in the five bullets above is relative to `src/lib/db/providers/`, and the
 * line numbers are a reading taken on 2026-09-14: they are a pointer to the branch, not a contract,
 * and the symbol named beside each is what a later reader should grep for when they drift.
 *
 * INFERENCE, NOT MEASUREMENT, and said in that voice: the five bullets rest on reading the connect
 * paths named above, not on driving two Oracle services or two named MSSQL instances. What WAS run
 * is the digest arithmetic, in `tests/unit/lib/db/connection-fingerprint.test.ts`.
 *
 * `oracle` and `mssql` declare NO editable kind today, so their two fields guard a population this
 * phase does not yet build. They are in the frame anyway because the frame answers "which server
 * is this", a question that has nothing to do with which kinds an engine will take an edit for,
 * and a field added on the day an engine becomes editable is a field nobody remembers to add.
 */
export async function connectionFingerprint(connection: DatabaseConnection & WithTunnelFarEnd): Promise<string> {
  // The address this connection actually reaches: the tunnel's far end when the factory
  // rewrote the record, and the record's own otherwise. See the X23 paragraph above.
  const farEnd = connection[TUNNEL_FAR_END];
  const framed = [
    connection.type,
    farEnd?.host ?? connection.host ?? "",
    String(farEnd?.port ?? connection.port ?? ""),
    connection.database ?? "",
    connection.user ?? "",
    connection.connectionString ?? "",
    connection.schema ?? "",
    connection.serviceName ?? "",
    connection.instanceName ?? "",
    tunnelRoute(connection.sshTunnel),
  ]
    .map((value) => `${value.length}:${value}`)
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(framed));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
