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
import { isSystemIndex, SEARCH_CONTAINER_TYPES, toColumns } from "@/lib/db/providers/sql/search/introspect";
import { ELASTICSEARCH_PRODUCT, OPENSEARCH_PRODUCT } from "@/lib/db/providers/sql/search/index";
import type { SearchIndexInfo, SearchMappingField } from "@/lib/db/providers/sql/search/transport";

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

describe("the unprojectable types decision (#1459)", () => {
  // Measured on Elasticsearch 9.5.3 (flattened) and OpenSearch 3.9.0 (flat_object, unsigned_long, version):
  // each product declares its own measured unprojectable mapping types.
  test("Elasticsearch product declares exactly flattened as unprojectable", () => {
    expect([...ELASTICSEARCH_PRODUCT.unprojectableTypes]).toEqual(["flattened"]);
    expect(Object.isFrozen(ELASTICSEARCH_PRODUCT.unprojectableTypes)).toBe(true);
  });

  test("OpenSearch product declares flat_object, unsigned_long, and version as unprojectable", () => {
    expect([...OPENSEARCH_PRODUCT.unprojectableTypes]).toEqual(["flat_object", "unsigned_long", "version"]);
    expect(Object.isFrozen(OPENSEARCH_PRODUCT.unprojectableTypes)).toBe(true);
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

describe("toColumns (#1459)", () => {
  const fields: SearchMappingField[] = [
    { path: "id", type: "keyword", isMultiField: false, hasSubfields: false },
    { path: "blob", type: "flattened", isMultiField: false, hasSubfields: false },
    { path: "obj", type: "flat_object", isMultiField: false, hasSubfields: false },
    { path: "big", type: "unsigned_long", isMultiField: false, hasSubfields: false },
    { path: "ver", type: "version", isMultiField: false, hasSubfields: false },
    { path: "name", type: "text", isMultiField: false, hasSubfields: false },
  ];

  test("Elasticsearch: marks flattened as projectable: false, leaving unsigned_long and version projectable", () => {
    const columns = toColumns(fields, ELASTICSEARCH_PRODUCT.unprojectableTypes);
    expect(columns).toEqual([
      { name: "big", type: "unsigned_long", nullable: true, isPrimary: false },
      { name: "blob", type: "flattened", nullable: true, isPrimary: false, projectable: false },
      { name: "id", type: "keyword", nullable: true, isPrimary: false },
      { name: "name", type: "text", nullable: true, isPrimary: false },
      { name: "obj", type: "flat_object", nullable: true, isPrimary: false },
      { name: "ver", type: "version", nullable: true, isPrimary: false },
    ]);
  });

  test("OpenSearch: marks flat_object, unsigned_long, and version as projectable: false", () => {
    const columns = toColumns(fields, OPENSEARCH_PRODUCT.unprojectableTypes);
    expect(columns).toEqual([
      { name: "big", type: "unsigned_long", nullable: true, isPrimary: false, projectable: false },
      { name: "blob", type: "flattened", nullable: true, isPrimary: false },
      { name: "id", type: "keyword", nullable: true, isPrimary: false },
      { name: "name", type: "text", nullable: true, isPrimary: false },
      { name: "obj", type: "flat_object", nullable: true, isPrimary: false, projectable: false },
      { name: "ver", type: "version", nullable: true, isPrimary: false, projectable: false },
    ]);
  });

  test("defaults to an empty unprojectable list when omitted", () => {
    const columns = toColumns(fields);
    expect(columns.every((c) => c.projectable === undefined)).toBe(true);
  });
});
