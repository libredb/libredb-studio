import { describe, test, expect } from "bun:test";
import {
  clusterUsageReadDescriptor,
  clusterWorkloadsReadDescriptor,
  createCanonicalOperationRegistry,
  dbOperationsReadDescriptor,
  dbSchemaReadDescriptor,
  isStatementReadOperation,
  kubectlQueryReadDescriptor,
  mongoPlanEstimateDescriptor,
  mongoQueryReadDescriptor,
  mongoSchemaReadDescriptor,
  mongoTableProfileDescriptor,
  sqlExplainAnalyzeDescriptor,
  sqlExplainEstimateDescriptor,
  sqlQueryReadDescriptor,
  sqlTableProfileDescriptor,
} from "@/lib/db/operations/descriptors";

/**
 * The descriptors whose input IS a statement. Kept apart from the registry's full
 * set since the curated operational read joined it: that descriptor takes no `sql`
 * key at all, which is the point of it, so the statement-contract assertions below
 * are not true of it and must not be made to be.
 */
const sqlDescriptors = [
  sqlQueryReadDescriptor,
  sqlExplainEstimateDescriptor,
  sqlExplainAnalyzeDescriptor,
  sqlTableProfileDescriptor,
];

const canonicalDescriptors = [
  ...sqlDescriptors,
  dbOperationsReadDescriptor,
  dbSchemaReadDescriptor,
  kubectlQueryReadDescriptor,
  clusterUsageReadDescriptor,
  clusterWorkloadsReadDescriptor,
  mongoQueryReadDescriptor,
  mongoSchemaReadDescriptor,
  mongoPlanEstimateDescriptor,
  mongoTableProfileDescriptor,
];

describe("canonical operation registry", () => {
  test("registers exactly the canonical descriptors: no write, DDL, or admin operation exists", () => {
    // Every id below is a read, each for the reason its docblock states; the exact-array equality is the one place a
    // descriptor, a write, DDL or admin one included, can be added without somebody noticing.
    const registry = createCanonicalOperationRegistry();
    expect(registry.registeredIds()).toEqual([
      "cluster.usage.read",
      "cluster.workloads.read",
      "cypher.query.read",
      "db.operations.read",
      "db.schema.read",
      "etcdctl.query.read",
      "fsquery.query.read",
      "influxql.query.read",
      "kafkaread.query.read",
      "kubectl.query.read",
      "libredbkv.query.read",
      "milvusrpc.query.read",
      "modbusread.query.read",
      "mongo.plan.estimate",
      "mongo.query.read",
      "mongo.schema.read",
      "mongo.table.profile",
      "mqttread.query.read",
      "mtconnectread.query.read",
      "netconfrpc.query.read",
      "opcuaread.query.read",
      "oxiacli.query.read",
      "promql.query.read",
      "qdrantapi.query.read",
      "rabbitread.query.read",
      "rediscli.query.read",
      "s3api.query.read",
      "snmpget.query.read",
      "sparkplugread.query.read",
      "sql.explain.analyze",
      "sql.explain.estimate",
      "sql.query.read",
      "sql.table.profile",
      "weaviateapi.query.read",
    ]);
  });

  test("the provider schema read is R0 metadata, and takes no input at all", () => {
    // R0 for the same reason the curated reading is: an R1 descriptor must NAME the
    // mechanism bounding it, and a provider call has no statement for a read-only
    // transaction to bound. What bounds this one is that its input is
    // EMPTY — there is no selector to widen and nothing a model wrote reaches an
    // engine.
    expect(dbSchemaReadDescriptor).toMatchObject({
      id: "db.schema.read",
      riskClass: 0,
      accessLevel: "metadata-read",
      requiresApproval: false,
      supportsDryRun: false,
      requiredCapabilities: [],
    });
    expect(dbSchemaReadDescriptor.verification).toBeUndefined();
    // Heavy, not light, unlike the curated reading it is modelled on: this call is
    // N+1 round trips on most engines and samples documents on two of them.
    expect(dbSchemaReadDescriptor.resourceCost).toBe("heavy");
    // The empty object is the ONLY accepted input: `getSchema()` takes no argument, so
    // anything else is a caller that thinks it can narrow a reading it cannot.
    expect(dbSchemaReadDescriptor.inputSchema.safeParse({}).success).toBe(true);
    expect(dbSchemaReadDescriptor.inputSchema.safeParse({ sql: "SELECT 1" }).success).toBe(false);
    expect(dbSchemaReadDescriptor.inputSchema.safeParse({ kind: "sessions" }).success).toBe(false);
    expect(dbSchemaReadDescriptor.inputSchema.safeParse({ schema: "public" }).success).toBe(false);
  });

  test("the curated operational read is R0 metadata, and takes no statement at all", () => {
    // R0 rather than R1, and that is a claim about what bounds it rather than a way
    // around the verification marker: an R1 descriptor must NAME the mechanism
    // bounding it, and a curated provider call has none: there is no
    // statement for a read-only transaction to bound. What bounds it is the shape of
    // the input, which carries a kind out of a closed enum and nothing a model wrote.
    expect(dbOperationsReadDescriptor).toMatchObject({
      id: "db.operations.read",
      riskClass: 0,
      accessLevel: "metadata-read",
      requiresApproval: false,
      supportsDryRun: false,
    });
    expect(dbOperationsReadDescriptor.verification).toBeUndefined();
    // The structural difference from every other descriptor: no `sql` field exists,
    // so a statement cannot be smuggled through this operation at all.
    expect(dbOperationsReadDescriptor.inputSchema.safeParse({ sql: "SELECT 1" }).success).toBe(false);
    expect(dbOperationsReadDescriptor.inputSchema.safeParse({ kind: "sessions", sql: "SELECT 1" }).success).toBe(false);
    expect(dbOperationsReadDescriptor.inputSchema.safeParse({ kind: "sessions", limit: 25 }).success).toBe(true);
    // `kind` is required: unlike `inspect_schema`'s selector there is no historical
    // meaning for its absence, so a missing one is refused rather than defaulted.
    expect(dbOperationsReadDescriptor.inputSchema.safeParse({}).success).toBe(false);
    expect(dbOperationsReadDescriptor.inputSchema.safeParse({ kind: "tablespaces" }).success).toBe(false);
  });

  test("profiling is a bounded DATA read that needs no approval, and is separately auditable", () => {
    expect(sqlTableProfileDescriptor).toMatchObject({
      id: "sql.table.profile",
      riskClass: 1,
      accessLevel: "data-read",
      requiresApproval: false,
      resourceCost: "heavy",
      supportsDryRun: false,
    });
    // R1 is registrable only with a substantive verification marker naming its
    // boundary; the registry refuses a blank one.
    expect(sqlTableProfileDescriptor.verification?.boundary).toContain("READ ONLY");
    expect(sqlTableProfileDescriptor.verification?.reviewedBy).toContain("#330");
  });

  test("resolves every canonical id to its descriptor", () => {
    const registry = createCanonicalOperationRegistry();
    for (const descriptor of canonicalDescriptors) {
      const resolution = registry.resolve(descriptor.id);
      expect(resolution.kind).toBe("resolved");
      if (resolution.kind === "resolved") expect(resolution.descriptor.id).toBe(descriptor.id);
    }
  });

  test("denies unregistered operations with a reason code", () => {
    const registry = createCanonicalOperationRegistry();
    const resolution = registry.resolve("sql.query.write");
    expect(resolution).toEqual({ kind: "denied", reasonCode: "UNKNOWN_OPERATION", requestedId: "sql.query.write" });
  });
});

describe("sql.query.read", () => {
  test("is a verified bounded read: risk class 1 with a substantive verification marker", () => {
    expect(sqlQueryReadDescriptor.id).toBe("sql.query.read");
    expect(sqlQueryReadDescriptor.riskClass).toBe(1);
    expect(sqlQueryReadDescriptor.accessLevel).toBe("data-read");
    expect(sqlQueryReadDescriptor.resourceCost).toBe("heavy");
    expect(sqlQueryReadDescriptor.supportsDryRun).toBe(false);
    expect(sqlQueryReadDescriptor.requiresApproval).toBe(false);
    expect(sqlQueryReadDescriptor.verification?.reviewedBy.trim().length).toBeGreaterThan(0);
    expect(sqlQueryReadDescriptor.verification?.boundary).toContain("READ ONLY");
    expect(sqlQueryReadDescriptor.verification?.boundary).toContain("query_only");
    // The marker must state what each SQLite control actually covers. An
    // earlier version claimed the read-only open alone was the boundary, which
    // was false for writes to OTHER files (VACUUM INTO) — and the two
    // assertions above were satisfied by that false wording too.
    expect(sqlQueryReadDescriptor.verification?.boundary).toContain("before every statement");
    expect(sqlQueryReadDescriptor.verification?.boundary).toContain("other files");
    // Same correction on the PostgreSQL half: a read-only transaction forbids
    // changing the database, not writing server files or running programs
    // (verified on 18), so the least-privilege role is part of the boundary and
    // the marker has to say so.
    expect(sqlQueryReadDescriptor.verification?.boundary).toContain("least-privilege role verified at open");
    expect(sqlQueryReadDescriptor.verification?.boundary).toContain("program execution");
  });
});

describe("the statement-read operations", () => {
  test("are exactly the reads a model writes a statement for, one per language", () => {
    // A profile is a data read too, but its statement is the server's, and a plan's
    // statement is described rather than run: neither is one, or `present_answer`
    // would accept what it refuses on SQL today. That holds of MongoDB's plan and
    // profile exactly as of SQL's.
    const ids = createCanonicalOperationRegistry().registeredIds();
    expect(ids.filter(isStatementReadOperation).sort()).toEqual([
      "cypher.query.read",
      "etcdctl.query.read",
      "fsquery.query.read",
      "influxql.query.read",
      "kafkaread.query.read",
      "kubectl.query.read",
      "libredbkv.query.read",
      "milvusrpc.query.read",
      "modbusread.query.read",
      "mongo.query.read",
      "mqttread.query.read",
      "mtconnectread.query.read",
      "netconfrpc.query.read",
      "opcuaread.query.read",
      "oxiacli.query.read",
      "promql.query.read",
      "qdrantapi.query.read",
      "rabbitread.query.read",
      "rediscli.query.read",
      "s3api.query.read",
      "snmpget.query.read",
      "sparkplugread.query.read",
      "sql.query.read",
      "weaviateapi.query.read",
    ]);
    expect(isStatementReadOperation("mongo.plan.estimate")).toBe(false);
    expect(isStatementReadOperation("mongo.table.profile")).toBe(false);
  });

  test("an unknown id is not one", () => {
    expect(isStatementReadOperation("nope.read")).toBe(false);
  });
});

describe("kubectl.query.read", () => {
  test("is R1 data-read, heavy, never approval-gated and registered", () => {
    expect(kubectlQueryReadDescriptor).toMatchObject({
      id: "kubectl.query.read",
      riskClass: 1,
      accessLevel: "data-read",
      resourceCost: "heavy",
      requiresApproval: false,
      supportsDryRun: false,
      requiredCapabilities: [],
    });
    // Asserted on what the registry RESOLVES, not on the descriptor constant: a
    // descriptor that is defined and never registered would satisfy the block above.
    const resolution = createCanonicalOperationRegistry().resolve("kubectl.query.read");
    if (resolution.kind !== "resolved") throw new Error(`expected resolved, got ${resolution.kind}`);
    expect(resolution.descriptor.riskClass).toBe(1);
    expect(resolution.descriptor.accessLevel).toBe("data-read");
    expect(resolution.descriptor.requiresApproval).toBe(false);
  });

  test("names the request allowlist and RBAC as its boundary, and says the reader is not it", () => {
    const boundary = kubectlQueryReadDescriptor.verification?.boundary ?? "";
    expect(boundary).toContain("request allowlist");
    expect(boundary).toContain("RBAC");
    expect(boundary).toContain("The kubectl reader is not this boundary");
  });

  test("takes one statement and nothing else", () => {
    const schema = kubectlQueryReadDescriptor.inputSchema;
    expect(schema.safeParse({ statement: "get pods -n shop" }).success).toBe(true);
    expect(schema.safeParse({ sql: "get pods -n shop" }).success).toBe(false);
    expect(schema.safeParse({ statement: "get pods", extra: 1 }).success).toBe(false);
  });
});

describe("cluster.usage.read", () => {
  test("is R1 data-read, heavy, never approval-gated, registered, and bounded as kubectl.query.read is", () => {
    expect(clusterUsageReadDescriptor).toMatchObject({
      id: "cluster.usage.read",
      riskClass: 1,
      accessLevel: "data-read",
      resourceCost: "heavy",
      requiresApproval: false,
      supportsDryRun: false,
      requiredCapabilities: [],
    });
    expect(clusterUsageReadDescriptor.verification?.boundary).toBe(kubectlQueryReadDescriptor.verification?.boundary);
    const resolution = createCanonicalOperationRegistry().resolve("cluster.usage.read");
    if (resolution.kind !== "resolved") throw new Error(`expected resolved, got ${resolution.kind}`);
    expect(resolution.descriptor.riskClass).toBe(1);
    // A curated reading, not a statement the model wrote.
    expect(isStatementReadOperation("cluster.usage.read")).toBe(false);
  });

  test("takes a namespace name and an optional label selector that is not blank, and nothing else", () => {
    const schema = clusterUsageReadDescriptor.inputSchema;
    expect(schema.safeParse({ namespace: "shop" }).success).toBe(true);
    expect(schema.safeParse({ namespace: "shop", selector: "app=web" }).success).toBe(true);
    expect(schema.safeParse({ namespace: "Shop" }).success).toBe(false);
    expect(schema.safeParse({ namespace: "-shop" }).success).toBe(false);
    expect(schema.safeParse({ namespace: "a".repeat(64) }).success).toBe(false);
    expect(schema.safeParse({ namespace: "shop", selector: "" }).success).toBe(false);
    expect(schema.safeParse({ namespace: "shop", selector: "   " }).success).toBe(false);
    expect(schema.safeParse({ namespace: "shop", selector: "a".repeat(1025) }).success).toBe(false);
    expect(schema.safeParse({ namespace: "shop", statement: "get pods" }).success).toBe(false);
  });
});

describe("cluster.workloads.read", () => {
  test("is R1 data-read, heavy, never approval-gated, registered, and bounded as kubectl.query.read is", () => {
    expect(clusterWorkloadsReadDescriptor).toMatchObject({
      id: "cluster.workloads.read",
      riskClass: 1,
      accessLevel: "data-read",
      resourceCost: "heavy",
      requiresApproval: false,
      supportsDryRun: false,
      requiredCapabilities: [],
    });
    expect(clusterWorkloadsReadDescriptor.verification?.boundary).toBe(
      kubectlQueryReadDescriptor.verification?.boundary,
    );
    const resolution = createCanonicalOperationRegistry().resolve("cluster.workloads.read");
    if (resolution.kind !== "resolved") throw new Error(`expected resolved, got ${resolution.kind}`);
    expect(resolution.descriptor.riskClass).toBe(1);
    expect(isStatementReadOperation("cluster.workloads.read")).toBe(false);
  });

  test("takes a namespace name and nothing else", () => {
    const schema = clusterWorkloadsReadDescriptor.inputSchema;
    expect(schema.safeParse({ namespace: "shop" }).success).toBe(true);
    expect(schema.safeParse({ namespace: "Shop" }).success).toBe(false);
    expect(schema.safeParse({ namespace: "-shop" }).success).toBe(false);
    expect(schema.safeParse({ namespace: "a".repeat(64) }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ namespace: "shop", selector: "app=web" }).success).toBe(false);
  });
});

describe("plan inspection vs plan execution", () => {
  test("are distinct descriptors aligned with the explain seam's estimate/analyze modes", () => {
    expect(sqlExplainEstimateDescriptor.id).toBe("sql.explain.estimate");
    expect(sqlExplainAnalyzeDescriptor.id).toBe("sql.explain.analyze");
    expect(sqlExplainEstimateDescriptor.id).not.toBe(sqlExplainAnalyzeDescriptor.id);
  });

  test("plan inspection is metadata-only risk class 0 and needs no approval", () => {
    expect(sqlExplainEstimateDescriptor.riskClass).toBe(0);
    expect(sqlExplainEstimateDescriptor.accessLevel).toBe("metadata-read");
    expect(sqlExplainEstimateDescriptor.requiresApproval).toBe(false);
    // No capability at all, and its docblock argues why: `supportsExplain` is the
    // EDITOR's flag, the agent composes its own estimating form per dialect, and
    // requiring the editor's flag denied `inspect_plan` on SQL Server (an engine with
    // a verified agent plan and no editor Explain), so the workflow that needs a plan
    // could not complete there. The executing variant below still declares it.
    expect(sqlExplainEstimateDescriptor.requiredCapabilities).toEqual([]);
    expect(sqlExplainAnalyzeDescriptor.requiredCapabilities).toContain("supportsExplain");
  });

  test("plan execution is default-denied: verified risk class 1 that always requires approval", () => {
    expect(sqlExplainAnalyzeDescriptor.riskClass).toBe(1);
    expect(sqlExplainAnalyzeDescriptor.accessLevel).toBe("data-read");
    expect(sqlExplainAnalyzeDescriptor.requiresApproval).toBe(true);
    expect(sqlExplainAnalyzeDescriptor.requiredCapabilities).toContain("supportsExplain");
    expect(sqlExplainAnalyzeDescriptor.verification?.boundary.trim().length).toBeGreaterThan(0);
  });
});

describe("canonical input schemas", () => {
  test("accept exactly one non-empty SQL statement string", () => {
    for (const descriptor of sqlDescriptors) {
      expect(descriptor.inputSchema.safeParse({ sql: "SELECT 1" }).success).toBe(true);
    }
  });

  test("reject missing, empty, or non-string sql and any unknown key (fail closed)", () => {
    const hostileInputs = [
      {},
      { sql: "" },
      { sql: 1 },
      { sql: "SELECT 1", extra: true },
      "SELECT 1",
      null,
      undefined,
      [],
    ];
    for (const descriptor of sqlDescriptors) {
      for (const input of hostileInputs) {
        expect(descriptor.inputSchema.safeParse(input).success).toBe(false);
      }
    }
  });
});

describe("the MongoDB composed profile", () => {
  /**
   * A profile's `$group` in the shape `languages/mongo/tools.ts` composes it at pattern depth: a presence count for
   * every field, and the two shape tests for every textual one, over `fields` fields whose dotted names are
   * `nameLength` long.
   */
  function composedProfile(fields: number, nameLength: number): string {
    const group: Record<string, unknown> = { _id: null, row_count: { $sum: 1 } };
    for (let index = 0; index < fields; index += 1) {
      const path = `$${`f${index}.`.padEnd(nameLength, "x")}`;
      const textual = { $eq: [{ $type: path }, "string"] };
      group[`present_${index}`] = { $sum: { $cond: [{ $in: [{ $type: path }, ["missing", "null"]] }, 0, 1] } };
      group[`shaped_${index}`] = {
        $sum: { $cond: [{ $and: [textual, { $regexMatch: { input: path, regex: ".@.+\\..", options: "s" } }] }, 1, 0] },
      };
      group[`digits_${index}`] = {
        $sum: {
          $cond: [{ $and: [textual, { $regexMatch: { input: path, regex: "[0-9]{9,}", options: "s" } }] }, 1, 0],
        },
      };
    }
    return JSON.stringify({
      collection: "orders",
      database: "app",
      operation: "aggregate",
      pipeline: [{ $group: group }],
    });
  }

  test("admits the composed command past the cap a model's command is held to, because the server wrote it", () => {
    // Sixteen fields (MAX_PROFILE_COLUMNS) with long nested paths: field names have no length bound, so a batch
    // sized by count still composes far past the 4,096 characters that bound text a model writes.
    const command = composedProfile(16, 120);
    expect(command.length).toBeGreaterThan(4096);
    expect(mongoTableProfileDescriptor.inputSchema.safeParse({ command }).success).toBe(true);
    expect(mongoQueryReadDescriptor.inputSchema.safeParse({ command }).success).toBe(false);
  });

  test("holds the composed command to 65,536 characters, measured on a command the reader admits", () => {
    /** A count the reader admits, its filter's one value padded so the whole command is exactly `length` long. */
    const sized = (length: number): string => {
      const head = '{"collection":"orders","operation":"count","filter":{"note":"';
      const tail = '"}}';
      return `${head}${"x".repeat(length - head.length - tail.length)}${tail}`;
    };
    expect(sized(65_536)).toHaveLength(65_536);
    expect(mongoTableProfileDescriptor.inputSchema.safeParse({ command: sized(65_536) }).success).toBe(true);
    // One character past the bound, and the length is the only thing refused: the reader admits the command.
    const over = mongoTableProfileDescriptor.inputSchema.safeParse({ command: sized(65_537) });
    expect(over.error?.issues.map((issue) => issue.code)).toEqual(["too_big"]);
  });

  test("still reads the composed command with the reader every command meets", () => {
    const write = JSON.stringify({ collection: "orders", operation: "aggregate", pipeline: [{ $out: "copy" }] });
    expect(mongoTableProfileDescriptor.inputSchema.safeParse({ command: write }).success).toBe(false);
    expect(mongoTableProfileDescriptor.inputSchema.safeParse({ sql: composedProfile(1, 8) }).success).toBe(false);
  });
});

describe("the MongoDB boundaries", () => {
  test("name what the profile proves, and none of the claims a live probe measured false", () => {
    // Measured during review: an explain with candidate plans runs each for a trial, explain carried no deadline of
    // its own, a client timer only stops waiting, and a principal with write privileges on another database passed
    // the write probe on this one.
    const boundaries = [mongoQueryReadDescriptor, mongoPlanEstimateDescriptor, mongoTableProfileDescriptor].map(
      (descriptor) => descriptor.verification?.boundary ?? "",
    );
    for (const boundary of boundaries) {
      expect(boundary).not.toMatch(
        /no document is touched|ends a silent server|no write-capable connection is admitted|bounds the planning itself/,
      );
    }
    expect(mongoQueryReadDescriptor.verification?.boundary).toContain("privileges read as reads");
    expect(mongoQueryReadDescriptor.verification?.boundary).toContain("kills the session");
    expect(mongoPlanEstimateDescriptor.verification?.boundary).toContain("bounded trial");
  });

  test("count a cursor's documents in BSON bytes before decoding, and say a distinct's reply is decoded whole first", () => {
    // The driver decodes a command's reply even when asked for it raw (`distinctWithinBudget` in agent-read.ts), so
    // the before-decode measure holds for the documents a cursor yields and not for the one reply a distinct answers.
    const boundary = mongoQueryReadDescriptor.verification?.boundary ?? "";
    expect(boundary).toContain("a cursor's documents are counted in BSON bytes before they are decoded");
    expect(boundary).toContain(
      "a distinct's one reply, which the server holds to 16 MiB, is decoded whole before its values are counted",
    );
    expect(boundary).not.toMatch(/(?<!a cursor's )documents are counted in BSON bytes/);
  });
});

describe("the R1 boundary contract", () => {
  // R1 admits the engine's own read-only mechanism, or, where the engine has none,
  // a Studio-enforced allowlist on the final request plus the identity's own
  // authorization. Never a parser: a later descriptor that names one fails here.
  test("every R1 descriptor names its boundary, and none names the parser as it", () => {
    for (const id of [
      "sql.query.read",
      "sql.explain.analyze",
      "sql.table.profile",
      "kubectl.query.read",
      "cluster.usage.read",
      "cluster.workloads.read",
      "mongo.query.read",
      "mongo.plan.estimate",
      "mongo.table.profile",
    ]) {
      const resolution = createCanonicalOperationRegistry().resolve(id);
      if (resolution.kind !== "resolved") throw new Error(`expected ${id} resolved, got ${resolution.kind}`);
      const { descriptor } = resolution;
      if (descriptor.riskClass !== 1) throw new Error(`expected ${id} at R1, got R${descriptor.riskClass}`);
      const boundary = descriptor.verification.boundary;
      expect(boundary.trim().length).toBeGreaterThan(0);
      expect(boundary).not.toMatch(/\bparser (is|bounds)\b/i);
    }
  });
});
