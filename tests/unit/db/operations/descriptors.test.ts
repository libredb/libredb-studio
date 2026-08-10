import { describe, test, expect } from "bun:test";
import {
  createCanonicalOperationRegistry,
  sqlExplainAnalyzeDescriptor,
  sqlExplainEstimateDescriptor,
  sqlQueryReadDescriptor,
} from "@/lib/db/operations/descriptors";

const canonicalDescriptors = [sqlQueryReadDescriptor, sqlExplainEstimateDescriptor, sqlExplainAnalyzeDescriptor];

describe("canonical operation registry", () => {
  test("registers exactly the three canonical descriptors — no write, DDL, or admin operation exists", () => {
    const registry = createCanonicalOperationRegistry();
    expect(registry.registeredIds()).toEqual(["sql.explain.analyze", "sql.explain.estimate", "sql.query.read"]);
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
    for (const descriptor of canonicalDescriptors) {
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
    for (const descriptor of canonicalDescriptors) {
      for (const input of hostileInputs) {
        expect(descriptor.inputSchema.safeParse(input).success).toBe(false);
      }
    }
  });
});
