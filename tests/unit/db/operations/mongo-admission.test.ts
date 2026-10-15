/**
 * The agent's admission of one MongoDB statement (issue #1614).
 *
 * The fence is the model-facing half of the boundary: what it admits is the envelope the editor runs, and what it
 * refuses is refused WITH the sentence a model can act on. These tests hold each refusal code to its sentence and
 * each admitted shape to the editor's own grammar, so a drift in either direction is a red test rather than a
 * run-time surprise.
 *
 * The provider's own re-admission of the same text is held in `mongodb-provider.test.ts`'s profile block: the two
 * must refuse the same text, and the provider test says so.
 */
import { describe, expect, test } from "bun:test";
import {
  admitMongoStatement,
  MONGO_AGENT_MAX_STATEMENT_CHARS,
  mongoAgentReadInput,
} from "@/lib/db/operations/mongo-admission";

const envelope = (operation: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ collection: "orders", operation, ...extra });

describe("admitMongoStatement", () => {
  test("admits each of the five read operations, with and without a filter", () => {
    for (const operation of ["find", "findOne", "count"]) {
      expect(admitMongoStatement(envelope(operation))).toBeNull();
      expect(admitMongoStatement(envelope(operation, { filter: { status: "shipped" } }))).toBeNull();
    }
    // An aggregate names its stages - that is its grammar - and a filter enters as a $match.
    expect(admitMongoStatement(envelope("aggregate", { pipeline: [] }))).toBeNull();
    expect(admitMongoStatement(envelope("aggregate", { pipeline: [{ $match: { status: "shipped" } }] }))).toBeNull();
    // A distinct names its field - that is its grammar - with and without a filter.
    expect(admitMongoStatement(envelope("distinct", { field: "customer" }))).toBeNull();
    expect(admitMongoStatement(envelope("distinct", { field: "customer", filter: { status: "shipped" } }))).toBeNull();
  });

  test("admits the envelope's own options, a database, and an aggregate pipeline", () => {
    expect(
      admitMongoStatement(
        envelope("find", { options: { limit: 50, skip: 10, sort: { total: -1 }, projection: { customer: 1 } } }),
      ),
    ).toBeNull();
    expect(admitMongoStatement(envelope("find", { database: "reporting" }))).toBeNull();
    expect(
      admitMongoStatement(
        envelope("aggregate", { pipeline: [{ $match: { status: "shipped" } }, { $group: { _id: "$customer" } }] }),
      ),
    ).toBeNull();
    expect(admitMongoStatement(envelope("distinct", { field: "customer" }))).toBeNull();
  });

  test("refuses a write operation with the write's own sentence, not an unknown key's", () => {
    const refusal = admitMongoStatement(envelope("insertOne", { documents: [{ a: 1 }] }));
    expect(refusal?.code).toBe("non-read-operation");
    expect(refusal?.message).toContain('"insertOne" is not one of the five reads');
  });

  test("refuses a write's payload under a read's name by what it carries", () => {
    const refusal = admitMongoStatement(envelope("find", { documents: [{ a: 1 }] }));
    expect(refusal?.code).toBe("write-payload");
    expect(refusal?.message).toContain("a write's payload");
  });

  test("refuses $out and $merge wherever they appear in a pipeline", () => {
    for (const stage of [{ $out: "elsewhere" }, { $merge: { into: "elsewhere" } }]) {
      const refusal = admitMongoStatement(envelope("aggregate", { pipeline: [{ $match: {} }, stage] }));
      expect(refusal?.code).toBe("pipeline-writes");
      expect(refusal?.message).toContain("writes the pipeline's result into a collection");
    }
  });

  test("refuses an unknown top-level key, naming the key and the vocabulary", () => {
    const refusal = admitMongoStatement(envelope("find", { flter: {} }));
    expect(refusal?.code).toBe("unknown-key");
    expect(refusal?.message).toContain('"flter" is not a key the command envelope takes');
  });

  test("refuses a non-object root as a document that names no one command", () => {
    for (const text of ["[]", '[{"collection": "a"}, {"collection": "b"}]', '"find"', "42"]) {
      const refusal = admitMongoStatement(text);
      expect(refusal?.code).toBe("not-one-command");
    }
  });

  test("refuses text that is not JSON, with the worked envelope in the sentence", () => {
    const refusal = admitMongoStatement("db.orders.find({})");
    expect(refusal?.code).toBe("not-json");
    expect(refusal?.message).toContain('{"collection": "orders", "operation": "find"');
  });

  test("refuses past the deliberate length contract, naming the number", () => {
    const long = envelope("find", { filter: { pad: "x".repeat(MONGO_AGENT_MAX_STATEMENT_CHARS) } });
    const refusal = admitMongoStatement(long);
    expect(refusal?.code).toBe("agent-too-large");
    expect(refusal?.message).toContain(`${MONGO_AGENT_MAX_STATEMENT_CHARS} characters`);
  });

  test("refuses a missing collection, a missing operation, and a distinct with no field", () => {
    expect(admitMongoStatement('{"operation": "find"}')?.code).toBe("missing-collection");
    expect(admitMongoStatement('{"collection": "orders"}')?.code).toBe("missing-operation");
    expect(admitMongoStatement(envelope("distinct"))?.code).toBe("missing-field");
  });

  test("refuses the malformed shapes of the envelope's own fields", () => {
    expect(admitMongoStatement(envelope("find", { filter: ["not", "an", "object"] }))?.code).toBe("bad-filter");
    expect(admitMongoStatement(envelope("aggregate", { pipeline: "not-an-array" }))?.code).toBe("bad-pipeline");
    expect(admitMongoStatement(envelope("aggregate", { pipeline: ["not-a-stage"] }))?.code).toBe("bad-pipeline");
    expect(admitMongoStatement(envelope("find", { options: { limit: "fifty" } }))?.code).toBe("bad-options");
    expect(admitMongoStatement(envelope("find", { database: "" }))?.code).toBe("bad-database");
  });
});

describe("mongoAgentReadInput", () => {
  test("admits an envelope's text and refuses the same text the fence refuses", () => {
    expect(mongoAgentReadInput.safeParse({ command: envelope("find") }).success).toBe(true);
    const refused = mongoAgentReadInput.safeParse({ command: envelope("insertOne", { documents: [] }) });
    expect(refused.success).toBe(false);
  });

  test("is strict: a stray sql key is refused, not ignored", () => {
    const parsed = mongoAgentReadInput.safeParse({ sql: "SELECT 1", command: envelope("count") });
    expect(parsed.success).toBe(false);
  });
});
