import { describe, test, expect } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { ContainerLevelSpec, ObjectKindSpec, ObjectSourcePart, ProviderCapabilities } from "@/lib/db/types";
import {
  acceptedContainerShapes,
  assertContainerPathShape,
  type ContainerPathShapeEngine,
  containerDepth,
  declaredKinds,
  enumerableKinds,
  findKind,
  keyBrowserKind,
  kindAcceptsRowWrites,
  offersTestDataGeneration,
  kindCountIsListing,
  relationKindIds,
  isCountSampled,
  isCountUnavailable,
  kindHasColumns,
  kindHasSource,
  isSourcePartUnavailable,
  applySourceBound,
  sourceBoundTruncationReason,
  SOURCE_CHARACTER_LIMIT,
  SOURCE_PART_LIMIT,
  requireSourceKind,
  kindAcceptsSourceEdits,
  requireEditableKind,
  renderContainerShapes,
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

/**
 * A kind only the Keys panel enumerates (#1089 3.4). etcd declares one, `key`, because the Source tab
 * and the guarded edit need a declared kind, while a folder, an inventory listing or a line of plan
 * mode's prompt per key would put key names where the tree and the agent read them. So the kind leaves
 * every walk over all kinds and still resolves by id.
 */
describe("enumerableKinds and keyBrowserKind", () => {
  const withKeyBrowser = {
    ...base,
    containerLevels: [],
    keyScan: { defaultCount: 500, maxCount: 1000 },
    objectKinds: [
      { id: "prefix", role: "relation", label: "Key Prefix", labelPlural: "Key Prefixes" },
      {
        id: "key",
        role: "config",
        label: "Key",
        labelPlural: "Keys",
        enumeratedBy: "key-browser",
        hasSource: true,
        sourceLanguage: "json",
        acceptsSourceEdits: true,
      },
      {
        id: "member",
        role: "config",
        label: "Member",
        labelPlural: "Members",
        hasSource: true,
        sourceLanguage: "json",
      },
    ],
  } as unknown as ProviderCapabilities;
  const engine = { displayName: "A key-value engine", type: "redis" } as const;

  test("with no enumeratedBy anywhere, every declared kind is enumerable, in declaration order", () => {
    expect(enumerableKinds(withKinds).map((kind) => kind.id)).toEqual(["table", "view", "procedure"]);
    expect(enumerableKinds(base)).toEqual([]);
  });

  test("a kind the Keys panel enumerates leaves the enumerable kinds and stays among the declared ones", () => {
    expect(enumerableKinds(withKeyBrowser).map((kind) => kind.id)).toEqual(["prefix", "member"]);
    expect(declaredKinds(withKeyBrowser).map((kind) => kind.id)).toEqual(["prefix", "key", "member"]);
  });

  test("keyBrowserKind names that one kind, and is undefined on every engine that declares none", () => {
    expect(keyBrowserKind(withKeyBrowser)?.id).toBe("key");
    expect(keyBrowserKind(withKinds)).toBeUndefined();
    expect(keyBrowserKind(base)).toBeUndefined();
  });

  test("the kind still resolves by id, so its Source tab and both edit routes reach it", () => {
    expect(findKind(withKeyBrowser, "key")?.enumeratedBy).toBe("key-browser");
    expect(kindHasSource(withKeyBrowser, "key")).toBe(true);
    expect(kindAcceptsSourceEdits(withKeyBrowser, "key")).toBe(true);
    expect(requireSourceKind(withKeyBrowser, "key", engine).sourceLanguage).toBe("json");
    expect(requireEditableKind(withKeyBrowser, "key", engine).id).toBe("key");
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

describe("offersTestDataGeneration", () => {
  const generating = { ...withKinds, supportsTestDataGeneration: true } as ProviderCapabilities;

  test("a kind that takes row writes on an engine that declares the generator is offered it", () => {
    expect(offersTestDataGeneration(generating, "table")).toBe(true);
  });

  test("an absent flag reads as not offered, even on a kind that takes row writes", () => {
    expect(offersTestDataGeneration(withKinds, "table")).toBe(false);
    expect(offersTestDataGeneration({ ...withKinds, supportsTestDataGeneration: false }, "table")).toBe(false);
  });

  test("the per-kind row-write rule still applies on top of the engine flag", () => {
    expect(offersTestDataGeneration(generating, "view")).toBe(false);
    expect(offersTestDataGeneration(generating, "package")).toBe(false);
  });

  // The generator writes `insertMany` on MongoDB, which has no `UPDATE ... SET` for the grid's
  // inline editor, so the grid's flag must not decide it in either direction.
  test("the results grid's supportsInlineRowEdit is not consulted", () => {
    const collection = {
      ...base,
      objectKinds: [
        { id: "collection", role: "relation", label: "Collection", labelPlural: "Collections", acceptsRowWrites: true },
      ],
    } as unknown as ProviderCapabilities;
    expect(
      offersTestDataGeneration(
        { ...collection, supportsInlineRowEdit: false, supportsTestDataGeneration: true },
        "collection",
      ),
    ).toBe(true);
    expect(
      offersTestDataGeneration(
        { ...collection, supportsInlineRowEdit: true, supportsTestDataGeneration: false },
        "collection",
      ),
    ).toBe(false);
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

/**
 * A kind whose count and listing are one read (#1089 3.4, 4.7), which etcd's leases, users and roles
 * are: the count IS the listing's length, so a refused count is a refused listing.
 */
describe("kindCountIsListing", () => {
  const withListingCounts = {
    ...base,
    objectKinds: [
      { id: "member", role: "config", label: "Member", labelPlural: "Members" },
      { id: "user", role: "config", label: "User", labelPlural: "Users", countIsListing: true },
    ],
  } as unknown as ProviderCapabilities;

  test("only an explicit true says the count and the listing are one read", () => {
    expect(kindCountIsListing(withListingCounts, "user")).toBe(true);
    expect(kindCountIsListing(withListingCounts, "member")).toBe(false);
  });

  test("a kind this engine does not declare is not assumed to be one", () => {
    expect(kindCountIsListing(withListingCounts, "role")).toBe(false);
    expect(kindCountIsListing(base, "user")).toBe(false);
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

describe("kindHasColumns", () => {
  const spec = (extra: Partial<ObjectKindSpec>): ObjectKindSpec => ({
    id: "table",
    role: "relation",
    label: "Table",
    labelPlural: "Tables",
    ...extra,
  });

  test("a declared flag reads as true", () => {
    expect(kindHasColumns(spec({ hasColumns: true }))).toBe(true);
  });

  test("a spec that declares nothing reads as false, so its object row is a leaf", () => {
    // The permissive default is wrong here for the reason `acceptsRowWrites` records: only the
    // provider knows, and a twisty on a kind whose `describeObject` answers `columns: []` opens
    // on nothing. `role: "relation"` is set on this spec deliberately, because the role is
    // exactly what this function must NOT read: five `config` kinds in the fleet have columns
    // and Oracle's `sequence` has none.
    expect(kindHasColumns(spec({}))).toBe(false);
    expect(kindHasColumns(spec({ hasColumns: false }))).toBe(false);
  });

  test("an undefined spec reads as false rather than throwing", () => {
    // A caller holding only an id passes `findKind(capabilities, id)` straight in, which answers
    // `undefined` for a kind this provider does not declare, so the absent case is a value this
    // function is handed rather than one every caller is asked to guard against.
    expect(kindHasColumns(undefined)).toBe(false);
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
    reach this through its own fixture, and every other provider that reads a source
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

describe("requireSourceKind", () => {
  const engine = { displayName: "SQLite", type: "sqlite" } as const;

  const sourceKinds = {
    ...base,
    objectKinds: [
      { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasSource: true, sourceLanguage: "sql" },
      { id: "column", role: "relation", label: "Column", labelPlural: "Columns" },
      { id: "trigger", role: "trigger", label: "Trigger", labelPlural: "Triggers", hasSource: true },
    ],
  } as unknown as ProviderCapabilities;

  test("answers the declared kind with its language narrowed to a string", () => {
    const spec = requireSourceKind(sourceKinds, "table", engine);

    expect(spec.id).toBe("table");
    // The narrowing is the point: the caller reads `spec.sourceLanguage` with no `??` and no
    // second undefined check, which is what nine providers each wrote for themselves.
    const language: string = spec.sourceLanguage;
    expect(language).toBe("sql");
  });

  test("a kind the engine never declared raises, naming the engine and the kind", () => {
    expect(() => requireSourceKind(sourceKinds, "materialized_view", engine)).toThrow(
      new QueryError('SQLite declares no object kind "materialized_view"', "sqlite"),
    );
  });

  test("a declared kind that publishes no definition text raises, and it is a different sentence", () => {
    expect(() => requireSourceKind(sourceKinds, "column", engine)).toThrow(
      new QueryError('SQLite publishes no definition text for the kind "column"', "sqlite"),
    );
  });

  test("a source-bearing kind with no sourceLanguage raises rather than defaulting to one", () => {
    expect(() => requireSourceKind(sourceKinds, "trigger", engine)).toThrow(
      new QueryError(
        'SQLite declares readable source for the kind "trigger" and no sourceLanguage to render it with',
        "sqlite",
      ),
    );
  });

  test("every raise is a QueryError carrying the engine's own type id, never a bare Error", () => {
    // This loop is the only place in the repository that asserts `raised.provider` and
    // `instanceof QueryError` for all three arms, so a zero-iteration state would let the helper
    // answer a bare Error with no provider id and leave this file green. The floor therefore counts
    // the iterations the loop actually ran, over the same named const it iterates. Measured on
    // 2026-09-13: the previous floor asserted `toHaveLength(3)` on a SECOND freshly written literal,
    // so replacing the loop's array with `[] as string[]` still reported 35 pass 0 fail, with
    // expect() calls falling from 60 to 48 as the only trace. With the counter below, the same
    // emptying fails this test by name.
    const arms = ["materialized_view", "column", "trigger"];
    let raisedArms = 0;
    for (const kind of arms) {
      let raised: unknown;
      try {
        requireSourceKind(sourceKinds, kind, { displayName: "Trino", type: "trino" });
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(QueryError);
      if (!(raised instanceof QueryError)) throw new Error("narrowing");
      expect(raised.provider).toBe("trino");
      expect(raised.message).toContain("Trino");
      expect(raised.message).toContain(`"${kind}"`);
      raisedArms += 1;
    }
    if (raisedArms !== 3) {
      throw new Error(`requireSourceKind arms: expected 3 iterations, ran ${raisedArms}`);
    }
  });

  test("an engine declaring no kinds at all raises the unknown-kind sentence, not a crash", () => {
    expect(() => requireSourceKind(base, "table", engine)).toThrow(
      new QueryError('SQLite declares no object kind "table"', "sqlite"),
    );
  });
});

describe("kindAcceptsSourceEdits", () => {
  const capabilities = {
    objectKinds: [
      {
        id: "function",
        role: "routine",
        label: "Function",
        labelPlural: "Functions",
        hasSource: true,
        sourceLanguage: "pgsql",
        acceptsSourceEdits: true,
      },
      { id: "view", role: "relation", label: "View", labelPlural: "Views", hasSource: true, sourceLanguage: "pgsql" },
      { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
    ],
  } as unknown as ProviderCapabilities;

  test("true only where the kind declared it", () => {
    expect(kindAcceptsSourceEdits(capabilities, "function")).toBe(true);
    // Absent reads as FALSE, the same default `hasSource` and `acceptsRowWrites` take, and the
    // permissive default is wrong here for the same reason: only the provider knows.
    expect(kindAcceptsSourceEdits(capabilities, "view")).toBe(false);
    expect(kindAcceptsSourceEdits(capabilities, "table")).toBe(false);
    expect(kindAcceptsSourceEdits(capabilities, "no_such_kind")).toBe(false);
  });

  test("it is NOT conjoined with hasSource", () => {
    // A kind that declares an edit and no source is a broken DECLARATION, and this derivation
    // must not hide it by answering false: the census is what refuses it, by name, and it can
    // only do that if this function reports what the declaration really says.
    const broken = {
      objectKinds: [{ id: "x", role: "routine", label: "X", labelPlural: "Xs", acceptsSourceEdits: true }],
    } as unknown as ProviderCapabilities;
    expect(kindAcceptsSourceEdits(broken, "x")).toBe(true);
  });
});

describe("requireEditableKind", () => {
  const engine = { displayName: "PostgreSQL", type: "postgres" } as const;
  const capabilities = {
    objectKinds: [
      {
        id: "function",
        role: "routine",
        label: "Function",
        labelPlural: "Functions",
        hasSource: true,
        sourceLanguage: "pgsql",
        acceptsSourceEdits: true,
      },
      { id: "view", role: "relation", label: "View", labelPlural: "Views", hasSource: true, sourceLanguage: "pgsql" },
      {
        id: "nolang",
        role: "routine",
        label: "No language",
        labelPlural: "No languages",
        hasSource: true,
        acceptsSourceEdits: true,
      },
    ],
  } as unknown as ProviderCapabilities;

  test("returns the spec with sourceLanguage narrowed to string", () => {
    const spec = requireEditableKind(capabilities, "function", engine);
    // `.length` compiles only because the return type narrows it; that is the whole point of
    // the third throw below.
    expect(spec.sourceLanguage.length).toBeGreaterThan(0);
    expect(spec.id).toBe("function");
  });

  test("three separate facts get three separate sentences", () => {
    expect(() => requireEditableKind(capabilities, "ghost", engine)).toThrow(
      'PostgreSQL declares no object kind "ghost"',
    );
    expect(() => requireEditableKind(capabilities, "view", engine)).toThrow(
      'PostgreSQL does not apply an edited definition for the kind "view"',
    );
    expect(() => requireEditableKind(capabilities, "nolang", engine)).toThrow(
      'PostgreSQL declares an editable kind "nolang" and no sourceLanguage to render it with',
    );
  });
});

const SCHEMA_LEVEL: ContainerLevelSpec = { id: "schema", label: "Schema", labelPlural: "Schemas" };
const CATALOG_LEVEL: ContainerLevelSpec = { id: "catalog", label: "Catalog", labelPlural: "Catalogs" };
/** A level whose label is not its id's word, so the two spellings can differ. */
const DATABASE: ContainerLevelSpec = { id: "catalog", label: "Database", labelPlural: "Databases" };

/** A declaration with these levels and, when named, this policy. An unnamed policy is ABSENT, not undefined. */
function declaration(levels: readonly ContainerLevelSpec[], policy?: "exact" | "prefixes"): ProviderCapabilities {
  return {
    ...base,
    containerLevels: levels,
    ...(policy === undefined ? {} : { containerPathShapes: policy }),
  } as unknown as ProviderCapabilities;
}

const ids = (shapes: readonly (readonly ContainerLevelSpec[])[]): string[][] =>
  shapes.map((shape) => shape.map((level) => level.id));

/** The error a call raised, so a message can be compared whole rather than as a substring. */
function refusal(call: () => void): QueryError {
  try {
    call();
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("the call did not refuse");
}

describe("acceptedContainerShapes (#1147)", () => {
  test("exact accepts the declared depth and nothing else, at depths 0, 1 and 2", () => {
    expect(ids(acceptedContainerShapes(declaration([], "exact")))).toEqual([[]]);
    expect(ids(acceptedContainerShapes(declaration([SCHEMA_LEVEL], "exact")))).toEqual([["schema"]]);
    expect(ids(acceptedContainerShapes(declaration([CATALOG_LEVEL, SCHEMA_LEVEL], "exact")))).toEqual([
      ["catalog", "schema"],
    ]);
  });

  test("prefixes accepts every depth from one level up to the declared one", () => {
    expect(ids(acceptedContainerShapes(declaration([SCHEMA_LEVEL], "prefixes")))).toEqual([["schema"]]);
    expect(ids(acceptedContainerShapes(declaration([CATALOG_LEVEL, SCHEMA_LEVEL], "prefixes")))).toEqual([
      ["catalog"],
      ["catalog", "schema"],
    ]);
  });

  test("prefixes with no level accepts nothing, not even the empty path", () => {
    expect(acceptedContainerShapes(declaration([], "prefixes"))).toEqual([]);
  });

  test("an absent field reads as exact at depths 0, 1 and 2, never as prefixes", () => {
    expect(ids(acceptedContainerShapes(declaration([])))).toEqual([[]]);
    expect(ids(acceptedContainerShapes(declaration([SCHEMA_LEVEL])))).toEqual([["schema"]]);
    expect(ids(acceptedContainerShapes(declaration([CATALOG_LEVEL, SCHEMA_LEVEL])))).toEqual([["catalog", "schema"]]);
    // The control: at depth 0 and at depth 2 the two policies answer differently, so the
    // assertions above could not pass if absent were read as prefixes.
    expect(acceptedContainerShapes(declaration([]))).not.toEqual(acceptedContainerShapes(declaration([], "prefixes")));
    expect(acceptedContainerShapes(declaration([CATALOG_LEVEL, SCHEMA_LEVEL]))).not.toEqual(
      acceptedContainerShapes(declaration([CATALOG_LEVEL, SCHEMA_LEVEL], "prefixes")),
    );
  });

  test("a value outside the union reads as exact, never as prefixes", () => {
    // Only the exact string "prefixes" widens; a typo, a case variant, an empty string or a
    // future member a reader does not know yet must fail closed.
    for (const value of ["prefix", "EXACT", "Prefixes", ""]) {
      const capabilities = {
        ...base,
        containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
        containerPathShapes: value,
      } as unknown as ProviderCapabilities;
      expect(ids(acceptedContainerShapes(capabilities))).toEqual([["catalog", "schema"]]);
    }
  });

  test("a declaration with no containerLevels at all is depth 0", () => {
    expect(acceptedContainerShapes(base)).toEqual([[]]);
  });

  test("a third declared level widens nothing", () => {
    const threeLevels = {
      ...base,
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL, { id: "schema", label: "Extra", labelPlural: "Extras" }],
      containerPathShapes: "prefixes",
    } as unknown as ProviderCapabilities;
    expect(ids(acceptedContainerShapes(threeLevels))).toEqual([["catalog"], ["catalog", "schema"]]);
  });
});

describe("renderContainerShapes (#1147)", () => {
  test("label spelling prints each level's label, lowercased", () => {
    expect(renderContainerShapes([[DATABASE], [DATABASE, SCHEMA_LEVEL]], "label")).toBe(
      "[database] or [database, schema]",
    );
  });

  test("id spelling prints each level's id", () => {
    expect(renderContainerShapes([[DATABASE], [DATABASE, SCHEMA_LEVEL]], "id")).toBe("[catalog] or [catalog, schema]");
  });

  test("a prose label shows the difference between the two spellings", () => {
    const shapes = [[{ id: "schema", label: "Key Space", labelPlural: "Key Spaces" } satisfies ContainerLevelSpec]];
    expect(renderContainerShapes(shapes, "label")).toBe("[key space]");
    expect(renderContainerShapes(shapes, "id")).toBe("[schema]");
  });

  test("one shape carries no or", () => {
    expect(renderContainerShapes([[SCHEMA_LEVEL]], "label")).toBe("[schema]");
  });

  test("the empty path and no shape at all print their own words under both spellings", () => {
    expect(renderContainerShapes([[]], "label")).toBe("empty");
    expect(renderContainerShapes([[]], "id")).toBe("empty");
    expect(renderContainerShapes([], "label")).toBe("nothing: this declaration carries no container level");
    expect(renderContainerShapes([], "id")).toBe("nothing: this declaration carries no container level");
  });

  test("the empty wordings are the two policies' own answers over no level", () => {
    expect(renderContainerShapes(acceptedContainerShapes(declaration([], "exact")), "label")).toBe("empty");
    expect(renderContainerShapes(acceptedContainerShapes(declaration([], "prefixes")), "label")).toBe(
      "nothing: this declaration carries no container level",
    );
  });
});

describe("assertContainerPathShape (#1147)", () => {
  const POSTGRES: ContainerPathShapeEngine = { code: "postgres", label: "A PostgreSQL", shapeNames: "id" };
  const TRINO: ContainerPathShapeEngine = { code: "trino", label: "A Trino", shapeNames: "id" };
  const SQLITE: ContainerPathShapeEngine = { code: "sqlite", label: "A SQLite", shapeNames: "label" };
  const DUCKDB: ContainerPathShapeEngine = { code: "duckdb", label: "A DuckDB", shapeNames: "label" };

  test("prefixes over two levels accepts one or two segments and refuses the rest", () => {
    const capabilities = declaration([CATALOG_LEVEL, SCHEMA_LEVEL], "prefixes");
    expect(() => assertContainerPathShape(capabilities, ["c"], TRINO)).not.toThrow();
    expect(() => assertContainerPathShape(capabilities, ["c", "s"], TRINO)).not.toThrow();
    expect(refusal(() => assertContainerPathShape(capabilities, [], TRINO)).message).toBe(
      "A Trino container path is [catalog] or [catalog, schema], received []",
    );
    expect(refusal(() => assertContainerPathShape(capabilities, ["c", "s", "x"], TRINO)).message).toBe(
      'A Trino container path is [catalog] or [catalog, schema], received ["c","s","x"]',
    );
  });

  test("exact over one level accepts only that level", () => {
    const capabilities = declaration([SCHEMA_LEVEL], "exact");
    expect(() => assertContainerPathShape(capabilities, ["app"], POSTGRES)).not.toThrow();
    expect(refusal(() => assertContainerPathShape(capabilities, [], POSTGRES)).message).toBe(
      "A PostgreSQL container path is [schema], received []",
    );
    expect(refusal(() => assertContainerPathShape(capabilities, ["app", "x"], POSTGRES)).message).toBe(
      'A PostgreSQL container path is [schema], received ["app","x"]',
    );
  });

  test("the two empty wordings survive the move byte for byte", () => {
    expect(refusal(() => assertContainerPathShape(declaration([], "exact"), ["main"], SQLITE)).message).toBe(
      'A SQLite container path is empty, received ["main"]',
    );
    expect(refusal(() => assertContainerPathShape(declaration([], "prefixes"), [], DUCKDB)).message).toBe(
      "A DuckDB container path is nothing: this declaration carries no container level, received []",
    );
  });

  test("an absent policy refuses a partial path", () => {
    expect(
      refusal(() => assertContainerPathShape(declaration([CATALOG_LEVEL, SCHEMA_LEVEL]), ["c"], TRINO)).message,
    ).toBe('A Trino container path is [catalog, schema], received ["c"]');
  });

  test("the refusal is a QueryError stamped with the descriptor's code", () => {
    const raised = refusal(() => assertContainerPathShape(declaration([SCHEMA_LEVEL], "exact"), [], POSTGRES));
    expect(raised).toBeInstanceOf(QueryError);
    expect(raised.provider).toBe("postgres");
  });

  test("the descriptor carries no accepted depths any more, and the compiler holds it there", () => {
    const withShapes: ContainerPathShapeEngine = {
      code: "postgres",
      label: "A PostgreSQL",
      shapeNames: "id",
      // @ts-expect-error the accepted depths are the declaration's containerPathShapes since #1147
      shapes: "exact",
    };
    const withEmptyShapes: ContainerPathShapeEngine = {
      code: "postgres",
      label: "A PostgreSQL",
      shapeNames: "id",
      // @ts-expect-error the empty wording follows from containerPathShapes since #1147
      emptyShapes: "empty",
    };
    // A stray member is inert: the declaration decides, whatever the descriptor carries.
    expect(() =>
      assertContainerPathShape(declaration([CATALOG_LEVEL, SCHEMA_LEVEL], "prefixes"), ["c"], withShapes),
    ).not.toThrow();
    expect(refusal(() => assertContainerPathShape(declaration([], "prefixes"), [], withEmptyShapes)).message).toEndWith(
      "nothing: this declaration carries no container level, received []",
    );
  });
});
