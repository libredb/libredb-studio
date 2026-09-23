import { describe, test, expect } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import {
  NON_SQL_DESTRUCTIVE_VOCABULARY,
  isDestructiveNonSqlQuery,
  vocabularyDecidesAlone,
} from "@/lib/db/destructive-commands";
import { readsSqlText } from "@/lib/sql/grammar";

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
});

describe("vocabularyDecidesAlone", () => {
  // The one row the gate reads without its SQL keyword test in front. MongoDB and Redis
  // keep that test as a backstop; a type with no row is read by the SQL half entirely.
  test("is true for prometheus and for no other type", () => {
    expect(SHIPPED_DATABASE_TYPES.filter((type) => vocabularyDecidesAlone(type))).toEqual(["prometheus"]);
  });

  test("is false with no type at all", () => {
    expect(vocabularyDecidesAlone()).toBe(false);
  });
});

describe("NON_SQL_DESTRUCTIVE_VOCABULARY", () => {
  test("carries a row for exactly the three types whose text is not SQL", () => {
    expect(Object.keys(NON_SQL_DESTRUCTIVE_VOCABULARY).sort()).toEqual(["mongodb", "prometheus", "redis"]);
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
