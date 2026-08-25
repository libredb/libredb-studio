/**
 * Redis Provider Integration Tests
 *
 * Uses mock.module() from bun:test to mock the 'ioredis' driver
 * before importing the RedisProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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

const MOCK_CLIENT_LIST =
  "id=1 addr=127.0.0.1:6379 name=app1 db=0 flags=N cmd=get idle=5\nid=2 addr=127.0.0.1:6380 name=app2 db=0 flags=N cmd=set idle=10";

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
 * Every options object the provider handed the `Redis` constructor. The TLS
 * selection is observable nowhere else: ioredis takes it at construction time and
 * never exposes it again.
 */
const capturedRedisOptions: Record<string, unknown>[] = [];

mock.module("ioredis", () => {
  class MockRedis {
    private _config: unknown;

    constructor(config?: unknown) {
      this._config = config;
      capturedRedisOptions.push((config ?? {}) as Record<string, unknown>);
    }

    async connect() {
      // noop — connection established
    }

    disconnect() {
      // noop — connection closed
    }

    async info() {
      return MOCK_INFO_STRING;
    }

    async dbsize() {
      return 42;
    }

    async scan(): Promise<[string, string[]]> {
      return ["0", ["user:1", "user:2", "session:abc"]];
    }

    async type() {
      return "string";
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
      // MULTI/EXEC exists in Redis and is not exposed through this provider (#U13).
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

    test("the generated Scan Keys command runs against this provider (#427)", async () => {
      const schema = await provider.getSchema();
      const generated = generateTableQuery(schema[0].name, provider.getCapabilities(), schema[0].columns);
      const result = await provider.query(generated);
      expect(result.rows).toBeArray();
    });

    test("every command line the cheatsheet generates is accepted (#427)", async () => {
      for (const sample of ["string", "hash", "list", "set", "zset"]) {
        const columns = [
          { name: "key", type: "string", nullable: false, isPrimary: true },
          { name: "value", type: sample, nullable: true, isPrimary: false },
          { name: "type", type: sample, nullable: false, isPrimary: false },
        ];
        const out = generateSelectQuery("user:*", columns, provider.getCapabilities());
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
        generateSelectQuery('say"hi"', KEY_COLUMNS("string"), provider.getCapabilities()),
      );
      for (const call of calls) {
        expect(call.args[0]).toBe('say"hi"');
      }
      expect(calls.map((c) => c.command)).toContain("DEL");
    });

    test("a key containing a single quote reaches the driver unmangled (#427)", async () => {
      const calls = await runGeneratedLines(
        generateSelectQuery("it's", KEY_COLUMNS("hash"), provider.getCapabilities()),
      );
      for (const call of calls) {
        expect(call.args[0]).toBe("it's");
      }
    });

    test("a quoted prefix group SCANs the pattern it meant to (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery('a"b:*', provider.getCapabilities(), KEY_COLUMNS("string")),
      );
      expect(calls).toEqual([{ command: "SCAN", args: ["0", "MATCH", 'a"b:*', "COUNT", "50"] }]);
    });

    test("a key containing whitespace still round-trips in plain form (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery("my key", provider.getCapabilities(), KEY_COLUMNS("string")),
      );
      expect(calls).toEqual([{ command: "GET", args: ["my key"] }]);
    });

    test("an ordinary key still round-trips in plain form (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery("user:1", provider.getCapabilities(), KEY_COLUMNS("zset")),
      );
      expect(calls).toEqual([{ command: "ZRANGE", args: ["user:1", "0", "-1", "WITHSCORES"] }]);
    });

    test("a glob-escaped prefix reaches the driver with its backslash intact (#427)", async () => {
      const calls = await runGeneratedLines(
        generateTableQuery("a[b:*", provider.getCapabilities(), KEY_COLUMNS("string")),
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
      await provider.query(generateSelectQuery("user:*", KEY_COLUMNS("string"), provider.getCapabilities()));
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
      const calls = await runWholeBuffer(generateSelectQuery(name, KEY_COLUMNS("string"), provider.getCapabilities()));
      expect(calls).toEqual([{ command: "TYPE", args: [name] }]);
    });

    test("a node name containing CRLF cannot inject a command (#427)", async () => {
      const name = "a\r\nDEL user:1 x";
      const calls = await runWholeBuffer(generateSelectQuery(name, KEY_COLUMNS("string"), provider.getCapabilities()));
      expect(calls).toEqual([{ command: "TYPE", args: [name] }]);
    });

    test("a node name containing a newline and a quote cannot inject a command (#427)", async () => {
      const name = 'a\nDEL "user:1" x';
      const calls = await runWholeBuffer(generateSelectQuery(name, KEY_COLUMNS("hash"), provider.getCapabilities()));
      expect(calls).toEqual([{ command: "TYPE", args: [name] }]);
    });

    test("a newline-bearing prefix group still SCANs its own pattern (#427)", async () => {
      const calls = await runWholeBuffer(
        generateSelectQuery("a\nDEL user:1 x:*", KEY_COLUMNS("string"), provider.getCapabilities()),
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
        const buffer = generateSelectQuery(node, KEY_COLUMNS(sample), provider.getCapabilities());
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

    test("returns key patterns as tables from SCAN", async () => {
      const schemas = await provider.getSchema();
      expect(schemas).toBeArray();
      expect(schemas.length).toBeGreaterThan(0);

      // user:1 and user:2 -> "user:*" pattern; session:abc -> "session:*"
      const userPattern = schemas.find((s) => s.name === "user:*");
      expect(userPattern).toBeDefined();
      expect(userPattern!.rowCount).toBe(2);

      const sessionPattern = schemas.find((s) => s.name === "session:*");
      expect(sessionPattern).toBeDefined();
      expect(sessionPattern!.rowCount).toBe(1);

      // Columns should include key, value, type
      expect(userPattern!.columns.length).toBe(3);
      expect(userPattern!.columns[0].name).toBe("key");
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
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(typeof overview.tableCount).toBe("number");
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
});
