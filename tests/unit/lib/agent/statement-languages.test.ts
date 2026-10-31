import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY, AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { cypherRowCapAdvice, fingerprintCypher } from "@/lib/agent/languages/cypher/adapter";
import { fingerprintInfluxql, influxqlRowCapAdvice } from "@/lib/agent/languages/influxql/adapter";
import { fingerprintKubectl, kubectlRowCapAdvice } from "@/lib/agent/languages/kubectl/adapter";
import { fingerprintLibredbkv, libredbkvRowCapAdvice } from "@/lib/agent/languages/libredbkv/adapter";
import { fingerprintMongo, mongoRowCapAdvice } from "@/lib/agent/languages/mongo/adapter";
import { fingerprintWeaviateapi, weaviateapiRowCapAdvice } from "@/lib/agent/languages/weaviateapi/adapter";
import { fingerprintQdrantapi, qdrantapiRowCapAdvice } from "@/lib/agent/languages/qdrantapi/adapter";
import { fingerprintMilvusrpc, milvusrpcRowCapAdvice } from "@/lib/agent/languages/milvusrpc/adapter";
import { fingerprintRediscli, rediscliRowCapAdvice } from "@/lib/agent/languages/rediscli/adapter";
import { etcdctlRowCapAdvice, fingerprintEtcdctl } from "@/lib/agent/languages/etcdctl/adapter";
import { fingerprintOxiacli, oxiacliRowCapAdvice } from "@/lib/agent/languages/oxiacli/adapter";
import { fingerprintRabbitread, rabbitreadRowCapAdvice } from "@/lib/agent/languages/rabbitread/adapter";
import { fingerprintKafkaread, kafkareadRowCapAdvice } from "@/lib/agent/languages/kafkaread/adapter";
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
import {
  admitCypherStatement,
  CYPHER_AGENT_MAX_STATEMENT_CHARS,
  cypherAgentReadInput,
} from "@/lib/db/operations/cypher-admission";
import {
  admitWeaviateapiStatement,
  WEAVIATEAPI_AGENT_MAX_STATEMENT_CHARS,
  weaviateapiAgentReadInput,
} from "@/lib/db/operations/weaviateapi-admission";
import { WEAVIATE_AGENT_SENTENCES } from "@/lib/db/providers/vector/weaviate/metadata-request";
import {
  admitQdrantapiStatement,
  QDRANTAPI_AGENT_MAX_STATEMENT_CHARS,
  qdrantapiAgentReadInput,
} from "@/lib/db/operations/qdrantapi-admission";
import { QDRANT_AGENT_SENTENCES } from "@/lib/db/providers/vector/qdrant/metadata-request";
import {
  admitMilvusrpcStatement,
  MILVUSRPC_AGENT_MAX_STATEMENT_CHARS,
  milvusrpcAgentReadInput,
} from "@/lib/db/operations/milvusrpc-admission";
import { MILVUS_AGENT_SENTENCES } from "@/lib/db/providers/vector/milvus/metadata-request";
import {
  admitRediscliStatement,
  REDISCLI_AGENT_MAX_STATEMENT_CHARS,
  rediscliAgentReadInput,
} from "@/lib/db/operations/rediscli-admission";
import { REDIS_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/redis-agent-statement";
import {
  admitEtcdctlStatement,
  ETCDCTL_AGENT_MAX_STATEMENT_CHARS,
  etcdctlAgentReadInput,
} from "@/lib/db/operations/etcdctl-admission";
import { ETCD_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-statement";
import {
  admitOxiacliStatement,
  OXIACLI_AGENT_MAX_STATEMENT_CHARS,
  oxiacliAgentReadInput,
} from "@/lib/db/operations/oxiacli-admission";
import { OXIA_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/oxia/agent-statement";
import {
  admitRabbitreadStatement,
  RABBITREAD_AGENT_MAX_STATEMENT_CHARS,
  rabbitreadAgentReadInput,
} from "@/lib/db/operations/rabbitread-admission";
import { RABBITMQ_AGENT_SENTENCES } from "@/lib/db/providers/stream/rabbitmq/agent-statement";
import {
  admitKafkareadStatement,
  KAFKAREAD_AGENT_MAX_STATEMENT_CHARS,
  kafkareadAgentReadInput,
} from "@/lib/db/operations/kafkaread-admission";
import { KAFKA_AGENT_SENTENCES } from "@/lib/db/providers/stream/kafka/agent-statement";
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

describe("the weaviateapi language's server adapter and admission", () => {
  test("the fingerprint is the request as the reader reads it, so one read written three ways is one identity", () => {
    const one = fingerprintWeaviateapi("GET /v1/nodes?output=verbose");
    expect(fingerprintWeaviateapi("// shard rows\nGET /v1/nodes?output=verbose")).toBe(one);
    expect(fingerprintWeaviateapi("GET   /v1/nodes?output=verbose")).toBe(one);
    expect(fingerprintWeaviateapi("GET /v1/nodes?output=minimal")).not.toBe(one);
    expect(fingerprintWeaviateapi("GET /v1/schema/Note")).not.toBe(fingerprintWeaviateapi("GET /v1/schema/Doc"));
    expect(fingerprintWeaviateapi('POST /v1/aggregate/Note {"tenant": "a"}')).not.toBe(
      fingerprintWeaviateapi('POST /v1/aggregate/Note {"tenant": "b"}'),
    );
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = "GET /v1/objects?class=Note";
    expect(fingerprintWeaviateapi(raw)).toBe(fingerprintWeaviateapi(raw));
    expect(fingerprintWeaviateapi(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintWeaviateapi(`${raw} `)).not.toBe(fingerprintWeaviateapi(raw));
  });

  test("every advice key of the weaviateapi copy has its own sentence", () => {
    const generic = weaviateapiRowCapAdvice("GET /v1/objects?class=Note", "200");
    const requestFor: Readonly<Record<string, string>> = {
      schema: "GET /v1/schema",
      tenants: "GET /v1/schema/Tenanted/tenants",
      nodes: "GET /v1/nodes?output=verbose",
    };
    expect([...AGENT_LANGUAGE_COPY.weaviateapi.adviceKeys].sort()).toEqual(["nodes", "schema", "tenants"]);
    for (const key of AGENT_LANGUAGE_COPY.weaviateapi.adviceKeys) {
      expect(weaviateapiRowCapAdvice(requestFor[key] as string, "200"), key).not.toBe(generic);
    }
    expect(weaviateapiRowCapAdvice("GET /v1/nodes/Note?output=verbose", "200")).toBe(
      weaviateapiRowCapAdvice("GET /v1/nodes", "200"),
    );
    expect(weaviateapiRowCapAdvice("GET /v1/schema", "200")).toContain("GET /v1/schema/{collection}");
  });

  test("a request without advice of its own, or one that is refused, gets the generic sentence", () => {
    const generic =
      "Ask for at most 200 rows: read one collection, tenant or node instead of the whole list, and run it again.";
    expect(weaviateapiRowCapAdvice("GET /v1/aliases", "200")).toBe(generic);
    expect(weaviateapiRowCapAdvice("GET /v1/objects?class=Note", "200")).toBe(generic);
    expect(languageServer("weaviateapi").shapeAdvice).toContain("a valid Weaviate request");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitWeaviateapiStatement("GET /v1/schema")).toBeNull();
    expect(admitWeaviateapiStatement("GET /v1/objects?class=Note")).toEqual({
      code: "metadata-only",
      message: WEAVIATE_AGENT_SENTENCES.metadataOnly("GET /v1/objects"),
    });
    expect(admitWeaviateapiStatement('POST /v1/aggregate/Note {"groupBy": "body"}')).toEqual({
      code: "aggregate-shape",
      message: WEAVIATE_AGENT_SENTENCES.aggregateShape("groupBy"),
    });
    expect(admitWeaviateapiStatement("DELETE /v1/schema/Note")?.code).toBe("request");
    const long = `GET /v1/meta ${"/".repeat(WEAVIATEAPI_AGENT_MAX_STATEMENT_CHARS)}`;
    expect(admitWeaviateapiStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The request is longer than ${WEAVIATEAPI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("weaviateapi").admit?.("GET /v1/meta")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("weaviateapi").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "collection", plural: "collections" })).toBe(
      "The capture failed.\nSo nothing about this database has been established for you: not one collection name. Read what you need with run_read_query, starting with GET /v1/schema.",
    );
    expect(languageServerPack("weaviateapi").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the request, and refuses what the admission refuses", () => {
    expect(weaviateapiAgentReadInput.safeParse({ statement: "GET /v1/meta" }).success).toBe(true);
    expect(weaviateapiAgentReadInput.safeParse({ statement: "GET /v1/meta", sql: "x" }).success).toBe(false);
    const refused = weaviateapiAgentReadInput.safeParse({ statement: "GET /v1/objects?class=Note" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(WEAVIATE_AGENT_SENTENCES.metadataOnly("GET /v1/objects"));
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.weaviateapi).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.weaviateapi.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the qdrantapi language's server adapter and admission", () => {
  test("the fingerprint is the request as the reader reads it, so one read written three ways is one identity", () => {
    const one = fingerprintQdrantapi("POST /collections/plain/points/count");
    expect(fingerprintQdrantapi("// a count\nPOST /collections/plain/points/count")).toBe(one);
    expect(fingerprintQdrantapi('POST /collections/plain/points/count {"exact": true}')).toBe(one);
    expect(fingerprintQdrantapi('POST /collections/plain/points/count {"exact": false}')).not.toBe(one);
    expect(fingerprintQdrantapi("POST /collections/plain/points/count?consistency=all")).not.toBe(one);
    expect(fingerprintQdrantapi("GET /collections/plain")).not.toBe(fingerprintQdrantapi("GET /collections/docs"));
  });

  test("the query keys are read in order, so their order in the text does not make a second read", () => {
    expect(fingerprintQdrantapi("POST /collections/plain/points/count?consistency=all&timeout=3")).toBe(
      fingerprintQdrantapi("POST /collections/plain/points/count?timeout=3&consistency=all"),
    );
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = "GET /collections/plain/points/1";
    expect(fingerprintQdrantapi(raw)).toBe(fingerprintQdrantapi(raw));
    expect(fingerprintQdrantapi(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintQdrantapi(`${raw} `)).not.toBe(fingerprintQdrantapi(raw));
  });

  test("every advice key of the qdrantapi copy has its own sentence", () => {
    const generic = qdrantapiRowCapAdvice("GET /collections/plain/points/1", "200");
    const requestFor: Readonly<Record<string, string>> = {
      collections: "GET /collections",
      collection: "GET /collections/plain",
      aliases: "GET /aliases",
    };
    expect([...AGENT_LANGUAGE_COPY.qdrantapi.adviceKeys].sort()).toEqual(["aliases", "collection", "collections"]);
    for (const key of AGENT_LANGUAGE_COPY.qdrantapi.adviceKeys) {
      expect(qdrantapiRowCapAdvice(requestFor[key] as string, "200"), key).not.toBe(generic);
    }
    expect(qdrantapiRowCapAdvice("GET /collections", "200")).toContain("GET /collections/{collection}");
  });

  test("a request without advice of its own, or one that is refused, gets the generic sentence", () => {
    const generic = "Ask for at most 200 rows: read one collection instead of the whole list, and run it again.";
    expect(qdrantapiRowCapAdvice("GET /collections/plain/cluster", "200")).toBe(generic);
    expect(qdrantapiRowCapAdvice("GET /collections/plain/points/1", "200")).toBe(generic);
    expect(languageServer("qdrantapi").shapeAdvice).toContain("a valid Qdrant request");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitQdrantapiStatement("GET /collections")).toBeNull();
    expect(admitQdrantapiStatement("GET /collections/plain/points/1")).toEqual({
      code: "metadata-only",
      message: QDRANT_AGENT_SENTENCES.metadataOnly("GET /collections/{collection_name}/points/{id}"),
    });
    expect(admitQdrantapiStatement('POST /collections/plain/points/count {"shard_key": "a"}')).toEqual({
      code: "count-shape",
      message: QDRANT_AGENT_SENTENCES.countShape("shard_key"),
    });
    expect(admitQdrantapiStatement("DELETE /collections/plain")?.code).toBe("request");
    const long = `GET /collections ${"/".repeat(QDRANTAPI_AGENT_MAX_STATEMENT_CHARS)}`;
    expect(admitQdrantapiStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The request is longer than ${QDRANTAPI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("qdrantapi").admit?.("GET /")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("qdrantapi").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "collection", plural: "collections" })).toBe(
      "The capture failed.\nSo nothing about this database has been established for you: not one collection name. Read what you need with run_read_query, starting with GET /collections.",
    );
    expect(languageServerPack("qdrantapi").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the request, and refuses what the admission refuses", () => {
    expect(qdrantapiAgentReadInput.safeParse({ statement: "GET /collections" }).success).toBe(true);
    expect(qdrantapiAgentReadInput.safeParse({ statement: "GET /collections", sql: "x" }).success).toBe(false);
    const refused = qdrantapiAgentReadInput.safeParse({ statement: 'POST /collections/plain/facet {"key": "city"}' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(
      QDRANT_AGENT_SENTENCES.metadataOnly("POST /collections/{collection_name}/facet"),
    );
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.qdrantapi).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.qdrantapi.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the cypher language's server adapter and admission", () => {
  test("the fingerprint is the statement's tokens, keywords folded, so one read written three ways is one identity", () => {
    const one = fingerprintCypher("MATCH (n:Person) RETURN n.name LIMIT 5");
    expect(fingerprintCypher("match (n:Person)  return n.name limit 5")).toBe(one);
    expect(fingerprintCypher("MATCH (n:Person)\nRETURN n.name LIMIT 5;")).toBe(one);
    expect(fingerprintCypher("MATCH (n:person) RETURN n.name LIMIT 5")).not.toBe(one);
    expect(fingerprintCypher("MATCH (n:Person) RETURN n.name LIMIT 6")).not.toBe(one);
    expect(fingerprintCypher("MATCH (n:Person) RETURN n.Name LIMIT 5")).not.toBe(one);
  });

  test("the fingerprint is total: a refused statement is identified by its raw text, so it is refused again", () => {
    const raw = "LOAD CSV FROM 'file:///x.csv' AS row RETURN row";
    expect(fingerprintCypher(raw)).toBe(fingerprintCypher(raw));
    expect(fingerprintCypher(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintCypher(raw.toLowerCase())).not.toBe(fingerprintCypher(raw));
  });

  test("the copy has no advice key, and every statement gets the one Cypher sentence", () => {
    expect([...AGENT_LANGUAGE_COPY.cypher.adviceKeys]).toEqual([]);
    expect(cypherRowCapAdvice("MATCH (n) RETURN n", "200")).toBe(
      "Ask for at most 200 rows: narrow the MATCH with a WHERE, aggregate with count() or collect(), or bound it with LIMIT, and run it again.",
    );
    expect(languageServer("cypher").rowCapAdvice("SHOW INDEXES", "200")).toBe(cypherRowCapAdvice("x", "200"));
    expect(languageServer("cypher").shapeAdvice).toContain("a valid Cypher statement");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitCypherStatement("MATCH (n) RETURN count(n) AS n")).toBeNull();
    expect(admitCypherStatement("RETURN 1 // why")).toEqual({
      code: "agent-comment",
      message: "An agent statement has no comment: remove it and send the statement alone. Nothing was sent.",
    });
    expect(admitCypherStatement("LOAD CSV FROM 'file:///x.csv' AS row RETURN row")?.code).toBe("denied-word");
    const long = `RETURN '${"m".repeat(CYPHER_AGENT_MAX_STATEMENT_CHARS)}'`;
    expect(admitCypherStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The statement is longer than ${CYPHER_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("cypher").admit?.("MATCH (n) RETURN n LIMIT 1")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told no rule of the agent's reader", () => {
    const ungrounded = languageServerPack("cypher").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "label", plural: "labels" })).toBe(
      "The capture failed.\nSo nothing about this database has been established for you: not one label name. Read what you need with run_read_query, starting with CALL db.labels().",
    );
    expect(languageServerPack("cypher").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the statement, and refuses what the admission refuses", () => {
    expect(cypherAgentReadInput.safeParse({ statement: "MATCH (n) RETURN n LIMIT 1" }).success).toBe(true);
    expect(cypherAgentReadInput.safeParse({ statement: "MATCH (n) RETURN n", sql: "x" }).success).toBe(false);
    const refused = cypherAgentReadInput.safeParse({ statement: "RETURN 1\r" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toContain("An agent statement has no carriage return");
  });
});

describe("the milvusrpc language's server adapter and admission", () => {
  const describe_ = (body: string) => `POST /v2/vectordb/collections/describe\n${body}`;

  test("the fingerprint is the request as the reader reads it, so one read written three ways is one identity", () => {
    const one = fingerprintMilvusrpc(describe_('{"collectionName": "docs"}'));
    expect(fingerprintMilvusrpc(`# a describe\n${describe_('{"collectionName": "docs"}')}`)).toBe(one);
    expect(fingerprintMilvusrpc('POST collections/describe\n{"collectionName": "docs"}')).toBe(one);
    expect(fingerprintMilvusrpc(describe_('{"dbName": "default", "collectionName": "docs"}'))).toBe(one);
    expect(fingerprintMilvusrpc(describe_('{"collectionName": "other"}'))).not.toBe(one);
    expect(fingerprintMilvusrpc("POST /v2/vectordb/collections/list")).not.toBe(
      fingerprintMilvusrpc("POST /v2/vectordb/databases/list"),
    );
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = 'POST /v2/vectordb/entities/get\n{"collectionName": "docs", "id": 1}';
    expect(fingerprintMilvusrpc(raw)).toBe(fingerprintMilvusrpc(raw));
    expect(fingerprintMilvusrpc(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintMilvusrpc(`${raw} `)).not.toBe(fingerprintMilvusrpc(raw));
  });

  test("every advice key of the milvusrpc copy has its own sentence", () => {
    const generic = milvusrpcRowCapAdvice("POST /v2/vectordb/entities/query", "200");
    const requestFor: Readonly<Record<string, string>> = {
      databases: "POST /v2/vectordb/databases/list",
      collections: "POST /v2/vectordb/collections/list",
      collection: describe_('{"collectionName": "docs"}'),
      partitions: 'POST /v2/vectordb/partitions/list\n{"collectionName": "docs"}',
      aliases: "POST /v2/vectordb/aliases/list",
    };
    expect([...AGENT_LANGUAGE_COPY.milvusrpc.adviceKeys].sort()).toEqual([
      "aliases",
      "collection",
      "collections",
      "databases",
      "partitions",
    ]);
    for (const key of AGENT_LANGUAGE_COPY.milvusrpc.adviceKeys) {
      expect(milvusrpcRowCapAdvice(requestFor[key] as string, "200"), key).not.toBe(generic);
      expect(milvusrpcRowCapAdvice(requestFor[key] as string, "200"), key).toContain("Ask for at most 200 rows");
    }
  });

  test("a request without advice of its own, or one that is refused, gets the generic sentence", () => {
    const generic = "Ask for at most 200 rows: read one collection instead of the whole list, and run it again.";
    expect(milvusrpcRowCapAdvice('POST /v2/vectordb/indexes/list\n{"collectionName": "docs"}', "200")).toBe(generic);
    expect(milvusrpcRowCapAdvice("POST /v2/vectordb/entities/query", "200")).toBe(generic);
    expect(languageServer("milvusrpc").shapeAdvice).toContain("a valid Milvus request");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitMilvusrpcStatement("POST /v2/vectordb/collections/list")).toBeNull();
    expect(admitMilvusrpcStatement('POST /v2/vectordb/entities/get\n{"collectionName": "docs", "id": 1}')).toEqual({
      code: "metadata-only",
      message: MILVUS_AGENT_SENTENCES.metadataOnly("entities/get"),
    });
    expect(admitMilvusrpcStatement('POST /v2/vectordb/collections/load\n{"collectionName": "docs"}')?.code).toBe(
      "request",
    );
    const long = `POST /v2/vectordb/collections/list\n{"dbName": "${"a".repeat(MILVUSRPC_AGENT_MAX_STATEMENT_CHARS)}"}`;
    expect(admitMilvusrpcStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The request is longer than ${MILVUSRPC_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("milvusrpc").admit?.("POST /v2/vectordb/databases/list")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("milvusrpc").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "collection", plural: "collections" })).toBe(
      "The capture failed.\nSo nothing about this database has been established for you: not one collection name. Read what you need with run_read_query, starting with POST /v2/vectordb/collections/list.",
    );
    expect(languageServerPack("milvusrpc").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the request, and refuses what the admission refuses", () => {
    expect(milvusrpcAgentReadInput.safeParse({ statement: "POST /v2/vectordb/collections/list" }).success).toBe(true);
    expect(
      milvusrpcAgentReadInput.safeParse({ statement: "POST /v2/vectordb/collections/list", sql: "x" }).success,
    ).toBe(false);
    const refused = milvusrpcAgentReadInput.safeParse({
      statement: 'POST /v2/vectordb/entities/query\n{"collectionName": "docs", "filter": "id > 0"}',
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(MILVUS_AGENT_SENTENCES.metadataOnly("entities/query"));
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.milvusrpc).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.milvusrpc.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the rediscli language's server adapter and admission", () => {
  test("the fingerprint is the argv the reader sends, so one read written three ways is one identity", () => {
    const one = fingerprintRediscli("TYPE session:42");
    expect(fingerprintRediscli("type   session:42")).toBe(one);
    expect(fingerprintRediscli('TYPE "session:42"')).toBe(one);
    expect(fingerprintRediscli("TYPE session:43")).not.toBe(one);
    expect(fingerprintRediscli("TTL session:42")).not.toBe(one);
  });

  test("the fingerprint is total: a refused command is identified by its raw text, so it is refused again", () => {
    const raw = "GET session:42";
    expect(fingerprintRediscli(raw)).toBe(fingerprintRediscli(raw));
    expect(fingerprintRediscli(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintRediscli(`${raw} `)).not.toBe(fingerprintRediscli(raw));
  });

  test("every read answers one row, so the copy names no advice key and the advice names no narrower read", () => {
    expect(AGENT_LANGUAGE_COPY.rediscli.adviceKeys).toEqual([]);
    expect(rediscliRowCapAdvice("DBSIZE", "0")).toBe(
      "Ask for at most 0 rows: every Redis read agent mode runs answers one row, about the database or one key, so read one key at a time.",
    );
    expect(languageServer("rediscli").shapeAdvice).toContain("a valid Redis command");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitRediscliStatement("DBSIZE")).toBeNull();
    expect(admitRediscliStatement("GET session:42")).toEqual({
      code: "metadata-only",
      message: REDIS_AGENT_SENTENCES.metadataOnly,
    });
    expect(admitRediscliStatement("TYPE")?.code).toBe("arguments");
    const long = `TYPE ${"k".repeat(REDISCLI_AGENT_MAX_STATEMENT_CHARS)}`;
    expect(admitRediscliStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The command is longer than ${REDISCLI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("rediscli").admit?.("TTL session:42")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("rediscli").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "key", plural: "keys" })).toBe(
      "The capture failed.\nSo nothing about this database has been established for you: not one key name, and none will be, since key names are withheld from agent mode. Read what you need with run_read_query, starting with DBSIZE.",
    );
    expect(languageServerPack("rediscli").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the command, and refuses what the admission refuses", () => {
    expect(rediscliAgentReadInput.safeParse({ statement: "DBSIZE" }).success).toBe(true);
    expect(rediscliAgentReadInput.safeParse({ statement: "DBSIZE", sql: "x" }).success).toBe(false);
    const refused = rediscliAgentReadInput.safeParse({ statement: "KEYS *" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(REDIS_AGENT_SENTENCES.metadataOnly);
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.rediscli).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.rediscli.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the etcdctl language's server adapter and admission", () => {
  test("the fingerprint is the request the reader sends, so one read written two ways is one identity", () => {
    const one = fingerprintEtcdctl("get /app/config");
    expect(fingerprintEtcdctl('get "/app/config"')).toBe(one);
    expect(fingerprintEtcdctl("  get /app/config")).toBe(one);
    expect(fingerprintEtcdctl("get /app/other")).not.toBe(one);
    expect(fingerprintEtcdctl("endpoint status")).not.toBe(one);
    expect(fingerprintEtcdctl('get "" --prefix --count-only')).toBe(
      fingerprintEtcdctl('get "" --from-key --count-only'),
    );
  });

  test("the fingerprint is total: a refused command is identified by its raw text, so it is refused again", () => {
    const raw = "get /app/ --prefix";
    expect(fingerprintEtcdctl(raw)).toBe(fingerprintEtcdctl(raw));
    expect(fingerprintEtcdctl(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintEtcdctl(`${raw} `)).not.toBe(fingerprintEtcdctl(raw));
  });

  test("only a list can pass the row budget, so the advice names the reads that answer one row", () => {
    expect(AGENT_LANGUAGE_COPY.etcdctl.adviceKeys).toEqual([]);
    expect(etcdctlRowCapAdvice("member list", "2")).toBe(
      "Ask for at most 2 rows: member list, alarm list and lease list answer one row per member, alarm or lease, so read one lease with lease timetolive, or the cluster with endpoint status.",
    );
    expect(languageServer("etcdctl").shapeAdvice).toContain("a valid etcdctl command");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitEtcdctlStatement("endpoint status")).toBeNull();
    expect(admitEtcdctlStatement("get /app/ --prefix")).toEqual({
      code: "metadata-only",
      message: ETCD_AGENT_SENTENCES.metadataOnly,
    });
    expect(admitEtcdctlStatement("get /app/config --rev=2")?.code).toBe("arguments");
    const long = `get /${"k".repeat(ETCDCTL_AGENT_MAX_STATEMENT_CHARS)}`;
    expect(admitEtcdctlStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The command is longer than ${ETCDCTL_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("etcdctl").admit?.("member list")).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("etcdctl").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "key prefix", plural: "key prefixes" })).toBe(
      "The capture failed.\nSo nothing about this cluster's keys has been established for you: not one key prefix name, and none will be, since key names are withheld from agent mode. Read what you need with run_read_query, starting with endpoint status.",
    );
    expect(languageServerPack("etcdctl").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the command, and refuses what the admission refuses", () => {
    expect(etcdctlAgentReadInput.safeParse({ statement: "alarm list" }).success).toBe(true);
    expect(etcdctlAgentReadInput.safeParse({ statement: "alarm list", sql: "x" }).success).toBe(false);
    const refused = etcdctlAgentReadInput.safeParse({ statement: "watch /app/config" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(ETCD_AGENT_SENTENCES.metadataOnly);
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.etcdctl).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.etcdctl.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the oxiacli language's server adapter and admission", () => {
  test("the fingerprint is the read the reader sends, so one read written two ways is one identity", () => {
    const one = fingerprintOxiacli("get /admin/policies");
    expect(fingerprintOxiacli("get '/admin/policies'")).toBe(one);
    expect(fingerprintOxiacli("oxia client get /admin/policies")).toBe(one);
    expect(fingerprintOxiacli("get /admin/other")).not.toBe(one);
    expect(fingerprintOxiacli("shards")).not.toBe(one);
    expect(fingerprintOxiacli("ls")).toBe(fingerprintOxiacli("oxia client list"));
    // A refused count is identified by its raw text, so two spellings of it are two identities.
    expect(fingerprintOxiacli("list /a /z")).not.toBe(fingerprintOxiacli("list -s /a -e /z"));
  });

  test("the fingerprint is total: a refused command is identified by its raw text, so it is refused again", () => {
    const raw = "range-scan --prefix /admin/";
    expect(fingerprintOxiacli(raw)).toBe(fingerprintOxiacli(raw));
    expect(fingerprintOxiacli(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOxiacli(`${raw} `)).not.toBe(fingerprintOxiacli(raw));
  });

  test("every read answers one row, and the advice offers no narrower count", () => {
    expect(AGENT_LANGUAGE_COPY.oxiacli.adviceKeys).toEqual([]);
    expect(oxiacliRowCapAdvice("list", "2")).toBe(
      "Ask for at most 2 rows: shards, get and list each answer one row, and list counts the namespace only when it holds at most 2 keys; a count over a narrower range is not one of agent mode's reads, since it would reveal key names.",
    );
    expect(languageServer("oxiacli").shapeAdvice).toContain("a valid oxia command");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitOxiacliStatement("shards")).toBeNull();
    expect(admitOxiacliStatement("range-scan")).toEqual({
      code: "metadata-only",
      message: OXIA_AGENT_SENTENCES.metadataOnly,
    });
    expect(admitOxiacliStatement("get -t floor /a")?.code).toBe("arguments");
    const long = `get /${"k".repeat(OXIACLI_AGENT_MAX_STATEMENT_CHARS)}`;
    expect(admitOxiacliStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The command is longer than ${OXIACLI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("oxiacli").admit?.("list")).toBeNull();
    expect(languageServer("oxiacli").admit?.("list --prefix /a/")).toEqual({
      code: "metadata-only",
      message: OXIA_AGENT_SENTENCES.rangeCount,
    });
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("oxiacli").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "shard", plural: "shards" })).toBe(
      "The capture failed.\nSo nothing about this namespace's keys has been established for you: not one shard name, and none will be, since key names are withheld from agent mode. Read what you need with run_read_query, starting with shards.",
    );
    expect(languageServerPack("oxiacli").grounding.planningRules).toBeUndefined();
  });

  test("the descriptor's input is strict, carries the command, and refuses what the admission refuses", () => {
    expect(oxiacliAgentReadInput.safeParse({ statement: "shards" }).success).toBe(true);
    expect(oxiacliAgentReadInput.safeParse({ statement: "shards", sql: "x" }).success).toBe(false);
    const refused = oxiacliAgentReadInput.safeParse({ statement: "notifications" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(OXIA_AGENT_SENTENCES.metadataOnly);
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.oxiacli).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.oxiacli.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the rabbitread language's server adapter and admission", () => {
  const READ = '{"vhost": "/", "stream": "orders", "from": "first", "limit": 5}';

  test("the fingerprint is the read the reader sends, so one read written two ways is one identity", () => {
    const one = fingerprintRabbitread(READ);
    expect(fingerprintRabbitread('{"limit":5,"from":"first","stream":"orders","vhost":"/"}')).toBe(one);
    expect(fingerprintRabbitread('{"vhost": "/", "stream": "orders", "from": "first", "limit": 6}')).not.toBe(one);
    expect(fingerprintRabbitread('{"vhost": "/", "stream": "audit", "from": "first", "limit": 5}')).not.toBe(one);
    // A default written out is the read left out.
    expect(fingerprintRabbitread('{"vhost": "/", "stream": "orders"}')).toBe(
      fingerprintRabbitread('{"vhost": "/", "stream": "orders", "from": "last", "limit": 50}'),
    );
    expect(fingerprintRabbitread('{"vhost": "/", "stream": "orders", "from": {"offset": 7}}')).toBe(
      fingerprintRabbitread('{"vhost": "/", "stream": "orders", "from": {"offset": "7"}}'),
    );
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = '{"vhost": "/", "stream": "orders", "ack": true}';
    expect(fingerprintRabbitread(raw)).toBe(fingerprintRabbitread(raw));
    expect(fingerprintRabbitread(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintRabbitread(`${raw} `)).not.toBe(fingerprintRabbitread(raw));
  });

  test("a read answers one row per message, and the advice names the limit", () => {
    expect(AGENT_LANGUAGE_COPY.rabbitread.adviceKeys).toEqual([]);
    expect(rabbitreadRowCapAdvice(READ, "2")).toBe(
      'Ask for at most 2 rows: a read answers one row per message, up to its "limit", so write "limit": 2 or less, and read on from the offset after the last one you read.',
    );
    expect(languageServer("rabbitread").shapeAdvice).toContain("a valid read request");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitRabbitreadStatement(READ)).toBeNull();
    expect(admitRabbitreadStatement("")).toEqual({ code: "request", message: RABBITMQ_AGENT_SENTENCES.empty });
    expect(admitRabbitreadStatement('{"vhost": "/", "stream": "orders", "ack": true}')?.code).toBe("request");
    const long = JSON.stringify({ vhost: "/", stream: "s".repeat(RABBITREAD_AGENT_MAX_STATEMENT_CHARS) });
    expect(admitRabbitreadStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The read request is longer than ${RABBITREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("rabbitread").admit?.(READ)).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("rabbitread").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "stream", plural: "streams" })).toBe(
      "The capture failed.\nSo nothing about this broker has been established for you: not one stream name. Read a stream the question names with run_read_query; each message answers its offset and body size only.",
    );
    expect(languageServerPack("rabbitread").grounding.planningRules).toBeUndefined();
    expect(languageServerPack("rabbitread").grounding.omissionAdvice).toContain("by offset and body size only");
  });

  test("the descriptor's input is strict, carries the request, and refuses what the admission refuses", () => {
    expect(rabbitreadAgentReadInput.safeParse({ statement: READ }).success).toBe(true);
    expect(rabbitreadAgentReadInput.safeParse({ statement: READ, sql: "x" }).success).toBe(false);
    const refused = rabbitreadAgentReadInput.safeParse({ statement: "basic.get orders" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toStartWith("A RabbitMQ read request is one JSON object");
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.rabbitread).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.rabbitread.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the kafkaread language's server adapter and admission", () => {
  const READ = '{"read": "offsets", "topic": "orders", "limit": 5}';

  test("the fingerprint is the plan the reader sends, so one read written two ways is one identity", () => {
    const one = fingerprintKafkaread(READ);
    expect(fingerprintKafkaread('{"limit":5,"topic":"orders","read":"offsets"}')).toBe(one);
    expect(fingerprintKafkaread('{"read": "offsets", "topic": "orders", "limit": 6}')).not.toBe(one);
    expect(fingerprintKafkaread('{"read": "partitions", "topic": "orders", "limit": 5}')).not.toBe(one);
    // A default written out is the read left out.
    expect(fingerprintKafkaread('{"read": "topics"}')).toBe(fingerprintKafkaread('{"read": "topics", "limit": 50}'));
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = '{"read": "fetch", "topic": "orders"}';
    expect(fingerprintKafkaread(raw)).toBe(fingerprintKafkaread(raw));
    expect(fingerprintKafkaread(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintKafkaread(`${raw} `)).not.toBe(fingerprintKafkaread(raw));
  });

  test("a read answers one row per topic, broker or partition, and the advice names the limit and the cursor", () => {
    expect(AGENT_LANGUAGE_COPY.kafkaread.adviceKeys).toEqual([]);
    expect(kafkareadRowCapAdvice(READ, "2")).toBe(
      'Ask for at most 2 rows: a read answers one row per topic, broker or partition, up to its "limit", so write "limit": 2 or less, and read on with "after" set to the last name or id you read.',
    );
    expect(languageServer("kafkaread").shapeAdvice).toContain("a valid read request");
  });

  test("the admission is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitKafkareadStatement(READ)).toBeNull();
    expect(admitKafkareadStatement("")).toEqual({ code: "request", message: KAFKA_AGENT_SENTENCES.empty });
    expect(admitKafkareadStatement('{"read": "fetch"}')).toEqual({
      code: "metadata-only",
      message: KAFKA_AGENT_SENTENCES.notARead,
    });
    const long = JSON.stringify({ read: "topics", after: "a".repeat(KAFKAREAD_AGENT_MAX_STATEMENT_CHARS) });
    expect(admitKafkareadStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The read request is longer than ${KAFKAREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("kafkaread").admit?.(READ)).toBeNull();
  });

  test("an ungrounded run is sent to a read it holds, and plan mode is told none of the reader's rules", () => {
    const ungrounded = languageServerPack("kafkaread").grounding.ungrounded;
    expect(ungrounded?.("The capture failed.", { singular: "topic", plural: "topics" })).toBe(
      'The capture failed.\nSo nothing about this cluster has been established for you: not one topic name. List the topics with run_read_query, {"read": "topics"}; answers carry names, counts and offsets only.',
    );
    expect(languageServerPack("kafkaread").grounding.planningRules).toBeUndefined();
    expect(languageServerPack("kafkaread").grounding.omissionAdvice).toContain("by its partitions and offsets only");
  });

  test("the descriptor's input is strict, carries the request, and refuses what the admission refuses", () => {
    expect(kafkareadAgentReadInput.safeParse({ statement: READ }).success).toBe(true);
    expect(kafkareadAgentReadInput.safeParse({ statement: READ, sql: "x" }).success).toBe(false);
    const refused = kafkareadAgentReadInput.safeParse({ statement: "fetch orders" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toStartWith("A Kafka agent read is one JSON object");
  });

  test("only the investigation and the operations workflow are offered: nothing else reads metadata alone", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.kafkaread).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.kafkaread.investigation?.canAutoExecute).toBe(false);
  });
});
