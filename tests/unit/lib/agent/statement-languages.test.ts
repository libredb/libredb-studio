import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY } from "@/lib/agent/agent-manifest";
import { fingerprintInfluxql, influxqlRowCapAdvice } from "@/lib/agent/languages/influxql/adapter";
import { fingerprintKubectl, kubectlRowCapAdvice } from "@/lib/agent/languages/kubectl/adapter";
import { fingerprintLibredbkv, libredbkvRowCapAdvice } from "@/lib/agent/languages/libredbkv/adapter";
import { fingerprintMongo, mongoRowCapAdvice } from "@/lib/agent/languages/mongo/adapter";
import { languageServer, languageServerPack } from "@/lib/agent/languages/server";
import {
  admitLibredbkvStatement,
  LIBREDBKV_AGENT_MAX_STATEMENT_CHARS,
  libredbkvAgentReadInput,
} from "@/lib/db/operations/libredbkv-admission";
import {
  admitInfluxqlStatement,
  INFLUXQL_AGENT_MAX_STATEMENT_CHARS,
  influxqlAgentReadInput,
} from "@/lib/db/operations/influxql-admission";
import { admitMongoStatement } from "@/lib/db/operations/mongo-admission";
import { INFLUXQL_AGENT_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/influxql-agent-statement";
import { INFLUXQL_POLICY_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";

/**
 * kubectl's server half: the repair ledger's identity of one read, and the row-cap advice written in the command's
 * own flags. SQL's adapter is held by the D6 golden file and `tools.test.ts`.
 */

describe("the kubectl fingerprint", () => {
  test("is the same for one read written three ways", () => {
    const one = fingerprintKubectl("get pods -n shop");
    expect(fingerprintKubectl("kubectl get pods --namespace=shop")).toBe(one);
    expect(fingerprintKubectl("get   pods  -n   shop")).toBe(one);
  });

  test("differs when a flag's value differs", () => {
    expect(fingerprintKubectl("get pods -n shop")).not.toBe(fingerprintKubectl("get pods -n web"));
    expect(fingerprintKubectl("get pods -n shop -l app=a")).not.toBe(fingerprintKubectl("get pods -n shop -l app=A"));
  });

  test("is the same for two flag orders: the parser builds one statement for both", () => {
    expect(fingerprintKubectl("get pods -l app=a -n shop")).toBe(fingerprintKubectl("get pods -n shop -l app=a"));
  });

  test("-n Shop and -n shop do not collide: one parses and one does not", () => {
    expect(fingerprintKubectl("get pods -n Shop")).not.toBe(fingerprintKubectl("get pods -n shop"));
  });

  test("is total: malformed text and the paging clause are fingerprinted, not thrown", () => {
    expect(fingerprintKubectl("get pods | grep x")).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintKubectl("get pods -n shop\n# libredb:page offset=0 limit=5")).not.toBe(
      fingerprintKubectl("get pods -n shop"),
    );
  });

  // Pinned digests: kubectl's identity is the key-sorted JSON of its parsed statement, whatever order the parser
  // builds its fields in and however the mongo fingerprint serialises. The pins hold that sort; the flag-order test
  // above holds the parser.
  test("is the digest it has always been, parsed and unparsed", () => {
    expect(fingerprintKubectl("get pods -n shop")).toBe(
      "eac2daa40ca752687e46ac9d5163ed9edca576379996a083461da3960143bb83",
    );
    expect(fingerprintKubectl("get pods | grep x")).toBe(
      "c52dd92bf94081fff912a2dea7444074741b261b2b228fb88f4686866bbf7893",
    );
  });
});

describe("row-cap advice by command", () => {
  test.each([
    ["get pods -A", ["-n", "-l", "--field-selector"]],
    ["top pod -A", ["-n", "-l"]],
    ["logs web-1 --all-containers", ["--tail", "-c"]],
    ["events -A", ["-n", "--for", "--types"]],
  ] as const)("%s names only flags its command takes", (statement, flags) => {
    const advice = kubectlRowCapAdvice(statement, "200");
    for (const flag of flags) expect(advice).toContain(flag);
    expect(advice).toContain("200");
    expect(advice).not.toContain("LIMIT");
  });

  test("every advice key of the kubectl copy has its own sentence", () => {
    const generic = kubectlRowCapAdvice("version", "200");
    const statementFor: Readonly<Record<string, string>> = {
      get: "get pods",
      top: "top pod",
      logs: "logs web-1",
      events: "events -n shop",
    };
    for (const command of AGENT_LANGUAGE_COPY.kubectl.adviceKeys) {
      expect(kubectlRowCapAdvice(statementFor[command] as string, "200"), command).not.toBe(generic);
    }
  });

  test("a command without advice of its own, or a line that does not parse, gets the generic sentence", () => {
    expect(kubectlRowCapAdvice("version", "200")).toContain("at most 200 rows");
    expect(kubectlRowCapAdvice("get pods | grep x", "200")).toBe(kubectlRowCapAdvice("version", "200"));
  });
});

describe("the mongo language's server adapter", () => {
  // Key order is part of a MongoDB command: a sort document and an exact embedded-document match return different
  // documents in another order. So the identity is the command as written, and only the spacing around it is not.
  test("the fingerprint keeps the written key order, so two sort orders are two reads", () => {
    const byBThenA = JSON.stringify({ collection: "c", operation: "find", options: { sort: { b: 1, a: 1 } } });
    const byAThenB = JSON.stringify({ collection: "c", operation: "find", options: { sort: { a: 1, b: 1 } } });
    expect(fingerprintMongo(byBThenA)).not.toBe(fingerprintMongo(byAThenB));
    expect(fingerprintMongo('{"options":{"sort":{"b":1,"a":1}}}')).not.toBe(
      fingerprintMongo('{"options":{"sort":{"a":1,"b":1}}}'),
    );
    expect(fingerprintMongo('{"collection": "orders", "operation": "count"}')).not.toBe(
      fingerprintMongo('{"collection": "orders", "operation": "find"}'),
    );
  });

  test("the fingerprint ignores whitespace around and inside the command", () => {
    const written = '{"options":{"sort":{"b":1,"a":1}}}';
    expect(fingerprintMongo(' {"options": {"sort": {"b": 1, "a": 1}}}\n')).toBe(fingerprintMongo(written));
    expect(fingerprintMongo('{\n  "options": {\n    "sort": { "b": 1, "a": 1 }\n  }\n}')).toBe(
      fingerprintMongo(written),
    );
  });

  test("a line that does not parse is still an identity, so a refused line is refused again", () => {
    const raw = "db.orders.find({})";
    expect(fingerprintMongo(raw)).toBe(fingerprintMongo(raw));
    expect(fingerprintMongo(raw)).not.toBe(fingerprintMongo('{"collection": "orders", "operation": "find"}'));
  });

  test("every advice key of the mongo copy has its own sentence, and the keys are the five reads", () => {
    const generic = mongoRowCapAdvice('{"collection": "orders", "operation": "findOne"}', "200");
    const statementFor: Readonly<Record<string, string>> = {
      find: '{"collection": "orders", "operation": "find"}',
      aggregate: '{"collection": "orders", "operation": "aggregate", "pipeline": []}',
      count: '{"collection": "orders", "operation": "count"}',
      distinct: '{"collection": "orders", "operation": "distinct", "field": "customer"}',
    };
    // The copy names exactly the operations that read many, which is what a row cap is about.
    expect([...AGENT_LANGUAGE_COPY.mongo.adviceKeys].sort()).toEqual(["aggregate", "count", "distinct", "find"]);
    for (const operation of AGENT_LANGUAGE_COPY.mongo.adviceKeys) {
      expect(mongoRowCapAdvice(statementFor[operation] as string, "200"), operation).not.toBe(generic);
    }
  });

  test("the row-cap advice names the narrowing THIS operation can do, and no SQL does", () => {
    expect(mongoRowCapAdvice('{"collection": "orders", "operation": "find"}', "200")).toContain('"options"');
    expect(mongoRowCapAdvice('{"collection": "orders", "operation": "aggregate", "pipeline": []}', "200")).toContain(
      "$match",
    );
    expect(mongoRowCapAdvice('{"collection": "orders", "operation": "count"}', "200")).not.toContain("$match");
    expect(mongoRowCapAdvice('{"operation": "find", "collection": "orders"}', "200")).not.toContain("LIMIT");
  });

  test("a line that does not parse gets the generic sentence, and the shape advice is the language's own", () => {
    expect(mongoRowCapAdvice("not json", "200")).toContain("at most 200 rows");
    expect(languageServer("mongo").shapeAdvice).toContain("a valid MongoDB read");
    expect(languageServer("mongo").readOperation).toBe("mongo.query.read");
    expect(languageServer("mongo").admit).toBe(admitMongoStatement);
  });

  test("reads an admitted command against the inventory, and says nothing about text that is not one command", () => {
    const inventoryProblem = languageServer("mongo").inventoryProblem;
    const inventory = {
      objects: [{ name: "shop.orders", path: ["shop", "orders"], kind: "collection", columns: [], indexes: [] }],
      kinds: [{ id: "collection", role: "relation" as const, label: "Collection", labelPlural: "Collections" }],
    };
    expect(inventoryProblem?.('{"collection": "shop.orders", "operation": "count"}', inventory)).toContain(
      "is the inventory's spelling",
    );
    expect(inventoryProblem?.('{"collection": "orders", "operation": "count"}', inventory)).toBeNull();
    expect(inventoryProblem?.("not json", inventory)).toBeNull();
    expect(languageServer("sql").inventoryProblem).toBeUndefined();
    expect(languageServer("kubectl").inventoryProblem).toBeUndefined();
  });
});

describe("the shape advice", () => {
  // No kubectl read reaches a shape denial through run_read_query today: the reader refuses an over-long line before
  // the policy does. The sentence is still the language's own, so a later path that does reach one says the right thing.
  test("kubectl speaks of a valid kubectl statement, and SQL keeps the sentence the golden file holds", () => {
    expect(languageServer("kubectl").shapeAdvice).toContain("a valid kubectl statement");
    expect(languageServer("kubectl").shapeAdvice).not.toContain("SQL");
    expect(languageServer("sql").shapeAdvice).toBeUndefined();
  });
});

/**
 * One model argument as the statement text the fence, the provider, the ledger and the repair identity read. Every
 * value that is not a statement is null, so a caller refuses it rather than sending something it did not mean.
 */
describe("canonicalize", () => {
  const NOT_A_STATEMENT: readonly unknown[] = ["", null, undefined, 0, 42, true, [], ["SELECT 1"], {}];

  test.each(["sql", "kubectl"] as const)("%s passes a non-empty string through unchanged", (language) => {
    const { canonicalize } = languageServer(language);
    expect(canonicalize("SELECT 1")).toBe("SELECT 1");
    expect(canonicalize("  get pods -n shop\n")).toBe("  get pods -n shop\n");
  });

  test.each(["sql", "kubectl"] as const)("%s answers null for anything that is not a string", (language) => {
    const { canonicalize } = languageServer(language);
    for (const raw of [...NOT_A_STATEMENT, { sql: "SELECT 1" }, { statement: "get pods" }]) {
      expect(canonicalize(raw), JSON.stringify(raw) ?? String(raw)).toBeNull();
    }
  });

  test("mongo passes a non-empty string through unchanged", () => {
    const { canonicalize } = languageServer("mongo");
    expect(canonicalize('{"operation": "find", "collection": "orders"}')).toBe(
      '{"operation": "find", "collection": "orders"}',
    );
  });

  test("mongo writes a command object as JSON in the order the model wrote it, at every depth", () => {
    const { canonicalize } = languageServer("mongo");
    expect(canonicalize({ operation: "find", collection: "orders", filter: { status: "shipped" } })).toBe(
      '{"operation":"find","collection":"orders","filter":{"status":"shipped"}}',
    );
    expect(canonicalize({ collection: "c", operation: "find", options: { sort: { b: 1, a: 1 } } })).toBe(
      '{"collection":"c","operation":"find","options":{"sort":{"b":1,"a":1}}}',
    );
    expect(canonicalize({ collection: "c", operation: "aggregate", pipeline: [{ $sort: { z: 1, a: -1 } }] })).toBe(
      '{"collection":"c","operation":"aggregate","pipeline":[{"$sort":{"z":1,"a":-1}}]}',
    );
    expect(
      canonicalize({ collection: "people", operation: "count", filter: { address: { zip: "1", city: "x" } } }),
    ).toBe('{"collection":"people","operation":"count","filter":{"address":{"zip":"1","city":"x"}}}');
  });

  // The one residual of written order: JavaScript puts integer-like keys first in every object, before any code here
  // sees it, so a field named "2" cannot keep its place after a field named "a".
  test("mongo keeps written order except for integer-like keys, which JavaScript puts first", () => {
    expect(languageServer("mongo").canonicalize({ a: 1, "2": 1, "1": 1 })).toBe('{"1":1,"2":1,"a":1}');
  });

  test("mongo answers null for an empty command and for anything that is not a plain object or a string", () => {
    const { canonicalize } = languageServer("mongo");
    const serialisesToNothing = { toJSON: () => undefined };
    for (const raw of [
      ...NOT_A_STATEMENT,
      [{ collection: "c" }],
      { only: undefined },
      serialisesToNothing,
      new Date(0),
      new Map(),
    ]) {
      expect(canonicalize(raw), Object.prototype.toString.call(raw)).toBeNull();
    }
  });

  test("the mongo text of an object fingerprints as the same read as its spaced-out spelling", () => {
    const command = { collection: "c", operation: "find", options: { sort: { b: 1, a: 1 } } };
    const text = languageServer("mongo").canonicalize(command);
    expect(text).not.toBeNull();
    expect(fingerprintMongo(text as string)).toBe(fingerprintMongo(JSON.stringify(command, null, 2)));
  });
});

describe("the libredbkv language's server adapter and admission", () => {
  test("the fingerprint is the parsed command, so one read written three ways is one identity", () => {
    const one = fingerprintLibredbkv("get users:1");
    expect(fingerprintLibredbkv("GET users:1")).toBe(one);
    expect(fingerprintLibredbkv('  get "users:1"  ')).toBe(one);
    expect(fingerprintLibredbkv("get users:2")).not.toBe(one);
    expect(fingerprintLibredbkv("prefix users:1")).not.toBe(one);
    expect(fingerprintLibredbkv("range a b")).not.toBe(fingerprintLibredbkv("range a c"));
  });

  test("the fingerprint is total: a refused command is identified by its raw text, so it is refused again", () => {
    const raw = "put users:9 Mallory";
    expect(fingerprintLibredbkv(raw)).toBe(fingerprintLibredbkv(raw));
    expect(fingerprintLibredbkv(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintLibredbkv("PUT users:9 Mallory")).not.toBe(fingerprintLibredbkv(raw));
  });

  test("every advice key of the libredbkv copy has its own sentence, and get, which reads one key, has none", () => {
    const generic = libredbkvRowCapAdvice("get users:1", "200");
    const statementFor: Readonly<Record<string, string>> = { prefix: "prefix users:", range: "range a z" };
    expect([...AGENT_LANGUAGE_COPY.libredbkv.adviceKeys].sort()).toEqual(["prefix", "range"]);
    for (const command of AGENT_LANGUAGE_COPY.libredbkv.adviceKeys) {
      expect(libredbkvRowCapAdvice(statementFor[command] as string, "200"), command).not.toBe(generic);
    }
    expect(libredbkvRowCapAdvice("prefix users:", "200")).toContain("prefix");
    expect(libredbkvRowCapAdvice("range a z", "200")).toContain("range");
  });

  test("a command without advice of its own, or one that does not parse, gets the generic sentence", () => {
    expect(libredbkvRowCapAdvice("get users:1", "200")).toBe(
      "Ask for at most 200 keys: narrow the read to fewer keys, and run it again.",
    );
    expect(libredbkvRowCapAdvice("put a b", "200")).toBe(libredbkvRowCapAdvice("get users:1", "200"));
    expect(languageServer("libredbkv").shapeAdvice).toContain("a valid LibreDB command");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitLibredbkvStatement("prefix users:")).toBeNull();
    expect(admitLibredbkvStatement("delete users:1")).toEqual({
      code: "write-command",
      message:
        '"delete" writes, and an agent read only reads: the reads are get <key>, prefix <p> and range <start> <end>. Nothing was sent.',
    });
    const long = `get ${"k".repeat(LIBREDBKV_AGENT_MAX_STATEMENT_CHARS)}`;
    expect(admitLibredbkvStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The statement is longer than ${LIBREDBKV_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten the key or the prefix. Nothing was sent.`,
    });
    expect(languageServer("libredbkv").admit?.("get users:1")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, since no inspect_schema is offered", () => {
    const ungrounded = languageServerPack("libredbkv").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "key prefix", plural: "key prefixes" })).toBe(
      "The capture failed.\nSo nothing about this database has been established for you: not one key prefix name. Read what you need with run_read_query, starting with prefix on the namespaces your objective names.",
    );
    expect(languageServerPack("libredbkv").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the statement, and refuses what the admission refuses", () => {
    expect(libredbkvAgentReadInput.safeParse({ statement: "get users:1" }).success).toBe(true);
    expect(libredbkvAgentReadInput.safeParse({ statement: "get users:1", sql: "x" }).success).toBe(false);
    const refused = libredbkvAgentReadInput.safeParse({ statement: "put users:9 x" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toStartWith('"put" writes');
  });
});

describe("the influxql language's server adapter and admission", () => {
  test("the fingerprint is the statement's tokens, so one read written three ways is one identity", () => {
    const one = fingerprintInfluxql("SELECT * FROM home");
    expect(fingerprintInfluxql("select *  from home")).toBe(one);
    expect(fingerprintInfluxql("SELECT *\nFROM home")).toBe(one);
    expect(fingerprintInfluxql('SELECT * FROM "home2"')).not.toBe(one);
    expect(fingerprintInfluxql("SELECT * FROM home LIMIT 5")).not.toBe(one);
  });

  test("the fingerprint is total: a refused statement is identified by its raw text, so it is refused again", () => {
    const raw = 'SELECT * INTO "other".."m" FROM home';
    expect(fingerprintInfluxql(raw)).toBe(fingerprintInfluxql(raw));
    expect(fingerprintInfluxql(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintInfluxql(raw.toLowerCase())).not.toBe(fingerprintInfluxql(raw));
  });

  test("every advice key of the influxql copy has its own sentence", () => {
    const generic = influxqlRowCapAdvice("DROP DATABASE home", "200");
    const statementFor: Readonly<Record<string, string>> = { SELECT: "SELECT * FROM home", SHOW: "SHOW SERIES" };
    expect([...AGENT_LANGUAGE_COPY.influxql.adviceKeys].sort()).toEqual(["SELECT", "SHOW"]);
    for (const kind of AGENT_LANGUAGE_COPY.influxql.adviceKeys) {
      expect(influxqlRowCapAdvice(statementFor[kind] as string, "200"), kind).not.toBe(generic);
    }
    expect(influxqlRowCapAdvice("SELECT * FROM home", "200")).toContain("SLIMIT");
    expect(influxqlRowCapAdvice("SHOW SERIES", "200")).toContain("WITH KEY");
  });

  test("a statement without advice of its own, or one that is refused, gets the generic sentence", () => {
    expect(influxqlRowCapAdvice("EXPLAIN SELECT * FROM home", "200")).toBe(
      "Ask for at most 200 rows: narrow the read to fewer rows, and run it again.",
    );
    expect(influxqlRowCapAdvice("SHOW QUERIES", "200")).toBe(
      "Ask for at most 200 rows: narrow the read to fewer rows, and run it again.",
    );
    expect(languageServer("influxql").shapeAdvice).toContain("a valid InfluxQL statement");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitInfluxqlStatement("SHOW MEASUREMENTS")).toBeNull();
    expect(admitInfluxqlStatement('SELECT * INTO "other".."m" FROM home')).toEqual({
      code: "policy",
      message: INFLUXQL_POLICY_SENTENCES.into,
    });
    expect(admitInfluxqlStatement("SHOW QUERIES")).toEqual({
      code: "show-kind",
      message: INFLUXQL_AGENT_SENTENCES.showKind("QUERIES"),
    });
    const long = `SELECT * FROM "${"m".repeat(INFLUXQL_AGENT_MAX_STATEMENT_CHARS)}"`;
    expect(admitInfluxqlStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The statement is longer than ${INFLUXQL_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("influxql").admit?.("SELECT * FROM home")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, since no inspect_schema is offered", () => {
    const ungrounded = languageServerPack("influxql").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "measurement", plural: "measurements" })).toBe(
      "The capture failed.\nSo nothing about this database has been established for you: not one measurement name. Read what you need with run_read_query, starting with SHOW MEASUREMENTS.",
    );
    expect(languageServerPack("influxql").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the statement, and refuses what the admission refuses", () => {
    expect(influxqlAgentReadInput.safeParse({ statement: "SELECT * FROM home" }).success).toBe(true);
    expect(influxqlAgentReadInput.safeParse({ statement: "SELECT * FROM home", sql: "x" }).success).toBe(false);
    const refused = influxqlAgentReadInput.safeParse({ statement: "SHOW USERS" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(INFLUXQL_AGENT_SENTENCES.showKind("USERS"));
  });
});
