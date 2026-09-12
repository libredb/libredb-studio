import { describe, test, expect } from "bun:test";
import type { ObjectSourcePart, ProviderCapabilities } from "@/lib/db/types";
import {
  containerDepth,
  declaredKinds,
  findKind,
  kindAcceptsRowWrites,
  relationKindIds,
  isCountSampled,
  isCountUnavailable,
  kindHasSource,
  isSourcePartUnavailable,
  applySourceBound,
  sourceBoundTruncationReason,
  SOURCE_CHARACTER_LIMIT,
  SOURCE_PART_LIMIT,
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

describe("kindHasSource", () => {
  test("an absent flag reads as false, so an undeclared kind never offers a Source tab", () => {
    expect(kindHasSource(withKinds, "view")).toBe(false);
  });

  test("a kind this engine never declared reads as false rather than throwing", () => {
    expect(kindHasSource(withKinds, "package")).toBe(false);
  });

  test("a declared flag reads as true", () => {
    const caps = {
      ...withKinds,
      objectKinds: [{ id: "function", role: "routine", label: "F", labelPlural: "Fs", hasSource: true }],
    } as unknown as ProviderCapabilities;
    expect(kindHasSource(caps, "function")).toBe(true);
  });
});

describe("isSourcePartUnavailable", () => {
  const refused: ObjectSourcePart = { id: "definition", label: "Definition", unavailable: "Encrypted." };
  const readable: ObjectSourcePart = {
    id: "definition",
    label: "Definition",
    text: "SELECT 1",
    language: "sql",
    form: "complete",
    origin: "stored",
  };

  test("narrows a refusal", () => {
    expect(isSourcePartUnavailable(refused)).toBe(true);
  });

  test("narrows a readable part in the other direction, so the caller reaches text", () => {
    expect(isSourcePartUnavailable(readable)).toBe(false);
    // The values walked here are typed as the WHOLE union and are NOT narrowed by their own
    // initializers, which is the only shape in which the predicate's FALSE branch is
    // load-bearing. MEASURED: with `readonly` dropped from the three members of the
    // predicate's return type, `part.text` below is TS2339 and `bun run typecheck` fails on
    // this file. The earlier spelling of this test narrowed a `const` at its declaration, so
    // `.text` resolved whether the predicate narrowed the false branch or not, and the same
    // mutation left this file with zero errors.
    const parts: readonly ObjectSourcePart[] = [readable, refused];
    const texts: string[] = [];
    for (const part of parts) {
      if (isSourcePartUnavailable(part)) continue;
      texts.push(part.text);
    }
    expect(texts).toEqual(["SELECT 1"]);
  });
});

describe("applySourceBound", () => {
  test("an unbounded call marks nothing, because marking an exact answer teaches a reader to discount every mark", () => {
    const bounded = applySourceBound("SELECT 1", undefined);

    expect(bounded).toEqual({ text: "SELECT 1" });
    // `toEqual` IGNORES an explicitly-undefined property, so the line above passes for an
    // implementation answering `{ text, truncated: undefined }`. The part shape and the
    // source route both read the KEY's ABSENCE, so the key is what is asserted.
    expect(Object.hasOwn(bounded, "truncated")).toBe(false);
  });

  test("a text that fits its bound is not marked either", () => {
    const bounded = applySourceBound("SELECT 1", 8);

    expect(bounded).toEqual({ text: "SELECT 1" });
    expect(Object.hasOwn(bounded, "truncated")).toBe(false);
  });

  test("a text over its bound is sliced and marked with the one sentence", () => {
    const bounded = applySourceBound("SELECT 1", 6);
    expect(bounded.text).toBe("SELECT");
    expect(bounded.truncated).toEqual({ limit: 6, reason: sourceBoundTruncationReason(6) });
  });

  /*
    A bound cuts UTF-16 CODE UNITS, and an astral character is two of them. A PL/pgSQL body
    or a Lua library holding an emoji or an astral CJK character, bounded at exactly the
    offset between the pair, would otherwise end in an unpaired high surrogate: JSON
    serializes it as a lone \ud83d and Monaco renders a replacement glyph. Redis cannot
    reach this through its own fixture, and every one of the remaining sixteen providers
    routes its text through this one function, which is why the guard lives here.
  */
  test("a bound landing inside a surrogate pair cuts before it, never emitting a lone surrogate", () => {
    const bounded = applySourceBound("a\u{1F600}b", 2);

    expect(bounded.text).toBe("a");
    expect([...bounded.text]).toHaveLength(1);
    // The mark still names the CALLER's number. It is the bound that was asked for, and a
    // provider reporting the emitted length instead would tell a reader a bound it never set.
    expect(bounded.truncated).toEqual({ limit: 2, reason: sourceBoundTruncationReason(2) });
  });

  test("a bound landing after a whole surrogate pair keeps the pair", () => {
    const bounded = applySourceBound("a\u{1F600}b", 3);

    expect(bounded.text).toBe("a\u{1F600}");
    expect([...bounded.text]).toHaveLength(2);
  });

  test("a bound of zero answers an empty text rather than reading past the start", () => {
    const bounded = applySourceBound("SELECT 1", 0);

    expect(bounded.text).toBe("");
    expect(bounded.truncated).toEqual({ limit: 0, reason: sourceBoundTruncationReason(0) });
  });
});

describe("the source bounds", () => {
  test("the character bound is the one number the route applies", () => {
    expect(SOURCE_CHARACTER_LIMIT).toBe(1_000_000);
  });

  test("the part bound is four times the largest shape any engine in the fleet produces", () => {
    expect(SOURCE_PART_LIMIT).toBe(8);
  });

  test("the bound sentence names the number and the caller", () => {
    expect(sourceBoundTruncationReason(1_000_000)).toBe(
      "the source read was bounded at 1,000,000 characters by its caller",
    );
  });
});
