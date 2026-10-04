/**
 * The route table's drift test (vector-family spec 5.4, E21, E34, VF2, VF5).
 *
 * The fixture `tests/fixtures/vector/routes/milvus-v1.json` is generated from the vendor's REST reference summary,
 * `rest-summary-v3.0.x.tsv` at web-content 78d9def7, whose SHA-256 the fixture records and this test pins. Against
 * it: every key a route accepts is documented for that route; the documented keys it does not accept are exactly its
 * refusal list, each with a reason; the keys E34 refuses in every release are refused on both search routes although
 * the vendor documents them; and a hybrid sub-request accepts the keys of the vendor's Hybrid Search page.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MILVUS_DOCUMENTED_REFUSALS,
  MILVUS_PERMANENT_REFUSALS,
  MILVUS_ROUTE_KEYS,
  MILVUS_ROUTES,
  MILVUS_SUB_REQUEST_KEYS,
  MILVUS_UNDOCUMENTED_REFUSALS,
  type MilvusOp,
  permanentRefusalSentence,
} from "@/lib/db/providers/vector/milvus/routes";

/** The SHA-256 of `rest-summary-v3.0.x.tsv` at milvus-io/web-content 78d9def7 (E21, R46 C7). */
const PINNED_TSV_SHA256 = "e85963fdb0aaf506f89ba0cc3825fbd480d61c671fa08b7ef7f6245acdabb723";

/** The sub-request keys of the vendor's Hybrid Search page (v3.0.x): the one schema the TSV does not carry. */
const DOCUMENTED_SUB_REQUEST_KEYS = ["annsField", "data", "filter", "exprParams", "limit", "params", "metricType"];

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "vector", "routes", "milvus-v1.json"), "utf8"),
) as {
  readonly $generated: { readonly sha256: string };
  readonly routes: readonly { readonly op: MilvusOp; readonly bodyKeys: readonly { readonly name: string }[] }[];
};

const documented = (op: MilvusOp): string[] =>
  (FIXTURE.routes.find((route) => route.op === op)?.bodyKeys ?? []).map((key) => key.name);

describe("the pinned source", () => {
  test("the fixture was generated from the pinned TSV", () => {
    expect(FIXTURE.$generated.sha256).toBe(PINNED_TSV_SHA256);
  });
});

describe.each(MILVUS_ROUTES.map((route) => [route.op]))("%s", (op) => {
  test("accepts no key the vendor does not document for it", () => {
    const undocumented = MILVUS_ROUTE_KEYS[op].filter((key) => !documented(op).includes(key));
    expect(undocumented).toEqual([]);
  });

  test("refuses exactly the documented keys it does not accept, each with a reason", () => {
    const refused = documented(op).filter((key) => !MILVUS_ROUTE_KEYS[op].includes(key));
    expect(Object.keys(MILVUS_DOCUMENTED_REFUSALS[op] ?? {}).sort()).toEqual([...refused].sort());
    for (const reason of Object.values(MILVUS_DOCUMENTED_REFUSALS[op] ?? {})) expect(reason.length).toBeGreaterThan(20);
  });

  test("names no undocumented refusal that the vendor documents", () => {
    for (const key of Object.keys(MILVUS_UNDOCUMENTED_REFUSALS[op] ?? {})) expect(documented(op)).not.toContain(key);
  });
});

describe("the permanent refusals (E34, VF2)", () => {
  test.each(["entities/search", "entities/hybrid_search"] as const)(
    "%s refuses every one, with the E34 sentence, and accepts none",
    (op) => {
      for (const key of MILVUS_PERMANENT_REFUSALS) {
        expect(MILVUS_ROUTE_KEYS[op]).not.toContain(key);
        const reason = MILVUS_DOCUMENTED_REFUSALS[op]?.[key] ?? MILVUS_UNDOCUMENTED_REFUSALS[op]?.[key];
        expect(reason).toBe(permanentRefusalSentence(key));
      }
    },
  );

  test("the list overrides the vendor table, which documents them for search", () => {
    for (const key of MILVUS_PERMANENT_REFUSALS) expect(documented("entities/search")).toContain(key);
    expect(documented("entities/hybrid_search")).toContain("functionScore");
  });
});

describe("the hybrid sub-request (5.4)", () => {
  test("accepts the keys of the vendor's Hybrid Search page, no more", () => {
    expect([...MILVUS_SUB_REQUEST_KEYS]).toEqual(DOCUMENTED_SUB_REQUEST_KEYS);
  });
});
