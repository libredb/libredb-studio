import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY } from "@/lib/agent/agent-manifest";
import {
  fingerprintKubectl,
  kubectlRowCapAdvice,
  fingerprintMongo,
  mongoRowCapAdvice,
  languageServer,
} from "@/lib/agent/statement-languages";
import { admitMongoStatement } from "@/lib/db/operations/mongo-admission";

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

  test("-n Shop and -n shop do not collide: one parses and one does not", () => {
    expect(fingerprintKubectl("get pods -n Shop")).not.toBe(fingerprintKubectl("get pods -n shop"));
  });

  test("is total: malformed text and the paging clause are fingerprinted, not thrown", () => {
    expect(fingerprintKubectl("get pods | grep x")).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintKubectl("get pods -n shop\n# libredb:page offset=0 limit=5")).not.toBe(
      fingerprintKubectl("get pods -n shop"),
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
  // The canonical text every layer carries is sorted-key JSON, so two spellings of one
  // command are ONE identity: the repair ledger's whole reason for the fingerprint.
  test("the fingerprint is key-order total over the command", () => {
    expect(fingerprintMongo('{"collection": "orders", "operation": "find"}')).toBe(
      fingerprintMongo('{"operation": "find", "collection": "orders"}'),
    );
    expect(fingerprintMongo('{"collection": "orders", "operation": "count"}')).not.toBe(
      fingerprintMongo('{"collection": "orders", "operation": "find"}'),
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
