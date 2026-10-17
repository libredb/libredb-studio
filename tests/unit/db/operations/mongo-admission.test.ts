/**
 * The agent's admission of one MongoDB statement (issue #1614).
 *
 * The admission is the command reader (`readMongoCommand` in `envelope.ts`) plus one refusal of the agent's own, the
 * 4,096-character contract. These tests hold the admission to the reader, so the tool path and the provider, which
 * reads the same text with the same reader, cannot refuse two different sets of commands; and each refusal code to the
 * sentence a model can act on. The reader's own grammar is held in `tests/unit/db/mongodb/envelope.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  admitMongoStatement,
  MONGO_AGENT_MAX_STATEMENT_CHARS,
  type MongoAdmissionCode,
  mongoAgentReadInput,
} from "@/lib/db/operations/mongo-admission";
import { readMongoCommand } from "@/lib/db/providers/document/mongodb/envelope";

const envelope = (operation: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ collection: "orders", operation, ...extra });

describe("admitMongoStatement is the command reader", () => {
  /** One command of each shape the reader admits, and one of each code it refuses with. */
  const COMMANDS = [
    envelope("find", { filter: { status: "shipped" }, options: { projection: { total: 1 }, sort: { total: -1 } } }),
    envelope("findOne", { filter: { status: "shipped" } }),
    envelope("aggregate", { pipeline: [{ $match: { status: "shipped" } }, { $group: { _id: "$customer" } }] }),
    envelope("count", { filter: { status: "shipped" } }),
    envelope("distinct", { field: "customer" }),
    "db.orders.find({})",
    "[]",
    envelope("find", { flter: {} }),
    '{"operation": "find"}',
    '{"collection": "orders"}',
    envelope("insertOne", { documents: [{ a: 1 }] }),
    envelope("find", { documents: [{ a: 1 }] }),
    envelope("aggregate", { pipeline: "not-an-array" }),
    envelope("aggregate", { pipeline: [{ $out: "elsewhere" }] }),
    envelope("aggregate", { pipeline: [{ $collStats: {} }] }),
    envelope("find", { filter: { $where: "this.total > 5" } }),
    envelope("find", { options: { projection: { x: { $_internalJsEmit: {} } } } }),
    envelope("find", { filter: ["not", "an", "object"] }),
    envelope("find", { filter: { _id: { $oid: "65f0a1b2c3d4e5f6a7b8c9d0", other: 1 } } }),
    envelope("distinct"),
    envelope("find", { options: { limit: "fifty" } }),
    envelope("find", { database: "" }),
  ];

  test("admits exactly what the reader admits, and refuses the rest with the reader's code and sentence", () => {
    const codes = new Set<string>();
    for (const text of COMMANDS) {
      const reading = readMongoCommand(text);
      if (reading.ok) {
        expect(admitMongoStatement(text)).toBeNull();
      } else {
        codes.add(reading.code);
        expect(admitMongoStatement(text)).toEqual({ code: reading.code, message: reading.message });
      }
    }
    // Every refusal code the reader has is driven above, so a code the admission rewrote would show here.
    expect([...codes].sort()).toEqual([
      "bad-database",
      "bad-extended-json",
      "bad-filter",
      "bad-options",
      "bad-pipeline",
      "internal-operator",
      "missing-collection",
      "missing-field",
      "missing-operation",
      "non-read-operation",
      "not-json",
      "not-one-command",
      "pipeline-stage",
      "pipeline-writes",
      "server-side-javascript",
      "unknown-key",
      "write-payload",
    ]);
  });

  test("refuses the limits a cursor would misread and the keys the read would drop", () => {
    const refusals: [string, MongoAdmissionCode][] = [
      [envelope("find", { options: { limit: 0 } }), "bad-options"],
      ['{"collection": "orders", "operation": "find", "options": {"limit": -0}}', "bad-options"],
      [envelope("find", { options: { limit: 0.5 } }), "bad-options"],
      [envelope("find", { options: { limit: -1 } }), "bad-options"],
      [envelope("find", { options: { limit: { $numberLong: "5" } } }), "bad-options"],
      [envelope("findOne", { options: { sort: { total: -1 } } }), "unknown-key"],
      [envelope("aggregate", { filter: { status: "shipped" }, pipeline: [] }), "unknown-key"],
      [envelope("find", { pipeline: [] }), "unknown-key"],
      [envelope("find", { field: "customer" }), "unknown-key"],
      [envelope("find", { options: { noCursorTimeout: true } }), "unknown-key"],
    ];
    for (const [text, code] of refusals) expect(admitMongoStatement(text)?.code).toBe(code);
  });

  test("the length contract is the agent's own: a command the reader admits is refused past it", () => {
    const long = envelope("find", { filter: { pad: "x".repeat(MONGO_AGENT_MAX_STATEMENT_CHARS) } });
    expect(readMongoCommand(long).ok).toBe(true);
    expect(admitMongoStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The statement is longer than ${MONGO_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: narrow the filter or the pipeline. Nothing was sent.`,
    });
    // Exactly at the contract is admitted.
    const filler = "x".repeat(MONGO_AGENT_MAX_STATEMENT_CHARS - envelope("find", { filter: { pad: "" } }).length);
    const atLimit = envelope("find", { filter: { pad: filler } });
    expect(atLimit.length).toBe(MONGO_AGENT_MAX_STATEMENT_CHARS);
    expect(admitMongoStatement(atLimit)).toBeNull();
  });
});

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

  test("refuses the server-side JavaScript operators wherever the envelope carries them", () => {
    // In a find's filter, plainly.
    const plain = admitMongoStatement(envelope("find", { filter: { $where: "this.total > 5" } }));
    expect(plain?.code).toBe("server-side-javascript");
    expect(plain?.message).toContain('"$where" runs JavaScript');
    // Nested inside $and - the reach is the whole filter, not its top level.
    const nested = admitMongoStatement(
      envelope("find", { filter: { $and: [{ status: "shipped" }, { $where: "this.total > 5" }] } }),
    );
    expect(nested?.code).toBe("server-side-javascript");
    // Inside $expr in a filter, as $function.
    const expressed = admitMongoStatement(
      envelope("find", { filter: { $expr: { $function: { body: "function() { return 1; }" } } } }),
    );
    expect(expressed?.code).toBe("server-side-javascript");
    // Inside a $match stage of a pipeline.
    const matched = admitMongoStatement(
      envelope("aggregate", { pipeline: [{ $match: { $where: "this.total > 5" } }] }),
    );
    expect(matched?.code).toBe("server-side-javascript");
    // As a $group accumulator and inside a $project expression.
    const accumulated = admitMongoStatement(
      envelope("aggregate", {
        pipeline: [{ $group: { _id: null, m: { $accumulator: { init: "function() {}", combine: "function() {}" } } } }],
      }),
    );
    expect(accumulated?.code).toBe("server-side-javascript");
    const projected = admitMongoStatement(
      envelope("aggregate", {
        pipeline: [{ $project: { computed: { $function: { body: "function(x) { return x; }" } } } }],
      }),
    );
    expect(projected?.code).toBe("server-side-javascript");
    // A count and a distinct carry the same reach through their query.
    const counted = admitMongoStatement(envelope("count", { filter: { $where: "true" } }));
    expect(counted?.code).toBe("server-side-javascript");
  });

  test("admits the operators that merely match and compute - no false positive on the JavaScript refusal", () => {
    // The engine's own grammar makes a `$`-key an operator, and the matching/computing ones are not the
    // JavaScript ones: every one of these is the plain filter or expression the refusal's own sentence points at.
    expect(admitMongoStatement(envelope("find", { filter: { status: { $regex: "^sh" } } }))).toBeNull();
    expect(admitMongoStatement(envelope("aggregate", { pipeline: [{ $match: { total: { $gte: 5 } } }] }))).toBeNull();
    expect(
      admitMongoStatement(
        envelope("aggregate", {
          pipeline: [{ $project: { ok: { $regexMatch: { input: "$status", regex: "^sh" } } } }],
        }),
      ),
    ).toBeNull();
    expect(
      admitMongoStatement(envelope("find", { filter: { $expr: { $cond: [{ $eq: ["$status", "shipped"] }, 1, 0] } } })),
    ).toBeNull();
    expect(
      admitMongoStatement(envelope("aggregate", { pipeline: [{ $group: { _id: "$customer", n: { $sum: 1 } } }] })),
    ).toBeNull();
    // An array value and a deep plain filter are walked without a hit and without complaint.
    expect(admitMongoStatement(envelope("find", { filter: { tags: { $in: ["a", "b"] } } }))).toBeNull();
  });

  test("refuses the malformed shapes of the envelope's own fields", () => {
    expect(admitMongoStatement(envelope("find", { filter: ["not", "an", "object"] }))?.code).toBe("bad-filter");
    expect(admitMongoStatement(envelope("aggregate", { pipeline: "not-an-array" }))?.code).toBe("bad-pipeline");
    expect(admitMongoStatement(envelope("aggregate", { pipeline: ["not-a-stage"] }))?.code).toBe("bad-pipeline");
    expect(admitMongoStatement(envelope("find", { options: { limit: "fifty" } }))?.code).toBe("bad-options");
    expect(admitMongoStatement(envelope("find", { database: "" }))?.code).toBe("bad-database");
    // The options object's own shape: not an object at all, and a sort or projection that is one.
    expect(admitMongoStatement(envelope("find", { options: "none" }))?.code).toBe("bad-options");
    expect(admitMongoStatement(envelope("find", { options: { sort: "descending" } }))?.code).toBe("bad-options");
    expect(admitMongoStatement(envelope("find", { options: { projection: ["customer"] } }))?.code).toBe("bad-options");
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
