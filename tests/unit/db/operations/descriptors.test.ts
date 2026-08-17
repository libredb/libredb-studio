import { describe, test, expect } from "bun:test";
import {
  createCanonicalOperationRegistry,
  dbOperationsReadDescriptor,
  dbSchemaReadDescriptor,
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

const canonicalDescriptors = [...sqlDescriptors, dbOperationsReadDescriptor, dbSchemaReadDescriptor];

describe("canonical operation registry", () => {
  test("registers exactly the six canonical descriptors — no write, DDL, or admin operation exists", () => {
    // Six since #414, which gave the provider's own schema inspection an id so that
    // grounding on an engine with no composed catalog goes through the audited path
    // rather than beside it. Five since the `operations` workflow, which added the
    // first descriptor carrying no statement at all (`docs/BACKLOG.md` B27). Four
    // since #330 T3, which reopened a decision epic #325 had pinned at three.
    // The assertion is exact-array equality on purpose: it is the one place a
    // descriptor can be added without somebody noticing.
    const registry = createCanonicalOperationRegistry();
    expect(registry.registeredIds()).toEqual([
      "db.operations.read",
      "db.schema.read",
      "sql.explain.analyze",
      "sql.explain.estimate",
      "sql.query.read",
      "sql.table.profile",
    ]);
  });

  test("the provider schema read is R0 metadata, and takes no input at all", () => {
    // R0 for the same reason the curated reading is: an R1 descriptor must NAME the
    // database-native mechanism bounding it, and a provider call has no statement for
    // a read-only transaction to bound. What bounds this one is that its input is
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
    // around the verification marker: an R1 descriptor must NAME the database-native
    // mechanism bounding it, and a curated provider call has none — there is no
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
    // R1 is registrable only with a substantive verification marker naming a
    // database-native boundary; the registry refuses a blank one.
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
    expect(sqlExplainEstimateDescriptor.requiredCapabilities).toContain("supportsExplain");
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
