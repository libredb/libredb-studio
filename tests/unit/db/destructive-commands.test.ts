import { afterEach, describe, test, expect } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import {
  NON_SQL_DESTRUCTIVE_VOCABULARY,
  isDestructiveNonSqlQuery,
  vocabularyDecidesAlone,
  vocabularySendsToModel,
  vocabularyTypedConfirmation,
} from "@/lib/db/destructive-commands";
import { etcdTypedConfirmation } from "@/lib/db/providers/keyvalue/etcd/guard";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import { readsSqlText } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";
import { installStandInVocabulary, STAND_IN_TYPE } from "../../helpers/stand-in-vocabulary";

// The facts behind the confirmation gate for the engines whose query text is not
// SQL. The gate itself (`isDangerousQuery`) is tested in
// tests/components/QuerySafetyDialog.test.tsx; this file pins the vocabulary and the
// readers it is driven from, because they are what decides whether an operator is
// asked before a FLUSHALL or a deleteMany runs.

describe("isDestructiveNonSqlQuery", () => {
  // ── The table decides which types this reader answers about ───────────────

  test.each<["postgres" | "mysql" | "clickhouse" | "couchbase"]>([
    ["postgres"],
    ["mysql"],
    ["clickhouse"],
    ["couchbase"],
  ])("answers false for %s, whose text a SQL reader reads", (type) => {
    // Not "safe": these types have no row in the table, because their statements are
    // read by the SQL half of the gate. A row here would be a second, weaker opinion.
    expect(isDestructiveNonSqlQuery("DROP TABLE users", type)).toBe(false);
  });

  test("answers false with no type at all", () => {
    expect(isDestructiveNonSqlQuery("FLUSHALL")).toBe(false);
  });

  // ── MongoDB ──────────────────────────────────────────────────────────────

  test.each<[string, string]>([
    ["deleteMany", '{"collection":"users","operation":"deleteMany","filter":{}}'],
    ["deleteOne", '{"collection":"users","operation":"deleteOne","filter":{"_id":1}}'],
    ["updateMany", '{"collection":"users","operation":"updateMany","filter":{},"update":{"$unset":{"email":""}}}'],
    ["updateOne", '{"collection":"users","operation":"updateOne","filter":{"_id":1},"update":{"$set":{"a":1}}}'],
  ])("asks before a MongoDB %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "mongodb")).toBe(true);
  });

  test.each<[string, string]>([
    ["find", '{"collection":"users","operation":"find","filter":{"age":{"$gt":18}}}'],
    ["findOne", '{"collection":"users","operation":"findOne","filter":{}}'],
    ["count", '{"collection":"users","operation":"count","filter":{}}'],
    ["distinct", '{"collection":"products","operation":"distinct","field":"category"}'],
    ["insertOne", '{"collection":"users","operation":"insertOne","documents":[{"name":"J"}]}'],
    ["insertMany", '{"collection":"users","operation":"insertMany","documents":[{"name":"J"}]}'],
    ["aggregate", '{"collection":"orders","operation":"aggregate","pipeline":[{"$group":{"_id":"$status"}}]}'],
  ])("does not ask before a MongoDB %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "mongodb")).toBe(false);
  });

  test.each<[string, string]>([
    ["$out", '{"collection":"orders","operation":"aggregate","pipeline":[{"$match":{}},{"$out":"orders_copy"}]}'],
    [
      "$merge",
      '{"collection":"orders","operation":"aggregate","pipeline":[{"$merge":{"into":"totals","whenMatched":"replace"}}]}',
    ],
  ])("asks before an aggregate whose pipeline carries %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "mongodb")).toBe(true);
  });

  test.each<[string, string]>([
    ["a pipeline that is not an array", '{"collection":"o","operation":"aggregate","pipeline":{"$out":"x"}}'],
    ["a stage that is not an object", '{"collection":"o","operation":"aggregate","pipeline":[1,null,"$out"]}'],
    ["no pipeline at all", '{"collection":"o","operation":"aggregate"}'],
  ])("does not ask for an aggregate with %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "mongodb")).toBe(false);
  });

  test.each<[string, string]>([
    ["a document that never closes", '{"collection":"users","operation":"deleteMany"'],
    ["a trailing comma", '{"operation":"find",}'],
    ["mongosh shell syntax", "db.users.deleteMany({})"],
    ["a bare word", "deleteMany"],
    ["a JSON array", '[{"operation":"find"}]'],
    ["a JSON null", "null"],
    ["a JSON number", "5"],
    ["an operation that is not a string", '{"collection":"users","operation":7}'],
    ["no operation key", '{"collection":"users"}'],
  ])("asks when the payload cannot be read as a command document: %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "mongodb")).toBe(true);
  });

  test.each<[string, string]>([
    ["nothing", ""],
    ["whitespace", "  \n "],
  ])("does not ask for %s, which is not a command", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "mongodb")).toBe(false);
  });

  test("matches the operation spelling the provider dispatches on", () => {
    // `SUPPORTED_OPERATIONS` is checked case-sensitively, so `DELETEMANY` is refused
    // before any collection is touched: prompting for it would be a prompt about text
    // that cannot run.
    expect(isDestructiveNonSqlQuery('{"collection":"users","operation":"DELETEMANY"}', "mongodb")).toBe(false);
  });

  // ── Redis ────────────────────────────────────────────────────────────────

  test.each<[string]>([
    ["FLUSHALL"],
    ["FLUSHDB"],
    ["DEL session:1"],
    ["UNLINK session:1"],
    ["RENAME a b"],
    ["SET k v"],
    ["GETDEL k"],
    ["HDEL h f"],
    ["LPOP list"],
    ["LTRIM list 0 0"],
    ["SREM s member"],
    ["ZREM z member"],
    ["XTRIM stream MAXLEN 0"],
    ["XGROUP DELCONSUMER stream g c"],
    ["SETBIT k 7 1"],
    ["CLUSTER SETSLOT 42 NODE abc"],
    ["EXPIRE k 1"],
    ["SINTERSTORE dest a b"],
    ["SHUTDOWN NOSAVE"],
  ])("asks before the Redis command %s", (query) => {
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(true);
  });

  test.each<[string]>([
    ["BLPOP queue 0"],
    ["BRPOP queue 0"],
    ["BLMPOP 2 2 queue LEFT COUNT 1"],
    ["BLMOVE src dst LEFT RIGHT 0"],
    ["BRPOPLPUSH src dst 0"],
    ["BZPOPMIN z 0"],
    ["BZPOPMAX z 0"],
    ["BZMPOP 2 1 z MIN COUNT 1"],
  ])("does not ask before the Redis command %s, which the provider refuses before it reaches the server", (query) => {
    // Since #1121 `RedisProvider.query()` refuses the blocking commands through
    // `sharedConnectionRefusal`, so a confirmation followed by a refusal is the
    // double take this gate exists to avoid. The dialog is for commands that run.
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(false);
  });

  test.each<[string]>([
    ["LPOP queue"],
    ["RPOP queue"],
    ["LMPOP 1 queue LEFT COUNT 1"],
    ["LMOVE src dst LEFT RIGHT"],
    ["RPOPLPUSH src dst"],
    ["ZPOPMIN z"],
    ["ZPOPMAX z"],
    ["ZMPOP 1 z MIN COUNT 1"],
  ])("still asks before %s, the non-blocking form of a refused command", (query) => {
    // The provider runs these, and each one removes what it returns.
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(true);
  });

  test.each<[string]>([
    ["GET k"],
    ["HGETALL user:1"],
    ["SCAN 0 MATCH session:* COUNT 50"],
    ["INFO"],
    ["TTL k"],
    ["EXISTS k"],
    ["SETNX k v"],
    ["LRANGE list 0 -1"],
    ["GETBIT k 7"],
    ["GETRANGE k 0 -1"],
    ["CLUSTER SLOTS"],
    ["XINFO STREAM stream"],
  ])("does not ask before the Redis command %s", (query) => {
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(false);
  });

  test.each<[string, string]>([
    ["the STORE option of SORT", "SORT mylist STORE dest"],
    ["a BITFIELD SET sub-operation", "BITFIELD k SET u8 0 255"],
    ["GETEX with an expiry option", "GETEX k EX 60"],
  ])("does not ask for %s, an argument position this reading does not inspect", (_label, query) => {
    // A named gap, not an oversight: the option sits past the two tokens this reader
    // looks at, and the same command without it is a plain read. Pinned here so that
    // closing it is a deliberate change rather than a silent one.
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(false);
  });

  test("does not ask for a plain GETEX, which is byte-for-byte a GET", () => {
    expect(isDestructiveNonSqlQuery("GETEX k", "redis")).toBe(false);
  });

  test("reads the command name the way the provider does: case-folded", () => {
    // Both parsers uppercase the command before `client.call`, so a lowercase
    // `del` reaches the server as DEL.
    expect(isDestructiveNonSqlQuery("del session:1", "redis")).toBe(true);
    expect(isDestructiveNonSqlQuery("FlushAll", "redis")).toBe(true);
  });

  test("reads a quoted first token the way the plain tokenizer does", () => {
    expect(isDestructiveNonSqlQuery('"DEL" session:1', "redis")).toBe(true);
  });

  test.each<[string, string]>([
    ["a container command whose subcommand writes", "CONFIG SET maxmemory 0"],
    ["a lowercase subcommand", "acl deluser reader"],
    ["a script flush", "SCRIPT FLUSH"],
  ])("asks for %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(true);
  });

  test.each<[string, string]>([
    ["the same container reading", "CONFIG GET maxmemory"],
    ["an ACL read", "ACL LIST"],
    ["a script load", 'SCRIPT LOAD "return 1"'],
  ])("does not ask for %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(false);
  });

  test.each<[string, string, boolean]>([
    ["the JSON command form", '{"command":"DEL","args":["session:1"]}', true],
    ["the JSON read form", '{"command":"GET","args":["session:1"]}', false],
    ["a pretty-printed JSON command", '{\n  "command": "FLUSHALL"\n}', true],
    ["a JSON container command", '{"command":"CONFIG","args":["SET","maxmemory","0"]}', true],
    ["a JSON container reading", '{"command":"CONFIG","args":["GET","maxmemory"]}', false],
    ["a JSON command with a non-string first arg", '{"command":"DEL","args":[7]}', true],
  ])("answers %s with %p", (_label, query, expected) => {
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(expected);
  });

  test.each<[string, string]>([
    ["a document that never closes", '{"command":"GET","args":["k"]'],
    ["a command that is not a string", '{"command":7}'],
    ["no command key at all", '{"args":["k"]}'],
  ])("asks when a JSON Redis payload cannot be read: %s", (_label, query) => {
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(true);
  });

  test.each<[string, string, boolean]>([
    ["a comment above the command", "# nightly\nFLUSHALL", true],
    ["a comment above a read", "# nightly\nGET k", false],
    ["an indented comment", "   # note\nDEL k", true],
    ["leading blank lines", "\n\nDEL k", true],
    ["a command wrapped across lines, named on the first", "HSET k a 1\nb 2", true],
    ["a wrapped read", "HMGET k a\nb", false],
    ["a second block after a blank line", "GET k\n\nFLUSHALL", false],
    ["only comments", "# nothing to run", false],
    ["nothing at all", "", false],
  ])("reduces the buffer the way the provider does - %s", (_label, query, expected) => {
    expect(isDestructiveNonSqlQuery(query, "redis")).toBe(expected);
  });

  // ── Prometheus ───────────────────────────────────────────────────────────

  test.each<[string, string]>([
    ["a metric named like a SQL write", "update"],
    ["the same name uppercased", "DELETE"],
    ["a selector with a matcher", 'drop{job="x"}'],
    ["a range function", "rate(http_requests_total[5m])"],
    ["a selector behind a comment", "# nightly\nalter"],
    ["SQL, which the server refuses to parse", "DROP TABLE users"],
    ["an expression that never closes", "sum(("],
    ["nothing at all", ""],
  ])("names nothing for %s, because PromQL text can only be evaluated", (_label, query) => {
    // Not "unreadable, so ask": whatever the text, the one request it becomes is an
    // evaluation on the query endpoint, which cannot write (#1085, section 2). Text the
    // server cannot parse is refused there, with nothing changed.
    expect(isDestructiveNonSqlQuery(query, "prometheus")).toBe(false);
  });

  // ── Kafka ────────────────────────────────────────────────────────────────

  test.each<[string, string]>([
    ["a read of a topic named like a SQL write", '{"topic": "delete", "from": "latest", "limit": 50}'],
    ["the same, uppercased", '{"topic": "DROP", "from": "earliest"}'],
    ["a topic named update, by offset", '{"topic": "update", "partition": 0, "from": {"offset": "120"}}'],
    ["a topic named truncate, by timestamp", '{"topic": "truncate", "from": {"timestamp": "2026-09-23T00:00:00Z"}}'],
    ["topics named insert and alter", '{"topic": "insert"} {"topic": "alter"}'],
    ["SQL, which the parser refuses", "DELETE FROM orders"],
    ["a request that never closes", '{"topic": "orders"'],
    ["nothing at all", ""],
  ])("names nothing for %s, because a Kafka read request can only read", (_label, query) => {
    // Not "unreadable, so ask": whatever the text, the provider either parses it as one read of
    // one topic's messages or refuses it before anything is sent, and it sends no request that
    // writes (#1088, section 2).
    expect(isDestructiveNonSqlQuery(query, "kafka")).toBe(false);
  });

  // ── Neo4j ────────────────────────────────────────────────────────────────

  test.each<[string, string]>([
    ["a read", "MATCH (n:Person) RETURN n LIMIT 25"],
    ["a write", "CREATE (n:Person {name: 'Ada'})"],
    ["a detach delete", "MATCH (n) DETACH DELETE n"],
    ["a schema change", "DROP INDEX person_name"],
    ["SQL", "DROP TABLE users"],
    ["a statement that never closes", "MATCH (n RETURN n"],
    ["nothing at all", ""],
  ])("names nothing for %s, because the provider refuses every write before sending it", (_label, query) => {
    // Not "unreadable, so ask": the read policy refuses a write before anything is sent (Neo4j spec 5.5), so a
    // confirmation would ask about a statement that cannot run.
    expect(isDestructiveNonSqlQuery(query, "neo4j")).toBe(false);
  });
});

describe("vocabularyDecidesAlone", () => {
  // The rows the gate reads without its SQL keyword test in front. MongoDB and Redis keep that
  // test as a backstop; a type with no row is read by the SQL half entirely.
  test("is true for prometheus, kafka, etcd and neo4j and for no other type", () => {
    expect(SHIPPED_DATABASE_TYPES.filter((type) => vocabularyDecidesAlone(type))).toEqual([
      "prometheus",
      "kafka",
      "etcd",
      "neo4j",
    ]);
  });

  test("is false with no type at all", () => {
    expect(vocabularyDecidesAlone()).toBe(false);
  });
});

describe("NON_SQL_DESTRUCTIVE_VOCABULARY", () => {
  test("carries a row for exactly the six types whose text is not SQL", () => {
    expect(Object.keys(NON_SQL_DESTRUCTIVE_VOCABULARY).sort()).toEqual([
      "etcd",
      "kafka",
      "mongodb",
      "neo4j",
      "prometheus",
      "redis",
    ]);
  });

  test("names no Neo4j operation, because the provider sends no write to name", () => {
    expect(NON_SQL_DESTRUCTIVE_VOCABULARY.neo4j?.operations.size).toBe(0);
  });

  test("names no Kafka operation, because a read request has none to name", () => {
    // Not an omission: the editor text is one read request, and the provider refuses any key
    // but the four it reads, so there is no operation a row could list.
    expect(NON_SQL_DESTRUCTIVE_VOCABULARY.kafka?.operations.size).toBe(0);
  });

  // `readsSqlText` is the gate's other table. A type it reports as not SQL skips the SQL
  // span check, and without a row here nothing but the SQL keyword test reads its text:
  // that is how PromQL came to be read as SQL. A type added to one table and not the
  // other fails here, so the gate's reading of it is decided rather than inherited.
  test("carries a row for a type exactly when readsSqlText says its text is not SQL", () => {
    const notSql = SHIPPED_DATABASE_TYPES.filter((type) => !readsSqlText(type));
    expect(Object.keys(NON_SQL_DESTRUCTIVE_VOCABULARY).sort()).toEqual([...notSql].sort());
  });

  test("names no MongoDB operation the provider cannot dispatch", () => {
    // The gate's vocabulary may not invent operations: `drop`, `dropDatabase` and
    // `createIndex` are absent from `SUPPORTED_OPERATIONS`, so this editor cannot run
    // them and a row for them would be a prompt about something unreachable.
    const operations = NON_SQL_DESTRUCTIVE_VOCABULARY.mongodb?.operations;
    for (const absent of ["drop", "dropCollection", "dropDatabase", "createIndex", "renameCollection"]) {
      expect(operations?.has(absent)).toBe(false);
    }
  });
});

// The two fields a row declares for the dialog rather than for the gate's yes or no (#1089, section 5.5 and E10).
// These tests install a row of their own under a key no DatabaseType spells, and remove it after each test, so each
// rule is pinned apart from any engine's grammar. etcd's row, the one shipped row that declares both fields, is
// pinned as well: its typed confirmation with its own commands in describe("the etcd row") below, and its
// safetyAnalysis: false by the etcd test of describe("vocabularySendsToModel").

describe("vocabularyTypedConfirmation", () => {
  let remove: () => void = () => {};

  afterEach(() => {
    remove();
    remove = () => {};
  });

  test.each<[DatabaseType, string]>([
    ["postgres", "DROP TABLE users"],
    ["redis", "FLUSHALL"],
    ["mongodb", '{"collection":"users","operation":"deleteMany","filter":{}}'],
    ["prometheus", "up"],
    ["kafka", '{"topic": "orders"}'],
    ["neo4j", "MATCH (n) DETACH DELETE n"],
  ])(
    "asks for nothing to be typed on %s, whose row declares no typed confirmation or which has no row",
    (type, text) => {
      expect(vocabularyTypedConfirmation(type, text)).toBeUndefined();
    },
  );

  test("asks for nothing to be typed with no type at all", () => {
    expect(vocabularyTypedConfirmation(undefined, "FLUSHALL")).toBeUndefined();
  });

  test("hands a row's answer through as the row gave it, either shape, and nothing where the row asks nothing", () => {
    // Each answer carries whitespace a reader could be tempted to tidy, and ` /App/ ` is not `/App/` to etcd: the
    // reader hands on the row's own objects, the very ones, untouched (#1089, section 5.5).
    const prefixAsk: TypedConfirmationAsk = { type: "text", text: " /App/ " };
    const everyKeyAsk: TypedConfirmationAsk = { type: "connection-name", targets: [" every key "] };
    const seen: string[] = [];
    remove = installStandInVocabulary({
      typedConfirmation: (text): TypedConfirmationAsk | undefined => {
        seen.push(text);
        if (text === 'wipe-prefix " /App/ "') return prefixAsk;
        if (text === "wipe-all") return everyKeyAsk;
        return undefined;
      },
    });

    const prefix = vocabularyTypedConfirmation(STAND_IN_TYPE, 'wipe-prefix " /App/ "');
    expect(prefix).toBe(prefixAsk);
    // Against a fresh literal as well, since an answer trimmed in place is still the same object.
    expect(prefix).toEqual({ type: "text", text: " /App/ " });
    const everyKey = vocabularyTypedConfirmation(STAND_IN_TYPE, "wipe-all");
    expect(everyKey).toBe(everyKeyAsk);
    expect(everyKey).toEqual({ type: "connection-name", targets: [" every key "] });
    expect(vocabularyTypedConfirmation(STAND_IN_TYPE, "get /App/")).toBeUndefined();
    // Whitespace around the text is the row's to read: trimmed, this would be the wipe-all ask above.
    expect(vocabularyTypedConfirmation(STAND_IN_TYPE, " wipe-all\n")).toBeUndefined();
    // The text reaches the row as written: no trim, no case folding.
    expect(seen).toEqual(['wipe-prefix " /App/ "', "wipe-all", "get /App/", " wipe-all\n"]);
  });
});

describe("vocabularySendsToModel", () => {
  let remove: () => void = () => {};

  afterEach(() => {
    remove();
    remove = () => {};
  });

  // What the dialog did for every engine before the field existed, but for etcd, whose row keeps its statements,
  // values included, on this deployment (#1089 E10).
  test("keeps etcd's statements from the AI analysis, and no other shipped type's", () => {
    expect(SHIPPED_DATABASE_TYPES.filter((type) => !vocabularySendsToModel(type))).toEqual(["etcd"]);
  });

  test("sends with no type at all", () => {
    expect(vocabularySendsToModel()).toBe(true);
  });

  test("keeps a row's statements on this device where it declares safetyAnalysis: false, and only there", () => {
    remove = installStandInVocabulary({ safetyAnalysis: false });
    expect(vocabularySendsToModel(STAND_IN_TYPE)).toBe(false);
    remove();

    remove = installStandInVocabulary({});
    expect(vocabularySendsToModel(STAND_IN_TYPE)).toBe(true);
  });
});

/**
 * etcd's row (#1089, section 5.5 and E10), read by `guard.ts` over the provider's own parser, so what runs and
 * what asks are one parse. The Gate column of 5.1.3: reads never ask, `lease grant` and `lease keep-alive` ask
 * nothing, a single-key write asks one click, a range delete asks for its prefix or start key, a `lease revoke`
 * for its lease, and a delete of every key or a txn with more than one destructive target for the name.
 */
describe("the etcd row", () => {
  test.each([
    ["a read", "get /app/ --prefix"],
    ["a read of a key spelled like a SQL write", "get /update/drop --prefix"],
    ["a watch", "watch /app/ --prefix"],
    ["a lease grant, which destroys nothing", "lease grant 60"],
    ["a keep-alive, which destroys nothing", "lease keep-alive --once 694d8147df1dc4c8"],
    ["a txn of reads", 'txn\nmod("/app/cfg") > "0"\n\nget /app/cfg\n\n'],
    ["text the parser refuses, which will not run", "compaction 5"],
    ["an empty buffer", ""],
  ])("asks nothing for %s", (_label, text) => {
    expect(isDestructiveNonSqlQuery(text, "etcd")).toBe(false);
    expect(vocabularyTypedConfirmation("etcd", text)).toBeUndefined();
  });

  test.each([
    ["a put", "put /app/cfg value"],
    ["a single-key del", "del /app/cfg"],
    ["a txn that writes", 'txn\nmod("/app/cfg") > "0"\n\nput /app/cfg v\n\n'],
    ["a txn of two single-key dels", "txn\n\ndel /app/a\ndel /app/b\n\n"],
  ])("asks one click for %s, and no typed text", (_label, text) => {
    expect(isDestructiveNonSqlQuery(text, "etcd")).toBe(true);
    expect(vocabularyTypedConfirmation("etcd", text)).toBeUndefined();
  });

  test.each([
    ["a prefix delete, the prefix", "del /App/ --prefix", { type: "text", text: "/App/" }],
    ["a from-key delete, the start key", "del /app/a --from-key", { type: "text", text: "/app/a" }],
    ["a lease revoke, the lease id", "lease revoke 694d8147df1dc4c8", { type: "text", text: "694d8147df1dc4c8" }],
  ] as const)("asks for typed text for %s", (_label, text, ask) => {
    expect(isDestructiveNonSqlQuery(text, "etcd")).toBe(true);
    expect(vocabularyTypedConfirmation("etcd", text)).toEqual(ask);
  });

  test("a delete of every key, and a txn with two destructive targets, ask for the connection's name", () => {
    expect(vocabularyTypedConfirmation("etcd", "del '' --prefix")).toEqual({
      type: "connection-name",
      targets: ["every key"],
    });
    const two = "txn\n\ndel /app/ --prefix\ndel /cfg/ --prefix\n\n";
    const ask = vocabularyTypedConfirmation("etcd", two);
    expect(ask?.type).toBe("connection-name");
    expect(ask).toEqual(etcdTypedConfirmation(two));
    expect(ask?.type === "connection-name" ? ask.targets : []).toHaveLength(2);
  });

  test("the row decides alone, so no SQL keyword test reads an etcd key", () => {
    expect(vocabularyDecidesAlone("etcd")).toBe(true);
    // Read as SQL, the key names below are a DELETE and a DROP; read as etcdctl, they are keys a get reads.
    expect(isDestructiveNonSqlQuery("get DELETE FROM users", "etcd")).toBe(false);
    expect(isDestructiveNonSqlQuery("get /drop/table --prefix", "etcd")).toBe(false);
  });
});
