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
 *
 * WHY NINE FIELDS AND NOT FIVE. The first five (`type`, `host`, `port`, `database`, `user`) were
 * the whole frame until an external review of PR #831 asked what a connection reaches when it
 * carries a URI. The criterion for a field belonging here is not that the field exists, it is
 * that changing that field ALONE, with the other eight held equal, sends the same sealed plan to
 * a different server, a different database or a different namespace. Each of the four additions
 * was checked against the code that opens the connection, and the check REPRODUCED before it was
 * fixed: two connections differing only in `connectionString` answered the same digest.
 *
 * - `connectionString` OVERRIDES the field-by-field form outright and is not merged with it.
 *   `src/lib/db/providers/sql/postgres.ts:2095-2099` returns `{ ...baseConfig, connectionString }`
 *   and never reaches the `host`/`port`/`user`/`database` branch below it. The same shape is at
 *   `mysql.ts:1973-1976` (`uri`), `oracle.ts:1545-1546`, `sqlite.ts:1189-1192`,
 *   `mongodb.ts:800-801`, `libsql/index.ts:116-120`, `clickhouse/index.ts:402-422` and
 *   `couchbase/index.ts:478`. PostgreSQL is the LIVE population: it declares two editable kinds.
 * - `schema` is Trino's session schema and is sent as the `X-Trino-Schema` submission header
 *   (`trino/http-transport.ts:710` and `:885`), which is what an UNQUALIFIED name in the applied
 *   statement resolves against. Trino declares an editable kind, so this population is live too.
 *   The normal path is qualified: measured on Trino 476, `SHOW CREATE FUNCTION` answers
 *   `memory.app.plus_one`, so the case needs a user edit that drops the qualification, which the
 *   pane cannot stop and the seal is not entitled to assume away.
 * - `serviceName` is Oracle's connect-string tail, `oracle.ts:1551-1560` building
 *   `host:port/serviceName`, so it selects WHICH DATABASE on that listener.
 * - `instanceName` is a MSSQL NAMED INSTANCE, `mssql.ts:1652-1655`, resolved by the SQL Server
 *   Browser to a different server process, typically on a port that is not the one in the record.
 *
 * INFERENCE, NOT MEASUREMENT, and said in that voice: the four bullets rest on reading the connect
 * paths named above, not on driving two Oracle services or two named MSSQL instances. What WAS run
 * is the digest arithmetic, in `tests/unit/lib/db/connection-fingerprint.test.ts`.
 *
 * `oracle` and `mssql` declare NO editable kind today, so their two fields guard a population this
 * phase does not yet build. They are in the frame anyway because the frame answers "which server
 * is this", a question that has nothing to do with which kinds an engine will take an edit for,
 * and a field added on the day an engine becomes editable is a field nobody remembers to add.
 */
export async function connectionFingerprint(connection: DatabaseConnection): Promise<string> {
  const framed = [
    connection.type,
    connection.host ?? "",
    String(connection.port ?? ""),
    connection.database ?? "",
    connection.user ?? "",
    connection.connectionString ?? "",
    connection.schema ?? "",
    connection.serviceName ?? "",
    connection.instanceName ?? "",
  ]
    .map((value) => `${value.length}:${value}`)
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(framed));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
