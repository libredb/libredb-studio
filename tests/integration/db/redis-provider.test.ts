/**
 * Redis Provider Integration Tests
 *
 * Uses mock.module() from bun:test to mock the 'ioredis' driver
 * before importing the RedisProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import type { DatabaseConnection } from "@/lib/types";
import { generateTableQuery, generateSelectQuery } from "@/lib/query-generators";

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
];

/**
 * What `FUNCTION LIST` answers, reset to `MOCK_FUNCTION_LIST` before each object-surface
 * test. A test REORDERS the fields to prove the parser reads `library_name` by its key: the
 * shipped mock carries the order redis 8.10.0 answered in, and a parser taking `entry[1]`
 * is indistinguishable from a correct one for as long as that order is the only one tested.
 */
let functionListReply: unknown[] = MOCK_FUNCTION_LIST;

/**
 * When set, `FUNCTION LIST` rejects with this sentence. Three of the four Redis-wire
 * relatives do exactly that and each says it differently (all measured 2026-09-11):
 * KeyDB 6.3.4 "ERR unknown command `FUNCTION`, with args beginning with: `LIST`, ",
 * DragonflyDB df-v1.40.1 "ERR Unknown subcommand or wrong number of arguments for 'LIST'.
 * Try FUNCTION HELP." and Garnet 2.1.5 "ERR unknown command".
 */
let functionRefusal: string | null = null;

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
      if (cmd === "CONFIG") return databasesReply;
      if (cmd === "FUNCTION") {
        if (functionRefusal !== null) throw new Error(functionRefusal);
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
      functionRefusal = null;
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
        kinds: { keyspace: 2, function: 1 },
        sampleObject: { path: ["0", "user:*"], kind: "keyspace" },
      });
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

      expect(counts).toEqual({ keyspace: { count: 2 }, function: { count: 1 } });
      expect(commandsSent()).toContain("FUNCTION LIST");
    });

    test("an empty database counts zero rather than losing its folders", async () => {
      const counts = await provider.countObjects(["7"]);
      expect(counts).toEqual({ keyspace: { count: 0 }, function: { count: 1 } });
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
        function: { count: 1 },
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
        function: { count: 1 },
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

      expect(objects).toEqual([{ path: ["0", "libredb_probe"], name: "libredb_probe", kind: "function" }]);
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
  });
});
