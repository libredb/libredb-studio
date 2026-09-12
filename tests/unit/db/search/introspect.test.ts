/**
 * Elasticsearch / OpenSearch schema introspection (issue #424, Phase 1)
 *
 * Driven entirely through a hand-built `SearchTransport` - the point of the seam:
 * no `fetch` mocking, no `mock.module()` (process-wide in bun) and no server. Every
 * index row and mapping shape below was captured from the live probe clusters on
 * 2026-08-19 (Elasticsearch 9.1.4 and OpenSearch 3.8.0, stock single nodes), so the
 * fake speaks exactly what the transport speaks:
 *
 * - `probe_shapes` maps `address` as an object with `address.city`, and `note` as
 *   `text` with a `keyword` multi-field. `GET /probe_shapes/_mapping` and
 *   `DESCRIBE probe_shapes` were both re-measured for this test: the flattened set
 *   is `address`/object, `address.city`/keyword, `note`/text, `note.keyword`/keyword.
 * - `SELECT note, note.keyword, address.city FROM probe_shapes` answers HTTP 200
 *   with all three columns (measured), while `SELECT address FROM probe_shapes` is
 *   HTTP 400 `verification_exception`, "line 1:8: Cannot use field [address] type
 *   [object] only its subfields". That pair is the whole column decision: the
 *   container is not a column, its leaf is, and a `text` parent stays one.
 * - `probe_orders` reports `docs.count` 1 and `pri.store.size` 5913, and a closed
 *   index reports JSON `null` for both while still saying `"status":"close"`.
 *
 * The fake's `query()` THROWS on purpose. Introspection reading a statement would be
 * a design regression, not a test failure: `introspect.ts:9-16` records that
 * `SELECT *` describes the statement rather than the index - measured, an index
 * mapping `flattened` and `nested` answers `SELECT *` with `{"columns":[],"rows":[[]]}` -
 * so the mapping is the only honest source.
 */
import { describe, expect, test } from "bun:test";
import { isSystemIndex, SEARCH_CONTAINER_TYPES } from "@/lib/db/providers/sql/search/introspect";
import type {
  SearchClusterHealth,
  SearchIndexInfo,
  SearchMappingField,
  SearchObjectInfo,
  SearchQueryResult,
  SearchTransport,
} from "@/lib/db/providers/sql/search/transport";
import { SearchTransportError } from "@/lib/db/providers/sql/search/transport";

// ============================================================================
// Fake transport
// ============================================================================

interface FakeOptions {
  indices?: SearchIndexInfo[];
  /** Mapping per index name. An index absent from here answers an empty mapping. */
  mappings?: Record<string, SearchMappingField[]>;
  /** Raised instead of returning a mapping, per index name. */
  failures?: Record<string, Error>;
  /** Milliseconds each index's mapping read takes, per index name. */
  delays?: Record<string, number>;
}

interface Recorded {
  /** Index names in the order `mapping()` was entered. */
  mappingCalls: string[];
  /** The signal each seam call received, so forwarding can be asserted. */
  signals: (AbortSignal | undefined)[];
  /** The highest number of mapping reads in flight at once. */
  peakInFlight: number;
}

function index(name: string, overrides: Partial<SearchIndexInfo> = {}): SearchIndexInfo {
  return {
    name,
    docCount: 1,
    sizeBytes: 5913,
    status: "open",
    // Both products mark their own with a leading dot; the transport also flags
    // OpenSearch's date-suffixed query-insights index, which carries none
    // (`http-transport.ts:263-264`). Introspection reads the flag, never the name.
    isSystem: false,
    ...overrides,
  };
}

function field(path: string, type: string, hasSubfields = false, isMultiField = false): SearchMappingField {
  return { path, type, hasSubfields, isMultiField };
}

function createTransport(options: FakeOptions = {}) {
  const recorded: Recorded = { mappingCalls: [], signals: [], peakInFlight: 0 };
  let inFlight = 0;

  const transport: SearchTransport = {
    dialect: "elasticsearch",

    indices: async (signal?: AbortSignal): Promise<SearchIndexInfo[]> => {
      recorded.signals.push(signal);
      return options.indices ?? [];
    },

    // The bulk form is unused by `introspect.ts`, which reads one index at a time, and it
    // is here because the seam requires it: a double that omitted a method would not
    // compile, and one that answered rows for it would let a read that should never happen
    // pass unnoticed.
    mappings: async (): Promise<Map<string, SearchMappingField[]>> => {
      throw new Error("introspect must not use the bulk mapping read");
    },

    mapping: async (name: string, signal?: AbortSignal): Promise<SearchMappingField[]> => {
      recorded.mappingCalls.push(name);
      recorded.signals.push(signal);
      inFlight += 1;
      recorded.peakInFlight = Math.max(recorded.peakInFlight, inFlight);
      // A real read suspends, which is the only way the concurrency limit is
      // observable at all: without a suspension every worker would finish before
      // the next one starts and any limit would look respected.
      await new Promise((resolve) => setTimeout(resolve, options.delays?.[name] ?? 1));
      inFlight -= 1;

      const failure = options.failures?.[name];
      if (failure) throw failure;
      return options.mappings?.[name] ?? [];
    },

    // Introspection must never reach these seven. The four object listings (#789)
    // belong to the OBJECT surface, which is a different reader of the same seam:
    // `getSchema()` describes indices and nothing else, so an alias, a pipeline, a
    // template or a data stream reaching this file would be a scope error rather
    // than a missing case.
    aliases: (): Promise<SearchObjectInfo[]> => {
      throw new Error("introspection listed aliases; getSchema describes indices");
    },
    pipelines: (): Promise<SearchObjectInfo[]> => {
      throw new Error("introspection listed ingest pipelines; getSchema describes indices");
    },
    templates: (): Promise<SearchObjectInfo[]> => {
      throw new Error("introspection listed index templates; getSchema describes indices");
    },
    dataStreams: (): Promise<SearchObjectInfo[]> => {
      throw new Error("introspection listed data streams; getSchema describes indices");
    },

    // See the file header for why `query()` in particular is a design boundary
    // rather than a convenience.
    query: (): Promise<SearchQueryResult> => {
      throw new Error("introspection ran a statement; the schema comes from the mapping");
    },
    version: (): Promise<{ version: string; product: string }> => {
      throw new Error("introspection read the version");
    },
    health: (): Promise<SearchClusterHealth> => {
      throw new Error("introspection read cluster health");
    },
  };

  return { transport, recorded };
}

/** The `probe_shapes` mapping as the transport flattens it, measured. */
function probeShapesMapping(): SearchMappingField[] {
  return [
    field("address", "object", true),
    field("address.city", "keyword"),
    field("note", "text", true),
    // A MULTI-FIELD, and the flag matters: the transport marks everything below a
    // mapping's `fields` this way, and introspection drops that kind because
    // OpenSearch cannot select it. The fake has to say so or it stops speaking what
    // the transport speaks.
    field("note.keyword", "keyword", false, true),
  ];
}

function names(columns: { name: string }[]): string[] {
  return columns.map((column) => column.name);
}

// ============================================================================
// Constants
// ============================================================================

describe("the container decision", () => {
  // Measured on Elasticsearch 9.1.4: `SELECT address FROM probe_shapes` is HTTP 400,
  // `verification_exception`, "Cannot use field [address] type [object] only its
  // subfields", and `nested` is refused with the same wording. `query-generators.ts`
  // builds its starter query by enumerating every declared column, so listing a
  // container would hand the user a query that cannot run at all.
  test("names exactly the two types the engine refuses to project", () => {
    expect([...SEARCH_CONTAINER_TYPES]).toEqual(["object", "nested"]);
  });

  // One definition is the point (`introspect.ts:86-89`): the completion and
  // labelling surfaces have to agree with the schema tree about what a column is.
  test("is frozen, so no caller can widen it at runtime", () => {
    expect(Object.isFrozen(SEARCH_CONTAINER_TYPES)).toBe(true);
  });
});

// ============================================================================
// System indices
// ============================================================================

describe("isSystemIndex", () => {
  /**
   * The rule is deliberately the flag and nothing more (`introspect.ts:150-154`).
   * The NAME shapes that produce the flag - the leading dot both products use by
   * convention, and OpenSearch's date-suffixed query-insights index - are
   * `http-transport.ts:263-264,751`, which is where a test of the rule itself
   * belongs; what is verified here is that introspection adds no second opinion.
   */
  test.each<[string, string]>([
    ["a dot-prefixed index, the convention on both products", ".plugins-ml-config"],
    ["OpenSearch's query-insights index, which carries no dot", "top_queries-2026.08.18-74305"],
  ])("hides %s", (_label, name) => {
    expect(isSystemIndex(index(name, { isSystem: true }))).toBe(true);
  });

  test("keeps a user's index", () => {
    expect(isSystemIndex(index("probe_orders"))).toBe(false);
  });
});

// ============================================================================
// Columns
// ============================================================================

// ============================================================================
// Table shape
// ============================================================================

// ============================================================================
// Failures
// ============================================================================

// ============================================================================
// Reads
// ============================================================================

describe("getSchema mapping reads", () => {
  function manyIndices(count: number): SearchIndexInfo[] {
    return Array.from({ length: count }, (_unused, position) => index(`probe_${position}`));
  }
});
