import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { OperationRegistry, OperationRegistrationError } from "@/lib/db/operations/registry";
import type { RegistrableOperationDescriptor, RiskClass, RiskVerification } from "@/lib/db/operations/types";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const verification: RiskVerification = {
  reviewedBy: "registry unit test",
  boundary: "database-native read-only enforcement (test fixture)",
  verifiedOn: "2026-08-10",
};

function readDescriptor(overrides: Partial<Record<string, unknown>> = {}): RegistrableOperationDescriptor {
  // The cast lets tests hand the registry descriptors TypeScript structurally
  // forbids (risk class 2+, missing verification) — runtime refusal of exactly
  // those shapes is the behavior under test.
  return {
    id: "test.operation.read",
    riskClass: 0,
    accessLevel: "metadata-read",
    requiredCapabilities: [],
    resourceCost: "light",
    supportsDryRun: false,
    requiresApproval: false,
    inputSchema: z.strictObject({}),
    ...overrides,
  } as unknown as RegistrableOperationDescriptor;
}

function captureRefusal(fn: () => void): OperationRegistrationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationRegistrationError);
    return error as OperationRegistrationError;
  }
  throw new Error("expected the registration to be refused");
}

// ─── register ───────────────────────────────────────────────────────────────

describe("OperationRegistry.register", () => {
  test("registers a risk-class-0 descriptor and resolves it by exact id", () => {
    const registry = new OperationRegistry();
    registry.register(readDescriptor());
    const resolution = registry.resolve("test.operation.read");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.descriptor.id).toBe("test.operation.read");
      expect(resolution.descriptor.riskClass).toBe(0);
    }
  });

  test("registers a verified risk-class-1 descriptor", () => {
    const registry = new OperationRegistry();
    registry.register(readDescriptor({ riskClass: 1, verification }));
    const resolution = registry.resolve("test.operation.read");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.descriptor.riskClass).toBe(1);
      expect(resolution.descriptor.verification).toEqual(verification);
    }
  });

  test("refuses every risk class above 1 and stores nothing", () => {
    const refusedClasses: RiskClass[] = [2, 3, 4, 5, 6];
    for (const riskClass of refusedClasses) {
      const registry = new OperationRegistry();
      const refusal = captureRefusal(() => registry.register(readDescriptor({ riskClass, verification })));
      expect(refusal.reasonCode).toBe("UNREGISTRABLE_RISK_CLASS");
      const resolution = registry.resolve("test.operation.read");
      expect(resolution.kind).toBe("denied");
      if (resolution.kind === "denied") expect(resolution.reasonCode).toBe("UNKNOWN_OPERATION");
    }
  });

  test("refuses risk classes outside the 0-6 scale and non-integer classes", () => {
    for (const riskClass of [-1, 7, 1.5, Number.NaN, "1", null, undefined]) {
      const registry = new OperationRegistry();
      const refusal = captureRefusal(() => registry.register(readDescriptor({ riskClass, verification })));
      expect(refusal.reasonCode).toBe("UNREGISTRABLE_RISK_CLASS");
    }
  });

  test("refuses an unverified risk-class-1 descriptor exactly like class 2+: error thrown, nothing stored", () => {
    const registry = new OperationRegistry();
    const refusal = captureRefusal(() => registry.register(readDescriptor({ riskClass: 1 })));
    expect(refusal.reasonCode).toBe("UNVERIFIED_RISK_CLASS");
    expect(registry.resolve("test.operation.read").kind).toBe("denied");
  });

  test("refuses a risk-class-1 descriptor whose verification marker is blank or partial", () => {
    const blankMarkers = [
      { reviewedBy: " ", boundary: "b", verifiedOn: "2026-08-10" },
      { reviewedBy: "r", boundary: "", verifiedOn: "2026-08-10" },
      { reviewedBy: "r", boundary: "b", verifiedOn: "   " },
      { reviewedBy: "r", boundary: "b" },
      "verified",
    ];
    for (const marker of blankMarkers) {
      const registry = new OperationRegistry();
      const refusal = captureRefusal(() => registry.register(readDescriptor({ riskClass: 1, verification: marker })));
      expect(refusal.reasonCode).toBe("UNVERIFIED_RISK_CLASS");
      expect(registry.resolve("test.operation.read").kind).toBe("denied");
    }
  });

  test("refuses non-canonical operation ids", () => {
    const invalidIds = [
      "",
      "sql",
      "SQL.Query.Read",
      " sql.query.read",
      "sql.query.read ",
      "sql..read",
      "sql_query.read",
      "sql.query.",
      7,
    ];
    for (const id of invalidIds) {
      const registry = new OperationRegistry();
      const refusal = captureRefusal(() => registry.register(readDescriptor({ id })));
      expect(refusal.reasonCode).toBe("INVALID_OPERATION_ID");
    }
  });

  test("refuses malformed descriptors: non-boolean flags, unknown levels or costs, bad capability lists, missing input schema", () => {
    const malformed: Array<Record<string, unknown>> = [
      { supportsDryRun: "no" },
      { requiresApproval: undefined },
      { accessLevel: "root" },
      { resourceCost: "free" },
      { requiredCapabilities: "supportsExplain" },
      { requiredCapabilities: [""] },
      { requiredCapabilities: [42] },
      { inputSchema: undefined },
      { inputSchema: { safeParse: "not-a-function" } },
    ];
    for (const overrides of malformed) {
      const registry = new OperationRegistry();
      const refusal = captureRefusal(() => registry.register(readDescriptor(overrides)));
      expect(refusal.reasonCode).toBe("MALFORMED_DESCRIPTOR");
      expect(registry.resolve("test.operation.read").kind).toBe("denied");
    }
  });

  test("refuses a duplicate id and keeps the original descriptor untouched", () => {
    const registry = new OperationRegistry();
    registry.register(readDescriptor());
    const refusal = captureRefusal(() => registry.register(readDescriptor({ requiresApproval: true })));
    expect(refusal.reasonCode).toBe("DUPLICATE_OPERATION_ID");
    const resolution = registry.resolve("test.operation.read");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") expect(resolution.descriptor.requiresApproval).toBe(false);
  });

  test("stores an immutable snapshot: later mutation of the caller's object never reaches the registry", () => {
    const registry = new OperationRegistry();
    const original = readDescriptor({ riskClass: 1, verification: { ...verification } });
    registry.register(original);
    (original as unknown as { requiresApproval: boolean }).requiresApproval = true;
    (original.verification as { boundary: string }).boundary = "tampered";
    const resolution = registry.resolve("test.operation.read");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.descriptor.requiresApproval).toBe(false);
      expect(resolution.descriptor.verification?.boundary).toBe(verification.boundary);
      expect(Object.isFrozen(resolution.descriptor)).toBe(true);
      expect(Object.isFrozen(resolution.descriptor.requiredCapabilities)).toBe(true);
      expect(Object.isFrozen(resolution.descriptor.verification)).toBe(true);
    }
  });
});

// ─── resolve ────────────────────────────────────────────────────────────────

describe("OperationRegistry.resolve", () => {
  test("denies an unknown id with a reason code — never undefined, never a throw", () => {
    const registry = new OperationRegistry();
    const resolution = registry.resolve("sql.query.write");
    expect(resolution).toEqual({ kind: "denied", reasonCode: "UNKNOWN_OPERATION", requestedId: "sql.query.write" });
  });

  test("denies as ambiguous an id that only normalizes to a registered one — the registry never guesses", () => {
    const registry = new OperationRegistry();
    registry.register(readDescriptor());
    for (const requestedId of [
      "Test.Operation.Read",
      "TEST.OPERATION.READ",
      " test.operation.read ",
      "test.operation.read\n",
    ]) {
      const resolution = registry.resolve(requestedId);
      expect(resolution.kind).toBe("denied");
      if (resolution.kind === "denied") {
        expect(resolution.reasonCode).toBe("AMBIGUOUS_OPERATION");
        expect(resolution.requestedId).toBe(requestedId);
      }
    }
  });

  test("denies normalized non-matches as unknown, not ambiguous", () => {
    const registry = new OperationRegistry();
    registry.register(readDescriptor());
    const resolution = registry.resolve("Test Operation Read");
    expect(resolution.kind).toBe("denied");
    if (resolution.kind === "denied") expect(resolution.reasonCode).toBe("UNKNOWN_OPERATION");
  });

  test("denies the empty string and non-string input without throwing", () => {
    const registry = new OperationRegistry();
    registry.register(readDescriptor());
    expect(registry.resolve("").kind).toBe("denied");
    for (const hostile of [null, undefined, 42, { id: "test.operation.read" }]) {
      const resolution = registry.resolve(hostile as unknown as string);
      expect(resolution.kind).toBe("denied");
      if (resolution.kind === "denied") expect(resolution.reasonCode).toBe("UNKNOWN_OPERATION");
    }
  });

  test("lists registered ids deterministically sorted", () => {
    const registry = new OperationRegistry();
    registry.register(readDescriptor({ id: "test.zeta.read" }));
    registry.register(readDescriptor({ id: "test.alpha.read" }));
    expect(registry.registeredIds()).toEqual(["test.alpha.read", "test.zeta.read"]);
  });
});
