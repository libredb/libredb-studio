/**
 * Redis Database Provider
 * Key-value store support with ioredis
 *
 * Query format (JSON):
 * { "command": "GET", "args": ["key"] }
 * { "command": "KEYS", "args": ["user:*"] }
 * { "command": "HGETALL", "args": ["user:1"] }
 * { "command": "SET", "args": ["key", "value"] }
 *
 * Or plain Redis commands:
 * GET key
 * KEYS user:*
 * HGETALL user:1
 */

import { createHash, randomUUID } from "node:crypto";
import Redis, { type RedisOptions } from "ioredis";
import { BaseDatabaseProvider } from "../../base-provider";
import {
  applySourceBound,
  assertObjectPathShape,
  type ObjectPathShapeEngine,
  callerBoundTruncationReason,
  containerDepth,
  declaredKinds,
  findKind,
  requireEditableKind,
} from "../../object-kinds";
import { EDIT_CHARACTER_LIMIT, userPositionOf } from "../../object-edit";
import { connectionFingerprint } from "../../connection-fingerprint";
import { comparePaths } from "../../object-path";
import {
  type DatabaseConnection,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type PreparedQuery,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
  type ColumnSchema,
  type Container,
  type ContainerLevels,
  type ContainerLevelSpec,
  type DatabaseObject,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectEditBuild,
  type ObjectEditCatalogFact,
  type ObjectEditConsequence,
  type ObjectEditOutcome,
  type ObjectEditPlan,
  type ObjectEditPosition,
  type ObjectEditRefusalClass,
  type ObjectEditRequest,
  type ObjectEditStep,
  type ObjectKindSpec,
  type ObjectSourceDocument,
  type OpenQueryTransactionOutcome,
} from "../../types";
import { DatabaseConfigError, QueryError, ConnectionError } from "../../errors";

/**
 * The server's own words for "you asked me to discard and there is nothing queued".
 *
 * MEASURED on redis 7.4.11 through ioredis 5.11.1: `DISCARD` on a connection with no open
 * `MULTI` answers the error reply "ERR DISCARD without MULTI", and the refusal costs the
 * connection nothing - the very next command runs normally. Under
 * `RedisProvider.endOpenQueryTransaction` it is reached only AFTER the reading said a
 * `MULTI` was open, where it means another caller on this shared connection ended it in
 * between.
 */
const NO_TRANSACTION_MARKER = "DISCARD without MULTI";

/**
 * The status reply a Redis server sends INSTEAD of a command's own reply while a `MULTI`
 * is open on that connection.
 *
 * MEASURED on redis 7.4.11 through ioredis 5.11.1: inside a `MULTI`, `SET`, `GET`, `PING`
 * and `CLIENT INFO` all answer this and run nothing, while a second connection is
 * untouched. The substitution is the reading: a command with a known reply of its own
 * answers the question just by being answered (see `RedisProvider.endOpenQueryTransaction`).
 */
const QUEUED_REPLY = "QUEUED";

/** `PING`'s own reply, the other half of the reading above. */
const PONG_REPLY = "PONG";

// JSON query payload: { "command": "GET", "args": ["key"] }
type RedisJsonCommand = { command: string; args?: string[] };

/**
 * Vendor-specific version fields a Redis-protocol server publishes beside `redis_version`,
 * the Redis compatibility level every relative in this family reports. Three of the four
 * relatives (Valkey, DragonflyDB, Garnet) name themselves in a field of their own; KeyDB
 * does not, so its `redis_version` (`6.3.4`) already is its real version and needs no
 * relabeling. All four measured live 2026-09-04: `valkey_version:9.1.1`,
 * `dragonfly_version:df-v1.40.1`, `garnet_version:2.1.5` (Valkey and Garnet also publish a
 * matching `server_name`, which this does not need to key on).
 */
const VENDOR_VERSION_FIELDS: Array<{ field: string; vendor: string }> = [
  { field: "valkey_version", vendor: "Valkey" },
  { field: "dragonfly_version", vendor: "Dragonfly" },
  { field: "garnet_version", vendor: "Garnet" },
];

/**
 * How the overview names the server: `<vendor> <version> (Redis <compat level>)` when the
 * `INFO` reply names itself, the bare compat level when it does not (KeyDB) - the same
 * self-naming-wins rule the MySQL provider's `labelServerVersion()` applies to `VERSION()`.
 */
function labelServerVersion(parsed: Record<string, string>): string {
  for (const { field, vendor } of VENDOR_VERSION_FIELDS) {
    const version = parsed[field];
    if (version) return `${vendor} ${version} (Redis ${parsed.redis_version || "unknown"})`;
  }
  return parsed.redis_version || "unknown";
}

// ============================================================================
// Object model (issue #789)
// ============================================================================

/**
 * The one container level Redis has, and there is no second one to add above or below it.
 *
 * A Redis server holds a fixed number of NUMBERED databases and nothing else: there is no
 * catalog above them, and a key is not a container. The structural `id` is `schema`
 * because that is what `ContainerLevelSpec` calls the innermost level on every engine; the
 * LABEL is the engine's own word, which is Database.
 *
 * How many there are is NOT a constant, which is why `listContainers` asks the server.
 * Measured 2026-09-11 on redis 8.10.0: a stock server answers `CONFIG GET databases` with
 * 16, and the SAME image started with `--cluster-enabled yes` answers 1 - cluster mode has
 * only database 0, and `SELECT 3` there answers "ERR SELECT is not allowed in cluster
 * mode". So the server's own reply already reflects the deployment and nothing here has to
 * read `cluster_enabled` to work it out.
 */
const REDIS_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

/**
 * The two kinds this engine has, and the three candidates that are deliberately absent.
 *
 * `keyspace` is the grouping `getSchema()` has always produced: a bounded `SCAN` of 1000
 * keys, collapsed to one row per prefix. Those rows are this server's own summary and NOT
 * objects anybody named, which is what `tablesAreDerivedGroupings` says, and the
 * declaration carries that refusal forward - see the note on that flag in
 * `getCapabilities()`.
 *
 * `function` is a real, named, stored object: a Redis 7.0 FUNCTION library is persisted,
 * replicated, listed by `FUNCTION LIST` and addressed by its `library_name`
 * (`FUNCTION LIST LIBRARYNAME <name>` answers it and nothing else, measured). It declares
 * `hasSource`, and it is the only thing in this engine that can: `FUNCTION LIST WITHCODE`
 * answers the library's Lua source verbatim, shebang line included.
 *
 * Three candidates are absent on purpose:
 *
 * - An `EVAL` script is not enumerable. Redis publishes `SCRIPT EXISTS <sha>`, which
 *   answers about a sha the caller already has, and there is no `SCRIPT LIST`. A tree node
 *   is something that can be listed, so a kind here would draw a folder that could never
 *   fill.
 * - A keyspace notification is pub/sub, not a stored trigger: nothing is persisted and
 *   nothing has a name.
 * - The separately named "Triggers and Functions" feature is RedisGears-based, ships only
 *   in Redis Stack and Enterprise, and is on Redis's own deprecated list. Declaring it
 *   would draw a folder on every plain server that has no such concept at all.
 *
 * The list is STATIC, and one measurement is what decides that it has to be. Three of the
 * four Redis-wire relatives refuse `FUNCTION LIST` outright, each in its own words
 * (measured 2026-09-11): KeyDB 6.3.4 "ERR unknown command `FUNCTION`, with args beginning
 * with: `LIST`, ", DragonflyDB df-v1.40.1 "ERR Unknown subcommand or wrong number of
 * arguments for 'LIST'. Try FUNCTION HELP." and Garnet 2.1.5 "ERR unknown command";
 * Valkey 9.1.1 (which reports `redis_version:7.2.4`) supports it. A version-driven declaration, the shape `mysql.ts` uses, would
 * be WRONG here rather than merely awkward: DragonflyDB reports `redis_version:7.4.0` and
 * still has no `FUNCTION LIST`, so the version cannot answer the question. `countObjects`
 * therefore carries the server's own sentence under `{ unavailable }`, which is the state
 * `KindCount` has for a refused read, and the folder says why it has no number instead of
 * showing a zero nobody measured.
 */
const REDIS_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "keyspace", role: "relation", label: "Key Pattern", labelPlural: "Key Patterns" },
  {
    id: "function",
    role: "routine",
    label: "Function Library",
    labelPlural: "Function Libraries",
    hasSource: true,
    sourceLanguage: "lua",
    // THE ONE EDITABLE KIND ON THIS ENGINE (#789 Phase 3). `keyspace` declares nothing, and
    // that is the same refusal `hasSource` already makes for it: a key prefix is a grouping
    // this server derived from a bounded SCAN, nobody wrote a definition for it, so there is
    // nothing to edit and no folder that could offer one. A library is the opposite: it is
    // stored, named, persisted and replicated, and `FUNCTION LOAD REPLACE` writes it back.
    acceptsSourceEdits: true,
  },
] as const);

/** How many keys one `SCAN` walk samples before it stops. The keyspace kind's whole bound. */
const KEY_SCAN_LIMIT = 1000;

/**
 * What a `keyspace` count was counted FROM when the walk stopped on its key budget.
 *
 * The fourth `KindCount` state is per KIND and not per provider, and this engine is half of
 * the proof: `keyspace` is derived from the bounded `SCAN` above, so a walk that stopped
 * early counted the groupings it SAW and the badge is a floor; `function` comes from
 * `FUNCTION LIST`, which enumerates the whole server, and stays an exact number in the same
 * record. A walk whose cursor came back to 0 saw the whole keyspace and is exact too, so the
 * mark is attached to the RUN rather than to the kind (#789).
 *
 * Phrased to follow "counted from", which is how `flatten.ts` builds the badge's title.
 */
const KEY_SCAN_SAMPLE_SENTENCE = `the first ${KEY_SCAN_LIMIT.toLocaleString("en-US")} keys of one SCAN walk`;

/**
 * The SECOND of the two sentences `describeObjects` reports a bound with, and they are two
 * DIFFERENT bounds rather than two phrasings of one (#789).
 *
 * The first is the CALLER's and is `callerBoundTruncationReason()` in `object-kinds.ts`,
 * shared by every provider so that one event reads one way whichever engine is open. This
 * one is a bound nobody asked for on the call: the walk stops at `KEY_SCAN_LIMIT` keys, so
 * on a larger keyspace the groupings are the groupings of a SAMPLE and there may be objects
 * the batch does not hold. A cap nobody can see is exactly what
 * `ObjectDetailBatch.truncated` exists to prevent, so this one is reported on an unbounded
 * read too, and both are named when both bite.
 *
 * It reuses `KEY_SCAN_SAMPLE_SENTENCE`, the same words `countObjects` puts on the badge
 * through `KindCount.sampledFrom`, so a person meeting the fact twice meets it in one
 * wording.
 */
const SCAN_BOUND_SENTENCE = `the key walk stopped at ${KEY_SCAN_SAMPLE_SENTENCE}`;

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()` reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by two
 * different rules. `containerDepth()` decides, never `containerLevels.length`.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * Redis: neither kind declares `attachedTo`, so there is one shape: the declared level
 * plus the name.
 */
const PATH_SHAPE_ENGINE: ObjectPathShapeEngine = {
  code: "redis",
  label: "A Redis",
  attachedSegment: "required",
};

/**
 * The segment of `path` belonging to the declared container level `id`.
 *
 * NEVER `path[0]`, which standing ruling 5g forbids as a class rather than as instances: a
 * container level's POSITION is a property of the declaration. Redis declares one level, so
 * the database is the first segment here and the two spellings are behaviour-identical -
 * which is exactly why the wrong one keeps surviving reviews on one-level engines. The
 * suite pins it by spying a two-level declaration in and driving the call to the BOUND
 * VALUE.
 */
function containerSegment(
  capabilities: ProviderCapabilities,
  path: readonly string[],
  id: ContainerLevelSpec["id"],
): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === id);
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A Redis path needs a "${id}" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      "redis",
    );
  }
  return segment;
}

/**
 * The numbered database one container path names.
 *
 * Two refusals, and both are explicit rather than a fallback to database 0: a path of the
 * wrong length is a caller that built it from another engine's shape, and a segment that is
 * not a number cannot be a Redis database at all. Reading either as 0 would silently answer
 * for the wrong database, which on this engine is a different set of keys entirely.
 *
 * A number that no server has (`SELECT 99`) is NOT refused here, deliberately: the server
 * answers "ERR DB index is out of range" in its own words, and that sentence names the real
 * limit of the deployment, which this function does not know without a second round trip.
 */
function containerDatabase(capabilities: ProviderCapabilities, container: readonly string[]): number {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `A Redis container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      "redis",
    );
  }
  const segment = containerSegment(capabilities, container, "schema");
  if (!/^\d+$/.test(segment)) {
    throw new QueryError(`A Redis database is a number, received ${JSON.stringify(segment)}`, "redis");
  }
  return Number(segment);
}

/**
 * The grouping one key belongs to: `user:123` and `user:456` are both `user:*`, and a key
 * with no colon is its own grouping.
 *
 * Module-level and shared, so `getSchema()` and the object surface can never group the same
 * keyspace two different ways.
 */
function keyGrouping(key: string): string {
  const colonIdx = key.indexOf(":");
  if (colonIdx > 0) {
    return key.substring(0, colonIdx) + ":*";
  }
  return key;
}

/**
 * The three columns every row of a key grouping has, DERIVED rather than read from a
 * catalog: Redis publishes no schema for a key, so these are this provider's own statement
 * about the shape a `SCAN` row comes back in. `key` is the real key name and is the primary
 * one; `value` and `type` carry the value types SAMPLED from the first three keys of the
 * grouping, which is why a grouping holding strings and hashes reads `string/hash`.
 *
 * Shared by `getSchema()` and `describeObject`, so the flat model and the object model
 * cannot describe the same grouping differently while both surfaces are live.
 */
function keyGroupColumns(sampledTypes: ReadonlySet<string>): ColumnSchema[] {
  const types = Array.from(sampledTypes);
  return [
    { name: "key", type: "string", nullable: false, isPrimary: true },
    { name: "value", type: types.join("/"), nullable: true, isPrimary: false },
    { name: "type", type: types.join(", "), nullable: false, isPrimary: false },
  ];
}

/**
 * The `databases` value out of a `CONFIG GET databases` reply.
 *
 * The reply is a flat key/value list, so the value is found by its KEY rather than at index
 * 1: `CONFIG GET` accepts a glob and answers every matching parameter, so the position of a
 * parameter in the reply is a property of the request, not of the parameter.
 *
 * A reply with no such key raises. It is the shape a server that has disabled or renamed
 * CONFIG answers, and there is no honest fallback: 16 would be a number nobody measured,
 * and 1 would hide fifteen databases that may hold keys.
 */
function parseDatabaseCount(reply: unknown): number {
  const entries = Array.isArray(reply) ? reply : [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (String(entries[index]) !== "databases") continue;
    const count = Number(entries[index + 1]);
    if (Number.isInteger(count) && count > 0) return count;
    throw new QueryError(
      `Redis answered a CONFIG GET databases value of ${JSON.stringify(entries[index + 1])}`,
      "redis",
    );
  }
  throw new QueryError("Redis answered no databases value to CONFIG GET databases", "redis");
}

/**
 * The library names out of a `FUNCTION LIST` reply, in the order the server listed them.
 *
 * Measured against redis 8.10.0 through ioredis (RESP2): one entry per library, each a FLAT
 * key/value list - `["library_name", "libredb_probe", "engine", "LUA", "functions", [...]]`.
 * The name is therefore found by walking those pairs and reading the one whose key is
 * `library_name`, never by taking `entry[1]`: the nested `functions` value is itself a list
 * of key/value lists, and a parser that read positions would take a field name for a
 * library name the moment the server adds a field or answers a map instead.
 *
 * An entry with no `library_name` is SKIPPED rather than listed as `undefined`, because a
 * row that cannot be addressed must not become a tree node that opens onto nothing.
 */
function parseFunctionLibraries(reply: unknown): string[] {
  const names: string[] = [];
  for (const entry of Array.isArray(reply) ? reply : []) {
    if (!Array.isArray(entry)) continue;
    for (let index = 0; index + 1 < entry.length; index += 2) {
      if (String(entry[index]) !== "library_name") continue;
      const name = entry[index + 1];
      if (typeof name === "string") names.push(name);
      break;
    }
  }
  return names;
}

/**
 * One library's `library_code` out of a `FUNCTION LIST ... WITHCODE` reply, selected
 * BYTE-EQUAL (#789 Phase 2).
 *
 * The selection is the whole of this function's reason to exist. MEASURED on redis 8.10.0
 * against the committed fixture: the library dictionary is CASE-SENSITIVE, so `libredb_probe`
 * and `LIBREDB_PROBE` coexist, while the `LIBRARYNAME` argument is a CASE-INSENSITIVE glob, so
 * ONE lookup for either name answers BOTH. `reply[0]` would therefore hand back the other
 * library's Lua as this object's definition, and `docker/redis-init/01-object-fixture.redis`
 * holds that pair for exactly this reason. Reply order is not part of the protocol contract:
 * RESP3 answers a map, where there is no order at all.
 *
 * The pairs are walked rather than indexed, the same rule `parseFunctionLibraries` records:
 * the nested `functions` value is itself a list of key/value lists, so a parser reading
 * positions takes a field name for a library name the moment the server adds a field.
 *
 * The walk itself moved into {@link parseFunctionLibrary} when the edit path arrived (#789
 * Phase 3), because that path needs the library's REGISTERED FUNCTIONS out of the same reply and
 * two walks of one reply could disagree about which entry they read.
 */
function parseFunctionLibraryCode(reply: unknown, name: string): string | undefined {
  return parseFunctionLibrary(reply, name)?.code;
}

/**
 * The registered function names out of one library entry's nested `functions` value, SORTED.
 *
 * Measured on redis 8.10.0 through ioredis (RESP2): the value is a list of key/value lists,
 * `[["name", "libredb_ping", "description", null, "flags", []], ...]`, so the names are found by
 * walking each inner list's pairs and reading the one whose key is `name`. Indexing would take a
 * field name for a function name the moment the server adds a field.
 *
 * SORTED HERE AND NOT AT THE CALL SITE, because the order the server answers in is an internal
 * one: measured against the committed fixture, `libredb_probe` comes back `libredb_ping` first
 * although it was loaded `libredb_echo_key` first. The collateral warning is built from this
 * list, and a warning whose wording changed between two identical reads of an unchanged library
 * would show a reader a difference that is not one (#789 Phase 3).
 */
function parseRegisteredFunctionNames(value: unknown): string[] {
  const names: string[] = [];
  for (const registered of Array.isArray(value) ? value : []) {
    if (!Array.isArray(registered)) continue;
    for (let index = 0; index + 1 < registered.length; index += 2) {
      if (String(registered[index]) !== "name") continue;
      const name = registered[index + 1];
      if (typeof name === "string") names.push(name);
      break;
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

/**
 * One library out of a `FUNCTION LIST ... WITHCODE` reply, selected BYTE-EQUAL, with the two
 * facts the edit path needs from the SAME round trip (#789).
 *
 * The selection rule and its measurement are {@link parseFunctionLibraryCode}'s, which is now a
 * reader of this function: the library dictionary is CASE-SENSITIVE and `LIBRARYNAME` is a
 * CASE-INSENSITIVE glob, so ONE lookup answers BOTH of the fixture's libraries and `reply[0]`
 * would hand back the other one's Lua.
 *
 * ONE PARSE FOR BOTH FACTS, and that is a correctness property rather than an economy: the
 * collateral warning names the functions of the library whose CODE the preview shows, and two
 * reads of that reply could legitimately disagree, since another session can load between them.
 *
 * `undefined` is ABSENCE: measured on redis 8.10.0, `FUNCTION LIST LIBRARYNAME no_such_library`
 * answers an EMPTY ARRAY and not an error, so emptiness is the only signal there is.
 */
function parseFunctionLibrary(
  reply: unknown,
  name: string,
): { readonly code: string | undefined; readonly functions: readonly string[] } | undefined {
  for (const entry of Array.isArray(reply) ? reply : []) {
    if (!Array.isArray(entry)) continue;
    let matched = false;
    let code: string | undefined;
    let functions: readonly string[] = [];
    for (let index = 0; index + 1 < entry.length; index += 2) {
      const key = String(entry[index]);
      const value = entry[index + 1];
      if (key === "library_name" && value === name) matched = true;
      if (key === "library_code" && typeof value === "string") code = value;
      if (key === "functions") functions = parseRegisteredFunctionNames(value);
    }
    if (matched) return { code, functions };
  }
  return undefined;
}

/**
 * The one part id a Redis function library's source document has, with ONE writer for the three
 * methods that must agree on it: the read that mints it, the build that refuses any other, and
 * the plan that carries it back (#789).
 */
const REDIS_SOURCE_PART_ID = "definition";

/**
 * The engine identity `requireEditableKind` puts in its three sentences, as one object rather
 * than two adjacent strings, which is that function's own measured rule: `displayName` and
 * `type` are both strings and a positional pair of them can be swapped in silence.
 */
const REDIS_ENGINE = Object.freeze({ displayName: "Redis", type: "redis" as const });

/**
 * The COMMAND every apply of this strategy sends, as the engine spells it, in ONE place.
 *
 * The verb and its two literal arguments are the plan's own fields rather than literals inside
 * the apply, which is ruling 1a: the bytes the reader approved in the preview are the bytes the
 * engine receives, and an apply that rebuilt the command line from constants of its own could
 * send something the preview never showed.
 */
const REDIS_LOAD_COMMAND = Object.freeze({ name: "FUNCTION", arguments: Object.freeze(["LOAD", "REPLACE"]) });

/**
 * A SHA-256 of the library's bytes, hex, which is this engine's revision token (#789 Phase 3).
 *
 * `node:crypto` rather than the `crypto.subtle` walk `connection-fingerprint.ts` and the Trino
 * provider spell out, and the difference is deliberate: a fingerprint has to be computable
 * WHEREVER a plan is read, including by the route, while a revision token is produced and
 * compared by THIS provider alone. Core never compares two tokens, never parses one and never
 * carries one between two plans, which `ObjectEditRevision`'s own docblock states.
 *
 * A content hash is SOUND here and it is not sound everywhere: MEASURED on redis 8.10.0,
 * `FUNCTION LIST WITHCODE` answers the bytes AS LOADED, with no reformatting of any kind, so two
 * reads of an unchanged library are byte-identical. On an engine that renders a definition from
 * a parse tree the same hash would move on a server upgrade and refuse every edit.
 */
function libraryDigest(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * The library name a submitted body DECLARES, out of its shebang line (#789 Phase 3).
 *
 * THE SHEBANG IS THE IDENTITY ON THIS ENGINE. There is no other addressing: `FUNCTION LOAD`
 * takes no name argument, and MEASURED on redis 8.10.0 the reply IS the name the server read out
 * of this line. So an edited shebang does not fail, it writes somewhere else, and three measured
 * outcomes follow from one line of text:
 *
 * - A CONSISTENT rename of the library and its functions SUCCEEDS, creates a SECOND library and
 *   leaves the original answering. The reader sees a success, the pane re-reads the original
 *   address, and their edit is nowhere on the screen.
 * - A name that is an EXISTING OTHER library REPLACES that library, wholesale. Measured against
 *   the fixture: a body whose shebang said `name=LIBREDB_PROBE`, submitted while addressed at
 *   `libredb_probe`, replaced `LIBREDB_PROBE` and left `libredb_probe` answering `pong`. So this
 *   check protects an object the reader was never even shown.
 * - A ONE-CHARACTER typo in the name alone is refused loudly by the engine itself,
 *   `ERR Function libredb_ping already exists`, because function names are global to the server.
 *   That one costs nothing; the two above cost the reader their edit or somebody else's library.
 *
 * `undefined` for a first line this cannot read, which the caller turns into the same `identity`
 * refusal. That is the safe direction: the cost of failing to parse a shebang the server would
 * have accepted is a FALSE REFUSAL, and the cost of the other direction is a lost object.
 * MEASURED: a body with no shebang at all is refused by the engine too,
 * `ERR Missing library metadata`, so the population where this is stricter than the server is
 * one the server also refuses.
 *
 * The ENGINE token is deliberately NOT checked. An unknown one is refused loudly and harmlessly
 * (`ERR Engine 'moon' not found`, measured), and Redis is free to add a second engine.
 */
function shebangLibraryName(text: string): string | undefined {
  const [first] = text.split("\n");
  const match = /^#!\s*(\S+)\s+name=(\S+)\s*$/.exec(first);
  return match?.[2];
}

/**
 * Whether a driver rejection is the SERVER's own error reply, rather than a transport
 * failure (#789 Phase 2).
 *
 * MEASURED against ioredis 5.11.1 and redis 8.10.0, from a container created for the
 * measurement: an ACL denial rejects with a `redis-errors` `ReplyError`
 * (`constructor.name` and `name` both "ReplyError") carrying "NOPERM User ... has no
 * permissions to run the 'function|list' command", and so does an unknown command
 * ("ERR unknown command 'NOSUCHCOMMAND'"). A DROPPED SOCKET rejects with a plain `Error`
 * named "Error", message "Connection is closed." with the offline queue on and "Stream
 * isn't writeable and enableOfflineQueue options is false" with it off.
 *
 * The NAME and not `instanceof`: ioredis re-exports the class, but the integration suite
 * replaces the whole module with `mock.module`, so an `instanceof` against the driver's
 * export would be `instanceof undefined` there. `redis-errors` sets `name` on the
 * prototype, so the name is the one fact both the real driver and a double can carry.
 */
function isServerErrorReply(error: unknown): boolean {
  return error instanceof Error && error.name === "ReplyError";
}

/**
 * The exact command the revision token is a digest OF, as a plan reader will see it.
 *
 * `ObjectEditRevision.basis` is "the engine expression the comparison is over", so it carries the
 * library name: two tokens from two libraries are never comparable and the field is what says so
 * (#789 Phase 3).
 */
function libraryReadBasis(name: string): string {
  return `FUNCTION LIST LIBRARYNAME ${name} WITHCODE`;
}

/**
 * The catalog fact behind a collateral warning: WHICH surface was read and WHAT it answered.
 *
 * `WITHCODE` is deliberately absent from the source string although the reply came from the same
 * round trip: the fact being reported is the library's registered FUNCTIONS, and
 * `FUNCTION LIST LIBRARYNAME <name>` is the command a reader would run to check it. Core composes
 * the sentence from this in `describeConsequence`, and a provider may never write that prose:
 * the class is closed and the fact is a value an engine answered, so the only thing left to get
 * wrong is one sentence with one owner (#789 Phase 3, ruling 1b amended).
 */
function libraryFact(name: string, functions: readonly string[]): ObjectEditCatalogFact {
  return { source: `FUNCTION LIST LIBRARYNAME ${name}`, observed: functions.join(", ") };
}

/**
 * What a SUCCESSFUL load of this library would destroy, from what it registers TODAY.
 *
 * EVERY FUNCTION THE LIBRARY REGISTERS IS NAMED, AT ONE AS READILY AS AT TWO. `REPLACE` deletes
 * every function the submitted body does not re-create and reports success, and the list this
 * names is what the library registers NOW, never a prediction about the submitted text: no Lua
 * parser is involved anywhere on this path, and the only identity check the build makes is the
 * shebang library name (#789 Phase 3, ruling 1b amended).
 *
 * THE ONE-FUNCTION FLOOR THAT USED TO BE HERE WAS WRONG AND IT WAS MEASURED WRONG, on a real
 * Redis 8.10.0 in a container on 2026-09-14 (D84). Its premise was "a library registering exactly
 * one function IS that function, so a body that re-registers it loses nothing", and the premise
 * is about the SUBMITTED text, which nothing here reads. Driven live: `libredb_probe` registering
 * only `libredb_ping`, loaded again with a body registering `libredb_other` under the SAME
 * shebang, answered `libredb_probe` from the load, `FUNCTION LIST LIBRARYNAME libredb_probe` then
 * answered `libredb_other` alone, and `FCALL libredb_ping 0` answered `ERR Function not found`.
 * Through this provider the same edit built `consequences: []` and applied
 * `applied-with-collateral` naming `libredb_ping`, so the build promised a loss could not happen
 * and the apply reported one that had. That is a SUCCESS destroying something the reader was
 * never shown, which is the clause ruling 1b was amended for.
 *
 * Cost, accepted: an edit of a single-function library carries one warning and one
 * acknowledgement tick even when the body re-registers the same name, because the build cannot
 * know which it does.
 *
 * THE EMPTY ARM IS NOT A SINGLE-FUNCTION LIBRARY AND IT IS NOT A LIVE SERVER STATE. MEASURED on
 * 8.10.0, `FUNCTION LOAD` over a body registering nothing answers `ERR No functions registered`,
 * so every library the server holds registers at least one. What reaches the empty arm is a
 * `FUNCTION LIST` reply {@link parseRegisteredFunctionNames} could read no names out of, and a
 * warning whose fact names nothing is worse than no warning, so it names nothing.
 */
function libraryCollateral(name: string, functions: readonly string[]): readonly ObjectEditConsequence[] {
  if (functions.length === 0) return [];
  return [{ loses: "replaces-whole-container", fact: libraryFact(name, functions) }];
}

/**
 * Where a Redis refusal points, in the coordinates of the text the reader submitted (#789).
 *
 * MEASURED on redis 8.10.0 with two points, so the claim is a measurement and not an inference:
 * a `@@@` on physical line 2 of the submitted body answered
 * `ERR Error compiling function: user_function:2: unexpected symbol near '@'` and the same error
 * on physical line 4 answered `user_function:4`. The count is 1-based and INCLUDES the shebang
 * line, which is the reader's line 1, so the mapping is the identity.
 *
 * IT IS STILL CONVERTED THROUGH CORE'S COORDINATE MAP rather than returned as a number. Two
 * reasons, and neither is symmetry for its own sake: the conversion is what rejects a line the
 * reader's text does not have, and MEASURED in a real browser an out-of-range coordinate handed
 * to `setModelMarkers` did not throw, did not warn and was silently CLAMPED to the end of the
 * model, so nothing downstream catches a number this function gets wrong. And if this engine ever
 * gains a splice, the identity stops holding and the map is already the thing being read.
 *
 * `none` when the sentence carries no coordinate at all, which is the answer for every refusal
 * shape here except a compile error: `ERR No functions registered`, `ERR Missing library
 * metadata`, `ERR Engine 'moon' not found` and `ERR Function libredb_ping already exists` are all
 * about the body as a whole.
 */
function redisErrorPosition(payload: ObjectEditStep, sentence: string): ObjectEditPosition {
  const match = /user_function:(\d+):/.exec(sentence);
  if (match === null) return { within: "none" };
  const line = Number(match[1]);
  let offset = 0;
  for (let seen = 1; seen < line; seen += 1) {
    const next = payload.text.indexOf("\n", offset);
    if (next < 0) return { within: "outside" };
    offset = next + 1;
  }
  return userPositionOf(payload, offset);
}

/**
 * The error prefixes whose reader action is "use a different connection" (#789 Phase 3).
 *
 * Redis's first word IS its error code, which is why it is carried in `ObjectEditRefusal.code` as
 * data as well as read here. Both are measured on 8.10.0: `NOPERM User libredb_nofunction has no
 * permissions to run the 'function|load' command` from the ACL user
 * `docker/redis-init/01-object-fixture.redis` creates, and
 * `READONLY You can't write against a read only replica.` from a replica. They map to `privilege`
 * although only one of them is about permissions, because the refusal CLASS is a statement about
 * what the reader does next and both answers are the same one.
 */
const REDIS_PRIVILEGE_CODES: readonly string[] = Object.freeze(["NOPERM", "READONLY"]);

/**
 * One `FUNCTION LOAD` rejection, turned into the outcome arm it IS (#789 Phase 3).
 *
 * THE FIRST QUESTION IS NOT WHICH REFUSAL, IT IS WHETHER THE SERVER SPOKE AT ALL, and
 * `isServerErrorReply` is what tells the two apart. It is the same distinction
 * `readObjectSource` already makes and it carries the same measurement: an error REPLY arrives as
 * a `redis-errors` `ReplyError`, and a dropped socket arrives as a plain `Error` named `Error`
 * with "Connection is closed." or "Stream isn't writeable and enableOfflineQueue options is
 * false". Nobody answering is not the server answering no, and the difference decides whether the
 * write may have landed: `interrupted` says `committed: "unknown"`, which is the only honest
 * answer, and never `"rolled-back"`, which only a provider that opened its own transaction may
 * claim.
 *
 * Everything else the server says is `definition`, carrying the engine's own sentence unprefixed
 * and its own first-word code as data. A code this table does not know is NOT guessed at: the
 * four other shapes measured on 8.10.0 are all about the body, and inventing a class for an
 * unmeasured fifth would be an inference in a measurement's voice.
 */
function redisApplyFailure(payload: ObjectEditStep, error: unknown, duration: number): ObjectEditOutcome {
  const sentence = error instanceof Error ? error.message : String(error);
  if (!isServerErrorReply(error)) {
    return { outcome: "interrupted", committed: "unknown", sentence, duration };
  }
  const code = sentence.split(" ")[0];
  const refusal = REDIS_PRIVILEGE_CODES.includes(code) ? "privilege" : "definition";
  return {
    outcome: "refused",
    refusal: {
      refusal,
      sentence,
      code,
      at: refusal === "privilege" ? { within: "none" } : redisErrorPosition(payload, sentence),
    },
    duration,
  };
}

// ============================================================================
// Redis Provider
// ============================================================================

export class RedisProvider extends BaseDatabaseProvider {
  private client: Redis | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      // Redis says "json" only because it is not SQL. Without this the client-side
      // generators fall through to their MongoDB branch and every schema-explorer
      // action emits `{"collection":...}` that `executeRedisCommand` rejects (#427).
      queryDialect: "redis",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      // Redis commands are not SQL, so the inline row editor's `UPDATE ... SET` has
      // nothing here to run against (issue #269).
      supportsInlineRowEdit: false,
      // MULTI/EXEC exists in Redis and is not exposed here.
      supportsTransactions: false,
      // Redis has no constraints of any kind, and this provider's "tables" are key
      // prefixes it grouped rather than declared objects. It emits no `foreignKeys`
      // field at all; this says why (#414).
      declaresForeignKeys: false,
      // `getSchema()` SCANs 1000 keys and groups them by the text before the first
      // colon, so every row it returns is this server's own summary of real key names
      // — `user:*` is a grouping, not a key, and nothing can be addressed by it (#414).
      //
      // STILL DECLARED after the object model landed, and it is not redundant with the
      // `keyspace` kind (#789). The flat row menu read this flag to withhold three items
      // from a derived grouping, measured in `src/components/schema-explorer/TableItem.tsx`:
      // Profile Table, Generate Test Data, and the two per-row maintenance links. It did
      // NOT withhold Generate Query, and that is right: the Redis generator answers
      // `SCAN 0 MATCH user:* COUNT 50` for a prefix group, which is a runnable command
      // against exactly the keys the row summarises. The object model reproduces two of
      // those three from the kind's own declaration - `keyspace` declares no
      // `acceptsRowWrites`, so no test-data or create item is offered, and this provider
      // declares `analyze` as `perEntity: false`, so no per-row maintenance item is - and
      // the third, Profile, has no declaration that can carry it, because profiling needs
      // an ADDRESSABLE object while every other relation action here needs only a
      // pattern. `src/components/object-tree/row-actions.ts` reads this flag for that one
      // item, which is why the flag stays.
      tablesAreDerivedGroupings: true,
      supportsMaintenance: true,
      maintenanceOperations: ["analyze"],
      // `runMaintenance(type)` takes no target parameter at all: the operation is
      // `INFO`, which reports on the server and cannot be pointed at a key pattern.
      // A per-row control here would have named one grouping and answered with
      // server-wide metrics - the dead end #427 reported for "Key Info" (#496).
      maintenanceOperationSpecs: {
        analyze: { label: "Server Info", perEntity: false, global: true },
      },
      supportsConnectionString: false,
      defaultPort: 6379,
      // The object model (#789). Both are module constants: see their docblocks for the
      // measurements behind the one container level and the two kinds.
      containerLevels: REDIS_CONTAINER_LEVELS,
      objectKinds: REDIS_OBJECT_KINDS,
      schemaRefreshPattern: "(DEL|FLUSHDB|FLUSHALL|RENAME)\\b",
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: "Key Pattern",
      entityNamePlural: "Key Patterns",
      rowName: "key",
      rowNamePlural: "keys",
      selectAction: "Scan Keys",
      generateAction: "Generate Command",
      analyzeAction: "Key Info",
      vacuumAction: "Memory Doctor",
      searchPlaceholder: "Search keys...",
      analyzeGlobalLabel: "Run Info",
      analyzeGlobalTitle: "Server Info",
      analyzeGlobalDesc: "Get Redis server information and statistics.",
      vacuumGlobalLabel: "Memory Doctor",
      vacuumGlobalTitle: "Memory Analysis",
      vacuumGlobalDesc: "Analyze memory usage and provide optimization suggestions.",
      // Stated verbatim in the agent's plan contract. Unlike MongoDB's, this sentence
      // is not about the LANGUAGE - a plan run on 2026-08-22 wrote real Redis
      // commands - but about the SHAPE it packaged them in:
      //
      //   1) KEYS session:*
      //   2) GET session:1
      //
      // `executeRedisCommand` reads the whole body as one command, so the server
      // answered `ERR unknown command '1)'`. The list numbering and the second
      // command are what made it unrunnable, so those are what this names. The
      // prefix-group sentence is here for the same reason `tablesAreDerivedGroupings`
      // exists: the inventory's rows are named `session:*`, which reads as something
      // addressable and is not (#427).
      statementLanguage:
        'exactly one Redis command, in the plain form `SCAN 0 MATCH session:* COUNT 50` or the lossless form {"command": "GET", "args": ["session:1"]} - one command and no more, with no list numbering, no bullet, no `redis-cli` prefix and no trailing semicolon; and the inventory\'s `prefix:*` rows are groupings this server summarised, not keys, so reach a prefix with SCAN ... MATCH and a key by its real name',
      // `getSlowQueries()` maps SLOWLOG GET, so an empty panel means the log is empty
      // rather than absent - a different fact from the PostgreSQL extension this used
      // to advertise (#463), and the one a Redis operator can act on.
      slowQueriesEmptyState:
        "Redis lists what SLOWLOG holds, and nothing has yet run slower than slowlog-log-slower-than.",
    };
  }

  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: 500, offset: 0 };
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public override validate(): void {
    super.validate();
    if (!this.config.host) {
      throw new DatabaseConfigError("Redis host is required", "redis");
    }
  }

  /**
   * ioredis hands `tls` straight to `tls.connect`, so the connection form's material
   * travels under Node's own names — the same mapping the PostgreSQL, MySQL and
   * Couchbase adapters use. `require` encrypts without checking the chain, because a
   * self-hosted Redis presents a self-signed certificate; the verifying modes check
   * it. An explicit flag always wins. Absent the key entirely for `disable`: ioredis
   * negotiates TLS whenever `tls` is present, `{}` included.
   *
   * Exercised against a TLS-only server, both arms (2026-08-23, `redis:latest` started with
   * `--port 0 --tls-port 6380` so no plaintext port exists): with `disable` the connection is
   * refused ("Connection is closed."), and with `require` it reports connected in 1ms. The two
   * arms together are what make it a measurement rather than a shape — before `tls` reached the
   * driver, `require` failed exactly like `disable`.
   */
  private buildTLSOptions(): RedisOptions["tls"] {
    const ssl = this.config.ssl;
    if (!ssl || ssl.mode === "disable") return undefined;

    const tls: NonNullable<RedisOptions["tls"]> = {
      // `require` encrypts without checking; every other mode verifies. `verify-system`
      // verifies against the runtime's own trust store, with no CA PEM to paste (D26).
      rejectUnauthorized: ssl.rejectUnauthorized ?? ssl.mode !== "require",
    };
    if (ssl.caCert) tls.ca = ssl.caCert;
    if (ssl.clientCert) tls.cert = ssl.clientCert;
    if (ssl.clientKey) tls.key = ssl.clientKey;
    return tls;
  }

  /**
   * The numbered database this connection's SESSION is in. Absent means 0, which is what
   * ioredis does with no `db` option and what a bare `redis-cli` connects to.
   */
  private sessionDatabase(): number {
    return this.config.database ? parseInt(this.config.database, 10) : 0;
  }

  /**
   * Every option ioredis needs, for ONE numbered database.
   *
   * Parameterised by `db` rather than reading `this.config.database` directly, because the
   * object surface reads a database the session is not in: `countObjects(["3"])` has to
   * scan database 3 while the session stays where the user put it. The alternative,
   * `SELECT`-ing on the shared client and selecting back, is a race rather than a shortcut
   * - this provider instance serves concurrent requests, so a query running alongside the
   * tree would execute against whichever database the object read had left selected.
   */
  private redisOptions(db: number): RedisOptions {
    const tls = this.buildTLSOptions();
    return {
      host: this.config.host,
      port: this.config.port || 6379,
      username: this.config.user || undefined,
      password: this.config.password || undefined,
      db,
      connectTimeout: this.queryTimeout,
      lazyConnect: true,
      ...(tls ? { tls } : {}),
    };
  }

  /**
   * The connection form's Username is the Redis 6 ACL user, and it has to reach the
   * driver under ioredis's own name — the field is `user` on the connection and
   * `username` in `RedisOptions`. Without it ioredis sends a one-argument `AUTH`,
   * which Redis resolves against `default`.
   *
   * Measured 2026-08-26 against `redis:latest` with `default` left `nopass +@all` and
   * `probe` defined `on >probepw ~* +@all -info`, both arms: with `{password}` alone
   * `ACL WHOAMI` answered `default` and `INFO` succeeded — the app ran as a principal
   * the user never chose, and health went green. With `{username, password}` WHOAMI
   * answered `probe` and `INFO` was refused `NOPERM`. The two arms together are what
   * make it a measurement rather than a shape (D29).
   *
   * `undefined` when the field is empty, never `""`: a plain `requirepass` server has
   * no ACL user to name, and only an absent `username` authenticates as `default`.
   */
  public async connect(): Promise<void> {
    try {
      this.client = new Redis(this.redisOptions(this.sessionDatabase()));

      await this.client.connect();
      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to Redis: ${error instanceof Error ? error.message : String(error)}`,
        "redis",
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // quit() may fail if already disconnected; force disconnect
        try {
          this.client.disconnect();
        } catch {
          /* ignore */
        }
      } finally {
        this.client = null;
      }
    }
    this.setConnected(false);
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        return this.executeRedisCommand(sql);
      });

      return { ...result, executionTime };
    });
  }

  /**
   * End a `MULTI` a statement left open on this connection, and say whether there was one
   * (D75).
   *
   * ioredis holds ONE connection here (`this.client`, a single `new Redis(...)`), and
   * `getOrCreateProvider` caches this provider per `connection.id` for the whole process,
   * so a `MULTI` a script sent through `query()` and never finished belongs to whoever
   * borrows the handle next. MEASURED 2026-09-15 on redis 7.4.11 through ioredis 5.11.1:
   * after a bare `MULTI`, every later command on that connection answers the string
   * "QUEUED" and does nothing - `SET`, `GET` and even `CLIENT INFO` alike - while a second
   * connection is untouched. So the next user's command does not fail, it silently does
   * not happen, and the schema explorer's `SCAN` is queued with it.
   *
   * THE ASK IS THAT SUBSTITUTION, AND IT IS NOT THE ACT. ioredis publishes no transaction
   * state for a `MULTI` sent through `call()` (`status` stays "ready", and the queueing
   * belongs to `Redis.prototype.multi()`'s pipeline object, which a raw command never
   * touches), so the server has to be asked - but a queued reply IS the server answering.
   * `PING` answers "PONG" outside a `MULTI` and "QUEUED" inside one, so one command with a
   * known reply of its own reads the state without changing it.
   *
   * Asking first is not a refinement, it is what keeps an ordinary connection working.
   * MEASURED on the same server: a read-only ACL (`+@read +ping +info`) answers "PONG" to
   * `PING` and "NOPERM User ro has no permissions to run the 'discard' command" to
   * `DISCARD`, and cannot run `MULTI` at all. `POST /api/db/multi-query` awaits this call
   * in a `finally`, so a blind `DISCARD` would turn every request on such a connection into
   * an error response and throw away the statement results it had already earned. With the
   * ask first, no `DISCARD` is sent unless there is one to send. The narrower ACL that CAN
   * open a `MULTI` but not discard it (`+@read +ping +multi +set`, measured) still raises,
   * and must: that transaction is open and this provider cannot end it.
   *
   * `DISCARD` and not `EXEC`, for the reason at `OpenQueryTransactionOutcome`: a script
   * that queued commands and never said `EXEC` did not ask for them to run.
   *
   * THE `scope` PARAMETER IS DECLARED ON THE INTERFACE AND IGNORED HERE, deliberately (D87). It
   * exists so a provider that borrows a DIFFERENT pooled client per call can name the one the
   * caller's own statements ran on; this provider holds ONE cached connection for its whole life, so
   * there is no other client to name. A signature that took it and did nothing with it would only
   * suggest the question had been considered per call, which it has not.
   *
   * WHAT THAT DOES NOT MEAN: that the transaction ended here is the caller's own. It is the clearest case of the three
   * providers that ignore this parameter. A `MULTI` is state of the CONNECTION, and this provider
   * has one for every concurrent request on the stored connection, so `POST /api/db/query` running
   * this in its `finally` PINGs and, on `QUEUED`, `DISCARD`s whatever `MULTI` is open there, whoever
   * opened it. A plain `GET` typed by one user therefore drops a `MULTI` another user had just
   * queued commands into, and that user is told nothing: their next command answers `QUEUED` from
   * no transaction. The `DISCARD` catch below already half-knows this, since "another caller on
   * this shared connection ended it in between" is the same collision seen from the other side.
   * It is the D87 shape on a single connection and it is NOT closed: closing it needs the `MULTI`
   * owned by a call scope rather than by the connection, which is a design change and not a
   * parameter, so it is filed rather than worked around here.
   */
  public async endOpenQueryTransaction(): Promise<OpenQueryTransactionOutcome> {
    this.ensureConnected();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reading = await (this.client as any).call("PING");
    if (reading === PONG_REPLY) return "none";
    if (reading !== QUEUED_REPLY) {
      // A third answer is a reading this code does not have. Reporting it as a clean
      // connection would certify an absence nobody read.
      throw new QueryError(`Cannot read Redis transaction state: PING answered ${String(reading)}`, "redis");
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.client as any).call("DISCARD");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The reading already said a `MULTI` was open, so the server's own "there was nothing
      // queued" can only mean another caller on this shared connection ended it in between.
      // The queue is gone either way, which is what "rolled-back" reports. Anything else is
      // a real failure - an ACL that refuses the `DISCARD`, a dead socket - and is raised:
      // the transaction is still open and this must not report it as ended.
      if (!message.includes(NO_TRANSACTION_MARKER)) throw error;
    }

    return "rolled-back";
  }

  /**
   * Advance the plain tokenizer's quote state across one line of text, using the
   * SAME rule `executePlainCommand` uses: outside a quote any `"` or `'` opens
   * one, inside a quote only the matching character closes it, and there is no
   * escape handling. Returns the open quote character, or '' when none is open.
   */
  private static quoteStateAfter(text: string, quoteChar: string): string {
    let open = quoteChar;
    for (const ch of text) {
      if (open === "") {
        if (ch === '"' || ch === "'") open = ch;
      } else if (ch === open) {
        open = "";
      }
    }
    return open;
  }

  /**
   * Reduce a buffer to the ONE command it should run: drop every `#` comment
   * line, then take the first blank-line-delimited block and join its lines back
   * with a NEWLINE. A line is a comment only when it *starts* with `#` (after
   * trimming) AND no quoted argument is open across it, so a `#` inside a key or
   * value is never mistaken for one. Returns '' when nothing runnable remains
   * (#427).
   *
   * Why a block rather than a line: outside quotes the tokenizer treats a
   * newline as ordinary whitespace, so a single command wrapped across several
   * lines (`HSET k a 1` / `b 2`) has always run whole, and a pretty-printed JSON
   * command is legitimately multi-line — picking only line 1 would silently
   * half-execute both. Why not the whole buffer: the schema-explorer "Generate
   * Command" cheatsheet is a list of alternatives separated by blank lines, and
   * running the buffer must run only its first command, not all of them.
   *
   * Why the join character is a newline and not a space: the tokenizer's
   * whitespace branch is guarded by `!inQuote`, so a newline INSIDE a quoted
   * argument is data. `SET note "line1\nline2"` stores a two-line value, and
   * joining with a space silently rewrote it to `line1 line2`. A newline join
   * keeps both behaviours exactly, and lines are appended verbatim so
   * indentation inside a quoted value survives too.
   */
  /**
   * What a buffer line is to `commandBody`. Both chrome kinds require that no
   * quoted argument is open across the line: inside one, a line-leading `#` and
   * an empty line are data, not structure (#427).
   */
  private static lineKind(raw: string, quoteChar: string): "comment" | "blank" | "content" {
    if (quoteChar !== "") return "content";
    const line = raw.trim();
    if (line.startsWith("#")) return "comment";
    return line === "" ? "blank" : "content";
  }

  private commandBody(input: string): string {
    const block: string[] = [];
    let quoteChar = "";
    let isJsonBlock = false;
    for (const raw of input.split("\n")) {
      const kind = RedisProvider.lineKind(raw, quoteChar);
      if (kind === "comment") continue;
      if (kind === "blank") {
        // A blank line ends the first block; blank lines before it are leading padding.
        if (block.length > 0) break;
        continue;
      }
      // The block's kind is fixed by its first content line, using the SAME test
      // `executeRedisCommand` uses to pick a parser. Quote tracking exists only to
      // protect a `#` inside a quoted argument of a PLAIN command, and its rules
      // are the plain tokenizer's — no escape handling. Applying them to a JSON
      // body counted `\"` inside a string as a real quote, so a key named `say"hi`
      // left a phantom quote open, every later comment line stopped being dropped,
      // and the buffer reached `JSON.parse` with comments in it (#427). A JSON
      // body cannot hide a line-leading `#` inside a string — JSON strings carry
      // no literal newline — so it needs no tracking at all.
      if (block.length === 0) isJsonBlock = raw.trimStart().startsWith("{");
      block.push(raw);
      if (!isJsonBlock) quoteChar = RedisProvider.quoteStateAfter(raw, quoteChar);
    }
    return block.join("\n");
  }

  private async executeRedisCommand(input: string): Promise<Omit<QueryResult, "executionTime">> {
    const body = this.commandBody(input);
    if (body.trim() === "") {
      throw new QueryError("No command to run (only comments or blank lines)", "redis");
    }

    // Try JSON format first — over the whole block, because `JSON.stringify(cmd,
    // null, 2)` is what the MongoDB-shaped generator emits and what users paste.
    // It is also the lossless form the Redis generators fall back to for any
    // argument the plain tokenizer cannot round-trip. Trailing `#` comment lines
    // are dropped with every other comment; trailing non-comment text is not —
    // it joins the block and fails JSON.parse (#427).
    if (body.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(body);
        return this.executeJsonCommand(parsed);
      } catch {
        throw new QueryError("Invalid JSON command format", "redis");
      }
    }

    // Plain text command format: COMMAND arg1 arg2 ...
    return this.executePlainCommand(body);
  }

  private async executeJsonCommand(cmd: RedisJsonCommand): Promise<Omit<QueryResult, "executionTime">> {
    if (!cmd.command) {
      throw new QueryError('Command is required in JSON format: { "command": "GET", "args": ["key"] }', "redis");
    }

    const command = cmd.command.toUpperCase();
    const args = cmd.args || [];

    return this.runCommand(command, args);
  }

  private async executePlainCommand(input: string): Promise<Omit<QueryResult, "executionTime">> {
    // Parse plain text command, respecting quoted strings
    const parts: string[] = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (!inQuote && (ch === '"' || ch === "'")) {
        inQuote = true;
        quoteChar = ch;
      } else if (inQuote && ch === quoteChar) {
        inQuote = false;
      } else if (!inQuote && /\s/.test(ch)) {
        if (current) {
          parts.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);

    if (parts.length === 0) {
      throw new QueryError("Empty command", "redis");
    }

    const command = parts[0].toUpperCase();
    const args = parts.slice(1);

    return this.runCommand(command, args);
  }

  private async runCommand(command: string, args: string[]): Promise<Omit<QueryResult, "executionTime">> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client as any).call(command, ...args);
      return this.formatResult(command, result);
    } catch (error) {
      throw new QueryError(`Redis error: ${error instanceof Error ? error.message : String(error)}`, "redis");
    }
  }

  private formatResult(command: string, result: unknown): Omit<QueryResult, "executionTime"> {
    // Handle null/nil
    if (result === null || result === undefined) {
      return { rows: [{ result: "(nil)" }], fields: ["result"], rowCount: 0 };
    }

    // Handle arrays (KEYS, SMEMBERS, LRANGE, etc.)
    if (Array.isArray(result)) {
      if (result.length === 0) {
        return { rows: [{ result: "(empty list)" }], fields: ["result"], rowCount: 0 };
      }

      // HGETALL returns flat [key, val, key, val...]
      if (command === "HGETALL" && result.length % 2 === 0) {
        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < result.length; i += 2) {
          rows.push({ field: String(result[i]), value: String(result[i + 1]) });
        }
        return { rows, fields: ["field", "value"], rowCount: rows.length };
      }

      // Regular array result
      const rows = result.map((item, index) => ({
        index: index + 1,
        value: typeof item === "object" ? JSON.stringify(item) : String(item),
      }));
      return { rows, fields: ["index", "value"], rowCount: rows.length };
    }

    // Handle integers
    if (typeof result === "number") {
      return { rows: [{ result: `(integer) ${result}` }], fields: ["result"], rowCount: 1 };
    }

    // Handle strings
    if (typeof result === "string") {
      // INFO command — parse into structured output
      if (command === "INFO") {
        return this.parseInfoResult(result);
      }
      return { rows: [{ result }], fields: ["result"], rowCount: 1 };
    }

    // Fallback
    return {
      rows: [{ result: JSON.stringify(result) }],
      fields: ["result"],
      rowCount: 1,
    };
  }

  private parseInfoResult(info: string): Omit<QueryResult, "executionTime"> {
    const rows: Record<string, unknown>[] = [];
    let currentSection = "";

    for (const line of info.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        currentSection = trimmed.replace("# ", "");
        continue;
      }
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        rows.push({
          section: currentSection,
          key: trimmed.substring(0, colonIdx),
          value: trimmed.substring(colonIdx + 1),
        });
      }
    }

    return { rows, fields: ["section", "key", "value"], rowCount: rows.length };
  }

  // ============================================================================
  // Schema Operations (Key patterns as "tables")
  // ============================================================================

  /**
   * One bounded `SCAN` walk of ONE database, collapsed to one entry per key grouping.
   *
   * THE single enumerator for the `keyspace` kind: `getSchema()`, `countObjects`,
   * `listObjects` and `describeObject` all read this and nothing else reads the keyspace.
   * That is where standing ruling 5f is held on an engine whose catalog is a command rather
   * than a query - there is no second SCAN with a different MATCH for a count and a listing
   * to drift apart in, and the count is the SIZE of the map this returns.
   *
   * Bounded at 1000 keys on purpose, and it is the same bound `getSchema()` has always had:
   * a full walk of a production keyspace is unbounded work on the server. What that costs is
   * real and is written down in the provider doc: on a keyspace larger than the bound, the
   * groupings are the groupings of a SAMPLE.
   *
   * `SCAN` is never `KEYS *`, which blocks the server for the length of the walk.
   */
  private static async scanKeyGroups(
    client: Redis,
  ): Promise<{ groups: Map<string, { count: number; types: Set<string> }>; truncated: boolean }> {
    const keyPatterns = new Map<string, { count: number; types: Set<string> }>();
    let cursor = "0";
    let totalScanned = 0;

    do {
      const [nextCursor, keys] = await client.scan(cursor, "COUNT", 100);
      cursor = nextCursor;

      for (const key of keys) {
        totalScanned++;
        const prefix = keyGrouping(key);
        if (!keyPatterns.has(prefix)) {
          keyPatterns.set(prefix, { count: 0, types: new Set() });
        }
        keyPatterns.get(prefix)!.count++;

        // Sample type for first few keys per pattern
        if (keyPatterns.get(prefix)!.types.size < 3) {
          try {
            const type = await client.type(key);
            keyPatterns.get(prefix)!.types.add(type);
          } catch {
            // ignore
          }
        }
      }
    } while (cursor !== "0" && totalScanned < KEY_SCAN_LIMIT);

    // A cursor back at "0" means the server walked the whole keyspace and this is
    // everything it holds; anything else means the key budget stopped the walk, so what
    // came back is a SAMPLE and every grouping derived from it is a floor. The count is
    // what decides the folder badge, so the caller is told rather than left to assume.
    return { groups: keyPatterns, truncated: cursor !== "0" };
  }

  // ============================================================================
  // Object Model (#789)
  // ============================================================================

  /**
   * A short-lived connection to ONE numbered database, for one object read.
   *
   * Its own connection rather than the session's, for the reason `redisOptions()` records:
   * a `SELECT` on the shared client would decide which database a concurrent query ran
   * against. Closed with `disconnect()` rather than `quit()` because nothing is pending on
   * it - `quit()` waits for a reply this caller has no use for.
   */
  private async withDatabase<T>(db: number, read: (client: Redis) => Promise<T>): Promise<T> {
    const client = new Redis(this.redisOptions(db));
    try {
      await client.connect();
      return await read(client);
    } finally {
      client.disconnect();
    }
  }

  /**
   * The numbered databases this deployment actually has.
   *
   * `CONFIG GET databases` and not a hardcoded 16: measured on redis 8.10.0, the stock
   * server answers 16 and the same image with `--cluster-enabled yes` answers 1, so the
   * reply already carries the deployment's shape. A refused or unparsable reply RAISES
   * (see `parseDatabaseCount`), because every fallback available here is a number nobody
   * measured.
   *
   * Every database is listed, including the empty ones. A Redis database is not created and
   * not dropped: all of them exist at all times, so listing only the ones `INFO keyspace`
   * mentions would hide a database a person is about to write to.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.ensureConnected();
    if (parent !== undefined && parent.length > 0) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply = await (this.client as any).call("CONFIG", "GET", "databases");
    const count = parseDatabaseCount(reply);
    const session = this.sessionDatabase();

    return Array.from({ length: count }, (_, index) => ({
      path: [String(index)],
      name: String(index),
      level: 0,
      // Redis publishes this one exactly: a connection is IN a database at all times, so
      // unlike a PostgreSQL `search_path` there is one answer and it is never ambiguous.
      isSessionDefault: index === session,
    }));
  }

  /**
   * How many objects of each declared kind one database holds.
   *
   * The count of a kind is the LENGTH of the listing that kind's own enumerator returns, so
   * the badge and the folder cannot disagree about what was counted (standing ruling 5f).
   * On a SQL engine that rule is a warning about two WHERE clauses; here the catalog is a
   * command, and the seam is this: `listIn` is the only thing that reads either catalog, and
   * both methods call it.
   *
   * Per KIND and not per read, which is what `KindCount` is for: a Redis-wire relative with no
   * `FUNCTION` command still has a keyspace, so its function folder carries the server's own
   * refusal while the keyspace folder carries a real number. Collapsing them would report a
   * whole database as unavailable because one of two commands is missing. The fourth state is
   * per kind for the same reason and lands in the same record: a `keyspace` count from a walk
   * the key budget cut short is a FLOOR, while the `function` count beside it is exact.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const db = containerDatabase(capabilities, container);
    const declared = declaredKinds(capabilities);
    const counts: Record<string, KindCount> = {};

    return this.withDatabase(db, async (client) => {
      // EVERY declared kind gets an entry, whatever the replies hold. Nine providers seed
      // zeros first and then overwrite from catalog rows; this loop is over the DECLARATION
      // itself and assigns unconditionally, which is the same guarantee without a write that
      // no mutation can reach - a kind holding nothing lands as `{ count: 0 }` because the
      // listing was empty, and a declared-and-empty folder therefore keeps its 0 badge.
      for (const kind of declared) {
        try {
          // The ENUMERATOR reports whether its read was bounded, so the count and that fact
          // come from one call and cannot drift: a folder badging `4+` and a listing of four
          // rows are the same walk. A bounded read answers a FLOOR, and the fourth `KindCount`
          // state is what says so instead of claiming the database holds exactly four.
          const { objects, sampledFrom } = await this.listIn(client, container, kind.id);
          counts[kind.id] =
            sampledFrom === undefined ? { count: objects.length } : { count: objects.length, sampledFrom };
        } catch (error) {
          // The server's own sentence, verbatim and unprefixed: it is rendered to a person
          // as the reason a folder has no number, so our words must not go in front of it.
          counts[kind.id] = { unavailable: error instanceof Error ? error.message : String(error) };
        }
      }
      return counts;
    });
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // The DECLARATION answers "is this a kind of mine", never the presence of a reader
    // below: deciding it from the reader would report "declares no object kind" about a
    // kind `objectKinds` does declare.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`Redis declares no object kind "${kind}"`, "redis");
    }
    const db = containerDatabase(capabilities, container);
    return this.withDatabase(db, async (client) => (await this.listIn(client, container, kind)).objects);
  }

  /**
   * ONE bounded walk turned into the key groupings it saw, each carrying the value types
   * that walk sampled under it.
   *
   * The one place a `keyspace` object is BUILT, so its path, its label, its row count and
   * the sample its columns are derived from all come from one pass. `listObjects` takes the
   * objects out of it and `describeObjects` takes the samples, which is what keeps the two
   * from describing the same grouping from two different walks - and this engine can tell
   * the difference, because two walks of a live keyspace need not see the same keys.
   *
   * Sorted by PATH, segment by segment. That is not a preference here, it is the only order
   * there is: `SCAN` guarantees NO order at all, not even a stable one between two walks of
   * an unchanged keyspace, so a bounded read's membership is decided by `comparePaths` and
   * never by the server. Every other engine in #789 cuts under the server's own collation
   * and re-sorts in code; this one has nothing to cut under.
   */
  private static async keyspaceEntries(
    client: Redis,
    container: readonly string[],
    kind: string,
  ): Promise<{ entries: { object: DatabaseObject; types: ReadonlySet<string> }[]; truncated: boolean }> {
    const { groups, truncated } = await RedisProvider.scanKeyGroups(client);
    const entries = [...groups.entries()]
      .map(([pattern, info]) => ({
        object: {
          path: [...container, pattern],
          name: pattern,
          kind,
          // The keys this SCAN walk saw under the prefix, which is a sample and not a total
          // wherever the keyspace is larger than the bound.
          rowCount: info.count,
        },
        types: info.types as ReadonlySet<string>,
      }))
      .sort((left, right) => comparePaths(left.object.path, right.object.path));
    return { entries, truncated };
  }

  /**
   * One walked grouping turned into one `ObjectDetail`, shared by the single and the bulk
   * read.
   *
   * One function because a caller joins the two answers together: two copies would be two
   * chances for the bulk read to spell a grouping's columns differently from the single read
   * of the same grouping. It goes through `keyGroupColumns`, which is also what `getSchema()`
   * builds its rows from, so all three surfaces describe one grouping one way while the flat
   * one is still live.
   */
  private static keyspaceDetail(path: readonly string[], types: ReadonlySet<string>): ObjectDetail {
    return { path: [...path], columns: keyGroupColumns(types), indexes: [], foreignKeys: [] };
  }

  /**
   * The objects of one kind in one database, and whether the read that produced them was
   * BOUNDED. The ONE reader of either catalog.
   *
   * `sampledFrom` travels with the objects rather than being worked out by the caller, so the
   * count, the rows and the claim about how complete they are all come from one walk.
   *
   * Sorted by PATH, segment by segment, rather than by the order the server answered in:
   * `SCAN` guarantees no order at all, and `FUNCTION LIST` answers in an internal order that
   * is not the load order.
   *
   * A FUNCTION LIBRARY IS SERVER-SCOPED AND THIS FOLDER IS PER DATABASE, so the SAME library
   * is listed under every database, at a different path each time: on a stock server answering
   * `CONFIG GET databases` with 16, `libredb_probe` appears in all sixteen Function Libraries
   * folders, and `countObjects` for a database holding no keys at all still answers a function
   * count of 1. That is deliberate rather than a leak. `FUNCTION LIST` takes no database and
   * `SELECT` does not change its answer: measured on redis 8.10.1, one `FUNCTION LOAD` of
   * `libredb_probe` is listed identically after `SELECT 0` and after `SELECT 7`, where `DBSIZE`
   * is 0. This engine declares one container level, the numbered database, so there is no
   * server level to hang the folder on.
   * Hiding the libraries under every database but one would invent a home the engine does not
   * have and would make fifteen of sixteen databases lie about what the server holds.
   */
  private async listIn(
    client: Redis,
    container: readonly string[],
    kind: string,
  ): Promise<{ objects: DatabaseObject[]; sampledFrom?: string }> {
    if (kind === "keyspace") {
      const { entries, truncated } = await RedisProvider.keyspaceEntries(client, container, kind);
      const objects = entries.map((entry) => entry.object);
      // Only when the walk actually stopped early. A completed cursor walked the whole
      // keyspace, and marking that count a floor would teach a reader to discount a number
      // that is exact.
      return truncated ? { objects, sampledFrom: KEY_SCAN_SAMPLE_SENTENCE } : { objects };
    }
    if (kind === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reply = await (client as any).call("FUNCTION", "LIST");
      return {
        objects: parseFunctionLibraries(reply)
          .map((name) => ({ path: [...container, name], name, kind }))
          .sort((left, right) => comparePaths(left.path, right.path)),
      };
    }
    throw new QueryError(`Redis declares the kind "${kind}" but has no command that lists it`, "redis");
  }

  /**
   * What one object of one KIND is made of.
   *
   * The kind decides, and nothing here reads the name to work out what it is holding: a key
   * grouping and a function library can legitimately be called the same thing, since one is
   * a key prefix and the other a Lua library name, and there is no namespace shared between
   * them to stop it.
   *
   * A function library answers three empty arrays with NO round trip. That is a true fact
   * about the kind rather than a failed read: a library has no columns, no indexes and no
   * foreign keys, and its SOURCE - the one thing it does have - is Phase 2's, through
   * `FUNCTION LIST WITHCODE`.
   *
   * THE TWO KINDS ARE DELIBERATELY ASYMMETRIC ABOUT EXISTENCE, and this is the reason. A
   * `function` path describes successfully for ANY name, because nothing here reads the
   * catalog to answer it; a `keyspace` path whose grouping the current scan no longer holds
   * RAISES below. Existence is not the same question on the two kinds: a key grouping is
   * derived from a scan, so it ceases to exist the moment its last key is deleted and an
   * empty shape would claim a grouping that is gone, while a library's detail at this depth
   * is a property of the KIND rather than of the object and is correct without asking. Paying
   * a `FUNCTION LIST` round trip here only to raise would buy a check nothing in Phase 1 shows
   * a person. Phase 2 is where the two must agree: its Source tab reads
   * `FUNCTION LIST WITHCODE LIBRARYNAME <name>`, which is a round trip that can miss, and it
   * misses QUIETLY: measured on redis 8.10.1, `FUNCTION LIST LIBRARYNAME no_such_library`
   * answers an empty array rather than an error, so whatever reads it has to treat emptiness as
   * absence itself. That belongs in `describeObject` at that point rather than in the tab.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`Redis declares no object kind "${kind}"`, "redis");
    }

    assertObjectPathShape(capabilities, findKind(capabilities, kind), kind, path, PATH_SHAPE_ENGINE);
    const levels = declaredLevels(capabilities);

    if (kind !== "keyspace") return { path: [...path], columns: [], indexes: [], foreignKeys: [] };

    const db = containerDatabase(capabilities, path.slice(0, levels.length));
    // The LAST segment and never `path[1]`: at depth 2 the second segment is a container.
    const name = path[path.length - 1];
    return this.withDatabase(db, async (client) => {
      const { groups } = await RedisProvider.scanKeyGroups(client);
      const info = groups.get(name);
      if (info === undefined) {
        throw new QueryError(
          `No key under ${JSON.stringify(name)} was found in the ${KEY_SCAN_LIMIT}-key SCAN of database ${db}`,
          "redis",
        );
      }
      return RedisProvider.keyspaceDetail(path, info.types);
    });
  }

  /**
   * `FUNCTION LIST LIBRARYNAME <name> WITHCODE`, as its own method (#789 Phase 2).
   *
   * A method rather than an inline call so the refusal arm of `readObjectSource` can be
   * driven without reaching into ioredis, and so the command text has one writer. It is
   * SERVER-SCOPED and takes no database: measured on redis 8.10.0, one `FUNCTION LOAD` is
   * visible from every numbered database and `SELECT` does not change what `FUNCTION LIST`
   * answers, which is the same fact `listObjects` records for the listing.
   */
  private async callFunctionList(name: string): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.client as any).call("FUNCTION", "LIST", "LIBRARYNAME", name, "WITHCODE");
  }

  /**
   * A function library's Lua source (#789 Phase 2).
   *
   * ONE kind can answer here and the DECLARATION says which: `function` declares `hasSource`
   * and `keyspace` does not, because a key prefix is a grouping this server derived from a
   * bounded `SCAN` and nobody wrote a definition for it. That is the
   * `tablesAreDerivedGroupings` refusal carried into the object model rather than left behind
   * with the flag's old reader. The refusal is read off the declaration and never off the
   * kind id, so a kind this engine does not declare at all takes the same path.
   *
   * A library the server does not hold RAISES. It has to: measured on redis 8.10.0,
   * `FUNCTION LIST LIBRARYNAME no_such_library WITHCODE` answers an EMPTY ARRAY and not an error, so
   * emptiness is absence here and a provider that returned a document would invent one. A
   * matching entry carrying no `library_code` takes the same arm, because an empty text would
   * put an empty editor over a definition that was never read.
   *
   * A refusal is the server's own sentence, unprefixed. KeyDB, DragonflyDB and Garnet have no
   * `FUNCTION` command at all and each refuses in its own words (all measured 2026-09-11), so
   * this path is reachable on three of the four Redis-wire relatives this type id serves.
   *
   * A refusal is ONLY the server's own error reply. A TRANSPORT failure RAISES, because it is
   * nobody answering rather than the server answering "no", and a pane reading "Connection is
   * closed." as this object's refusal would be a symptom presented as a fact about the
   * object. `isServerErrorReply` carries the measurement that tells the two apart.
   *
   * The name is `path[path.length - 1]` and never `path[1]`: standing ruling 5g, and the
   * integration suite pins it by swapping a two-level declaration in. The path SHAPE that
   * makes the last segment meaningful is checked by `assertObjectPathShape`, the same
   * function and the same sentence `describeObject` uses, because the HTTP route is not the
   * only caller: this method is published through `@libredb/studio` and reached by the
   * embedded host seam and by the conformance helper, none of which passes through a route.
   *
   * A kind that declares source and no `sourceLanguage` RAISES rather than falling back to
   * a literal "lua", which the external review of PR #820 corrected (#789). An unregistered
   * Monaco id degrades to plain text with no throw and nothing observable, so the fallback
   * hid a deleted declaration behind a tab that had quietly stopped highlighting.
   */
  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec?.hasSource !== true) {
      throw new QueryError(`Redis declares no readable source for the kind "${kind}"`, "redis");
    }
    const language = spec.sourceLanguage;
    if (language === undefined) {
      // An unregistered or absent Monaco id degrades to plain text with no throw and nothing
      // observable, so a kind that declared source and forgot its language would ship a
      // Source tab that silently stopped highlighting. The declaration is the only source of
      // the language and there is no literal here to fall back to: the census in
      // `tests/isolated/object-source-declarations.test.ts` pins every declared language, so
      // this arm is only ever reached by a declaration somebody deleted.
      throw new QueryError(
        `Redis declares readable source for the kind "${kind}" and no sourceLanguage to render it with`,
        "redis",
      );
    }
    assertObjectPathShape(capabilities, findKind(capabilities, kind), kind, path, PATH_SHAPE_ENGINE);
    const name = path[path.length - 1];
    let reply: unknown;
    try {
      reply = await this.callFunctionList(name);
    } catch (error) {
      // ONLY the server's own error reply is a refusal. A transport failure is nobody
      // answering at all, and answering a document for it would put "Connection is closed."
      // in the Source pane as this object's own refusal, with no raise, no retry affordance
      // and nothing in the document telling it apart from a real NOPERM. The two shapes are
      // measured on `isServerErrorReply`.
      if (!isServerErrorReply(error)) {
        throw new ConnectionError(
          `Failed to read the Redis function library ${JSON.stringify(name)}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          "redis",
        );
      }
      return {
        path: [...path],
        kind,
        parts: [
          {
            id: "definition",
            label: "Definition",
            unavailable: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    const code = parseFunctionLibraryCode(reply, name);
    if (code === undefined || code.trim() === "") {
      throw new QueryError(`Redis holds no function library called "${name}"`, "redis");
    }
    const bounded = applySourceBound(code, limit);
    return {
      path: [...path],
      kind,
      parts: [
        {
          id: REDIS_SOURCE_PART_ID,
          label: "Definition",
          text: bounded.text,
          language,
          form: "complete",
          origin: "stored",
          ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
          // THE AFFORDANCE, read off the DECLARATION and never off the kind id (#789 Phase 3).
          // A kind this engine declares and does not accept edits for answers no `edit` field
          // at all, which is a different fact from an `offered: false` and is what the pane's
          // predicate reads.
          //
          // IT IS OFFERED ON A TRUNCATED PART TOO, and that is deliberate rather than an
          // oversight. The bound is the CALLER's and the same object read without one is
          // whole, so a provider that withheld the affordance here would be answering a
          // property of this REQUEST as a property of the object. The refusal that matters is
          // made twice where it can be made honestly: the pane's own predicate reads
          // `truncated` before it reads `edit`, and `buildObjectEdit` re-reads the definition
          // and refuses `guard` when the server's bytes are longer than the read bound.
          ...(spec.acceptsSourceEdits === true ? { edit: { offered: true as const } } : {}),
        },
      ],
    };
  }

  /**
   * Build the ONE command that replaces a function library's definition (#789 Phase 3).
   *
   * THE EDITABLE UNIT IS THE LIBRARY AND NEVER ONE FUNCTION, which is what the Phase 2
   * declaration already says: `function` is the kind, its objects are libraries, and
   * `FUNCTION LIST WITHCODE` answers a library's whole Lua source. Redis publishes no surface
   * that writes one registered function.
   *
   * THE STRATEGY IS `replace-in-place-command` AND THE PREVIEWABLE UNIT IS A COMMAND, which is
   * why {@link ObjectEditUnit} has two arms at all. The apply is
   * `FUNCTION LOAD REPLACE <library code>`, and MEASURED on redis 8.10.0 its reply is the library
   * NAME the server read out of the shebang. Rendering that as pseudo-SQL would be a lie about
   * what runs.
   *
   * RULING 1b, BOTH AXES, MEASURED on 8.10.0 in a container created for this task:
   * - A FAILURE CANNOT LOSE THE OBJECT. Four refusal shapes were measured, a compile error
   *   (`ERR Error compiling function: user_function:5: '=' expected near 'local'`), a body
   *   registering nothing (`ERR No functions registered`), a missing shebang
   *   (`ERR Missing library metadata`) and an unknown engine (`ERR Engine 'moon' not found`), and
   *   after every one of them `FCALL libredb_ping 0` still answered `pong`.
   * - A SUCCESS CAN DESTROY SOMETHING, which is the second axis and the reason
   *   {@link ObjectEditPlan.consequences} is filled here. `REPLACE` replaces the WHOLE LIBRARY:
   *   measured, a body carrying only `libredb_ping` loaded successfully, answered
   *   `"libredb_probe"`, and `FCALL libredb_echo_key` then answered `ERR Function not found`. The
   *   sibling was deleted and success was reported.
   *
   * THE COLLATERAL READ RUNS IN BOTH DIRECTIONS AND IS NOT CONDITIONAL ON ANYTHING. It is the
   * same round trip that reads the definition, so it costs nothing, and running it only when
   * something already suspects a collateral would be a guard whose loop never sees the negative
   * case: `consequences: []` would never be produced and the empty arm would be dead. The
   * fixture holds one library of each shape for exactly this, `libredb_probe` with two
   * registered functions and `LIBREDB_PROBE` with one, and they are also the pair that proves
   * the byte-for-byte selection, because `LIBRARYNAME` is a CASE-INSENSITIVE glob over a
   * CASE-SENSITIVE dictionary.
   *
   * NO LUA PARSER IS INVOLVED ANYWHERE, here or in the apply. The warning says what the library
   * REGISTERS TODAY, which is a catalog fact, and never what the submitted text will register,
   * which would be a prediction from a Lua source this provider does not evaluate.
   *
   * THREE REFUSALS, IN THIS ORDER, and each one answers before anything is sent.
   *
   * A READ THE SERVER REFUSES RAISES rather than becoming a refusal, which is the one asymmetry
   * with `readObjectSource`: a NOPERM on `FUNCTION LIST` leaves this method knowing nothing about
   * the object, so there is no plan to issue and no fact a refusal could carry. The pane's own
   * read has already reported that sentence in the part it draws.
   */
  public async buildObjectEdit(request: ObjectEditRequest): Promise<ObjectEditBuild> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = requireEditableKind(capabilities, request.kind, REDIS_ENGINE);
    if (request.partId !== REDIS_SOURCE_PART_ID) {
      throw new QueryError(
        `A Redis ${spec.label.toLowerCase()} has one source part, "${REDIS_SOURCE_PART_ID}", ` +
          `received "${request.partId}"`,
        "redis",
      );
    }
    assertObjectPathShape(
      capabilities,
      findKind(capabilities, request.kind),
      request.kind,
      request.path,
      PATH_SHAPE_ENGINE,
    );
    // The LAST segment and never `path[1]`: at depth 2 the second segment is a container, and
    // the suite drives this by spying a two-level declaration in.
    const name = request.path[request.path.length - 1];
    const library = parseFunctionLibrary(await this.callFunctionList(name), name);
    if (library === undefined || library.code === undefined || library.code.trim() === "") {
      // The same fact and the same sentence the source read answers for an absent library:
      // measured, `FUNCTION LIST LIBRARYNAME no_such_library` answers an EMPTY ARRAY, so
      // emptiness is absence and a build that carried on would plan a write against nothing.
      throw new QueryError(`Redis holds no function library called "${name}"`, "redis");
    }
    const definition = library.code;

    const refuse = (refusal: ObjectEditRefusalClass, sentence: string): ObjectEditBuild => ({
      built: false,
      // `at: { within: "none" }` on every one of them, and it is a fact rather than a default:
      // nothing has been sent, so no engine has reported a position and there is no coordinate
      // to convert.
      refusal: { refusal, sentence, at: { within: "none" } },
    });

    // 1. The read bound. A part the pane could only show TRUNCATED is never editable: submitting
    //    the bounded text back is a truncation dressed as an edit, and it would delete
    //    everything past the bound. The number is core's `EDIT_CHARACTER_LIMIT`, so this refusal
    //    and the pane's bound can never drift apart, and the fixture's `libredb_bulk` is the
    //    population: MEASURED on 8.10.0, `FUNCTION LOAD` ACCEPTS a library over that bound and
    //    `FUNCTION LIST LIBRARYNAME libredb_bulk WITHCODE` reports 1,000,243 characters for it.
    if (definition.length > EDIT_CHARACTER_LIMIT) {
      return refuse(
        "guard",
        `this definition is ${definition.length.toLocaleString("en-US")} characters and the Source pane is ` +
          `bounded at ${EDIT_CHARACTER_LIMIT.toLocaleString("en-US")} characters, so the text you edited is a ` +
          "truncation of it and submitting it back would delete everything past the bound",
      );
    }

    // 2. Byte-identical text. A refusal and never a no-op apply, because sending an apply that
    //    cannot change anything spends a write path, an audit row and a round trip on nothing.
    //    It is a BYTE comparison and it is sound on this engine for the reason
    //    {@link libraryDigest} records: the bytes come back as they were loaded.
    if (request.text === definition) {
      return refuse("definition", "this text is identical to the definition on the server");
    }

    // 3. The SHEBANG, which is the whole identity on this engine. The three measured outcomes an
    //    edited one produces are in {@link shebangLibraryName}, and the worst of them replaces a
    //    library the reader was never shown.
    const declared = shebangLibraryName(request.text);
    if (declared !== name) {
      const wanted = `#!${spec.sourceLanguage} name=${name}`;
      return refuse(
        "identity",
        (declared === undefined
          ? `this text has no library shebang on its first line, so it names no library at all, and the ` +
            `object being edited declares "${wanted}"`
          : `this text declares the library "${declared}" and the object being edited is "${name}"`) +
          ". MEASURED on Redis 8.10.0, FUNCTION LOAD takes no name argument and the shebang IS the address: a " +
          "body naming another library creates a second one, or REPLACES an existing one wholesale, and " +
          "either way this object is unchanged and your edit is not where you are looking. Put the original " +
          "name back, or load the new library with a FUNCTION LOAD of your own in the editor",
      );
    }

    const payload: ObjectEditStep = {
      text: request.text,
      language: spec.sourceLanguage,
      // ONE segment, and the whole of it is the reader's. There is no splice anywhere on this
      // engine: the command carries the body verbatim, so the coordinate arithmetic is the
      // identity and a compile error's line number is already the reader's own.
      segments: [{ from: "user", start: 0, end: request.text.length }],
    };

    return {
      built: true,
      plan: {
        planVersion: 1,
        planId: randomUUID(),
        issuedAt: new Date().toISOString(),
        connectionFingerprint: await connectionFingerprint(this.config),
        type: this.type,
        path: [...request.path],
        kind: request.kind,
        partId: request.partId,
        strategy: "replace-in-place-command",
        unit: {
          medium: "command",
          name: REDIS_LOAD_COMMAND.name,
          arguments: [...REDIS_LOAD_COMMAND.arguments],
          payload,
        },
        // NONE. `FUNCTION LOAD` is server-scoped: measured on 8.10.0, one load is visible from
        // every numbered database and `SELECT` does not change what `FUNCTION LIST` answers, so
        // nothing this apply does depends on a session another borrower of this connection can
        // move.
        session: [],
        revision: {
          check: "compared",
          token: libraryDigest(definition),
          basis: libraryReadBasis(name),
          scope: "server",
        },
        consequences: libraryCollateral(name, library.functions),
      },
      preimage: { text: definition, language: spec.sourceLanguage },
    };
  }

  /**
   * Send the plan, and NEVER the text again (#789 Phase 3, ruling 1a).
   *
   * THE COMMAND LINE IS THE PLAN'S OWN, verb, literal arguments and payload, and it is not
   * rebuilt from constants here. That is what makes the preview binding: the dialog renders
   * `plan.unit` and this sends `plan.unit`, so byte-identity is structural rather than promised.
   *
   * THREE ROUND TRIPS AT MOST, IN THIS ORDER, and the order is the safety argument:
   *
   * 1. the RE-READ, which is what `compared` means, and it is the FIRST thing sent so nothing
   *    this design does sits between the comparison and the write. A library that moved is a
   *    `conflict` and NOTHING is executed. It NARROWS the window and does not close it: another
   *    session can still load between this read and the next round trip, and no transaction on
   *    this engine spans the two.
   * 2. the LOAD. Its reply is the library name the server read out of the shebang, MEASURED, and
   *    that name is compared against the addressed one. That comparison is a CONTROL rather than
   *    the primary guard, because the build's shebang check already refused a text naming
   *    another library: what it catches is a shebang-extraction bug in this file, and the arm it
   *    reaches is `applied-elsewhere` with the server's own reply in `wrote`. `undone` is FALSE,
   *    because Redis offers this design nothing to take it back with and it will not issue a
   *    `FUNCTION DELETE` of its own.
   * 3. the RE-READ AFTER, which supplies the NEW revision token and answers the collateral
   *    question. `lost` is a catalog fact read AFTER the write and never a restatement of the
   *    warning: the plan said what WOULD be lost, this says what WAS.
   *
   * The third round trip is skipped on the `applied-elsewhere` arm, because the addressed library
   * was not written: MEASURED on 8.10.0, a consistent rename left the original answering and a
   * shebang naming another existing library replaced THAT one and left this one untouched.
   *
   * A VERDICT THE ENGINE REACHED IS RETURNED AND NEVER THROWN, which is what keeps a deliberate
   * refusal off the 500 path the shipped error mapper would otherwise put it on.
   */
  public async applyObjectEdit(plan: ObjectEditPlan): Promise<ObjectEditOutcome> {
    this.ensureConnected();
    if (plan.unit.medium !== "command") {
      // A statement unit is not a shape this provider ever issues. It raises rather than
      // refusing, because a refusal reports an engine fact and this is a plan from somewhere
      // else.
      throw new QueryError("A Redis object edit plan carries a command unit, received a statement", "redis");
    }
    const unit = plan.unit;
    const capabilities = this.getCapabilities();
    requireEditableKind(capabilities, plan.kind, REDIS_ENGINE);
    assertObjectPathShape(capabilities, findKind(capabilities, plan.kind), plan.kind, plan.path, PATH_SHAPE_ENGINE);
    if (plan.revision.check === "unavailable") {
      // H3's three states stay three. A revision that says "this provider could not produce a
      // token" says NOTHING about whether the object moved, so answering `conflict` /
      // `object-changed` for it would assert a fact no read of this method observed, which is the
      // collapse H3 forbids. This provider issues `compared` on every plan it builds and the
      // route seals plans, so a plan arriving here with any other revision was built somewhere
      // else: it raises, exactly as the statement-unit arm above does, and it raises BEFORE the
      // first round trip, so a foreign plan costs nothing and cannot half-apply.
      throw new QueryError(
        `A Redis object edit plan carries a compared revision, received "${plan.revision.check}"`,
        "redis",
      );
    }
    const name = plan.path[plan.path.length - 1];
    const started = Date.now();

    const before = parseFunctionLibrary(await this.callFunctionList(name), name);
    const current = before?.code ?? "";
    if (libraryDigest(current) !== plan.revision.token) {
      // H3's diff: the server's own text as this comparison read it, so the reader is shown what
      // is there rather than asked to trust a detector. A library that was DELETED answers the
      // empty string, which is what is there.
      return {
        outcome: "conflict",
        conflict: "object-changed",
        current: { text: current, language: unit.payload.language },
        duration: Date.now() - started,
      };
    }

    let reply: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reply = await (this.client as any).call(unit.name, ...unit.arguments, unit.payload.text);
    } catch (error) {
      return redisApplyFailure(unit.payload, error, Date.now() - started);
    }

    const wrote = String(reply);
    if (wrote !== name) {
      return { outcome: "applied-elsewhere", undone: false, wrote, duration: Date.now() - started };
    }

    const after = parseFunctionLibrary(await this.callFunctionList(name), name);
    const revision = {
      check: "compared" as const,
      token: libraryDigest(after?.code ?? ""),
      basis: libraryReadBasis(name),
      scope: "server" as const,
    };
    const registered = after?.functions ?? [];
    const disappeared = (before?.functions ?? []).filter((registeredBefore) => !registered.includes(registeredBefore));
    if (disappeared.length > 0) {
      return {
        outcome: "applied-with-collateral",
        lost: [{ loses: "replaces-whole-container", fact: libraryFact(name, disappeared) }],
        revision,
        duration: Date.now() - started,
      };
    }
    return { outcome: "applied", revision, duration: Date.now() - started };
  }

  /**
   * Columns for EVERY object of one kind in one database, from ONE walk (#789).
   *
   * ONE WALK for the whole folder, which is the entire reason this method exists. Nothing
   * here sends a statement, so the N+1 the inventory route removed does not come back as
   * round trips: `describeObject` runs a full `scanKeyGroups` walk of its own, and a body
   * looping it would walk the keyspace once per grouping. The suite counts the driver's
   * `SCAN` calls, which is the only observable difference between the two.
   *
   * A FUNCTION LIBRARY HAS NO COLUMNS, so its folder answers `{ details: [] }` and sends
   * NOTHING - not even the `FUNCTION LIST` the listing needs. That is the reference's fourth
   * guard and it is the same fact `describeObject` already answers for one library: a library
   * has no columns, no indexes and no foreign keys, and its SOURCE, the one thing it does
   * have, is Phase 2's through `FUNCTION LIST WITHCODE`. It is a true statement about the
   * KIND rather than a refused read, so it is an empty batch and not a throw.
   *
   * A kind this provider declares and cannot enumerate is a different fact again, and it
   * RAISES: "this kind has no columns" and "this file has no reader for this kind" must not
   * arrive as the same empty answer, because only the second is a defect. The refusal is
   * `listIn`'s own, so the two methods refuse by one rule.
   *
   * TWO BOUNDS, AND THE ANSWER NAMES WHICHEVER BIT. The caller's `limit` is applied to the
   * sorted groupings and reports the caller's own number. The walk's 1,000-key budget is a
   * bound this provider did not choose on this call, and it is reported too, on an unbounded
   * read as readily as on a bounded one, because a cap nobody can see is the defect
   * `truncated` exists to prevent. It cannot bite on the `function` folder, which sends
   * nothing, so the marking is per KIND here exactly as it is in `countObjects`.
   *
   * THE CUT IS OURS, BECAUSE THIS ENGINE OFFERS NOTHING TO CUT UNDER. `SCAN` publishes no
   * order at all and its bound is on KEYS rather than on groupings, so there is no `limit + 1`
   * to push down: a walk cannot know how many groupings it will produce until it has finished.
   * The membership of a bounded read is therefore `comparePaths`' and this provider says so
   * rather than implying an order the server does not have.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // The four guards, in the reference's order: the DECLARATION first, because an undeclared
    // kind is a fact about the engine and an empty answer is a claim about the data; then the
    // container, through the same reader `listObjects` uses.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`Redis declares no object kind "${kind}"`, "redis");
    }
    const db = containerDatabase(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a truncation
      // the caller never asked for, and a fraction cannot cut a list; both are caller
      // mistakes and neither has a right answer to guess at.
      throw new QueryError(
        `A Redis bulk column read limit must be a positive whole number, received ${limit}`,
        "redis",
      );
    }
    if (kind === "function") return { details: [] };
    if (kind !== "keyspace") {
      // The same sentence `listIn` refuses with, so a kind added to the declaration without
      // a reader fails by name on both methods rather than answering an empty folder here.
      throw new QueryError(`Redis declares the kind "${kind}" but has no command that lists it`, "redis");
    }

    return this.withDatabase(db, async (client) => {
      const { entries, truncated: scanTruncated } = await RedisProvider.keyspaceEntries(client, container, kind);
      const bounded = limit !== undefined && entries.length > limit;
      const details = (bounded ? entries.slice(0, limit) : entries).map((entry) =>
        RedisProvider.keyspaceDetail(entry.object.path, entry.types),
      );

      if (!bounded && !scanTruncated) return { details };
      const reasons = [
        ...(bounded ? [callerBoundTruncationReason(limit!)] : []),
        ...(scanTruncated ? [SCAN_BOUND_SENTENCE] : []),
      ];
      // The CALLER's limit whenever the caller set one that bit; otherwise the number this
      // read actually produced. On that arm the bound the provider applied is a 1,000-KEY
      // walk budget and not an object count, so there is no object count to report and no
      // number that would be one; `reason` is what carries the truth, and `types.ts` says
      // so beside the field rather than leaving a reader to infer a cap nobody set.
      return { details, truncated: { limit: bounded ? limit! : details.length, reason: reasons.join(", and ") } };
    });
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      const info = await this.client!.info();
      const parsed = this.parseRedisInfo(info);

      return {
        activeConnections: parseInt(parsed.connected_clients || "0"),
        databaseSize: parsed.used_memory_human || "0B",
        cacheHitRatio: this.calculateHitRatio(parsed),
        slowQueries: [],
        activeSessions: [],
      };
    } catch (error) {
      throw new QueryError(
        `Failed to get Redis health: ${error instanceof Error ? error.message : String(error)}`,
        "redis",
      );
    }
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();
    const info = await this.client!.info();
    const parsed = this.parseRedisInfo(info);
    const dbsize = await this.client!.dbsize();

    return {
      version: labelServerVersion(parsed),
      uptime: this.formatDuration(parseInt(parsed.uptime_in_seconds || "0") * 1000),
      activeConnections: parseInt(parsed.connected_clients || "0"),
      // Dragonfly publishes this limit as `max_clients` (underscored); every other relative
      // that publishes one (Redis, Valkey, KeyDB) uses `maxclients`.
      maxConnections: parseInt(parsed.maxclients || parsed.max_clients || "0"),
      databaseSize: parsed.used_memory_human || "0B",
      databaseSizeBytes: parseInt(parsed.used_memory || "0"),
      tableCount: dbsize,
      indexCount: 0,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    const info = await this.client!.info();
    const parsed = this.parseRedisInfo(info);

    return {
      cacheHitRatio: parseFloat(this.calculateHitRatio(parsed)),
      queriesPerSecond: parseFloat(parsed.instantaneous_ops_per_sec || "0"),
    };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slowlog = (await (this.client as any).call("SLOWLOG", "GET", "10")) as unknown[][];
      if (!Array.isArray(slowlog)) return [];

      return slowlog.map((entry) => ({
        queryId: String(entry[0]),
        query: Array.isArray(entry[3]) ? (entry[3] as string[]).join(" ") : String(entry[3]),
        calls: 1,
        totalTime: Number(entry[2]) / 1000, // microseconds to ms
        avgTime: Number(entry[2]) / 1000,
        rows: 0,
      }));
    } catch {
      return [];
    }
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    try {
      const clientList = (await this.client!.client("LIST")) as string;
      const sessions: ActiveSessionDetails[] = [];

      for (const line of clientList.split("\n")) {
        if (!line.trim()) continue;
        const fields = Object.fromEntries(
          line.split(" ").map((pair) => {
            const eq = pair.indexOf("=");
            return eq > 0 ? [pair.substring(0, eq), pair.substring(eq + 1)] : [pair, ""];
          }),
        );

        sessions.push({
          pid: fields.id || "0",
          user: fields.user || "default",
          database: fields.db || "0",
          state: fields.flags || "N",
          query: fields.cmd || "idle",
          duration: `${Math.round(parseInt(fields.idle || "0"))}s`,
          durationMs: parseInt(fields.idle || "0") * 1000,
          clientAddr: fields.addr || "",
        });
      }

      return sessions;
    } catch {
      return [];
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    const info = await this.client!.info("memory");
    const parsed = this.parseRedisInfo(info);

    return [
      {
        name: "Memory",
        size: parsed.used_memory_human || "0B",
        sizeBytes: parseInt(parsed.used_memory || "0"),
        usagePercent:
          parsed.maxmemory && parsed.maxmemory !== "0"
            ? (parseInt(parsed.used_memory || "0") / parseInt(parsed.maxmemory)) * 100
            : undefined,
      },
    ];
  }

  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    this.ensureConnected();
    const startTime = performance.now();

    try {
      switch (type) {
        case "analyze": {
          const info = await this.client!.info();
          const executionTime = Math.round(performance.now() - startTime);
          const lines = info.split("\n").length;
          return { success: true, executionTime, message: `Server info retrieved (${lines} metrics)` };
        }
      }
      throw new QueryError(`Unsupported maintenance type for Redis: ${type}`, "redis");
    } catch (error) {
      if (error instanceof QueryError) throw error;
      const executionTime = Math.round(performance.now() - startTime);
      return { success: false, executionTime, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private parseRedisInfo(info: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of info.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        result[trimmed.substring(0, colonIdx)] = trimmed.substring(colonIdx + 1);
      }
    }
    return result;
  }

  private calculateHitRatio(info: Record<string, string>): string {
    const hits = parseInt(info.keyspace_hits || "0");
    const misses = parseInt(info.keyspace_misses || "0");
    const total = hits + misses;
    if (total === 0) return "100.0";
    return ((hits / total) * 100).toFixed(1);
  }
}
