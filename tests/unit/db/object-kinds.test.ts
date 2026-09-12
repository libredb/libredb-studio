import { describe, test, expect } from "bun:test";
import type { ProviderCapabilities } from "@/lib/db/types";
import {
  containerDepth,
  declaredKinds,
  findKind,
  kindAcceptsRowWrites,
  relationKindIds,
  isCountSampled,
  isCountUnavailable,
} from "@/lib/db/object-kinds";

const base = { queryLanguage: "sql" } as unknown as ProviderCapabilities;

const withKinds = {
  ...base,
  containerLevels: [
    { id: "catalog", label: "Database", labelPlural: "Databases" },
    { id: "schema", label: "Schema", labelPlural: "Schemas" },
  ],
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
    { id: "view", role: "relation", label: "View", labelPlural: "Views" },
    { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
  ],
} as unknown as ProviderCapabilities;

describe("containerDepth", () => {
  test("an engine that declares nothing has no container level", () => {
    expect(containerDepth(base)).toBe(0);
  });

  test("declared levels are counted, never inferred from the engine", () => {
    expect(containerDepth(withKinds)).toBe(2);
  });

  // Not in the task brief. The one-level answer is the shape most engines have, and the
  // arm that produces it is folded onto a single line, so the 100% line gate is already
  // satisfied by the zero-level and two-level cases while that arm never runs.
  test("a single declared level stays one level, which is the shape most engines have", () => {
    const oneLevel = {
      ...base,
      containerLevels: [{ id: "catalog", label: "Database", labelPlural: "Databases" }],
    } as unknown as ProviderCapabilities;
    expect(containerDepth(oneLevel)).toBe(1);
  });

  /**
   * The CEILING, pinned rather than left implicit (#789). `ContainerLevels` is a tuple union
   * of nought, one or two levels, so this declaration is a compile error where a provider
   * would write one and has to be cast in here. What the cast reaches is the clamp, and the
   * clamp answers two rather than three: the tree models two levels, and every two-level
   * provider's own path validation refuses a three-segment container independently
   * (`tests/integration/db/duckdb-provider.test.ts`, `.../trino-provider.test.ts`).
   */
  test("a third declared level is clamped to two, which is the deepest tree this phase models", () => {
    const threeLevels = {
      ...base,
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
        { id: "schema", label: "Sub-schema", labelPlural: "Sub-schemas" },
      ],
    } as unknown as ProviderCapabilities;
    expect(containerDepth(threeLevels)).toBe(2);
  });
});

describe("declaredKinds", () => {
  test("an engine that declares nothing exposes no kinds, rather than a default set", () => {
    expect(declaredKinds(base)).toEqual([]);
  });

  test("findKind answers undefined for a kind this engine never declared", () => {
    expect(findKind(withKinds, "package")).toBeUndefined();
  });
});

describe("kindAcceptsRowWrites", () => {
  test("an absent flag reads as false, so an undeclared kind is never an import target", () => {
    expect(kindAcceptsRowWrites(withKinds, "view")).toBe(false);
  });

  test("only an explicit true admits a kind", () => {
    expect(kindAcceptsRowWrites(withKinds, "table")).toBe(true);
  });

  test("a kind this engine does not declare is refused rather than assumed", () => {
    expect(kindAcceptsRowWrites(withKinds, "package")).toBe(false);
  });

  // Pins the ruling that this function answers the per-kind half only. Folding the
  // engine-wide `supportsInlineRowEdit` in here would drop MongoDB, Couchbase and
  // Cassandra out of the import target list, and all three declare it false while
  // declaring a kind that takes row writes.
  test("the engine-wide supportsInlineRowEdit is not folded in, so a kind still answers for itself", () => {
    const inlineEditRefused = {
      ...base,
      supportsInlineRowEdit: false,
      objectKinds: [
        { id: "collection", role: "relation", label: "Collection", labelPlural: "Collections", acceptsRowWrites: true },
      ],
    } as unknown as ProviderCapabilities;
    expect(kindAcceptsRowWrites(inlineEditRefused, "collection")).toBe(true);
  });
});

describe("relationKindIds", () => {
  test("consumers filter by role, never by kind id", () => {
    expect(relationKindIds(withKinds)).toEqual(["table", "view"]);
  });
});

describe("isCountUnavailable", () => {
  test("a refused read is a different fact from a zero count", () => {
    expect(isCountUnavailable({ unavailable: "permission denied for schema sales" })).toBe(true);
    expect(isCountUnavailable({ count: 0 })).toBe(false);
  });

  test("a sampled count is a NUMBER, so the refusal predicate must not claim it", () => {
    // The two new-state mistakes a renderer could make are opposite: treating a floor as a
    // refusal (no number at all) or treating a refusal as a floor. Both predicates are
    // asked about both shapes here so neither can start answering the other's question.
    expect(isCountUnavailable({ count: 4, sampledFrom: "one 1,000-key SCAN walk" })).toBe(false);
  });
});

describe("isCountSampled", () => {
  test("a bounded count is a different fact from an exact one and from a refusal", () => {
    expect(isCountSampled({ count: 4, sampledFrom: "one 1,000-key SCAN walk" })).toBe(true);
    expect(isCountSampled({ count: 4 })).toBe(false);
    expect(isCountSampled({ count: 0 })).toBe(false);
    expect(isCountSampled({ unavailable: "permission denied for schema sales" })).toBe(false);
  });

  test("the sentence is the provider's own, and it is what the caller reads", () => {
    const count = { count: 12, sampledFrom: "the first 1,000 keys of one SCAN walk" };
    // Narrowing is the point: a caller holding the union cannot reach `sampledFrom` at all
    // until the predicate has answered, which is what keeps the renderer honest.
    expect(isCountSampled(count) ? count.sampledFrom : "").toBe("the first 1,000 keys of one SCAN walk");
  });
});
