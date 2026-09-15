/**
 * Redis Provider Integration Tests
 *
 * Uses mock.module() from bun:test to mock the 'ioredis' driver
 * before importing the RedisProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { isSourcePartUnavailable, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import type { DatabaseConnection } from "@/lib/types";
import { generateTableQuery, generateSelectQuery } from "@/lib/query-generators";
import { describeConsequence, renderSegments, userPositionOf, EDIT_CHARACTER_LIMIT } from "@/lib/db/object-edit";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import type { ObjectEditOutcome } from "@/lib/db/types";

// ============================================================================
// Mock Setup — MUST come before provider import
// ============================================================================

const MOCK_INFO_STRING = [
  "# Server",
  "redis_version:7.2.4",
  "uptime_in_seconds:86400",
  "maxclients:10000",
  "",
  "# Clients",
  "connected_clients:12",
  "",
  "# Memory",
  "used_memory:2048000",
  "used_memory_human:1.95MB",
  "maxmemory:0",
  "",
  "# Stats",
  "instantaneous_ops_per_sec:42",
  "keyspace_hits:900",
  "keyspace_misses:100",
  "",
].join("\n");

// `name=` is the connection name (empty until a client calls CLIENT SETNAME) and is
// deliberately left blank here, distinct from `user=` (the authenticated ACL user) - the
// two used to be conflated in getActiveSessions(), which read `name` for the user column.
const MOCK_CLIENT_LIST =
  "id=1 addr=127.0.0.1:6379 name= db=0 flags=N cmd=get idle=5 user=studio\nid=2 addr=127.0.0.1:6380 name= db=0 flags=N cmd=set idle=10 user=default";

// SLOWLOG GET entries: [id, timestamp, duration-in-microseconds, args, clientAddr, clientName]
// The second entry carries a non-array args payload to exercise the String() fallback.
const MOCK_SLOWLOG_ENTRIES = [
  [1, 1700000000, 1500, ["GET", "user:1"], "127.0.0.1:6379", "app1"],
  [2, 1700000001, 2500, "HGETALL user:2", "127.0.0.1:6380", "app2"],
];

const mockCallResults: Record<string, unknown> = {
  GET: "hello-world",
  SET: "OK",
  KEYS: ["user:1", "user:2", "session:abc"],
  HGETALL: ["field1", "value1", "field2", "value2"],
  INFO: MOCK_INFO_STRING,
  DEL: 1,
  PING: "PONG",
  DBSIZE: 42,
  SLOWLOG: MOCK_SLOWLOG_ENTRIES,
  // Every verb the schema-explorer generators can emit, so the round-trip tests
  // below can feed generated command lines straight into query() (#427). One
  // entry per verb is enough; `capturedCalls` records the args separately.
  SCAN: ["0", ["user:1", "user:2"]],
  TYPE: "string",
  TTL: -1,
  HSET: 1,
  LRANGE: [],
  RPUSH: 1,
  SMEMBERS: [],
  SADD: 1,
  ZRANGE: [],
  ZADD: 1,
};

/**
 * Every (command, args) tuple the provider actually handed the driver. The
 * round-trip tests assert against THIS, not against the reply: a generated
 * command that reaches the driver with mangled args still "succeeds" otherwise,
 * which is exactly how the quote defect survived the first review (#427).
 */
const capturedCalls: Array<{ command: string; args: string[] }> = [];

/**
 * What `SCAN` answers in each numbered database, keyed by the `db` the connection was
 * OPENED on (issue #789).
 *
 * Two databases and not one, because a provider that read the SESSION's database instead
 * of the CONTAINER's is indistinguishable from a correct one when every database holds the
 * same keys. `report:daily` exists in db 3 and nowhere else, exactly as
 * `docker/redis-init/01-object-fixture.redis` builds it on a real server.
 */
const MOCK_KEYS_BY_DB: Record<number, string[]> = {
  0: ["user:1", "user:2", "session:abc"],
  3: ["report:daily"],
};

/**
 * The value type of each mock key, taken from the committed fixture: `HSET session:abc`
 * makes that one a hash while the `SET` keys are strings. Anything absent is a string.
 */
const MOCK_KEY_TYPES: Record<string, string> = { "session:abc": "hash" };

/**
 * What `CONFIG GET databases` answers. 16 is a stock server; a test sets it to 1 to stand
 * for the cluster-mode deployment, where the reply really is 1 (measured on redis 8.10.0
 * started with `--cluster-enabled yes`, where `SELECT 3` also answers "ERR SELECT is not
 * allowed in cluster mode").
 */
let databasesReply: string[] = ["databases", "16"];

/**
 * One library, in the exact RESP2 shape ioredis hands back: a flat key/value list per
 * library, measured against redis 8.10.0 holding `docker/redis-init/01-object-fixture.redis`.
 * The nested `functions` entry is the library's registered functions and is deliberately
 * present, because a parser that walked the top-level list two entries at a time without
 * reading the KEYS would take `functions` as a library name.
 */
const MOCK_FUNCTION_LIST: unknown[] = [
  [
    "library_name",
    "libredb_probe",
    "engine",
    "LUA",
    "functions",
    [
      ["name", "libredb_ping", "description", null, "flags", []],
      ["name", "libredb_echo_key", "description", null, "flags", []],
    ],
  ],
  // The case-variant sibling `docker/redis-init/01-object-fixture.redis` now loads. The
  // library dictionary is CASE-SENSITIVE: measured on redis 8.10.0, `libredb_probe` and
  // `LIBREDB_PROBE` coexist and `FUNCTION LIST` answers both, in this order.
  [
    "library_name",
    "LIBREDB_PROBE",
    "engine",
    "LUA",
    "functions",
    [["name", "LIBREDB_UPPER_PING", "description", null, "flags", []]],
  ],
];

/**
 * What `FUNCTION LIST` answers, reset to `MOCK_FUNCTION_LIST` before each object-surface
 * test. A test REORDERS the fields to prove the parser reads `library_name` by its key: the
 * shipped mock carries the order redis 8.10.0 answered in, and a parser taking `entry[1]`
 * is indistinguishable from a correct one for as long as that order is the only one tested.
 */
let functionListReply: unknown[] = MOCK_FUNCTION_LIST;

/**
 * The library's Lua source, byte for byte what `docker/redis-init/01-object-fixture.redis`
 * loads. MEASURED on redis 8.10.0: `FUNCTION LIST ... WITHCODE` answers the shebang line and
 * the body exactly as they were given to `FUNCTION LOAD`, with no reformatting.
 */
const FIXTURE_LIBRARY_CODE = [
  "#!lua name=libredb_probe",
  "local function echo_key(keys, args)",
  "  return redis.call('GET', keys[1])",
  "end",
  "local function ping(keys, args)",
  "  return 'pong'",
  "end",
  "redis.register_function('libredb_echo_key', echo_key)",
  "redis.register_function('libredb_ping', ping)",
].join("\n");

/** The SECOND library, differing from the first ONLY in case. See the reply below. */
const FIXTURE_UPPER_LIBRARY_CODE = [
  "#!lua name=LIBREDB_PROBE",
  "local function upper_ping(keys, args)",
  "  return 'PONG'",
  "end",
  "redis.register_function('LIBREDB_UPPER_PING', upper_ping)",
].join("\n");

/**
 * What `FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE` answers, and the reason the reply
 * carries TWO libraries.
 *
 * MEASURED on redis 8.10.0 against the committed fixture: the library dictionary is
 * CASE-SENSITIVE, so `libredb_probe` and `LIBREDB_PROBE` coexist, while `LIBRARYNAME` is a
 * CASE-INSENSITIVE glob, so ONE lookup for either name answers BOTH. A reader taking
 * `reply[0]` would hand back the other library's Lua as this object's definition.
 *
 * The wrong library is FIRST here and the live server happened to answer the exact match
 * first. That is deliberate: reply order is not part of the protocol contract, RESP3 answers
 * a map with no order at all, and a mock that reproduced the lucky order would certify a
 * parser that indexes.
 */
const MOCK_FUNCTION_WITHCODE: unknown[] = [
  [
    "library_name",
    "LIBREDB_PROBE",
    "engine",
    "LUA",
    "functions",
    [["name", "LIBREDB_UPPER_PING", "description", null, "flags", []]],
    "library_code",
    FIXTURE_UPPER_LIBRARY_CODE,
  ],
  [
    "library_name",
    "libredb_probe",
    "engine",
    "LUA",
    "functions",
    [
      ["name", "libredb_ping", "description", null, "flags", []],
      ["name", "libredb_echo_key", "description", null, "flags", []],
    ],
    "library_code",
    FIXTURE_LIBRARY_CODE,
  ],
];

/**
 * What a `WITHCODE` read answers, reset before each object-surface test. A test empties it to
 * stand for a library the server does not hold: measured on redis 8.10.0,
 * `FUNCTION LIST LIBRARYNAME no_such_library` answers an EMPTY ARRAY rather than an error.
 */
let functionWithCodeReply: unknown[] = MOCK_FUNCTION_WITHCODE;

/**
 * When set, EVERY `FUNCTION` call answers through this function instead of the three reply
 * variables above, and the arguments it receives are the ones the provider sent (#789 Phase 3).
 *
 * The edit path needs a reply that CHANGES between round trips, which a variable cannot express:
 * one apply sends `FUNCTION LIST ... WITHCODE`, then `FUNCTION LOAD REPLACE`, then the same
 * `FUNCTION LIST` again, and the whole collateral question is the difference between the first
 * list and the third round trip's.
 *
 * IT DISPATCHES ON THE ARGUMENTS THE PROVIDER BUILT, which standing ruling 5b names as a blind
 * spot: a fake that routes on the request cannot see a change to the request. The apply tests
 * therefore also assert the exact command line every round trip carried, through
 * `capturedCalls`, so the bytes are pinned by something other than the dispatcher that reads
 * them.
 */
let mockCall: ((command: string, ...args: string[]) => Promise<unknown>) | null = null;

/**
 * One `FUNCTION LIST ... WITHCODE` entry, in the flat RESP2 key/value shape ioredis hands back,
 * measured on redis 8.10.0 (#789 Phase 3).
 *
 * The Lua code is ALSO reachable as `.library_code` on the returned array, which is a property
 * the driver never sets and the provider never reads: every parser in `redis.ts` walks the entry
 * by INDEX two at a time, so a named property is invisible to it. It exists so a test can assert
 * against the same bytes it built the reply from without a second constant that could drift.
 *
 * `functions` is given in the order a server answered it rather than sorted, because the
 * provider is the thing that has to sort: `FUNCTION LIST` answers in an internal order, so a
 * warning built from it would otherwise change its wording between two identical reads.
 */
function libraryEntry(name: string, code: string, functions: readonly string[]) {
  const entry: unknown[] = [
    "library_name",
    name,
    "engine",
    "LUA",
    "functions",
    functions.map((registered) => ["name", registered, "description", null, "flags", []]),
    "library_code",
    code,
  ];
  return Object.assign(entry, { library_code: code, library_name: name });
}

/**
 * When set, `FUNCTION LIST` rejects with this sentence. Three of the four Redis-wire
 * relatives do exactly that and each says it differently (all measured 2026-09-11):
 * KeyDB 6.3.4 "ERR unknown command `FUNCTION`, with args beginning with: `LIST`, ",
 * DragonflyDB df-v1.40.1 "ERR Unknown subcommand or wrong number of arguments for 'LIST'.
 * Try FUNCTION HELP." and Garnet 2.1.5 "ERR unknown command".
 */
let functionRefusal: string | null = null;

/**
 * When set, the `FUNCTION` command rejects the way a TRANSPORT failure does rather than the
 * way a server refusal does.
 *
 * MEASURED against ioredis 5.11.1 and redis 8.10.0 from a container created for this
 * measurement: a server ERROR REPLY arrives as a `redis-errors` `ReplyError`
 * (`name === "ReplyError"`), while a dropped socket arrives as a PLAIN `Error` named `Error`,
 * message "Connection is closed." with the offline queue on and "Stream isn't writeable and
 * enableOfflineQueue options is false" with it off. The two are different facts and the
 * provider must not present the second as the server refusing this object (#789).
 */
let functionTransportFailure: unknown = null;

/**
 * A server error reply, shaped as ioredis 5.11.1 delivers one.
 *
 * `redis-errors` sets `name` to "ReplyError" on the prototype and ioredis re-exports the
 * class, so the name is what the provider reads: an `instanceof` against the driver's export
 * would be `instanceof undefined` here, where `mock.module` replaces the whole module.
 */
function replyError(message: string): Error {
  const error = new Error(message);
  error.name = "ReplyError";
  return error;
}

/**
 * When set, `DISCARD` rejects with this error instead of answering. Only the server's own
 * "ERR DISCARD without MULTI" is an answer; every other failure has to reach the caller
 * (D75).
 */
let discardFailure: Error | null = null;

/**
 * When set, `PING` rejects with this error instead of answering.
 *
 * A real ACL can refuse the reading itself: `ACL SETUSER x on >pw ~* +@read` grants neither
 * `PING` nor `DISCARD`, so a provider that cannot ask has to say so rather than guess (D75).
 */
let pingFailure: Error | null = null;

/** When set, `SCAN` rejects with this sentence, whatever database it was opened on. */
let scanRefusal: string | null = null;

/**
 * How many `SCAN` calls the driver has taken since a test reset it.
 *
 * The bulk column read's whole claim is that a folder costs ONE keyspace walk rather than
 * one per object, and on this engine that is not a statement count: nothing here sends a
 * statement. Counting the driver calls is the only observable difference between one walk
 * and a loop over `describeObject`, and it does not depend on the wall clock (#789).
 */
let scanCalls = 0;

/**
 * When true, `SCAN` answers a NON-ZERO cursor and a page big enough to spend the provider's
 * 1000-key budget in one call, which is a keyspace larger than the walk can reach. A stock
 * mock answers cursor "0", so the two arms of the fourth `KindCount` state are both real
 * runs here rather than one run and an argument.
 */
let scanOverflows = false;

/** The oversized page: 1000 keys under one grouping, which is the budget exactly. */
const OVERFLOW_KEYS: string[] = Array.from({ length: 1000 }, (_, index) => `bulk:${index}`);

/**
 * Every options object the provider handed the `Redis` constructor. The TLS
 * selection is observable nowhere else: ioredis takes it at construction time and
 * never exposes it again.
 */
const capturedRedisOptions: Record<string, unknown>[] = [];

/**
 * When set, `info()` rejects with this message instead of answering. A Redis 6 ACL
 * user without `+info` is refused exactly this way, and it is the one shape where
 * the server is reachable but every INFO-derived surface is not (D29).
 */
let infoRefusal: string | null = null;

/**
 * When set, `info()` answers with this string instead of `MOCK_INFO_STRING` - lets a test
 * simulate a relative that publishes an extra field (e.g. `dragonfly_version`) without a
 * second mock module.
 */
let infoOverride: string | null = null;

mock.module("ioredis", () => {
  class MockRedis {
    private _config: unknown;
    private _db: number;
    /**
     * Whether this connection has an open `MULTI`, tracked per INSTANCE because that is
     * where a real server tracks it: measured on redis 7.4.11 through ioredis 5.11.1, a
     * `MULTI` sent on one connection leaves every later command on THAT connection
     * answering "QUEUED" while a second connection is untouched (D75).
     */
    private _inMulti = false;

    constructor(config?: unknown) {
      this._config = config;
      const options = (config ?? {}) as Record<string, unknown>;
      capturedRedisOptions.push(options);
      this._db = typeof options.db === "number" ? options.db : 0;
    }

    async connect() {
      // noop — connection established
    }

    disconnect() {
      // noop — connection closed
    }

    async info() {
      if (infoRefusal !== null) throw new Error(infoRefusal);
      return infoOverride ?? MOCK_INFO_STRING;
    }

    async dbsize() {
      return 42;
    }

    async scan(): Promise<[string, string[]]> {
      scanCalls += 1;
      if (scanRefusal !== null) throw new Error(scanRefusal);
      if (scanOverflows) return ["42", [...(MOCK_KEYS_BY_DB[this._db] ?? []), ...OVERFLOW_KEYS]];
      return ["0", MOCK_KEYS_BY_DB[this._db] ?? []];
    }

    /**
     * The value TYPE of one key, from a per-key table rather than one constant.
     *
     * A constant "string" made every grouping's column list identical, so a bulk read that
     * described every object with the FIRST grouping's types was indistinguishable from a
     * correct one. `session:abc` is a HASH in the committed fixture
     * (`docker/redis-init/01-object-fixture.redis` writes it with `HSET`) and
     * `queue:jobs` a list, so the table below is the fixture's own shape (#789).
     */
    async type(key: string) {
      return MOCK_KEY_TYPES[key] ?? "string";
    }

    async client(subcommand: string) {
      if (subcommand === "LIST") return MOCK_CLIENT_LIST;
      return "OK";
    }

    async call(command: string, ...args: string[]) {
      const cmd = command.toUpperCase();
      capturedCalls.push({ command: cmd, args });
      // Simulate a Redis-side error (e.g. unknown command / wrong arity)
      if (cmd === "BOGUS") {
        throw new Error("ERR unknown command 'BOGUS'");
      }
      if (cmd === "MULTI") {
        this._inMulti = true;
        return "OK";
      }
      if (cmd === "DISCARD") {
        if (discardFailure !== null) throw discardFailure;
        // The server's own words, measured on redis 7.4.11: a DISCARD with nothing queued
        // is refused, and the refusal costs the connection nothing.
        if (!this._inMulti) throw replyError("ERR DISCARD without MULTI");
        this._inMulti = false;
        return "OK";
      }
      if (cmd === "PING" && pingFailure !== null) throw pingFailure;
      // Inside a `MULTI` the server answers the status "QUEUED" INSTEAD of the command's
      // own reply and runs nothing, every command alike except the ones above. Measured on
      // redis 7.4.11 through ioredis 5.11.1: `SET`, `GET`, `PING` and `CLIENT INFO` all
      // answer "QUEUED" there while a second connection is untouched (D75). That
      // substitution is the only reading of the state this connection can be given, so the
      // mock has to make it or a provider that never asks would pass.
      if (this._inMulti) return "QUEUED";
      if (cmd === "CONFIG") return databasesReply;
      if (cmd === "FUNCTION") {
        if (mockCall !== null) return await mockCall(command, ...args);
        if (functionTransportFailure !== null) throw functionTransportFailure;
        if (functionRefusal !== null) throw replyError(functionRefusal);
        // WITHCODE is the source read and LIST without it is the listing. The two answer
        // different shapes on a real server and the mock has to as well, or a provider
        // reading `library_code` off the listing reply would pass.
        if (args.some((arg) => arg.toUpperCase() === "WITHCODE")) return functionWithCodeReply;
        return functionListReply;
      }
      if (cmd in mockCallResults) {
        return mockCallResults[cmd];
      }
      return null;
    }
  }

  return { default: MockRedis };
});

// ============================================================================
// Provider import — AFTER mock registration
// ============================================================================

const { RedisProvider } = await import("@/lib/db/providers/keyvalue/redis");
const { DatabaseConfigError } = await import("@/lib/db/errors");

// ============================================================================
// Test Config
// ============================================================================

const baseConfig: DatabaseConnection = {
  id: "test-redis",
  name: "Test Redis",
  type: "redis",
  host: "localhost",
  port: 6379,
  createdAt: new Date(),
};

// ============================================================================
// Tests
// ============================================================================

describe("RedisProvider", () => {
  let provider: InstanceType<typeof RedisProvider>;

  beforeEach(() => {
    provider = new RedisProvider({ ...baseConfig });
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      // ignore
    }
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe("validation", () => {
    test("throws DatabaseConfigError when host is missing", () => {
      expect(
        () =>
          new RedisProvider({
            ...baseConfig,
            host: undefined,
          }),
      ).toThrow(DatabaseConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    test("connect succeeds and marks provider as connected", async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect succeeds and marks provider as disconnected", async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // ACL user (D29)
  // --------------------------------------------------------------------------

  describe("the ACL user handed to ioredis", () => {
    /** The options object of the connection this test just opened. */
    const lastOptions = (): Record<string, unknown> => capturedRedisOptions[capturedRedisOptions.length - 1];

    const connectAs = async (user: string | undefined) => {
      provider = new RedisProvider({ ...baseConfig, user, password: "probepw" });
      await provider.connect();
      return lastOptions();
    };

    // Measured 2026-08-26 against `redis:latest` with `probe` defined as
    // `on >probepw ~* +@all -info`: without `username` in the options, `ACL WHOAMI`
    // answers `default` and INFO succeeds - the app authenticated as a principal the
    // user never chose. With it, WHOAMI answers `probe`.
    test("the connection's user travels as ioredis's username", async () => {
      expect(await connectAs("probe")).toMatchObject({ username: "probe", password: "probepw" });
    });

    // A `requirepass`-only server has no ACL users to name, and ioredis authenticates
    // as `default` only when `username` is absent. So an empty field must stay empty.
    test("no username is sent when the connection names no user", async () => {
      expect((await connectAs(undefined)).username).toBeUndefined();
    });

    test("an empty user string is sent as no username at all", async () => {
      expect((await connectAs("")).username).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // TLS
  // --------------------------------------------------------------------------

  describe("the TLS options handed to ioredis", () => {
    /** The options object of the connection this test just opened. */
    const lastOptions = (): Record<string, unknown> => capturedRedisOptions[capturedRedisOptions.length - 1];

    const connectWithSSL = async (ssl: DatabaseConnection["ssl"]) => {
      provider = new RedisProvider({ ...baseConfig, ssl });
      await provider.connect();
      return lastOptions();
    };

    test("carries no tls option when the connection names no SSL config", async () => {
      await provider.connect();
      expect("tls" in lastOptions()).toBe(false);
    });

    test("carries no tls option in mode disable", async () => {
      const options = await connectWithSSL({ mode: "disable" });
      expect("tls" in options).toBe(false);
    });

    test("mode require encrypts without checking the chain", async () => {
      const options = await connectWithSSL({ mode: "require" });
      expect(options.tls).toEqual({ rejectUnauthorized: false });
    });

    // D26: verification without a pasted CA, for a managed endpoint whose certificate a
    // public root already signs.
    test("mode verify-system verifies against the runtime trust store, with no ca option", async () => {
      const options = await connectWithSSL({ mode: "verify-system" });
      expect(options.tls).toEqual({ rejectUnauthorized: true });
    });

    test("mode verify-ca and verify-full check the chain", async () => {
      expect(await connectWithSSL({ mode: "verify-ca" })).toMatchObject({ tls: { rejectUnauthorized: true } });
      expect(await connectWithSSL({ mode: "verify-full" })).toMatchObject({ tls: { rejectUnauthorized: true } });
    });

    test("an explicit rejectUnauthorized wins over the mode", async () => {
      const options = await connectWithSSL({ mode: "verify-full", rejectUnauthorized: false });
      expect(options.tls).toEqual({ rejectUnauthorized: false });
    });

    test("the CA and client certificate bundle reaches the driver under Node's own names", async () => {
      const options = await connectWithSSL({
        mode: "verify-full",
        caCert: "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----",
        clientCert: "-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----",
        // Deliberately not a PEM header: `-----BEGIN PRIVATE KEY-----` alone, with no material
        // after it, is enough for gitleaks' `private-key` rule, so the realistic string fails the
        // Secret Scan gate for a secret that does not exist (the same reason
        // tests/unit/db/cassandra/wire.test.ts uses this literal). These assertions are about which
        // option name carries the value, not what the value looks like.
        clientKey: "client-key-pem",
      });
      expect(options.tls).toEqual({
        rejectUnauthorized: true,
        ca: "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----",
        cert: "-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----",
        key: "client-key-pem",
      });
    });
  });

  // --------------------------------------------------------------------------
  // getCapabilities()
  // --------------------------------------------------------------------------

  describe("getCapabilities()", () => {
    // #U9: `runMaintenance(type)` takes no target parameter at all - the operation is
    // INFO, which reports on the server and cannot be pointed at a key pattern. A
    // per-row control here answered with server-wide metrics for one grouping.
    test("declares the target grammar of its one maintenance operation", () => {
      const caps = provider.getCapabilities();

      expect(caps.maintenanceOperationSpecs).toEqual({
        analyze: { label: "Server Info", perEntity: false, global: true },
      });
      expect(Object.keys(caps.maintenanceOperationSpecs ?? {}).sort()).toEqual([...caps.maintenanceOperations].sort());
    });
    test("returns correct capability metadata", () => {
      const caps = provider.getCapabilities();
      expect(caps.queryLanguage).toBe("json");
      expect(caps.defaultPort).toBe(6379);
      expect(caps.supportsConnectionString).toBe(false);
      expect(caps.supportsCreateTable).toBe(false);
      // Redis commands are not SQL, so the inline row editor's `UPDATE ... SET`
      // has nothing to run against (#269).
      expect(caps.supportsInlineRowEdit).toBe(false);
      // MULTI/EXEC exists in Redis and is not exposed through this provider (#464).
      expect(caps.supportsTransactions).toBe(false);
      // Redis has no constraints at all, and its "tables" are key prefixes this
      // provider grouped rather than objects anyone declared (#414).
      expect(caps.declaresForeignKeys).toBe(false);
      // And the other half of that fact, declared rather than left to be inferred:
      // `getSchema()` SCANs a bounded slice of the keyspace and groups the real key
      // names it found by their prefix, so a `user:*` row is this server's own summary
      // and no command can be given it as a key (#414).
      expect(caps.tablesAreDerivedGroupings).toBe(true);
      expect(caps.supportsMaintenance).toBe(true);
      expect(caps.explainFormat).toBeUndefined();
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
    });

    test("declares the redis query dialect (#427)", () => {
      // Without this the client-side generators fall through to the MongoDB
      // branch on `queryLanguage === "json"` and every schema-explorer action
      // emits JSON this provider rejects.
      expect(provider.getCapabilities().queryDialect).toBe("redis");
    });
  });

  // --------------------------------------------------------------------------
  // getLabels()
  // --------------------------------------------------------------------------

  describe("getLabels()", () => {
    test("returns correct provider labels", () => {
      const labels = provider.getLabels();
      expect(labels.entityName).toBe("Key Pattern");
      expect(labels.rowName).toBe("key");
      expect(labels.selectAction).toBe("Scan Keys");
    });

    // Until #U12 the monitoring Queries panel told a Redis server to enable a
    // PostgreSQL extension. `getSlowQueries()` maps SLOWLOG GET, so the empty panel
    // means the log is empty - and that is what the sentence must say.
    test("names SLOWLOG, not a Postgres extension, as where query stats come from", () => {
      const { slowQueriesEmptyState } = provider.getLabels();

      expect(slowQueriesEmptyState).toContain("SLOWLOG");
      expect(slowQueriesEmptyState).toContain("slowlog-log-slower-than");
      expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
    });

    // `statementLanguage` is stated verbatim in the agent's plan contract, and this
    // engine needs one for a reason the MongoDB case does not cover: told to write
    // "one runnable statement in this Redis database's own query language", a live
    // plan run on 2026-08-22 answered with the right LANGUAGE in the wrong SHAPE —
    //
    //   1) KEYS session:*
    //   2) GET session:1
    //
    // `executeRedisCommand` reads the whole body as ONE command, so the server
    // answered `ERR unknown command '1)'`. The two failures the sentence has to rule
    // out are therefore the list numbering and the second command, not the verbs.
    test("declares the one-command statement shape as the statement language", () => {
      const { statementLanguage } = provider.getLabels();

      expect(statementLanguage).toBeString();
      // Both accepted forms are named, because the lossless JSON form is what the
      // generators fall back to for an argument the plain tokenizer cannot carry.
      expect(statementLanguage).toContain("one");
      expect(statementLanguage).toContain('"command"');
      // And the shapes that are not runnable here, named so they are excluded.
      expect(statementLanguage).toContain("numbering");
      expect(statementLanguage).toContain("redis-cli");
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery()
  // --------------------------------------------------------------------------

  describe("prepareQuery()", () => {
    test("returns query unchanged with wasLimited=false", () => {
      const input = '{"command":"GET","args":["mykey"]}';
      const prepared = provider.prepareQuery(input);
      expect(prepared.query).toBe(input);
      expect(prepared.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // query()
  // --------------------------------------------------------------------------

  describe("query()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("JSON format command works", async () => {
      const result = await provider.query(JSON.stringify({ command: "GET", args: ["mykey"] }));
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0].result).toBe("hello-world");
    });

    test("plain text command works", async () => {
      const result = await provider.query("GET mykey");
      expect(result.rows).toBeArray();
      expect(result.rows[0].result).toBe("hello-world");
    });

    test("empty command throws QueryError", async () => {
      await expect(provider.query("   ")).rejects.toThrow();
    });

    test("HGETALL returns field/value pairs", async () => {
      const result = await provider.query(JSON.stringify({ command: "HGETALL", args: ["user:1"] }));
      expect(result.rows).toBeArray();
      expect(result.fields).toContain("field");
      expect(result.fields).toContain("value");
      expect(result.rows[0].field).toBe("field1");
      expect(result.rows[0].value).toBe("value1");
    });

    test("INFO returns section/key/value rows", async () => {
      const result = await provider.query(JSON.stringify({ command: "INFO", args: [] }));
      expect(result.rows).toBeArray();
      expect(result.fields).toContain("section");
      expect(result.fields).toContain("key");
      expect(result.fields).toContain("value");
      // Should contain redis_version
      const versionRow = result.rows.find((r: Record<string, unknown>) => r.key === "redis_version");
      expect(versionRow).toBeDefined();
      expect(versionRow!.value).toBe("7.2.4");
    });

    test("null result returns (nil)", async () => {
      await provider.query(JSON.stringify({ command: "GET", args: ["nonexistent"] }));
      // The mock returns 'hello-world' for GET, so let's use PING which returns null
      // Actually, let's test with a command that returns null from our mock
      const result2 = await provider.query(JSON.stringify({ command: "RANDOMKEY", args: [] }));
      // RANDOMKEY is not in mockCallResults, so call() returns null
      expect(result2.rows[0].result).toBe("(nil)");
    });

    // --- Error handling (acceptance: "clear errors for invalid commands") ---

    test("malformed JSON command throws QueryError", async () => {
      // Starts with '{' so the JSON branch is taken, but the body is invalid JSON
      await expect(provider.query("{ command: GET }")).rejects.toThrow(/Invalid JSON command format/);
    });

    test('JSON command without "command" field throws QueryError', async () => {
      await expect(provider.query(JSON.stringify({ args: ["mykey"] }))).rejects.toThrow(/Command is required/);
    });

    test("Redis-side command error is surfaced as QueryError", async () => {
      await expect(provider.query("BOGUS arg1")).rejects.toThrow(/Redis error: ERR unknown command/);
    });

    // --- Commented cheatsheets from the schema explorer (#427) ---

    test("a leading # comment line is skipped; the command runs", async () => {
      const result = await provider.query("# Read the value\nGET mykey");
      expect(result.rows[0].result).toBe("hello-world");
    });

    test("blank lines are skipped", async () => {
      const result = await provider.query("\n\n   \nGET mykey");
      expect(result.rows[0].result).toBe("hello-world");
    });

    test('a "#" inside an argument is not a comment', async () => {
      const result = await provider.query("SET k #tag");
      expect(result.rows[0].result).toBe("OK");
    });

    test("input that is only comments and blank lines is rejected", async () => {
      await expect(provider.query("# just a note\n\n# and another")).rejects.toThrow(/only comments|no command/i);
    });

    test("a line that tokenizes to nothing throws Empty command", async () => {
      await expect(provider.query('""')).rejects.toThrow(/Empty command/);
    });

    test("a pretty-printed multi-line JSON command still parses", async () => {
      const result = await provider.query(JSON.stringify({ command: "GET", args: ["mykey"] }, null, 2));
      expect(result.rows[0].result).toBe("hello-world");
    });

    test("a JSON command preceded by comment lines still parses", async () => {
      const result = await provider.query('# a note\n\n{"command":"GET","args":["mykey"]}');
      expect(result.rows[0].result).toBe("hello-world");
    });

    test("a trailing # comment after a JSON body is dropped, not an error", async () => {
      const result = await provider.query('{"command":"GET","args":["mykey"]}\n# trailing note');
      expect(result.rows[0].result).toBe("hello-world");
    });

    test("trailing non-comment text after a JSON body is still an Invalid JSON command format", async () => {
      await expect(provider.query('{"command":"GET","args":["mykey"]}\ntrailing note')).rejects.toThrow(
        /Invalid JSON command format/,
      );
    });

    test("every command line the cheatsheet generates is accepted (#427)", async () => {
      for (const sample of ["string", "hash", "list", "set", "zset"]) {
        const columns = [
          { name: "key", type: "string", nullable: false, isPrimary: true },
          { name: "value", type: sample, nullable: true, isPrimary: false },
          { name: "type", type: sample, nullable: false, isPrimary: false },
        ];
        const out = generateSelectQuery(["user:*"], columns, provider.getCapabilities());
        const lines = out
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("#"));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          await expect(provider.query(line)).resolves.toBeDefined();
        }
      }
    });

    // --- Round-trip: generator output THROUGH this provider's own parser (#427) ---

    /**
     * Run every runnable line of a generated buffer and return what the driver
     * was actually called with. Comments and blank lines are dropped exactly as
     * "Run Selected" would leave them out.
     *
     * NOTE: this helper strips comments and blank lines ITSELF and runs each line
     * on its own, so it exercises the per-line paths and NOT `commandBody`'s block
     * logic — which is how a comment-stripping defect survived two reviews (#427).
     * The whole-buffer suite below is the one that covers `commandBody`.
     */
    async function runGeneratedLines(buffer: string): Promise<Array<{ command: string; args: string[] }>> {
      capturedCalls.length = 0;
      const lines = buffer
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
      for (const line of lines) await provider.query(line);
      return [...capturedCalls];
    }

    const KEY_COLUMNS = (sample: string) => [
      { name: "key", type: "string", nullable: false, isPrimary: true },
      { name: "value", type: sample, nullable: true, isPrimary: false },
      { name: "type", type: sample, nullable: false, isPrimary: false },
    ];

    test("a key containing a double quote reaches the driver unmangled (#427)", async () => {
      // Plain-form `DEL "say"hi""` tokenizes to `sayhi` — a DIFFERENT key. The
      // generator must fall back to the lossless JSON form for such a line.
      const calls = await runGeneratedLines(
        generateSelectQuery(['say"hi"'], KEY_COLUMNS("string"), provider.getCapabilities()),
      );
      for (const call of calls) {
        expect(call.args[0]).toBe('say"hi"');
      }
      expect(calls.map((c) => c.command)).toContain("DEL");
    });

    test("a key containing a single quote reaches the driver unmangled (#427)", async () => {
      const calls = await runGeneratedLines(
        generateSelectQuery(["it's"], KEY_COLUMNS("hash"), provider.getCapabilities()),
      );
      for (const call of calls) {
        expect(call.args[0]).toBe("it's");
      }
    });

    test("a quoted prefix group SCANs the pattern it meant to (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery(['a"b:*'], provider.getCapabilities(), KEY_COLUMNS("string")),
      );
      expect(calls).toEqual([{ command: "SCAN", args: ["0", "MATCH", 'a"b:*', "COUNT", "50"] }]);
    });

    test("a key containing whitespace still round-trips in plain form (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery(["my key"], provider.getCapabilities(), KEY_COLUMNS("string")),
      );
      expect(calls).toEqual([{ command: "GET", args: ["my key"] }]);
    });

    test("an ordinary key still round-trips in plain form (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery(["user:1"], provider.getCapabilities(), KEY_COLUMNS("zset")),
      );
      expect(calls).toEqual([{ command: "ZRANGE", args: ["user:1", "0", "-1", "WITHSCORES"] }]);
    });

    test("a glob-escaped prefix reaches the driver with its backslash intact (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery(["a[b:*"], provider.getCapabilities(), KEY_COLUMNS("string")),
      );
      expect(calls).toEqual([{ command: "SCAN", args: ["0", "MATCH", "a\\[b:*", "COUNT", "50"] }]);
    });

    // --- Multi-line bodies (#427 F2 regression) ---

    test("a plain command wrapped across lines still runs whole", async () => {
      // On main the tokenizer treated a newline as ordinary whitespace, so this
      // wrote BOTH fields. First-line-only picking silently dropped the second.
      capturedCalls.length = 0;
      await provider.query("HSET user:1 name alice\nemail a@b.c");
      expect(capturedCalls).toEqual([{ command: "HSET", args: ["user:1", "name", "alice", "email", "a@b.c"] }]);
    });

    test("a blank line ends the command: the cheatsheet runs only its first block", async () => {
      capturedCalls.length = 0;
      await provider.query(generateSelectQuery(["user:*"], KEY_COLUMNS("string"), provider.getCapabilities()));
      expect(capturedCalls).toEqual([{ command: "SCAN", args: ["0", "MATCH", "user:*", "COUNT", "50"] }]);
    });

    test("comment lines between the wrapped lines of one command are dropped", async () => {
      capturedCalls.length = 0;
      await provider.query("HSET user:1 name alice\n# a note\nemail a@b.c");
      expect(capturedCalls).toEqual([{ command: "HSET", args: ["user:1", "name", "alice", "email", "a@b.c"] }]);
    });

    // --- A node name may not smuggle a command through the header comment (#427) ---

    /**
     * A schema-tree node name is a real key name, and Redis keys are arbitrary
     * byte strings — a newline in one used to end the cheatsheet's header
     * comment and turn its own remainder into the FIRST runnable line of the
     * buffer, which this provider then executed. Asserted on what the driver was
     * called with, because a mangled command still "succeeds" otherwise.
     */
    async function runWholeBuffer(buffer: string): Promise<Array<{ command: string; args: string[] }>> {
      capturedCalls.length = 0;
      await provider.query(buffer);
      return [...capturedCalls];
    }

    test("a node name containing a newline cannot inject a command (#427)", async () => {
      const name = "a\nDEL user:1 x";
      const calls = await runWholeBuffer(
        generateSelectQuery([name], KEY_COLUMNS("string"), provider.getCapabilities()),
      );
      expect(calls).toEqual([{ command: "TYPE", args: [name] }]);
    });

    test("a node name containing CRLF cannot inject a command (#427)", async () => {
      const name = "a\r\nDEL user:1 x";
      const calls = await runWholeBuffer(
        generateSelectQuery([name], KEY_COLUMNS("string"), provider.getCapabilities()),
      );
      expect(calls).toEqual([{ command: "TYPE", args: [name] }]);
    });

    test("a node name containing a newline and a quote cannot inject a command (#427)", async () => {
      const name = 'a\nDEL "user:1" x';
      const calls = await runWholeBuffer(generateSelectQuery([name], KEY_COLUMNS("hash"), provider.getCapabilities()));
      expect(calls).toEqual([{ command: "TYPE", args: [name] }]);
    });

    test("a newline-bearing prefix group still SCANs its own pattern (#427)", async () => {
      const calls = await runWholeBuffer(
        generateSelectQuery(["a\nDEL user:1 x:*"], KEY_COLUMNS("string"), provider.getCapabilities()),
      );
      expect(calls).toEqual([{ command: "SCAN", args: ["0", "MATCH", "a\nDEL user:1 x:*", "COUNT", "50"] }]);
    });

    // --- The WHOLE generated buffer through commandBody (#427 S4) ---
    //
    // `runGeneratedLines` above pre-strips comments and blank lines, so it never
    // reaches `commandBody`. These hand the buffer over UNMODIFIED — what a user
    // gets by pressing Run with nothing selected — and assert the args the driver
    // received for the FIRST block, which is the only command that may run.
    const wholeBufferCases: {
      name: string;
      node: string;
      sample: string;
      expected: { command: string; args: string[] };
    }[] = [
      {
        name: "a plain prefix group",
        node: "user:*",
        sample: "string",
        expected: { command: "SCAN", args: ["0", "MATCH", "user:*", "COUNT", "50"] },
      },
      {
        name: "a bare key",
        node: "user:1",
        sample: "zset",
        expected: { command: "TYPE", args: ["user:1"] },
      },
      {
        // The quote forces every command line into the JSON form, and JSON's `\"`
        // is not the plain tokenizer's quote: counting it left a phantom quote
        // open, so no later comment line was dropped and the whole buffer reached
        // JSON.parse with comments in it — "Invalid JSON command format" instead
        // of a TYPE result (#427).
        name: "a name containing a double quote",
        node: 'say"hi',
        sample: "string",
        expected: { command: "TYPE", args: ['say"hi'] },
      },
      {
        name: "a name containing a newline",
        node: "a\nDEL user:1 x",
        sample: "string",
        expected: { command: "TYPE", args: ["a\nDEL user:1 x"] },
      },
    ];

    for (const { name, node, sample, expected } of wholeBufferCases) {
      test(`the whole cheatsheet buffer for ${name} runs exactly its first block (#427)`, async () => {
        const buffer = generateSelectQuery([node], KEY_COLUMNS(sample), provider.getCapabilities());
        const calls = await runWholeBuffer(buffer);
        expect(calls).toEqual([expected]);
      });
    }

    // --- A quoted argument spanning lines keeps its newline (#427 regression) ---

    test("a quoted value spanning two lines keeps the newline", async () => {
      // The tokenizer's whitespace branch is guarded by `!inQuote`, so inside a
      // quoted argument a newline is DATA. Joining the block with a space
      // rewrote the stored value silently.
      capturedCalls.length = 0;
      await provider.query('SET note "line1\nline2"');
      expect(capturedCalls).toEqual([{ command: "SET", args: ["note", "line1\nline2"] }]);
    });

    test("a quoted value whose continuation starts with # is data, not a comment", async () => {
      capturedCalls.length = 0;
      await provider.query('SET note "line1\n#tag"');
      expect(capturedCalls).toEqual([{ command: "SET", args: ["note", "line1\n#tag"] }]);
    });

    test("a blank line inside a quoted value does not end the command", async () => {
      capturedCalls.length = 0;
      await provider.query('SET note "line1\n\nline3"');
      expect(capturedCalls).toEqual([{ command: "SET", args: ["note", "line1\n\nline3"] }]);
    });

    test("indentation inside a quoted value is preserved", async () => {
      capturedCalls.length = 0;
      await provider.query('SET note "line1\n  line2"');
      expect(capturedCalls).toEqual([{ command: "SET", args: ["note", "line1\n  line2"] }]);
    });

    test("query on a disconnected provider throws", async () => {
      const disconnected = new RedisProvider({ ...baseConfig });
      await expect(disconnected.query("PING")).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // endOpenQueryTransaction() (D75)
  // --------------------------------------------------------------------------

  describe("endOpenQueryTransaction()", () => {
    /** An ordinary read-only ACL's refusal, in the server's own words (see the NOPERM test). */
    const noPermDiscard = () => replyError("NOPERM User ro has no permissions to run the 'discard' command");

    beforeEach(async () => {
      discardFailure = null;
      pingFailure = null;
      await provider.connect();
      capturedCalls.length = 0;
    });

    test("discards a MULTI a statement left open on this connection", async () => {
      await provider.query("MULTI");
      capturedCalls.length = 0;

      expect(await provider.endOpenQueryTransaction()).toBe("rolled-back");
      // The ask and the act are two commands and in this order: the reading is what says
      // a DISCARD is warranted, and a DISCARD sent before it would be a write nobody read.
      expect(capturedCalls.map((call) => call.command)).toEqual(["PING", "DISCARD"]);
    });

    test("answers none when no MULTI is open, and sends no DISCARD at all", async () => {
      expect(await provider.endOpenQueryTransaction()).toBe("none");
      expect(capturedCalls.map((call) => call.command)).toEqual(["PING"]);
      expect((await provider.query("PING")).rows[0]).toEqual({ result: "PONG" });
    });

    test("answers none once the MULTI has already been discarded", async () => {
      await provider.query("MULTI");
      await provider.query("DISCARD");

      expect(await provider.endOpenQueryTransaction()).toBe("none");
    });

    test("answers none on a connection whose ACL refuses DISCARD, because it never sends one", async () => {
      // MEASURED on redis 7.4.11: `ACL SETUSER ro on >pw ~* +@read +ping +info` answers
      // PONG to `PING` and "NOPERM User ro has no permissions to run the 'discard'
      // command" to `DISCARD`, and cannot run `MULTI` either. Asking first is what keeps
      // an ordinary read-only connection from turning every caller's request into an
      // error: `POST /api/db/multi-query` awaits this in a `finally`, so a raise here
      // replaces a response that already carried the statement results it earned.
      discardFailure = noPermDiscard();

      expect(await provider.endOpenQueryTransaction()).toBe("none");
      expect(capturedCalls.map((call) => call.command)).toEqual(["PING"]);
    });

    test("raises when the ACL refuses the DISCARD of a MULTI that IS open", async () => {
      // The other half of the same ACL reading, and the opposite answer. MEASURED on the
      // same server with `+@read +ping +multi +set`: the `MULTI` opens, `PING` answers
      // QUEUED, `DISCARD` is refused with NOPERM, and the next command is still QUEUED. The
      // transaction really is open and really cannot be ended, so saying "none" here would
      // certify a clean connection that is not clean.
      await provider.query("MULTI");
      discardFailure = noPermDiscard();

      await expect(provider.endOpenQueryTransaction()).rejects.toThrow("NOPERM");
    });

    test("answers rolled-back when the MULTI went away between the ask and the act", async () => {
      // One connection serves every concurrent caller of the cached provider, so another
      // caller's DISCARD or EXEC can land in between. The queue is gone either way, which
      // is what "rolled-back" says; only the server's own "there was nothing queued" reads
      // that way, and it reads that way only after the ask saw one.
      await provider.query("MULTI");
      discardFailure = replyError("ERR DISCARD without MULTI");

      expect(await provider.endOpenQueryTransaction()).toBe("rolled-back");
    });

    test("refuses to answer before connect()", async () => {
      const disconnected = new RedisProvider({ ...baseConfig });

      await expect(disconnected.endOpenQueryTransaction()).rejects.toThrow(DatabaseConfigError);
    });

    test("raises a DISCARD failure that is not the server's own refusal", async () => {
      // Reading every failure as "there was nothing open" would report an unknown
      // connection state as a clean one. Only "ERR DISCARD without MULTI" is an answer.
      await provider.query("MULTI");
      discardFailure = new Error("Connection is closed.");

      await expect(provider.endOpenQueryTransaction()).rejects.toThrow("Connection is closed.");
    });

    test("raises when the reading itself is refused", async () => {
      // An ACL that grants neither PING nor DISCARD leaves nothing to read. A provider that
      // cannot ask has to say so: answering "none" would certify an absence nobody read.
      pingFailure = replyError("NOPERM User locked has no permissions to run the 'ping' command");

      await expect(provider.endOpenQueryTransaction()).rejects.toThrow("NOPERM");
    });

    test("the doc names the ONE route that calls this, and says the editor is not on it", () => {
      // `POST /api/db/multi-query` is the only caller of `endOpenQueryTransaction()` in the
      // product, and `use-query-execution.ts` keeps a Redis buffer off that route: it gates
      // the multi-statement endpoint on `dialectIsSql`, read from this capability. An
      // editor run therefore goes to `POST /api/db/query`, which ends nothing on purpose
      // (D74), so the leak this method closes stays open on the editor path. A doc that
      // promised otherwise would be the boundary the next reader trusts.
      expect(provider.getCapabilities().queryLanguage).toBe("json");

      const doc = readFileSync(join(import.meta.dir, "../../../docs/providers/redis.md"), "utf8").replace(/\s+/g, " ");
      expect(doc).toContain("The surface has exactly one caller in the product, `POST /api/db/multi-query`");
      expect(doc).toContain("The editor never sends a Redis buffer there.");
      expect(doc).toContain("a `MULTI` typed into the editor is still open when the response is sent");
    });

    test("raises when PING answers neither its own reply nor QUEUED", async () => {
      // The reading is the SUBSTITUTION of "QUEUED" for the command's own reply, so a third
      // answer is a reading this code does not have, not a clean connection.
      mockCallResults.PING = "SOMETHING ELSE";
      try {
        await expect(provider.endOpenQueryTransaction()).rejects.toThrow("SOMETHING ELSE");
      } finally {
        mockCallResults.PING = "PONG";
      }
    });
  });

  // --------------------------------------------------------------------------
  // getSchema()
  // --------------------------------------------------------------------------

  describe("getSchema()", () => {
    beforeEach(async () => {
      await provider.connect();
    });
  });

  // --------------------------------------------------------------------------
  // getHealth()
  // --------------------------------------------------------------------------

  describe("getHealth()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns activeConnections, databaseSize, cacheHitRatio", async () => {
      const health = await provider.getHealth();
      expect(health.activeConnections).toBe(12);
      expect(health.databaseSize).toBe("1.95MB");
      // hitRatio: 900/(900+100)*100 = 90.0
      expect(health.cacheHitRatio).toBe("90.0");
    });

    /*
      D29's other half. An ACL user without `+info` connects and browses keys, and
      every INFO-derived surface is refused. `getHealth()` must NOT answer with
      fabricated zeros for a read that never happened - it raises the server's own
      sentence, which `POST /api/db/test-connection` turns into the degraded (amber)
      outcome rather than a green one (that translation is covered in
      tests/api/db/test-connection.test.ts).
    */
    test("a refused INFO raises the server's own NOPERM sentence", async () => {
      infoRefusal = "NOPERM User probe has no permissions to run the 'info' command";
      try {
        await expect(provider.getHealth()).rejects.toThrow(
          "Failed to get Redis health: NOPERM User probe has no permissions to run the 'info' command",
        );
      } finally {
        infoRefusal = null;
      }
    });
  });

  // --------------------------------------------------------------------------
  // runMaintenance()
  // --------------------------------------------------------------------------

  describe("runMaintenance()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("analyze returns server info", async () => {
      const result = await provider.runMaintenance("analyze");
      expect(result.success).toBe(true);
      expect(result.message).toContain("Server info retrieved");
    });

    test("unsupported maintenance type throws", async () => {
      await expect(provider.runMaintenance("vacuum")).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // getOverview()
  // --------------------------------------------------------------------------

  describe("getOverview()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns version, uptime, connections, size", async () => {
      const overview = await provider.getOverview();
      expect(typeof overview.version).toBe("string");
      expect(overview.version).toContain("7.2.4");
      expect(typeof overview.uptime).toBe("string");
      expect(typeof overview.activeConnections).toBe("number");
      expect(overview.activeConnections).toBe(12);
      expect(overview.maxConnections).toBe(10000);
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(typeof overview.tableCount).toBe("number");
    });

    test("labels a self-naming vendor version ahead of the plain compatibility level", async () => {
      const cases: Array<{ field: string; value: string; expected: string }> = [
        { field: "valkey_version", value: "9.1.1", expected: "Valkey 9.1.1 (Redis 7.2.4)" },
        { field: "dragonfly_version", value: "df-v1.40.1", expected: "Dragonfly df-v1.40.1 (Redis 7.2.4)" },
        { field: "garnet_version", value: "2.1.5", expected: "Garnet 2.1.5 (Redis 7.2.4)" },
      ];
      try {
        for (const { field, value, expected } of cases) {
          infoOverride = `${MOCK_INFO_STRING}${field}:${value}\n`;
          const overview = await provider.getOverview();
          expect(overview.version).toBe(expected);
        }
      } finally {
        infoOverride = null;
      }
    });

    test("reads the connection limit under Dragonfly's underscored max_clients", async () => {
      infoOverride = MOCK_INFO_STRING.replace("maxclients:10000", "max_clients:64000");
      try {
        const overview = await provider.getOverview();
        expect(overview.maxConnections).toBe(64000);
      } finally {
        infoOverride = null;
      }
    });
  });

  // --------------------------------------------------------------------------
  // getPerformanceMetrics()
  // --------------------------------------------------------------------------

  describe("getPerformanceMetrics()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns cache hit ratio and ops per sec", async () => {
      const metrics = await provider.getPerformanceMetrics();
      expect(typeof metrics.cacheHitRatio).toBe("number");
      // hitRatio: 900/(900+100)*100 = 90.0
      expect(metrics.cacheHitRatio).toBe(90);
    });
  });

  // --------------------------------------------------------------------------
  // getSlowQueries()
  // --------------------------------------------------------------------------

  describe("getSlowQueries()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns slow query data", async () => {
      const slow = await provider.getSlowQueries();
      expect(slow).toBeArray();
    });

    test("maps SLOWLOG entries to SlowQueryStats", async () => {
      const slow = await provider.getSlowQueries();
      expect(slow.length).toBe(2);

      // Array args are joined into a command string; duration is microseconds -> ms
      expect(slow[0].queryId).toBe("1");
      expect(slow[0].query).toBe("GET user:1");
      expect(slow[0].calls).toBe(1);
      expect(slow[0].totalTime).toBe(1.5);
      expect(slow[0].avgTime).toBe(1.5);
      expect(slow[0].rows).toBe(0);

      // Non-array args payload falls back to String()
      expect(slow[1].queryId).toBe("2");
      expect(slow[1].query).toBe("HGETALL user:2");
      expect(slow[1].totalTime).toBe(2.5);
    });
  });

  // --------------------------------------------------------------------------
  // getActiveSessions()
  // --------------------------------------------------------------------------

  describe("getActiveSessions()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns client list as sessions", async () => {
      const sessions = await provider.getActiveSessions();
      expect(sessions).toBeArray();
      expect(sessions.length).toBe(2);
      expect(sessions[0].user).toBeDefined();
    });

    test("reads the user column from CLIENT LIST's user field, not its name field", async () => {
      const sessions = await provider.getActiveSessions();
      expect(sessions[0].user).toBe("studio");
      expect(sessions[1].user).toBe("default");
    });
  });

  // --------------------------------------------------------------------------
  // getTableStats()
  // --------------------------------------------------------------------------

  describe("getTableStats()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns key pattern stats", async () => {
      const stats = await provider.getTableStats();
      expect(stats).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // getIndexStats()
  // --------------------------------------------------------------------------

  describe("getIndexStats()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns empty array (Redis has no indexes)", async () => {
      const stats = await provider.getIndexStats();
      expect(stats).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // getStorageStats()
  // --------------------------------------------------------------------------

  describe("getStorageStats()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns memory usage info", async () => {
      const stats = await provider.getStorageStats();
      expect(stats).toBeArray();
      expect(stats.length).toBeGreaterThan(0);
      expect(typeof stats[0].name).toBe("string");
      expect(typeof stats[0].sizeBytes).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // getMonitoringData()
  // --------------------------------------------------------------------------

  describe("getMonitoringData()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns monitoring data", async () => {
      const data = await provider.getMonitoringData();
      expect(data.timestamp).toBeInstanceOf(Date);
      expect(data.overview).toBeDefined();
      expect(data.performance).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Additional query scenarios
  // --------------------------------------------------------------------------

  describe("additional query scenarios", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("KEYS command returns key list", async () => {
      const result = await provider.query(JSON.stringify({ command: "KEYS", args: ["*"] }));
      expect(result.rows).toBeArray();
    });

    test("SET command returns OK", async () => {
      const result = await provider.query(JSON.stringify({ command: "SET", args: ["mykey", "myvalue"] }));
      expect(result.rows[0].result).toBe("OK");
    });

    test("DEL command returns integer count", async () => {
      const result = await provider.query(JSON.stringify({ command: "DEL", args: ["mykey"] }));
      expect(result.rows[0].result).toBe("(integer) 1");
    });

    test("PING returns PONG", async () => {
      const result = await provider.query(JSON.stringify({ command: "PING", args: [] }));
      expect(result.rows[0].result).toBe("PONG");
    });

    test("DBSIZE returns integer key count", async () => {
      const result = await provider.query(JSON.stringify({ command: "DBSIZE", args: [] }));
      expect(result.rows[0].result).toBe("(integer) 42");
    });
  });

  // --------------------------------------------------------------------------
  // Object surface (#789)
  // --------------------------------------------------------------------------

  /**
   * The four object-surface methods on an engine whose catalog is a COMMAND rather than a
   * query. Not the first non-SQL engine to get them: MongoDB's landed in 16b1b23a, two
   * minutes before this, and an earlier version of this comment claimed otherwise.
   *
   * The mock answers `CONFIG GET databases`, `FUNCTION LIST` and `SCAN` by dispatching on
   * the command the provider sent, which standing ruling 5b names as a blind spot: a fake
   * that routes by request content cannot see a change to that content. So every test
   * below that depends on WHICH command was sent also pins the command text through
   * `capturedCalls`, and the report sizes what the pins are worth by naming the mutations
   * that fail without them.
   */
  describe("object surface (#789)", () => {
    /** Every (command, args) the provider sent since this test started. */
    const commandsSent = () => capturedCalls.map((entry) => [entry.command, ...entry.args].join(" "));

    beforeEach(async () => {
      databasesReply = ["databases", "16"];
      functionListReply = MOCK_FUNCTION_LIST;
      functionWithCodeReply = MOCK_FUNCTION_WITHCODE;
      functionRefusal = null;
      functionTransportFailure = null;
      mockCall = null;
      scanRefusal = null;
      scanOverflows = false;
      scanCalls = 0;
      capturedCalls.length = 0;
      capturedRedisOptions.length = 0;
      await provider.connect();
    });

    test("declares one container level and the two kinds this engine really has", () => {
      const caps = provider.getCapabilities();

      expect(caps.containerLevels).toEqual([{ id: "schema", label: "Database", labelPlural: "Databases" }]);
      expect(caps.objectKinds).toEqual([
        { id: "keyspace", role: "relation", label: "Key Pattern", labelPlural: "Key Patterns" },
        {
          id: "function",
          role: "routine",
          label: "Function Library",
          labelPlural: "Function Libraries",
          hasSource: true,
          sourceLanguage: "lua",
          acceptsSourceEdits: true,
        },
      ]);
      // The derived-grouping refusal, carried forward: `keyspace` rows are this server's
      // own summary of a bounded SCAN, so nothing may offer to write rows into one.
      expect(caps.objectKinds?.find((kind) => kind.id === "keyspace")?.acceptsRowWrites).toBeUndefined();
      expect(caps.tablesAreDerivedGroupings).toBe(true);
    });

    test("satisfies the object-surface contract", async () => {
      await assertObjectSurface(provider, {
        containers: Array.from({ length: 16 }, (_, index) => [String(index)]),
        kinds: { keyspace: 2, function: 2 },
        sampleObject: { path: ["0", "user:*"], kind: "keyspace" },
        absentSource: { path: ["0", "no_such_library"], kind: "function" },
      });
    });

    test("reads a function library's Lua source, selecting the byte-equal name", async () => {
      const document = await provider.readObjectSource!(["0", "libredb_probe"], "function");

      expect(document.path).toEqual(["0", "libredb_probe"]);
      expect(document.kind).toBe("function");
      expect(document.parts).toHaveLength(1);
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("the fixture library is readable");
      expect(part.id).toBe("definition");
      expect(part.label).toBe("Definition");
      expect(part.language).toBe("lua");
      expect(part.form).toBe("complete");
      expect(part.origin).toBe("stored");
      expect(part.truncated).toBeUndefined();
      expect(part.text).toBe(FIXTURE_LIBRARY_CODE);
      // The case pair is why the selection is byte-equal: FUNCTION LIST LIBRARYNAME
      // glob-matches case-INSENSITIVELY over a case-SENSITIVE dictionary, so this reply
      // carries two libraries and the FIRST of them is the wrong one.
      expect(part.text).not.toContain("LIBREDB_UPPER_PING");
      expect(commandsSent()).toContain("FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE");
    });

    test("bounds one part at the caller's limit and reports the one shared sentence", async () => {
      const document = await provider.readObjectSource!(["0", "libredb_probe"], "function", 24);
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("the fixture library is readable");

      expect(part.text).toBe(FIXTURE_LIBRARY_CODE.slice(0, 24));
      expect(part.truncated).toEqual({ limit: 24, reason: sourceBoundTruncationReason(24) });
    });

    test("raises for a library the server does not hold, because an empty reply is absence", async () => {
      // Measured on redis 8.10.0: FUNCTION LIST LIBRARYNAME no_such_library WITHCODE answers
      // an EMPTY ARRAY rather than an error, so emptiness is absence to whatever asks.
      functionWithCodeReply = [];
      await expect(provider.readObjectSource!(["0", "no_such_library"], "function")).rejects.toThrow(/no_such_library/);
    });

    test("raises for a kind that declares no source, so keyspace never reaches an editor", async () => {
      // The `tablesAreDerivedGroupings` refusal carried into the object model: a key prefix
      // is a grouping this server derived from a bounded SCAN and nobody wrote a definition
      // for it. The refusal is driven off the DECLARATION and never off the kind id.
      await expect(provider.readObjectSource!(["0", "user:*"], "keyspace")).rejects.toThrow(
        /no readable source for the kind "keyspace"/,
      );
    });

    test("raises for a kind this engine does not declare at all", async () => {
      await expect(provider.readObjectSource!(["0", "x"], "procedure")).rejects.toThrow(
        /no readable source for the kind "procedure"/,
      );
    });

    test("carries the server's own refusal when the ACL denies FUNCTION", async () => {
      // MEASURED on redis 8.10.0 as the ACL user `libredb_nofunction` the fixture creates.
      functionRefusal = "NOPERM User libredb_nofunction has no permissions to run the 'function|list' command";
      const document = await provider.readObjectSource!(["0", "libredb_probe"], "function");
      const [part] = document.parts;

      if (!isSourcePartUnavailable(part)) throw new Error("a denied read is a refusal");
      expect(part.unavailable).toBe(
        "NOPERM User libredb_nofunction has no permissions to run the 'function|list' command",
      );
      expect("text" in part).toBe(false);
    });

    /*
      A REFUSAL is the server answering "no". A TRANSPORT failure is nobody answering at all,
      and the two must not arrive at the same pane. MEASURED against ioredis 5.11.1 and redis
      8.10.0: a dropped socket rejects with a PLAIN Error reading "Connection is closed.",
      while an ACL denial rejects with a `ReplyError`. A bare `catch` around the command turns
      the first into a Source pane reading "Connection is closed." presented as this object's
      own refusal, with no raise, no retry affordance and nothing in the document telling it
      apart from a real NOPERM. It raises instead, and the fifteen providers copying this arm
      copy the distinction with it.
    */
    test("a dropped connection RAISES rather than being presented as the server's refusal", async () => {
      functionTransportFailure = new Error("Connection is closed.");

      await expect(provider.readObjectSource!(["0", "libredb_probe"], "function")).rejects.toThrow(
        /Failed to read the Redis function library "libredb_probe": Connection is closed\./,
      );
    });

    test("a rejection that is not an Error at all raises too, rather than becoming a refusal sentence", async () => {
      // A driver is free to reject with something that is not an `Error`, and the class check
      // must not read that as a server reply by omission.
      functionTransportFailure = "socket hang up";

      await expect(provider.readObjectSource!(["0", "libredb_probe"], "function")).rejects.toThrow(
        /Failed to read the Redis function library "libredb_probe": socket hang up/,
      );
    });

    test("a library whose code the server withheld is absence rather than an empty definition", async () => {
      // The entry matches by name and carries no `library_code`. Answering a part with an
      // empty text would put an empty editor over a definition that was never read, which is
      // the DBeaver shape this contract exists to make unrepresentable.
      functionWithCodeReply = [["library_name", "libredb_probe", "engine", "LUA"]];
      await expect(provider.readObjectSource!(["0", "libredb_probe"], "function")).rejects.toThrow(/libredb_probe/);
    });

    test("a library the server answers with an EMPTY code is absence, not an empty definition", async () => {
      // Distinct from the entry that carries no `library_code` at all: this one carries the
      // key with nothing in it, which is the shape a reader would most easily hand to an
      // editor as a blank buffer.
      functionWithCodeReply = [["library_name", "libredb_probe", "engine", "LUA", "library_code", "   "]];
      await expect(provider.readObjectSource!(["0", "libredb_probe"], "function")).rejects.toThrow(
        /Redis holds no function library called "libredb_probe"/,
      );
    });

    test("the part's language is the kind's DECLARED sourceLanguage, not a literal", async () => {
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...provider.getCapabilities(),
        objectKinds: [
          { id: "keyspace", role: "relation", label: "Key Pattern", labelPlural: "Key Patterns" },
          {
            id: "function",
            role: "routine",
            label: "Function Library",
            labelPlural: "Function Libraries",
            hasSource: true,
            sourceLanguage: "luau",
          },
        ],
      } as ReturnType<typeof provider.getCapabilities>);

      const document = await provider.readObjectSource!(["0", "libredb_probe"], "function");
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("the fixture library is readable");
      expect(part.language).toBe("luau");
    });

    /*
      A source-bearing kind that declares no `sourceLanguage` RAISES, and this test replaces
      one that asserted the opposite (#789, the external review of PR #820). The old arm read
      `spec.sourceLanguage ?? "lua"`. Counted across the fleet at that point: nine of the
      eleven providers that read source threw here and exactly two fell back, this one and
      `oracle.ts`. A fallback in two of eleven is not a safety net, because the census in
      `tests/isolated/object-source-declarations.test.ts` pins every declared language, so the
      only way to reach the arm is a declaration somebody deleted - and the literal then hides
      that deletion behind a Source tab that still highlights.
    */
    test("a source-bearing kind that declares no language RAISES rather than falling back to a literal", async () => {
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...provider.getCapabilities(),
        objectKinds: [
          { id: "keyspace", role: "relation", label: "Key Pattern", labelPlural: "Key Patterns" },
          {
            id: "function",
            role: "routine",
            label: "Function Library",
            labelPlural: "Function Libraries",
            hasSource: true,
          },
        ],
      } as ReturnType<typeof provider.getCapabilities>);

      await expect(provider.readObjectSource!(["0", "libredb_probe"], "function")).rejects.toThrow(
        /Redis declares readable source for the kind "function" and no sourceLanguage to render it with/,
      );
      // Nothing was sent: the declaration is checked before the round trip, so a lost
      // language cannot cost a command either.
      expect(commandsSent()).not.toContain("FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE");
    });

    /*
      THE PATH SHAPE, which `describeObject` has checked since Phase 1 and this method did
      not (#789, the external review of PR #820). The HTTP route bounds an empty path, but
      this METHOD is published through `@libredb/studio`, is reached by the embedded host
      seam and by the conformance helper, and none of those three sees the route. Without the
      check, `path[path.length - 1]` on an empty path is `undefined` and the provider sends
      `FUNCTION LIST LIBRARYNAME undefined`.

      Both directions are driven, because a length check written as `<` or as `>` passes one
      of them: a path SHORTER than the declaration allows and a path LONGER than it allows.
    */
    test("a path that is not [database, name] is refused, in describeObject's own words", async () => {
      await expect(provider.readObjectSource!([], "function")).rejects.toThrow(
        'A Redis "function" path is [database, name], received []',
      );
      await expect(provider.readObjectSource!(["libredb_probe"], "function")).rejects.toThrow(
        'A Redis "function" path is [database, name], received ["libredb_probe"]',
      );
      await expect(provider.readObjectSource!(["0", "sub", "libredb_probe"], "function")).rejects.toThrow(
        'A Redis "function" path is [database, name], received ["0","sub","libredb_probe"]',
      );
      // Vacuity control: the same method on a WELL-SHAPED path still reads the library, so
      // the three refusals above are the shape check and not a broken fixture.
      expect((await provider.readObjectSource!(["0", "libredb_probe"], "function")).parts).toHaveLength(1);
    });

    test("the refused shape follows the DECLARED levels, so a two-level declaration accepts three segments", async () => {
      // The message and the bound both come from `declaredLevels`, never from a literal 2.
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...provider.getCapabilities(),
        containerLevels: [
          { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
          { id: "schema", label: "Database", labelPlural: "Databases" },
        ],
      } as ReturnType<typeof provider.getCapabilities>);

      await expect(provider.readObjectSource!(["0", "libredb_probe"], "function")).rejects.toThrow(
        'A Redis "function" path is [catalog, database, name], received ["0","libredb_probe"]',
      );
      expect((await provider.readObjectSource!(["main", "0", "libredb_probe"], "function")).parts).toHaveLength(1);
    });

    /**
     * Standing ruling 5g, pinned on a one-level engine (#789).
     *
     * The declaration is swapped for a two-level one and the read is driven all the way to
     * the NAME it selects by. A provider taking `path[1]` is behaviour-identical at depth 1
     * and silently wrong here, and a provider hardcoding the depth would refuse a path it
     * must accept.
     */
    test("the library name comes from the declared depth, not from a fixed position", async () => {
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...provider.getCapabilities(),
        containerLevels: [
          { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
          { id: "schema", label: "Database", labelPlural: "Databases" },
        ],
      } as ReturnType<typeof provider.getCapabilities>);

      const document = await provider.readObjectSource!(["main", "0", "libredb_probe"], "function");

      expect(document.path).toEqual(["main", "0", "libredb_probe"]);
      expect(commandsSent()).toContain("FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE");
    });

    test("the container list is the deployment's own database count, not a constant 16", async () => {
      databasesReply = ["databases", "1"];
      const containers = await provider.listContainers();

      expect(containers.map((container) => container.path)).toEqual([["0"]]);
      expect(commandsSent()).toContain("CONFIG GET databases");
    });

    test("a nested container list is empty: this engine has one level", async () => {
      expect(await provider.listContainers(["0"])).toEqual([]);
    });

    test("the session's own database is the one marked default", async () => {
      provider = new RedisProvider({ ...baseConfig, database: "3" });
      await provider.connect();
      const containers = await provider.listContainers();

      expect(containers.filter((container) => container.isSessionDefault).map((c) => c.name)).toEqual(["3"]);
      expect(containers.every((container) => container.level === 0)).toBe(true);
    });

    test("a refused CONFIG GET raises rather than inventing a database list", async () => {
      databasesReply = [];
      await expect(provider.listContainers()).rejects.toThrow(/CONFIG GET databases/);
    });

    test("counts both kinds, seeded at zero before either read answers", async () => {
      const counts = await provider.countObjects(["0"]);

      expect(counts).toEqual({ keyspace: { count: 2 }, function: { count: 2 } });
      expect(commandsSent()).toContain("FUNCTION LIST");
    });

    test("an empty database counts zero rather than losing its folders", async () => {
      const counts = await provider.countObjects(["7"]);
      expect(counts).toEqual({ keyspace: { count: 0 }, function: { count: 2 } });
    });

    // Measured on three of the four Redis-wire relatives, each with its own sentence.
    test("a server with no FUNCTION command carries its own sentence, not a zero", async () => {
      functionRefusal = "ERR unknown command `FUNCTION`, with args beginning with: `LIST`, ";
      const counts = await provider.countObjects(["0"]);

      expect(counts).toEqual({
        keyspace: { count: 2 },
        function: { unavailable: "ERR unknown command `FUNCTION`, with args beginning with: `LIST`, " },
      });
    });

    test("a SCAN stopped by its key budget answers a FLOOR, while the function count beside it stays exact", async () => {
      // The defect this closes: a bounded read rendered as a population. The walk stopped on
      // its 1000-key budget, so the three groupings it saw are AT LEAST three, and the tree
      // has to be able to say so. The `function` count in the same record comes from
      // `FUNCTION LIST`, which enumerates the whole server, and must NOT pick up the mark:
      // that is the per-kind half of the state (#789).
      scanOverflows = true;
      const counts = await provider.countObjects(["0"]);

      expect(counts).toEqual({
        keyspace: { count: 3, sampledFrom: "the first 1,000 keys of one SCAN walk" },
        function: { count: 2 },
      });
    });

    test("a SCAN that reached the end of the keyspace is NOT marked a sample", async () => {
      // The control for the test above. Without it, marking every keyspace count a floor
      // passes that assertion and is wrong on every small database: `2` and `2+` are
      // different claims and this engine can tell them apart, because a cursor back at 0
      // means the server walked everything it holds.
      const counts = await provider.countObjects(["0"]);

      expect(counts.keyspace).toEqual({ count: 2 });
      expect("sampledFrom" in counts.keyspace).toBe(false);
    });

    test("a refused SCAN leaves the keyspace count unavailable and the function count intact", async () => {
      scanRefusal = "NOPERM this user has no permissions to run the 'scan' command";
      const counts = await provider.countObjects(["0"]);

      expect(counts).toEqual({
        keyspace: { unavailable: "NOPERM this user has no permissions to run the 'scan' command" },
        function: { count: 2 },
      });
    });

    test("the count is the length of the listing it counted", async () => {
      const counts = await provider.countObjects(["0"]);
      const keyspaces = await provider.listObjects(["0"], "keyspace");
      const functions = await provider.listObjects(["0"], "function");

      expect(counts.keyspace).toEqual({ count: keyspaces.length });
      expect(counts.function).toEqual({ count: functions.length });
    });

    test("lists key groupings with their sampled key count", async () => {
      const objects = await provider.listObjects(["0"], "keyspace");

      expect(objects).toEqual([
        { path: ["0", "session:*"], name: "session:*", kind: "keyspace", rowCount: 1 },
        { path: ["0", "user:*"], name: "user:*", kind: "keyspace", rowCount: 2 },
      ]);
    });

    test("lists function libraries by their library_name, not by position", async () => {
      const objects = await provider.listObjects(["0"], "function");

      // Sorted by `comparePaths`, which orders the segments: "LIBREDB_PROBE" precedes
      // "libredb_probe" because the code units do.
      expect(objects).toEqual([
        { path: ["0", "LIBREDB_PROBE"], name: "LIBREDB_PROBE", kind: "function" },
        { path: ["0", "libredb_probe"], name: "libredb_probe", kind: "function" },
      ]);
      expect(commandsSent()).toContain("FUNCTION LIST");
    });

    /**
     * The same reply with its fields REORDERED, which is what makes the test above
     * non-vacuous: redis 8.10.0 happens to answer `library_name` first, so a parser reading
     * `entry[1]` passes every assertion built from the measured order. Field order is not
     * part of the protocol contract - RESP3 answers a map, where there is no order at all -
     * and a server adding a field ahead of this one would rename every library at once.
     */
    test("finds library_name wherever in the reply it sits", async () => {
      functionListReply = [["engine", "LUA", "library_name", "libredb_probe", "functions", []]];

      expect(await provider.listObjects(["0"], "function")).toEqual([
        { path: ["0", "libredb_probe"], name: "libredb_probe", kind: "function" },
      ]);
    });

    /** An entry carrying no `library_name` is skipped: an unaddressable row is not a node. */
    test("an entry with no library_name is skipped rather than listed as undefined", async () => {
      functionListReply = [
        ["engine", "LUA"],
        ["library_name", "only_real_one", "engine", "LUA"],
      ];

      expect((await provider.listObjects(["0"], "function")).map((object) => object.name)).toEqual(["only_real_one"]);
    });

    /**
     * `CONFIG GET` takes a GLOB and answers every parameter that matches it, so the position
     * of a parameter in the reply is a property of the request rather than of the parameter.
     * A stock `CONFIG GET databases` answers one pair and `databases` lands at index 0, which
     * is precisely why a positional read survives a suite built only from that reply.
     */
    test("finds the databases value by its key, not at index 1", async () => {
      databasesReply = ["maxmemory", "0", "databases", "4", "maxmemory-policy", "noeviction"];

      expect((await provider.listContainers()).map((container) => container.name)).toEqual(["0", "1", "2", "3"]);
    });

    test("a databases value that is not a positive integer raises rather than being coerced", async () => {
      databasesReply = ["databases", "not-a-number"];
      await expect(provider.listContainers()).rejects.toThrow(/"not-a-number"/);
    });

    test("reads the CONTAINER's database and never the session's", async () => {
      const objects = await provider.listObjects(["3"], "keyspace");

      expect(objects.map((object) => object.path)).toEqual([["3", "report:*"]]);
      // The session connection is db 0 and stays on it: nothing SELECTs underneath it.
      expect(capturedRedisOptions.map((options) => options.db)).toEqual([0, 3]);
      expect(commandsSent().filter((command) => command.startsWith("SELECT"))).toEqual([]);
    });

    test("describes a key grouping with the three columns every key row has", async () => {
      const detail = await provider.describeObject(["0", "user:*"], "keyspace");

      expect(detail.path).toEqual(["0", "user:*"]);
      expect(detail.columns.map((column) => column.name)).toEqual(["key", "value", "type"]);
      expect(detail.columns[0]).toEqual({ name: "key", type: "string", nullable: false, isPrimary: true });
      expect(detail.indexes).toEqual([]);
      expect(detail.foreignKeys).toEqual([]);
    });

    test("a grouping the current scan no longer holds raises rather than answering an empty shape", async () => {
      await expect(provider.describeObject(["0", "gone:*"], "keyspace")).rejects.toThrow(/gone:\*/);
    });

    test("describes a function library as the columnless object it is", async () => {
      const detail = await provider.describeObject(["0", "libredb_probe"], "function");

      expect(detail).toEqual({ path: ["0", "libredb_probe"], columns: [], indexes: [], foreignKeys: [] });
    });

    test("an undeclared kind is refused by name on every method that takes one", async () => {
      await expect(provider.listObjects(["0"], "stream")).rejects.toThrow(/declares no object kind "stream"/);
      await expect(provider.describeObject(["0", "x"], "stream")).rejects.toThrow(/declares no object kind "stream"/);
    });

    test("a container path of the wrong length is refused rather than read positionally", async () => {
      await expect(provider.countObjects([])).rejects.toThrow(/\[database\]/);
      await expect(provider.listObjects(["0", "1"], "keyspace")).rejects.toThrow(/\[database\]/);
      await expect(provider.describeObject(["0"], "keyspace")).rejects.toThrow(/\[database, name\]/);
    });

    test("a database segment that is not a number is refused with the segment in the message", async () => {
      await expect(provider.countObjects(["main"])).rejects.toThrow(/"main"/);
    });

    /**
     * A kind this engine declares and has no command to enumerate.
     *
     * Unreachable from the shipped declaration, which is the point: the two methods answer
     * "is this a kind of mine" from the DECLARATION and never from whether a reader exists
     * below, so a kind added to `objectKinds` without a reader has to fail by name rather
     * than answer an empty folder. Spied in because that is the only way to build the case.
     */
    test("a declared kind with no command behind it is refused by name", async () => {
      const base = provider.getCapabilities();
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...base,
        objectKinds: [...(base.objectKinds ?? []), { id: "stream", role: "relation", label: "S", labelPlural: "S" }],
      });

      await expect(provider.listObjects(["0"], "stream")).rejects.toThrow(/has no command that lists it/);
      // And the same kind counts as unavailable rather than as zero, carrying that sentence.
      const counts = await provider.countObjects(["0"]);
      expect(counts.stream).toEqual({
        unavailable: 'Redis declares the kind "stream" but has no command that lists it',
      });
    });

    /**
     * A declaration with container levels but no `schema` level among them.
     *
     * The database segment is found by the level's declared ID, so a declaration that names
     * no such level must raise instead of falling through to `path[0]`, which is the exact
     * positional read standing ruling 5g forbids.
     */
    test("a declaration with no database level is refused rather than read positionally", async () => {
      const base = provider.getCapabilities();
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...base,
        containerLevels: [{ id: "catalog", label: "Cluster", labelPlural: "Clusters" }],
      });

      await expect(provider.countObjects(["main"])).rejects.toThrow(/needs a "schema" container level/);
    });

    /**
     * Standing ruling 5g, the one test every provider owes whatever its engine's depth.
     *
     * A two-level declaration is spied in and the call is driven all the way to the BOUND
     * VALUE - the `db` the object connection was opened on - rather than to a refusal. Both
     * mutations die here and neither can die at depth 1: a hardcoded `container.length !== 1`
     * refuses this path outright, and `Number(container[0])` binds `NaN` for the catalog
     * segment instead of 3 for the database.
     */
    test("a two-level declaration binds the database from the level that declares it", async () => {
      const base = provider.getCapabilities();
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...base,
        containerLevels: [
          { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
          { id: "schema", label: "Database", labelPlural: "Databases" },
        ],
      });

      const objects = await provider.listObjects(["main", "3"], "keyspace");

      expect(objects.map((object) => object.path)).toEqual([["main", "3", "report:*"]]);
      expect(capturedRedisOptions[capturedRedisOptions.length - 1].db).toBe(3);
      const detail = await provider.describeObject(["main", "3", "report:*"], "keyspace");
      expect(detail.path).toEqual(["main", "3", "report:*"]);
    });

    // ======================================================================
    // The bulk column read (#789)
    // ======================================================================

    /**
     * ONE walk for the whole folder, and the SCAN count is what is asserted.
     *
     * `describeObject` runs a whole `scanKeyGroups` walk of its own, so a body looping it
     * would walk the keyspace once per grouping - which on this engine is the N+1 the
     * inventory route removed, spelled in SCAN pages rather than in statements. The
     * assertion is on the driver call count and not on the wall clock.
     */
    test("describeObjects walks the keyspace ONCE for a whole folder, not once per grouping", async () => {
      scanCalls = 0;
      const batch = await provider.describeObjects!(["0"], "keyspace");

      expect(batch.details.map((detail) => detail.path)).toEqual([
        ["0", "session:*"],
        ["0", "user:*"],
      ]);
      expect(scanCalls).toBe(1);
      // The control: the single read pays one walk per object, so two objects cost two.
      scanCalls = 0;
      await provider.describeObject(["0", "session:*"], "keyspace");
      await provider.describeObject(["0", "user:*"], "keyspace");
      expect(scanCalls).toBe(2);
    });

    test("every grouping carries ITS OWN sampled types, not the first one's", async () => {
      const batch = await provider.describeObjects!(["0"], "keyspace");

      // `session:abc` is a HASH and the two `user:` keys are strings, so the two groupings
      // answer two different column lists. With one type for the whole database a bulk read
      // describing every object from the first grouping's sample would be indistinguishable
      // from a correct one.
      expect(batch.details.map((detail) => detail.columns.map((column) => column.type))).toEqual([
        ["string", "hash", "hash"],
        ["string", "string", "string"],
      ]);
      expect(batch.details[0].columns.map((column) => column.name)).toEqual(["key", "value", "type"]);
    });

    test("the bulk read spells a grouping exactly as the single read does", async () => {
      const batch = await provider.describeObjects!(["0"], "keyspace");
      const listed = await provider.listObjects(["0"], "keyspace");

      expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
      for (const detail of batch.details) {
        expect(detail).toEqual(await provider.describeObject(detail.path, "keyspace"));
      }
    });

    /**
     * A FUNCTION LIBRARY HAS NO COLUMNS, so the batch is empty and NOTHING is sent.
     *
     * The reference's fourth guard, and here it is the same fact `describeObject` already
     * answers for one library: a library has no columns, no indexes and no foreign keys, and
     * its source is Phase 2's through `FUNCTION LIST WITHCODE`. The assertion is on the
     * commands sent, not on the empty array, because an implementation that read
     * `FUNCTION LIST` and then dropped every row would satisfy the array.
     */
    test("a function library folder answers an empty batch with NO round trip", async () => {
      capturedCalls.length = 0;
      scanCalls = 0;
      const batch = await provider.describeObjects!(["0"], "function");

      expect(batch).toEqual({ details: [] });
      expect(commandsSent()).toEqual([]);
      expect(scanCalls).toBe(0);
    });

    test("the caller's bound cuts the sorted groupings and reports the caller's own limit", async () => {
      const batch = await provider.describeObjects!(["0"], "keyspace", 1);

      expect(batch.details.map((detail) => detail.path)).toEqual([["0", "session:*"]]);
      expect(batch.truncated).toEqual({
        limit: 1,
        reason: "the bulk column read was bounded at 1 object by its caller",
      });
    });

    test("a bound the folder fits inside reports nothing, on either side of the boundary", async () => {
      expect((await provider.describeObjects!(["0"], "keyspace", 2)).truncated).toBeUndefined();
      expect((await provider.describeObjects!(["0"], "keyspace", 3)).truncated).toBeUndefined();
    });

    /**
     * The bound this provider did NOT choose, reported rather than hidden.
     *
     * The walk stops at 1,000 keys, so on a larger keyspace the groupings are the groupings
     * of a SAMPLE and there may be more objects than the batch holds. `countObjects` already
     * says so through `KindCount.sampledFrom`; this is the same fact from the same walk, in
     * the field `ObjectDetailBatch` has for it, and it is reported on an UNBOUNDED read
     * because a cap nobody can see is what `truncated` exists to prevent.
     */
    test("a SCAN stopped by its key budget is reported as truncation on an unbounded read", async () => {
      scanOverflows = true;
      const batch = await provider.describeObjects!(["0"], "keyspace");

      expect(batch.details.map((detail) => detail.path)).toEqual([
        ["0", "bulk:*"],
        ["0", "session:*"],
        ["0", "user:*"],
      ]);
      expect(batch.truncated).toEqual({
        limit: 3,
        reason: "the key walk stopped at the first 1,000 keys of one SCAN walk",
      });
      // The FUNCTION folder in the same state is not marked: `FUNCTION LIST` enumerates the
      // whole server and has no key budget at all. That is the per-kind half of the rule.
      expect((await provider.describeObjects!(["0"], "function")).truncated).toBeUndefined();
    });

    test("a walk that reached the end of the keyspace reports nothing, which is the control", async () => {
      expect((await provider.describeObjects!(["0"], "keyspace")).truncated).toBeUndefined();
    });

    test("both bounds at once name both, and the limit reported is the caller's", async () => {
      scanOverflows = true;
      const batch = await provider.describeObjects!(["0"], "keyspace", 1);

      expect(batch.details.map((detail) => detail.path)).toEqual([["0", "bulk:*"]]);
      expect(batch.truncated).toEqual({
        limit: 1,
        reason:
          "the bulk column read was bounded at 1 object by its caller, and the key walk " +
          "stopped at the first 1,000 keys of one SCAN walk",
      });
    });

    test("a refused SCAN raises rather than answering an empty folder", async () => {
      scanRefusal = "NOPERM this user has no permissions to run the 'scan' command";
      await expect(provider.describeObjects!(["0"], "keyspace")).rejects.toThrow(/NOPERM/);
    });

    test("an undeclared kind is refused by the DECLARATION, naming the engine and the kind", async () => {
      await expect(provider.describeObjects!(["0"], "stream")).rejects.toThrow(
        /Redis declares no object kind "stream"/,
      );
    });

    test("a container path of the wrong shape is refused before anything is opened", async () => {
      await expect(provider.describeObjects!([], "keyspace")).rejects.toThrow(/\[database\]/);
      await expect(provider.describeObjects!(["main"], "keyspace")).rejects.toThrow(/"main"/);
    });

    test("a limit that is not a positive whole number is refused, never clamped", async () => {
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        await expect(provider.describeObjects!(["0"], "keyspace", limit)).rejects.toThrow(
          /bulk column read limit must be a positive whole number/,
        );
      }
      // Guard ORDER: the declaration first, then the container, then the limit.
      await expect(provider.describeObjects!(["0"], "stream", 0)).rejects.toThrow(/declares no object kind/);
      await expect(provider.describeObjects!([], "keyspace", 0)).rejects.toThrow(/\[database\]/);
    });

    /**
     * A declared kind with no enumerator behind it, on the fifth method.
     *
     * The bulk read must refuse the same way the listing does rather than answer the empty
     * batch a columnless kind gets: "this kind has no columns" and "this provider has no
     * command for this kind" are different facts, and only the second is a defect.
     */
    test("a declared kind with no command behind it is refused by name, not answered empty", async () => {
      const base = provider.getCapabilities();
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...base,
        objectKinds: [...(base.objectKinds ?? []), { id: "stream", role: "relation", label: "S", labelPlural: "S" }],
      });

      await expect(provider.describeObjects!(["0"], "stream")).rejects.toThrow(/has no command that lists it/);
    });

    /**
     * Standing ruling 5g on the fifth method: driven to the BOUND VALUE, the `db` the object
     * connection was opened on, and not to a refusal.
     */
    test("the bulk read follows a two-level declaration to the database it binds", async () => {
      const base = provider.getCapabilities();
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...base,
        containerLevels: [
          { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
          { id: "schema", label: "Database", labelPlural: "Databases" },
        ],
      });

      const batch = await provider.describeObjects!(["main", "3"], "keyspace");

      expect(batch.details.map((detail) => detail.path)).toEqual([["main", "3", "report:*"]]);
      expect(batch.details[0].columns.map((column) => column.name)).toEqual(["key", "value", "type"]);
      expect(capturedRedisOptions[capturedRedisOptions.length - 1].db).toBe(3);
    });

    // ------------------------------------------------------------------------
    // Object edit (#789 Phase 3)
    // ------------------------------------------------------------------------

    /**
     * The apply path, over the fixture's own pair of libraries.
     *
     * EVERY MEASUREMENT NAMED HERE WAS TAKEN ON redis 8.10.0, in container
     * `libredb-redis-t09` on host port 16379, created and removed for this task, holding
     * `docker/redis-init/01-object-fixture.redis` applied the way that file's own compose
     * comment says: `docker exec -i <container> redis-cli --no-raw < <the fixture>`.
     */
    describe("object edit (#789)", () => {
      /** The library the tests address, and the two libraries the server answers for it. */
      const LOWER_NAME = "libredb_probe";
      const UPPER_NAME = "LIBREDB_PROBE";

      const LIBRARY_LOWER = libraryEntry(LOWER_NAME, FIXTURE_LIBRARY_CODE, ["libredb_ping", "libredb_echo_key"]);
      const LIBRARY_UPPER = libraryEntry(UPPER_NAME, FIXTURE_UPPER_LIBRARY_CODE, ["LIBREDB_UPPER_PING"]);

      /**
       * The reader's edit: the fixture library with `'pong'` changed to `'PONG!'`, which is a
       * change to the BODY and not to the shebang, and it still registers both functions.
       */
      const EDITED = FIXTURE_LIBRARY_CODE.replace("return 'pong'", "return 'PONG!'");
      /** The same edit on the one-function library, which is the collateral's empty direction. */
      const EDITED_UPPER = FIXTURE_UPPER_LIBRARY_CODE.replace("return 'PONG'", "return 'PONG!!'");

      const request = (text: string, path: readonly string[] = ["0", LOWER_NAME]) => ({
        path,
        kind: "function",
        partId: "definition",
        text,
      });

      test("declares acceptsSourceEdits on the function library and NOT on the key pattern", () => {
        const kinds = provider.getCapabilities().objectKinds ?? [];
        expect(kinds.filter((kind) => kind.acceptsSourceEdits === true).map((kind) => kind.id)).toEqual(["function"]);
        // `keyspace` is a prefix grouping this server derived from a bounded SCAN and nobody wrote a
        // definition for it, so there is nothing to edit and no folder that could offer one.
        expect(kinds.filter((kind) => kind.acceptsSourceEdits !== true).map((kind) => kind.id)).toEqual(["keyspace"]);
      });

      test("every function part the reader is shown carries the edit affordance", async () => {
        const document = await provider.readObjectSource!(["0", LOWER_NAME], "function");
        const [part] = document.parts;
        if (isSourcePartUnavailable(part)) throw new Error("the fixture library is readable");

        expect(part.edit).toEqual({ offered: true });
      });

      /**
       * The affordance is read off the DECLARATION, and the FALSE arm is given a population.
       *
       * Nothing in the shipped declaration reaches it: `keyspace`, the one kind that does not
       * accept edits, is refused earlier by the `hasSource` guard, so the conditional's false
       * arm has no live producer and a mutation making the field unconditional survived the
       * suite at 179 pass 0 fail. The population is built the way the two standing-ruling-5g
       * tests build theirs, by spying a declaration in: a kind that HAS source and does NOT
       * accept edits, which is a shape a later phase can declare for real.
       *
       * The absent field and an `offered: false` are different facts and the pane's predicate
       * reads the difference, so this asserts absence with `toBeUndefined` and not falsiness.
       */
      test("a kind that declares source and NOT edits is read with no edit affordance at all", async () => {
        const base = provider.getCapabilities();
        spyOn(provider, "getCapabilities").mockReturnValue({
          ...base,
          objectKinds: (base.objectKinds ?? []).map((kind) =>
            kind.id === "function" ? { ...kind, acceptsSourceEdits: false } : kind,
          ),
        });

        const document = await provider.readObjectSource!(["0", LOWER_NAME], "function");
        const [part] = document.parts;
        if (isSourcePartUnavailable(part)) throw new Error("the fixture library is readable");

        expect(part.edit).toBeUndefined();
      });

      test("the build reads WITHCODE and selects the library BYTE FOR BYTE", async () => {
        // MEASURED: `LIBRARYNAME` is a CASE-INSENSITIVE glob over a CASE-SENSITIVE dictionary, so the
        // reply can hold more than one library and the selection is a byte comparison of
        // `library_name`. The fixture's coexisting `libredb_probe` and `LIBREDB_PROBE` are the proof.
        mockCall = async () => [LIBRARY_UPPER, LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);
        expect(build.preimage.text).toBe(LIBRARY_LOWER.library_code);
        expect(build.preimage.language).toBe("lua");
        expect(commandsSent()).toEqual(["FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE"]);
      });

      test("the unit is a COMMAND, and the payload is the reader's bytes verbatim", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);
        expect(build.plan.unit).toEqual({
          medium: "command",
          name: "FUNCTION",
          arguments: ["LOAD", "REPLACE"],
          payload: { text: EDITED, language: "lua", segments: [{ from: "user", start: 0, end: EDITED.length }] },
        });
        // There is no splice, so the coordinate arithmetic is the identity and a compile error's line
        // number is already the reader's own.
        expect(build.plan.strategy).toBe("replace-in-place-command");
        expect(build.plan.session).toEqual([]);
      });

      /**
       * The rest of the plan, which is what the route seals and the dialog renders.
       *
       * `connectionFingerprint` is recomputed here from the SAME connection the provider was
       * built with, which is the comparison the route makes: it recomputes from the connection
       * THAT request resolved and refuses a mismatch, so a provider that wrote a constant would
       * be caught by nothing else in this suite.
       */
      test("the plan carries the identity the route ENFORCES rather than trusts", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        expect(build.plan.planVersion).toBe(1);
        expect(build.plan.type).toBe("redis");
        expect(build.plan.path).toEqual(["0", LOWER_NAME]);
        expect(build.plan.kind).toBe("function");
        expect(build.plan.partId).toBe("definition");
        expect(build.plan.connectionFingerprint).toBe(await connectionFingerprint(baseConfig));
        expect(build.plan.planId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(Date.parse(build.plan.issuedAt)).not.toBeNaN();
        // Two plans for the same edit are two DIFFERENT edits, and the audit's correlation id is
        // this value: a planId that repeated would file two applies under one id.
        const second = await provider.buildObjectEdit!(request(EDITED));
        if (!second.built) throw new Error(second.refusal.sentence);
        expect(second.plan.planId).not.toBe(build.plan.planId);
      });

      /**
       * The content hash is SOUND on this engine and only on this engine, which is why the
       * `compared` arm carries a token here at all: MEASURED on 8.10.0, `FUNCTION LIST WITHCODE`
       * answers the bytes AS LOADED, with no reformatting of any kind, so two reads of an
       * unchanged library are byte-identical.
       */
      test("the revision is a content hash of the bytes the read answered", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        expect(build.plan.revision).toEqual({
          check: "compared",
          token: createHash("sha256").update(FIXTURE_LIBRARY_CODE).digest("hex"),
          basis: "FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE",
          scope: "server",
        });
      });

      test("the payload's segment map renders back to the payload's own bytes", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);
        if (build.plan.unit.medium !== "command") throw new Error("narrowing");

        const { payload } = build.plan.unit;
        expect(renderSegments(EDITED, payload.segments)).toBe(payload.text);
      });

      test("the SHEBANG is the identity, and a consistent rename is refused", async () => {
        // MEASURED on 8.10.0: a one-character typo in the shebang is refused loudly by the engine
        // itself (`ERR Function libredb_ping already exists`, because function names are global), but a
        // CONSISTENT rename of the library and its functions SUCCEEDS, the reply is the NEW library
        // name, and the original library is still there and still answering. That is the most natural
        // edit a person makes, and without this check the reader sees a success, the pane re-reads the
        // original address and shows the original text, and their edit has vanished.
        mockCall = async () => [LIBRARY_LOWER];
        const renamed = EDITED.replace("name=libredb_probe", "name=libredb_probe_v2");
        const build = await provider.buildObjectEdit!(request(renamed));
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("identity");
      });

      /**
       * The same refusal for a text with NO shebang at all, and the reason it is `identity`
       * rather than `definition`.
       *
       * MEASURED on 8.10.0, a body with no shebang is refused by the engine
       * (`ERR Missing library metadata`), so nothing is lost either way. It is refused HERE
       * because the question this check asks is "does this text name the object the plan is
       * addressed to", and a text that names no library does not name this one. Failing that
       * way round is the safe direction: the cost is a false refusal, never a false apply.
       */
      test("a text with no shebang names no library, so it names not this one", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED.split("\n").slice(1).join("\n")));
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("identity");
        expect(build.refusal.at).toEqual({ within: "none" });
        expect(build.refusal.sentence).toContain("#!lua name=libredb_probe");
      });

      /**
       * The CASE half of the same rule, which is the one a case-insensitive comparison passes.
       *
       * MEASURED: the dictionary is case-SENSITIVE and both libraries exist, so a text whose
       * shebang says `LIBREDB_PROBE` addressed at `libredb_probe` would REPLACE the other
       * library wholesale. MEASURED on 8.10.0 by doing exactly that: `FCALL LIBREDB_UPPER_PING`
       * then answered the new body's value while `libredb_probe` still answered `pong`.
       */
      test("a shebang differing only in CASE is a different library, and is refused", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(
          request(EDITED.replace("name=libredb_probe", "name=LIBREDB_PROBE")),
        );
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("identity");
      });

      test("THE COLLATERAL RUNS IN BOTH DIRECTIONS, over a fixture that holds one of each", async () => {
        // A collateral read that only runs when something already suspects a collateral is a guard
        // whose loop never sees the negative case, so `consequences: []` would never be produced and
        // the empty arm would be dead.
        mockCall = async () => [LIBRARY_LOWER];
        const two = await provider.buildObjectEdit!(request(EDITED));
        if (!two.built) throw new Error(two.refusal.sentence);
        expect(two.plan.consequences).toEqual([
          {
            loses: "replaces-whole-container",
            fact: { source: "FUNCTION LIST LIBRARYNAME libredb_probe", observed: "libredb_echo_key, libredb_ping" },
          },
        ]);

        // The EMPTY direction, and its population is a reply this parser could read a library out
        // of and NOT a functions list: MEASURED on Redis 8.10.0, `FUNCTION LOAD` over a body that
        // registers nothing answers `ERR No functions registered`, so a library the server holds
        // always registers at least one function and a live server cannot produce this arm.
        // A warning naming nothing is worse than no warning, so nothing is what it names (#789).
        mockCall = async () => [["library_name", LOWER_NAME, "engine", "LUA", "library_code", FIXTURE_LIBRARY_CODE]];
        const none = await provider.buildObjectEdit!(request(EDITED));
        if (!none.built) throw new Error(none.refusal.sentence);
        expect(none.plan.consequences).toEqual([]);
      });

      /**
       * D84, MEASURED LIVE and not against a double, which is what moved it from residual to
       * blocking (#789, discussion #778).
       *
       * Against a real Redis 8.10.0 in a container, a library `libredb_probe` registering exactly
       * `libredb_ping`, loaded again with `FUNCTION LOAD REPLACE` over a body registering
       * `libredb_other` instead: the load answered `libredb_probe`,
       * `FUNCTION LIST LIBRARYNAME libredb_probe` answered `libredb_other` alone, and
       * `FCALL libredb_ping 0` answered `ERR Function not found`. The function was gone.
       *
       * The same edit driven through this provider against that container answered
       * `plan.consequences: []` and then `applied-with-collateral` naming `libredb_ping` as lost,
       * so the build promised a loss could not happen and the apply reported one. Ruling 1b
       * amended forbids exactly that: a SUCCESS destroyed something the reader was never shown.
       *
       * The premise the old floor rested on, "a library registering exactly one function IS that
       * function, so a body that re-registers it loses nothing", is about the SUBMITTED text, and
       * nothing on this path reads the submitted text's registrations: the only identity check is
       * the shebang library name and no Lua parser is involved anywhere. The rename leaves the
       * shebang untouched.
       *
       * Cost, accepted: every edit of a single-function library now carries one warning and one
       * acknowledgement tick. The other direction, an apply that stops reporting the loss, would
       * need evidence the registration cannot move, and the measurement above is that evidence
       * pointing the other way.
       */
      test("a ONE-function library names that function, because the apply can lose it and does", async () => {
        mockCall = async () => [LIBRARY_UPPER];
        const one = await provider.buildObjectEdit!(request(EDITED_UPPER, ["0", UPPER_NAME]));
        if (!one.built) throw new Error(one.refusal.sentence);

        expect(one.plan.consequences).toEqual([
          {
            loses: "replaces-whole-container",
            fact: { source: `FUNCTION LIST LIBRARYNAME ${UPPER_NAME}`, observed: "LIBREDB_UPPER_PING" },
          },
        ]);
      });

      /**
       * CORE renders the sentence, and this engine is the only day-one producer of a
       * consequence, so this is the only place in the tree where the composition is driven by a
       * real one rather than by a literal.
       */
      test("core's sentence for that consequence reads the fact this provider measured", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        expect(describeConsequence(build.plan.consequences[0])).toBe(
          "Applying this replaces the whole container, so anything in it that your text does not " +
            "re-create is deleted. FUNCTION LIST LIBRARYNAME libredb_probe answers: libredb_echo_key, libredb_ping.",
        );
      });

      /**
       * The order the warning names its functions in is OURS and not the server's.
       *
       * MEASURED on 8.10.0: `FUNCTION LIST` answers the registered functions in an internal
       * order, and the fixture's own library comes back `libredb_ping` first. A warning built
       * from that order would change its wording between two identical reads of an unchanged
       * library, and a reader comparing two previews would see a difference that is not one.
       */
      test("the consequence's observed value is sorted, so two reads word it the same", async () => {
        mockCall = async () => [libraryEntry(LOWER_NAME, FIXTURE_LIBRARY_CODE, ["libredb_ping", "libredb_echo_key"])];
        const first = await provider.buildObjectEdit!(request(EDITED));
        mockCall = async () => [libraryEntry(LOWER_NAME, FIXTURE_LIBRARY_CODE, ["libredb_echo_key", "libredb_ping"])];
        const second = await provider.buildObjectEdit!(request(EDITED));
        if (!first.built || !second.built) throw new Error("both build");

        expect(first.plan.consequences).toEqual(second.plan.consequences);
      });

      test("a text identical to the server's bytes is refused rather than applied for nothing", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(FIXTURE_LIBRARY_CODE));
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("definition");
        expect(build.refusal.sentence).toContain("identical");
      });

      /**
       * A part the pane could only show TRUNCATED is never editable, and the population is the
       * fixture's own `libredb_bulk`.
       *
       * MEASURED on 8.10.0: `FUNCTION LOAD` ACCEPTS a library over the read bound, and
       * `FUNCTION LIST LIBRARYNAME libredb_bulk WITHCODE` reports a `library_code` of 1,000,243
       * characters for the one `docker/redis-init/01-object-fixture.redis` loads. Submitting the
       * bounded text back would delete the 243 characters past the bound and report success.
       */
      test("a definition over the read bound is refused, and the fixture holds one", async () => {
        const oversized = `#!lua name=libredb_bulk\n--[[${"-".repeat(1_000_100)}]]\nredis.register_function('libredb_bulk_ping', function() return 'bulk' end)`;
        expect(oversized.length).toBeGreaterThan(EDIT_CHARACTER_LIMIT);
        mockCall = async () => [libraryEntry("libredb_bulk", oversized, ["libredb_bulk_ping"])];

        const build = await provider.buildObjectEdit!(request(oversized.slice(0, 24), ["0", "libredb_bulk"]));
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("guard");
        expect(build.refusal.sentence).toContain(oversized.length.toLocaleString("en-US"));
      });

      test("a library the server does not hold RAISES, because an empty reply is absence", async () => {
        mockCall = async () => [];
        await expect(provider.buildObjectEdit!(request(EDITED, ["0", "no_such_library"]))).rejects.toThrow(
          /Redis holds no function library called "no_such_library"/,
        );
      });

      test("the entry guards refuse a kind, a part and a path shape, each by name", async () => {
        await expect(provider.buildObjectEdit!({ ...request(EDITED), kind: "stream" })).rejects.toThrow(
          /Redis declares no object kind "stream"/,
        );
        await expect(provider.buildObjectEdit!({ ...request(EDITED), kind: "keyspace" })).rejects.toThrow(
          /Redis does not apply an edited definition for the kind "keyspace"/,
        );
        await expect(provider.buildObjectEdit!({ ...request(EDITED), partId: "body" })).rejects.toThrow(
          /one source part, "definition", received "body"/,
        );
        await expect(provider.buildObjectEdit!(request(EDITED, []))).rejects.toThrow(/\[database, name\]/);
      });

      /**
       * Standing ruling 5g on the SIXTH method: a two-level declaration spied in, driven to the
       * BOUND VALUE rather than to a refusal.
       *
       * The library name is `path[path.length - 1]` and never `path[0]`. Both spellings are
       * behaviour-identical on this one-level engine, which is exactly why the wrong one keeps
       * surviving reviews, so the declaration is swapped and the command line is asserted.
       */
      test("the build follows a two-level declaration to the library name it binds", async () => {
        const base = provider.getCapabilities();
        spyOn(provider, "getCapabilities").mockReturnValue({
          ...base,
          containerLevels: [
            { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
            { id: "schema", label: "Database", labelPlural: "Databases" },
          ],
        });
        mockCall = async () => [LIBRARY_LOWER];

        const build = await provider.buildObjectEdit!(request(EDITED, ["main", "3", LOWER_NAME]));
        if (!build.built) throw new Error(build.refusal.sentence);

        expect(commandsSent()).toEqual(["FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE"]);
        expect(build.plan.path).toEqual(["main", "3", LOWER_NAME]);
        expect(build.plan.consequences[0].fact.source).toBe("FUNCTION LIST LIBRARYNAME libredb_probe");
      });

      // ----------------------------------------------------------------------
      // The apply
      // ----------------------------------------------------------------------

      /**
       * One apply, against a server whose function list CHANGES across the write.
       *
       * `before` is what the addressed library registered when the plan was built and when the
       * apply re-read it; `after` is what it registers once the load has landed; `reply` is what
       * `FUNCTION LOAD REPLACE` answered, which MEASURED on 8.10.0 is the library name the server
       * read out of the shebang.
       */
      const applyAgainst = async (options: {
        before: readonly string[];
        after: readonly string[];
        reply: string;
      }): Promise<ObjectEditOutcome> => {
        mockCall = async () => [libraryEntry(LOWER_NAME, FIXTURE_LIBRARY_CODE, options.before)];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        let lists = 0;
        mockCall = async (_command, ...args) => {
          if (args[0] === "LOAD") return options.reply;
          lists += 1;
          return lists === 1
            ? [libraryEntry(LOWER_NAME, FIXTURE_LIBRARY_CODE, options.before)]
            : [libraryEntry(LOWER_NAME, EDITED, options.after)];
        };
        capturedCalls.length = 0;
        return await provider.applyObjectEdit!(build.plan);
      };

      /** The same apply, with the LOAD rejecting the way the SERVER refuses. */
      const applyWithRedisError = async (message: string): Promise<ObjectEditOutcome> =>
        await applyWithLoadFailure(replyError(message));

      /** The same apply, with the LOAD rejecting the way a DROPPED SOCKET does. */
      const applyWithTransportFailure = async (error: unknown): Promise<ObjectEditOutcome> =>
        await applyWithLoadFailure(error);

      const applyWithLoadFailure = async (failure: unknown): Promise<ObjectEditOutcome> => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        mockCall = async (_command, ...args) => {
          if (args[0] === "LOAD") throw failure;
          return [LIBRARY_LOWER];
        };
        return await provider.applyObjectEdit!(build.plan);
      };

      test("a body that registers BOTH functions is `applied`", async () => {
        const outcome = await applyAgainst({
          before: ["libredb_echo_key", "libredb_ping"],
          after: ["libredb_echo_key", "libredb_ping"],
          reply: "libredb_probe",
        });
        expect(outcome.outcome).toBe("applied");
      });

      /**
       * The three round trips, in order, with the bytes the plan sealed.
       *
       * Asserted against the driver's own record rather than against the dispatcher the harness
       * routes on, which is standing ruling 5b: a fake that picks its reply by reading the
       * request cannot see a change to the request.
       */
      test("the apply sends the PLAN'S OWN unit, between a re-read and a re-read", async () => {
        await applyAgainst({ before: ["libredb_ping"], after: ["libredb_ping"], reply: "libredb_probe" });

        expect(commandsSent()).toEqual([
          "FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE",
          `FUNCTION LOAD REPLACE ${EDITED}`,
          "FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE",
        ]);
      });

      test("the applied outcome carries the NEW revision, never the one the plan came with", async () => {
        const outcome = await applyAgainst({
          before: ["libredb_ping"],
          after: ["libredb_ping"],
          reply: "libredb_probe",
        });
        if (outcome.outcome !== "applied") throw new Error("narrowing");

        expect(outcome.revision).toEqual({
          check: "compared",
          token: createHash("sha256").update(EDITED).digest("hex"),
          basis: "FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE",
          scope: "server",
        });
        expect(outcome.duration).toBeGreaterThanOrEqual(0);
      });

      test("a body that registers only ONE is `applied-with-collateral` naming what disappeared", async () => {
        // MEASURED: a body carrying only the edited function DELETED the sibling function and reported
        // success. `lost` is a catalog fact read AFTER the apply, never a restatement of the warning:
        // the plan said what WOULD be lost, this says what WAS. No Lua parser is involved anywhere,
        // because predicting registrations from the reader's text is the fragile version of this.
        const outcome = await applyAgainst({
          before: ["libredb_echo_key", "libredb_ping"],
          after: ["libredb_ping"],
          reply: "libredb_probe",
        });
        if (outcome.outcome !== "applied-with-collateral") throw new Error("narrowing");
        expect(outcome.lost).toEqual([
          {
            loses: "replaces-whole-container",
            fact: { source: "FUNCTION LIST LIBRARYNAME libredb_probe", observed: "libredb_echo_key" },
          },
        ]);
      });

      /**
       * RULING 1b's second axis, over the ONE population that broke it (D84, #789).
       *
       * The assertion is the AGREEMENT and not either side alone: every function the apply
       * reports as lost was named in the plan the reader approved. It is driven over a library
       * registering exactly ONE function whose registration MOVES, which is the case the build
       * used to answer `consequences: []` for while this apply answered a loss.
       *
       * MEASURED against a real Redis 8.10.0 container on 2026-09-14, this exact edit: the
       * registered function was replaced and `FCALL` on the old name answered
       * `ERR Function not found`. This test drives the same shapes through the double so the
       * measurement is re-runnable without a container.
       */
      test("every function the apply reports LOST was named in the plan, at ONE function", async () => {
        const before = ["libredb_ping"];
        const after = ["libredb_other"];
        mockCall = async () => [libraryEntry(LOWER_NAME, FIXTURE_LIBRARY_CODE, before)];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        let lists = 0;
        mockCall = async (_command, ...args) => {
          if (args[0] === "LOAD") return LOWER_NAME;
          lists += 1;
          return lists === 1
            ? [libraryEntry(LOWER_NAME, FIXTURE_LIBRARY_CODE, before)]
            : [libraryEntry(LOWER_NAME, EDITED, after)];
        };
        const outcome = await provider.applyObjectEdit!(build.plan);
        if (outcome.outcome !== "applied-with-collateral") throw new Error("narrowing");

        expect(outcome.lost).toEqual([
          {
            loses: "replaces-whole-container",
            fact: { source: "FUNCTION LIST LIBRARYNAME libredb_probe", observed: "libredb_ping" },
          },
        ]);
        // The agreement, read off the two values rather than asserted twice by literal: the
        // warned set is the library's whole registered set, so the lost set is inside it.
        const warned = build.plan.consequences.flatMap((consequence) => consequence.fact.observed.split(", "));
        const lost = outcome.lost.flatMap((entry) => entry.fact.observed.split(", "));
        expect(lost.length).toBeGreaterThan(0);
        expect(lost.filter((name) => !warned.includes(name))).toEqual([]);
      });

      test("a reply naming a DIFFERENT library is `applied-elsewhere` carrying the server's own reply", async () => {
        // The reply of FUNCTION LOAD REPLACE IS the library name the server read from the shebang,
        // MEASURED, so the provider compares it against the addressed name. It is a CONTROL rather than
        // the primary guard, because the shebang check already refused that text, and it is what
        // catches a shebang extraction bug.
        const outcome = await applyAgainst({
          before: ["libredb_ping"],
          after: ["libredb_ping"],
          reply: "libredb_probe_v2",
        });
        if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
        expect(outcome.undone).toBe(false);
        expect(outcome.wrote).toBe("libredb_probe_v2");
      });

      /**
       * The SAME control, over the population the fixture's library pair exists to build: a reply
       * differing from the addressed name ONLY IN CASE.
       *
       * MEASURED on 8.10.0, `libredb_probe` and `LIBREDB_PROBE` coexist as two distinct
       * libraries, and a body whose shebang said `name=LIBREDB_PROBE` loaded while addressed at
       * `libredb_probe` REPLACED `LIBREDB_PROBE` wholesale and left `libredb_probe` untouched.
       * So a case-insensitive comparison here would report `applied` for a write that landed on a
       * THIRD object the reader was never shown, file a fresh revision token for it, and leave
       * the pane re-reading the addressed library unchanged with the reader's edit nowhere.
       * The `_v2` case above differs by more than case and cannot see that mutation: a
       * case-insensitive compare survived the suite at 179 pass 0 fail without this test.
       */
      test("a reply differing from the addressed name ONLY IN CASE is `applied-elsewhere` too", async () => {
        const outcome = await applyAgainst({
          before: ["libredb_ping"],
          after: ["libredb_ping"],
          reply: UPPER_NAME,
        });
        if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
        expect(outcome.undone).toBe(false);
        expect(outcome.wrote).toBe(UPPER_NAME);
      });

      test("a read-only replica maps to PRIVILEGE, because the reader's action is the same", async () => {
        // `READONLY You can't write against a read only replica.` The reader's next action is to use a
        // different connection, which is exactly what a privilege refusal tells them.
        const outcome = await applyWithRedisError("READONLY You can't write against a read only replica.");
        if (outcome.outcome !== "refused") throw new Error("narrowing");
        expect(outcome.refusal.refusal).toBe("privilege");
      });

      /**
       * The ACL refusal, which is the same reader action and the fixture's own user.
       *
       * MEASURED on 8.10.0 against `libredb_nofunction`, the user
       * `docker/redis-init/01-object-fixture.redis` creates with `-function`:
       * `NOPERM User libredb_nofunction has no permissions to run the 'function|load' command`.
       */
      test("an ACL refusal maps to PRIVILEGE too, and carries the server's own sentence", async () => {
        const outcome = await applyWithRedisError(
          "NOPERM User libredb_nofunction has no permissions to run the 'function|load' command",
        );
        if (outcome.outcome !== "refused") throw new Error("narrowing");
        expect(outcome.refusal.refusal).toBe("privilege");
        expect(outcome.refusal.sentence).toBe(
          "NOPERM User libredb_nofunction has no permissions to run the 'function|load' command",
        );
        expect(outcome.refusal.at).toEqual({ within: "none" });
      });

      test("a compile error's line number is already the READER's, because there is no splice", async () => {
        const outcome = await applyWithRedisError(
          "ERR Error compiling function: user_function:4: unexpected symbol near 'retur'",
        );
        if (outcome.outcome !== "refused") throw new Error("narrowing");
        expect(outcome.refusal.refusal).toBe("definition");
        expect(outcome.refusal.at).toEqual({ within: "user", line: 4, column: 1 });
      });

      /**
       * The control on the arithmetic above, and it is the one that makes the identity claim
       * mean something: the line the engine names is converted THROUGH core's coordinate map,
       * so a line past the end of the reader's text is `outside` rather than a number Monaco
       * would silently clamp.
       */
      test("a line number past the end of the reader's text is OUTSIDE, never clamped", async () => {
        const outcome = await applyWithRedisError(
          "ERR Error compiling function: user_function:400: unexpected symbol near 'retur'",
        );
        if (outcome.outcome !== "refused") throw new Error("narrowing");
        expect(outcome.refusal.at).toEqual({ within: "outside" });
      });

      /**
       * The three other refusal shapes 8.10.0 answered, all `definition`, all with no
       * coordinate, and the object intact after every one of them.
       */
      /**
       * The population where the coordinate map is not the identity, and it is MEASURED.
       *
       * A body ending with a trailing newline gets an error on the PHANTOM line after the last
       * one: measured on 8.10.0, `#!lua name=libredb_probe\nlocal function ping(keys, args)\n`
       * answered
       * `ERR Error compiling function: user_function:3: 'end' expected (to close 'function' at
       * line 2) near '<eof>'`, and the same text without the trailing newline answered
       * `user_function:2`. Line 3 is not a line of the reader's text, so a provider returning the
       * engine's number would hand Monaco a coordinate it CLAMPS in silence. Core's map answers
       * `outside`, which the dialog renders as a sentence.
       */
      test("a line the reader's text does not have is OUTSIDE, and a trailing newline makes one", async () => {
        const unterminated = "#!lua name=libredb_probe\nlocal function ping(keys, args)\n";
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(unterminated));
        if (!build.built) throw new Error(build.refusal.sentence);

        mockCall = async (_command, ...args) => {
          if (args[0] === "LOAD") {
            throw replyError(
              "ERR Error compiling function: user_function:3: 'end' expected (to close 'function' at line 2) near '<eof>'",
            );
          }
          return [LIBRARY_LOWER];
        };
        const outcome = await provider.applyObjectEdit!(build.plan);
        if (outcome.outcome !== "refused") throw new Error("narrowing");
        expect(outcome.refusal.at).toEqual({ within: "outside" });

        // The CONTROL, the same body with the newline taken off, where the engine's own number is
        // a line the reader has and the answer is that line.
        mockCall = async () => [LIBRARY_LOWER];
        const shorter = await provider.buildObjectEdit!(request(unterminated.trimEnd()));
        if (!shorter.built) throw new Error(shorter.refusal.sentence);
        mockCall = async (_command, ...args) => {
          if (args[0] === "LOAD") {
            throw replyError("ERR Error compiling function: user_function:2: 'end' expected near '<eof>'");
          }
          return [LIBRARY_LOWER];
        };
        const control = await provider.applyObjectEdit!(shorter.plan);
        if (control.outcome !== "refused") throw new Error("narrowing");
        expect(control.refusal.at).toEqual({ within: "user", line: 2, column: 1 });
      });

      /**
       * Ruling 1a over the WHOLE unit and not only the payload: the apply sends the verb and the
       * literal arguments the PLAN carries, and does not rebuild the command line from constants
       * of its own.
       *
       * The plan is tampered with by hand, which through the product the route's seal makes
       * impossible, and that is the point: the binding between the preview and the write has to
       * be a property of this method rather than of the two agreeing by coincidence today.
       */
      test("the command line is the PLAN'S, verb and arguments included", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);
        if (build.plan.unit.medium !== "command") throw new Error("narrowing");

        mockCall = async (_command, ...args) => (args[0] === "LOAD" ? LOWER_NAME : [LIBRARY_LOWER]);
        capturedCalls.length = 0;
        await provider.applyObjectEdit!({
          ...build.plan,
          unit: { ...build.plan.unit, arguments: ["LOAD"] },
        });

        expect(commandsSent()[1]).toBe(`FUNCTION LOAD ${EDITED}`);
      });

      test("the engine's other refusals are `definition` with the engine's own words", async () => {
        for (const sentence of [
          "ERR No functions registered",
          "ERR Missing library metadata",
          "ERR Engine 'moon' not found",
          "ERR Function libredb_ping already exists",
        ]) {
          const outcome = await applyWithRedisError(sentence);
          if (outcome.outcome !== "refused") throw new Error("narrowing");
          expect(outcome.refusal.refusal).toBe("definition");
          expect(outcome.refusal.sentence).toBe(sentence);
          expect(outcome.refusal.at).toEqual({ within: "none" });
        }
      });

      test("a TRANSPORT failure is INTERRUPTED and never a refusal", async () => {
        // `isServerErrorReply` is what tells the two apart, and the distinction is the same one
        // `readObjectSource` already makes: nobody answering is not the server answering no.
        const outcome = await applyWithTransportFailure(new Error("Connection is closed."));
        if (outcome.outcome !== "interrupted") throw new Error("narrowing");
        expect(outcome.committed).toBe("unknown");
        expect(outcome.sentence).toBe("Connection is closed.");
      });

      /**
       * H3's lost update, with the diff it requires.
       *
       * The window is NARROWED and not closed, and this is the read that narrows it: it is the
       * apply's FIRST round trip, so nothing this design does sits between the comparison and
       * the write. Another session can still get in, which is what `compared` says out loud.
       */
      test("a library that moved between the read and the write is a CONFLICT, and nothing is sent", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        const moved = `${FIXTURE_LIBRARY_CODE}\n-- somebody else got here first`;
        mockCall = async () => [libraryEntry(LOWER_NAME, moved, ["libredb_ping"])];
        capturedCalls.length = 0;
        const outcome = await provider.applyObjectEdit!(build.plan);

        if (outcome.outcome !== "conflict" || outcome.conflict !== "object-changed") throw new Error("narrowing");
        expect(outcome.current).toEqual({ text: moved, language: "lua" });
        expect(commandsSent()).toEqual(["FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE"]);
      });

      test("a library DELETED between the read and the write conflicts with the empty text", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        mockCall = async () => [];
        const outcome = await provider.applyObjectEdit!(build.plan);
        if (outcome.outcome !== "conflict" || outcome.conflict !== "object-changed") throw new Error("narrowing");
        expect(outcome.current.text).toBe("");
      });

      /**
       * H3 keeps its three states apart, and an `unavailable` revision is not one of them.
       *
       * A plan whose revision says "this provider could not produce a token" says nothing at all
       * about whether the object moved, so answering `conflict` / `object-changed` for it asserts
       * a fact this method's read did not observe, which is exactly the collapse H3 forbids. This
       * provider issues `compared` on every plan it builds and the route seals plans, so the only
       * way to hold such a plan is to have built it somewhere else: it raises, for the same
       * reason and in the same shape as the statement-unit arm below.
       */
      test("a plan carrying an UNAVAILABLE revision is not one this provider issued, and it raises", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        capturedCalls.length = 0;
        await expect(
          provider.applyObjectEdit!({
            ...build.plan,
            revision: { check: "unavailable", reason: "this provider publishes no revision" },
          }),
        ).rejects.toThrow(/carries a compared revision, received "unavailable"/);
        // It raises BEFORE the write and before the re-read, so a foreign plan costs no round
        // trip and cannot half-apply.
        expect(commandsSent()).toEqual([]);
      });

      test("a plan carrying a STATEMENT unit is not one this provider issued, and it raises", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        await expect(
          provider.applyObjectEdit!({
            ...build.plan,
            unit: {
              medium: "statement",
              steps: [{ text: "SELECT 1", language: "sql", segments: [{ from: "provider", text: "SELECT 1" }] }],
            },
          }),
        ).rejects.toThrow(/carries a command unit, received a statement/);
      });

      test("the apply re-resolves the kind on the DECLARATION, and refuses one it will not write", async () => {
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED));
        if (!build.built) throw new Error(build.refusal.sentence);

        await expect(provider.applyObjectEdit!({ ...build.plan, kind: "keyspace" })).rejects.toThrow(
          /Redis does not apply an edited definition for the kind "keyspace"/,
        );
      });

      /**
       * Standing ruling 5g on the apply as well, because the apply addresses the library by the
       * same rule and a plan carries the whole path.
       */
      test("the apply follows a two-level declaration to the library name it binds", async () => {
        const base = provider.getCapabilities();
        spyOn(provider, "getCapabilities").mockReturnValue({
          ...base,
          containerLevels: [
            { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
            { id: "schema", label: "Database", labelPlural: "Databases" },
          ],
        });
        mockCall = async () => [LIBRARY_LOWER];
        const build = await provider.buildObjectEdit!(request(EDITED, ["main", "3", LOWER_NAME]));
        if (!build.built) throw new Error(build.refusal.sentence);

        let lists = 0;
        mockCall = async (_command, ...args) => {
          if (args[0] === "LOAD") return LOWER_NAME;
          lists += 1;
          return lists === 1 ? [LIBRARY_LOWER] : [libraryEntry(LOWER_NAME, EDITED, ["libredb_ping"])];
        };
        capturedCalls.length = 0;
        const outcome = await provider.applyObjectEdit!(build.plan);

        expect(outcome.outcome).toBe("applied-with-collateral");
        expect(commandsSent()[0]).toBe("FUNCTION LIST LIBRARYNAME libredb_probe WITHCODE");
      });
    });
  });
});

/**
 * Every module-private function in this provider carries its OWN doc comment (#789).
 *
 * A guard and not a review note, because the defect it catches is invisible to both linters
 * this repository runs. A new function inserted BETWEEN an existing docblock and the function
 * that block documents leaves the original function undocumented and silently re-attributes
 * the measurement to a different function. Neither Biome nor oxlint nor ESLint reads comment
 * adjacency at all, and it happened here: `isServerErrorReply` landed between
 * `parseFunctionLibraryCode`'s block and `parseFunctionLibraryCode`.
 *
 * Measured with the TypeScript compiler API rather than by reading the text, because the
 * compiler resolves a block to the declaration it ACTUALLY attaches to, which is the whole
 * question. `ts.getJSDocCommentsAndTags` over the real file on disk, the same mechanism the
 * seven provider seam guards under `tests/unit/db` use.
 *
 * The blocks in this file are the only record of why the library selection is byte-equal and
 * why a reply's pairs are walked rather than indexed, and this is the reference implementation
 * fifteen provider tasks copy.
 */
describe("the Redis provider's own doc comments", () => {
  const FILE = join(import.meta.dir, "..", "..", "..", "src", "lib", "db", "providers", "keyvalue", "redis.ts");
  const source = ts.createSourceFile(FILE, readFileSync(FILE, "utf8"), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(ts.isFunctionDeclaration);
  const blocksOf = (declaration: ts.FunctionDeclaration) => ts.getJSDocCommentsAndTags(declaration).filter(ts.isJSDoc);

  test("no module-private function is left undocumented by a block that moved on to another", () => {
    // Non-vacuity first: a guard over an empty enumeration passes forever, and this one reads
    // a file it does not own the shape of.
    const names = functions.map((declaration) => declaration.name?.text);
    expect(names).toContain("parseFunctionLibraryCode");
    expect(names).toContain("isServerErrorReply");
    expect(functions.length).toBeGreaterThan(5);

    const undocumented = functions
      .filter((declaration) => blocksOf(declaration).length === 0)
      .map((declaration) => declaration.name?.text ?? "<anonymous>");
    expect(undocumented).toEqual([]);
  });

  test("the byte-equal selection rule is attached to the function that implements it", () => {
    // The block names a rule about ONE function's behaviour, so it is worth nothing on any
    // other: a reader asking why `reply[0]` is wrong for a WITHCODE reply finds it here or
    // nowhere.
    const declaration = functions.find((entry) => entry.name?.text === "parseFunctionLibraryCode");
    if (declaration === undefined) throw new Error("parseFunctionLibraryCode is gone from the provider");

    const documented = blocksOf(declaration)
      .map((block) => block.getText(source))
      .join("\n");

    expect(documented).toContain("BYTE-EQUAL");
    expect(documented).toContain("01-object-fixture.redis");
  });
});
