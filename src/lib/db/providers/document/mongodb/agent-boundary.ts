/**
 * The agent read-only execution profile's boundary on MongoDB (issue #1614), proven at the open of a connection that
 * will send statements.
 *
 * MongoDB has no read-only session or transaction, so the boundary is the connection's user, and the server must be
 * shown to enforce it. Three checks, each on the server's own answers, in the order `verifyAgentProfile` runs them:
 *
 * 1. **The server is MongoDB.** `buildInfo` must not name another server (FerretDB, Percona Server for MongoDB, Atlas
 *    Data Federation answer fields of their own), no host the client resolved may be a DocumentDB, Cosmos DB or
 *    Firestore endpoint, and the document must hold the stable fields a MongoDB answers (`version`, `versionArray`,
 *    `storageEngines` carrying `wiredTiger`). A server that fails is refused with `PROFILE_UNSUPPORTED_TARGET` until
 *    its own enforcement is measured, the D347 precedent that keeps Percona off the MySQL wire.
 * 2. **The user holds only reads of the bound database.** `connectionStatus` with `showPrivileges` lists every
 *    privilege the session's user holds; each must be an action of the read role on one collection of the database the
 *    connection is bound to, `system.*` excepted but for `system.js`. Read fail-closed: an action this module does not
 *    know, a resource of another shape, or a list it cannot read is a refusal.
 * 3. **The server enforces authorization.** A user's privileges read the same on a server that enforces nothing
 *    (measured on 9.0.4 with authorization off: the read user's status is the read role's, and its writes succeed), so
 *    the server is asked to refuse a delete the privileges do not allow. The delete names one `_id` no document holds,
 *    so it changes nothing on any outcome: refused with code 13 on an enforcing server, and answered `n: 0` with
 *    nothing created on one that enforces nothing (measured on 9.0.4, 8.3.11, 7.0.43, and 9.0.4 with authorization
 *    off, the database absent).
 *
 * A connection that authenticated no user holds no read privilege on an enforcing server, and is refused with
 * `PROFILE_PRIVILEGES_TOO_NARROW`; on a server that enforces nothing it can do anything, and the probe says so.
 */
import { ObjectId, type Db, type Document, type MongoClient } from "mongodb";
import { ExecutionProfileError } from "../../../errors";
import { AGENT_COMMAND_COMMENT } from "./agent-read";

/**
 * The server's own deadline on each verification command, as `maxTimeMS`. Each one answers from memory in
 * milliseconds; the bound is for a server too loaded to, so the open fails rather than waits on it.
 */
export const AGENT_VERIFY_MAX_TIME_MS = 5_000;

/**
 * The actions the read role holds, as `connectionStatus` answered them for a user holding only that role on one
 * database, measured on MongoDB 9.0.4, 8.3.11 and 7.0.43 (7.0.43 without `performRawDataOperations`; the replies are
 * `tests/unit/db/mongodb/fixtures/connection-status-libredb-agent-*.json`, captured 2026-10-17). One
 * set serves every version because each member is a read wherever it exists. A future server that adds an action to the
 * role is refused, naming the action, until the action is added here: the list is fail-closed by design.
 */
export const MONGO_AGENT_READ_ACTIONS: ReadonlySet<string> = new Set([
  "changeStream",
  "collStats",
  "dbHash",
  "dbStats",
  "find",
  "killCursors",
  "listCollections",
  "listIndexes",
  "listSearchIndexes",
  "performRawDataOperations",
  "planCacheRead",
]);

/** The one system collection the read role grants on a database: its stored JavaScript functions, which it reads. */
const READABLE_SYSTEM_COLLECTION = "system.js";

/**
 * The `buildInfo` fields a server answers to name itself, and the server each names. FerretDB's is measured (2.7.0
 * answers `ferretdb: {version, package}`); Percona documents `psmdbVersion` as the way to tell its server apart, and
 * Atlas Data Federation answers `dataLake`, the field MongoDB's own `mongodb-build-info` keys on. None of the three is
 * measured under this profile, so each is refused by name.
 */
const SELF_IDENTIFYING_BUILDINFO_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ferretdb: "FerretDB",
  psmdbVersion: "Percona Server for MongoDB",
  dataLake: "Atlas Data Federation",
});

/**
 * The host suffixes of the services that speak MongoDB's wire without being MongoDB. The first two mirror the driver's
 * own `DOCUMENT_DB_CHECK` and `COSMOS_DB_CHECK` (`mongodb/lib/utils.js`, internal and so copied, never imported);
 * Firestore's is the suffix `mongodb-build-info` keys on. A name check, defeated by a tunnel or a CNAME, which is why
 * the positive shape of `buildInfo` is checked after it.
 */
const WIRE_RELATIVE_HOSTS: readonly { readonly suffix: RegExp; readonly server: string }[] = Object.freeze([
  { suffix: /\.docdb(-elastic)?\.amazonaws\.com$/i, server: "Amazon DocumentDB" },
  { suffix: /\.cosmos\.azure\.com$/i, server: "Azure Cosmos DB" },
  { suffix: /\.firestore\.goog$/i, server: "Firestore" },
]);

/** The storage engine every MongoDB lists in `buildInfo.storageEngines`. */
const GENUINE_MONGODB_STORAGE_ENGINE = "wiredTiger";

/** The collection the probe names, and never creates: its delete matches nothing, so no write ever lands. */
const AGENT_PROBE_COLLECTION = "libredb_agent_probe";

/** What a command past the user's privileges answers: MongoDB's authorization refusal. */
const MONGO_UNAUTHORIZED_CODE = 13;

/**
 * The engine gate: this server must positively be the MongoDB the boundary was measured on. A server that names
 * itself, or a host that is a wire-compatible service's, is refused by name; then the document must hold the stable
 * fields a MongoDB answers, a version whose first three numbers `versionArray` repeats and a `storageEngines` list
 * carrying `wiredTiger`. Measured: FerretDB 2.7.0 answers `version: "7.0.77"` and a matching `versionArray`, and no
 * `storageEngines`. Never `allocator`, `javascriptEngine` or `gitVersion`: the first two change between releases (9.0.4
 * answers `tcmalloc-google` and `mozjs-wasm`, 7.0.43 `tcmalloc` and `mozjs`), and FerretDB answers a 40-hex
 * `gitVersion` of its own.
 */
export function assertAgentEngineIsAdmissible(buildInfo: Document, hosts: readonly string[]): void {
  for (const [key, server] of Object.entries(SELF_IDENTIFYING_BUILDINFO_KEYS)) {
    if (Object.hasOwn(buildInfo, key)) {
      throw new ExecutionProfileError(
        `The agent read-only execution profile is proven on MongoDB only; this server identifies itself as ${server} on the wire, and its own enforcement is not measured, so the connection is refused.`,
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }
  }
  for (const host of hosts) {
    const service = WIRE_RELATIVE_HOSTS.find(({ suffix }) => suffix.test(host));
    if (service !== undefined) {
      throw new ExecutionProfileError(
        `The agent read-only execution profile is proven on MongoDB only; the host ${host} is a ${service.server} endpoint, which speaks the MongoDB wire but whose own enforcement is not measured, so the connection is refused.`,
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }
  }
  const version = typeof buildInfo.version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(buildInfo.version) : null;
  const versionArray: unknown = buildInfo.versionArray;
  const storageEngines: unknown = buildInfo.storageEngines;
  const admissible =
    version !== null &&
    Array.isArray(versionArray) &&
    version.slice(1, 4).every((part, index) => versionArray[index] === Number(part)) &&
    Array.isArray(storageEngines) &&
    storageEngines.includes(GENUINE_MONGODB_STORAGE_ENGINE);
  if (!admissible) {
    throw new ExecutionProfileError(
      "The agent read-only execution profile is proven on MongoDB only; this server's own buildInfo does not answer the shape a MongoDB answers, so its enforcement is unproven and the connection is refused.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
}

/**
 * The privileges of the user the session authenticated, held to reads of `boundDatabase`, the scope #1614 settled on:
 * every resource is one collection of that database, as `{db, collection}`, a `system.*` collection only when it is
 * `system.js`; every action is one of `MONGO_AGENT_READ_ACTIONS`. A cluster, `anyResource` or `system_buckets`
 * resource, a `db: ""` wildcard and every other database are refused, naming the action and the resource, in the
 * MySQL profile's wording. Fail-closed: a list it cannot read (absent, as FerretDB answers, or malformed) is refused
 * too, because a privilege not read is a privilege not ruled out. A list it reads and finds empty is a user holding
 * nothing (measured: a user created with no roles answers `[]`), refused as too narrow.
 *
 * For a session that authenticated a user; whether a session that authenticated none is refused, and why, is the
 * probe's to say (`verifyAgentProfile`).
 */
export function assertAgentPrivilegesAreReadOnly(status: Document, boundDatabase: string): void {
  const privileges: unknown = (status.authInfo as Document | undefined)?.authenticatedUserPrivileges;
  if (!Array.isArray(privileges) || !privileges.every(isReadablePrivilege)) {
    throw new ExecutionProfileError(
      "The agent read-only execution profile could not read this session's privileges, so the boundary is unproven and the connection is refused.",
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  if (privileges.length === 0) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile needs a user holding read on "${boundDatabase}", and the user this connection authenticated as holds no privilege at all, so it cannot read it. Grant it the read role on "${boundDatabase}", or connect as a user that holds it.`,
      "PROFILE_PRIVILEGES_TOO_NARROW",
    );
  }
  for (const { resource, actions } of privileges) {
    const outside = refusalOfResource(resource, boundDatabase);
    const action = outside === null ? actions.find((held) => !MONGO_AGENT_READ_ACTIONS.has(held)) : actions[0];
    if (action === undefined) continue;
    throw new ExecutionProfileError(
      `The agent read-only execution profile admits a user holding only reads of "${boundDatabase}"; this session holds ${JSON.stringify(action)} on ${JSON.stringify(resource)}, ${outside ?? "which is not a read"}. Connect as a user holding only the read role on "${boundDatabase}".`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
}

interface ReadablePrivilege {
  readonly resource: Document;
  readonly actions: readonly string[];
}

function isReadablePrivilege(privilege: unknown): privilege is ReadablePrivilege {
  if (typeof privilege !== "object" || privilege === null) return false;
  const { resource, actions } = privilege as { resource?: unknown; actions?: unknown };
  return (
    typeof resource === "object" &&
    resource !== null &&
    Array.isArray(actions) &&
    actions.every((action) => typeof action === "string")
  );
}

/** Why `resource` is outside reads of the bound database, completing the refusal's sentence, or null when it is not. */
function refusalOfResource(resource: Document, boundDatabase: string): string | null {
  const keys = Object.keys(resource).sort();
  const oneCollection =
    keys.length === 2 &&
    keys[0] === "collection" &&
    keys[1] === "db" &&
    resource.db === boundDatabase &&
    typeof resource.collection === "string";
  if (!oneCollection) return `outside the database "${boundDatabase}" this connection is bound to`;
  const collection = resource.collection as string;
  if (collection.startsWith("system.") && collection !== READABLE_SYSTEM_COLLECTION) {
    return "a collection the server keeps for itself";
  }
  return null;
}

/**
 * The probe that proves the server enforces authorization, and changes nothing on any outcome: a delete of one
 * `_id` no document holds, in a collection the probe names and never creates. Measured on 9.0.4, 8.3.11 and 7.0.43:
 * a user holding only read is refused with code 13 even where the collection and the database do not exist; a server
 * that enforces nothing answers `n: 0` and creates nothing. Code 13 is the proof and returns; an accepted delete is a
 * server that does not enforce authorization; any other error is neither, and propagates as the open's own failure.
 */
export async function probeServerEnforcesAuthorization(db: Db, maxTimeMS: number): Promise<void> {
  try {
    await db.command({
      delete: AGENT_PROBE_COLLECTION,
      deletes: [{ q: { _id: new ObjectId() }, limit: 1 }],
      writeConcern: { w: 1 },
      maxTimeMS,
      comment: AGENT_COMMAND_COMMENT,
    });
  } catch (error) {
    if (isAuthorizationRefusal(error)) return;
    throw error;
  }
  throw new ExecutionProfileError(
    "The agent read-only execution profile needs a server that enforces authorization, and this one does not enforce authorization: it accepted a delete the connection's privileges do not allow (the delete matched nothing, so nothing changed), so no user's read-only boundary holds there. Turn on the server's authorization (security.authorization), and connect as a user holding only the read role.",
    "PROFILE_SERVER_UNENFORCED",
  );
}

function isAuthorizationRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === MONGO_UNAUTHORIZED_CODE;
}

/** The users the session authenticated, read fail-closed: a status that does not carry the list is refused. */
function authenticatedUsersOf(status: Document): readonly unknown[] {
  const users: unknown = (status.authInfo as Document | undefined)?.authenticatedUsers;
  if (!Array.isArray(users)) {
    throw new ExecutionProfileError(
      "The agent read-only execution profile could not read which user this session authenticated as, so the boundary is unproven and the connection is refused.",
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  return users;
}

function noUserRefusal(boundDatabase: string): ExecutionProfileError {
  return new ExecutionProfileError(
    `The agent read-only execution profile needs the connection to authenticate as a user holding read on "${boundDatabase}"; this connection authenticated no user, so it holds no read privilege on "${boundDatabase}". Connect as a user holding only the read role on it.`,
    "PROFILE_PRIVILEGES_TOO_NARROW",
  );
}

/** The hosts the client was given or resolved, the SRV host included, as the engine gate reads them. */
export function agentHostsOf(client: MongoClient): string[] {
  const hosts = client.options.hosts.flatMap((address) => (address.host === undefined ? [] : [address.host]));
  return client.options.srvHost === undefined ? hosts : [...hosts, client.options.srvHost];
}

/**
 * The profile's verification, at the open of a connection that will send statements, in the order the module's
 * docblock gives: `buildInfo` and the engine gate, then the session's privileges when it authenticated a user, then the
 * probe. Every command carries `maxTimeMS` and the agent's comment in its document. A refusal is an
 * `ExecutionProfileError` naming its own code; any other failure propagates as it is.
 *
 * MongoDB 9.0.4 and 8.3.11 refuse `buildInfo` itself, with code 13, to a connection that authenticated no user
 * (measured; 7.0.43 answers it), so that refusal is read against the session's status before it is called a failure.
 */
export async function verifyAgentProfile(
  client: MongoClient,
  boundDatabase: string,
  { maxTimeMS, hosts }: { readonly maxTimeMS: number; readonly hosts: readonly string[] },
): Promise<void> {
  const db = client.db(boundDatabase);
  const command = (document: Document) => db.command({ ...document, maxTimeMS, comment: AGENT_COMMAND_COMMENT });
  const readStatus = () => command({ connectionStatus: 1, showPrivileges: true });
  let buildInfo: Document;
  try {
    buildInfo = await command({ buildInfo: 1 });
  } catch (error) {
    if (isAuthorizationRefusal(error) && authenticatedUsersOf(await readStatus()).length === 0) {
      throw noUserRefusal(boundDatabase);
    }
    throw error;
  }
  assertAgentEngineIsAdmissible(buildInfo, hosts);
  const status = await readStatus();
  const authenticated = authenticatedUsersOf(status).length > 0;
  if (authenticated) assertAgentPrivilegesAreReadOnly(status, boundDatabase);
  await probeServerEnforcesAuthorization(db, maxTimeMS);
  if (!authenticated) throw noUserRefusal(boundDatabase);
}
