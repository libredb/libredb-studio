/**
 * The request-cost bounds of spec 6.6 in phase 0 (QE12): rows, batch size, the prefetch tree, the candidate budget,
 * the per-node controls and the facet limit, each refused with no call; and every documentation body the v1 table
 * accepts passes them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { parseConsole } from "@/lib/db/console/parser";
import { parseQdrantRequest, qdrantPhase0 } from "@/lib/db/providers/vector/qdrant/request";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "@/lib/db/providers/vector/qdrant/routes";

const plan = (text: string) => qdrantPhase0(parseQdrantRequest(text));
function refusal(text: string): RequestRefusal {
  try {
    plan(text);
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error(`accepted: ${text.slice(0, 200)}`);
}
const query = (body: string) => `POST /collections/docs/points/query\n${body}`;
const batch = (searches: readonly string[]) =>
  `POST /collections/docs/points/query/batch\n{"searches": [${searches.join(",")}]}`;

describe("rows", () => {
  test("a query, a scroll and a retrieve ask for at most 1,000 rows", () => {
    expect(plan(query('{"query": [0.1], "limit": 1000}')).route.op).toBe("query_points");
    expect(refusal(query('{"query": [0.1], "limit": 1001}')).message).toBe(
      "The request asks for 1001 rows (limit), above the bound of 1000.",
    );
    expect(refusal('POST /collections/docs/points/scroll\n{"limit": 1001}').message).toBe(
      "limit is 1001; it takes an integer from 1 to 1000.",
    );
    const ids = (count: number) => Array.from({ length: count }, (_, index) => index).join(",");
    expect(plan(`POST /collections/docs/points\n{"ids": [${ids(1000)}]}`).route.op).toBe("get_points");
    expect(refusal(`POST /collections/docs/points\n{"ids": [${ids(1001)}]}`).message).toBe(
      "The request asks for 1001 rows (one per id), above the bound of 1000.",
    );
  });

  test("a batch counts the sum of its searches' limits, an absent limit as 10", () => {
    expect(plan(batch(['{"query": [0.1], "limit": 990}', '{"query": [0.2]}'])).route.op).toBe("query_batch_points");
    expect(refusal(batch(['{"query": [0.1], "limit": 991}', '{"query": [0.2]}'])).message).toBe(
      "The request asks for 1001 rows (the sum of the searches' limits), above the bound of 1000.",
    );
  });

  test("a grouped query counts limit times group_size, absent as 10 and 3", () => {
    const groups = (body: string) => `POST /collections/docs/points/query/groups\n${body}`;
    expect(plan(groups('{"group_by": "c", "limit": 100, "group_size": 10}')).route.op).toBe("query_points_groups");
    expect(refusal(groups('{"group_by": "c", "limit": 101, "group_size": 10}')).message).toBe(
      "The request asks for 1010 rows (limit times group_size), above the bound of 1000.",
    );
    expect(refusal(groups('{"group_by": "c", "limit": 334}')).message).toBe(
      "The request asks for 1002 rows (limit times group_size), above the bound of 1000.",
    );
  });
});

describe("batches and the prefetch tree", () => {
  test("a batch holds 1 to 10 searches", () => {
    const searches = (count: number) => Array.from({ length: count }, () => '{"query": [0.1], "limit": 1}');
    expect(plan(batch(searches(10))).searches).toHaveLength(10);
    expect(refusal(batch(searches(11))).message).toBe("searches holds 11 searches; a batch takes 1 to 10.");
    expect(refusal(batch([])).message).toBe("searches holds 0 searches; a batch takes 1 to 10.");
  });

  test("a prefetch is at most 2 deep and 4 entries in one list", () => {
    const leaf = '{"query": [0.1], "limit": 5}';
    expect(
      plan(query(`{"prefetch": {"prefetch": ${leaf}, "query": {"fusion": "rrf"}}, "query": {"fusion": "rrf"}}`)).route
        .op,
    ).toBe("query_points");
    expect(
      refusal(
        query(
          `{"prefetch": {"prefetch": {"prefetch": ${leaf}, "query": {"fusion": "rrf"}}, "query": {"fusion": "rrf"}}, "query": {"fusion": "rrf"}}`,
        ),
      ).message,
    ).toBe("prefetch.prefetch.prefetch nests prefetch more than 2 levels deep, the console's bound.");
    expect(
      refusal(query(`{"prefetch": [${[leaf, leaf, leaf, leaf, leaf].join(",")}], "query": {"fusion": "rrf"}}`)).message,
    ).toBe("prefetch holds 5 entries, above the bound of 4 in one list.");
  });

  test("at most 10 prefetch nodes in the whole request, every search of a batch counted together", () => {
    const leaf = '{"query": [0.1], "limit": 5}';
    const branch = `{"query": [0.1], "limit": 5, "prefetch": [${leaf}, ${leaf}]}`;
    // Six prefetch nodes in one search: two branches of two leaves each.
    const six = `{"prefetch": [${branch}, ${branch}], "query": {"fusion": "rrf"}}`;
    const four = `{"prefetch": [${leaf}, ${leaf}, ${leaf}, ${leaf}], "query": {"fusion": "rrf"}}`;
    expect(plan(batch([six, four])).route.op).toBe("query_batch_points");
    expect(refusal(batch([six, six])).message).toBe(
      "The request holds more than 10 prefetch entries in all, every search counted together, the console's bound.",
    );
    expect(refusal(batch([four, four, four])).key).toBe("prefetch");
  });
});

describe("the candidate budget", () => {
  test("offset plus limit is at most 10,000 for one query", () => {
    expect(plan(query('{"query": [0.1], "offset": 9990, "limit": 10}')).route.op).toBe("query_points");
    expect(refusal(query('{"query": [0.1], "offset": 9991, "limit": 10}')).message).toContain(
      "The request asks its searches for 10001 candidates in all",
    );
  });

  test("every prefetch node counts its own limit, an absent one as 10, and oversampling multiplies", () => {
    expect(
      plan(
        query(
          '{"prefetch": [{"query": [0.1], "limit": 8990}, {"query": [0.1]}], "query": {"fusion": "rrf"}, "limit": 1000}',
        ),
      ).route.op,
    ).toBe("query_points");
    expect(
      refusal(
        query(
          '{"prefetch": [{"query": [0.1], "limit": 8991}, {"query": [0.1]}], "query": {"fusion": "rrf"}, "limit": 1000}',
        ),
      ).message,
    ).toContain("10001 candidates");
    expect(
      refusal(query('{"query": [0.1], "limit": 1000, "params": {"quantization": {"oversampling": 8}}, "offset": 251}'))
        .message,
    ).toContain("10008 candidates");
  });

  test("an MMR candidates_limit stands in for the limit, and is at most 1,024", () => {
    expect(plan(query('{"query": {"nearest": [0.1], "mmr": {"candidates_limit": 1024}}, "limit": 10}')).route.op).toBe(
      "query_points",
    );
    expect(refusal(query('{"query": {"nearest": [0.1], "mmr": {"candidates_limit": 1025}}}')).message).toBe(
      "query.mmr.candidates_limit is 1025; it takes an integer from 1 to 1024.",
    );
  });
});

describe("per-node controls and the facet", () => {
  test("hnsw_ef is at most 1,024 and oversampling 1 to 8", () => {
    expect(refusal(query('{"query": [0.1], "params": {"hnsw_ef": 1025}}')).message).toBe(
      "params.hnsw_ef is 1025; it takes an integer from 1 to 1024.",
    );
    expect(refusal(query('{"query": [0.1], "params": {"quantization": {"oversampling": 8.5}}}')).message).toBe(
      "params.quantization.oversampling is 8.5; it takes a number from 1 to 8.",
    );
    expect(refusal(query('{"query": [0.1], "params": {"quantization": {"oversampling": 0.5}}}')).key).toBe(
      "oversampling",
    );
  });

  test("a facet's limit is at most 1,000", () => {
    expect(plan('POST /collections/docs/facet\n{"key": "category", "limit": 1000}').route.op).toBe("facet");
    expect(refusal('POST /collections/docs/facet\n{"key": "category", "limit": 1001}').message).toBe(
      "limit is 1001; it takes an integer from 1 to 1000.",
    );
  });
});

describe("the documentation corpus", () => {
  const blocks = (
    JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "vector", "corpus", "qdrant-docs.json"), "utf8"),
    ) as { readonly blocks: readonly { readonly file: string; readonly text: string }[] }
  ).blocks.filter((block) => {
    try {
      parseConsole(QDRANT_CONSOLE, QDRANT_ROUTES, block.text);
      return true;
    } catch {
      return false;
    }
  });

  test("of the 82 blocks the v1 table accepts, 60 pass phase 0, 18 are refused for a model that is not local and 4 for options", () => {
    const outcome = { accepted: 0, model: 0, options: 0, other: [] as string[] };
    for (const block of blocks) {
      try {
        plan(block.text);
        outcome.accepted += 1;
      } catch (error) {
        const key = (error as RequestRefusal).key;
        if (key === "model") outcome.model += 1;
        else if (key === "options") outcome.options += 1;
        else outcome.other.push(`${block.file}: ${(error as Error).message}`);
      }
    }
    expect(blocks).toHaveLength(82);
    expect(outcome).toEqual({ accepted: 60, model: 18, options: 4, other: [] });
  });

  test("the four formula examples, their elided vectors filled, are accepted", () => {
    const vector = "[0.2, 0.8, 0.1, 0.4]";
    for (const text of [
      `{"prefetch": {"query": ${vector}, "limit": 50}, "query": {"formula": {"sum": ["$score", {"gauss_decay": {"x": {"geo_distance": {"origin": {"lat": 52.504043, "lon": 13.393236}, "to": "geo.location"}}, "scale": 5000 // 5km
}}]}, "defaults": {"geo.location": {"lat": 48.137154, "lon": 11.576124}}}}`,
      `{"prefetch": {"prefetch": [{"query": {"indices": [1, 42], "values": [0.22, 0.8]}, "using": "sparse", "limit": 100}, {"query": ${vector}, "using": "dense", "limit": 100}], "query": {"rrf": {}}, "limit": 100}, "query": {"formula": {"sum": ["$score", {"mult": [0.1, {"exp_decay": {"x": {"datetime_key": "published_at"}, "target": {"datetime": "2026-10-03T00:00:00Z"}, "scale": 15552000, "midpoint": 0.5}}]}]}}, "limit": 10}`,
      `{"prefetch": {"query": ${vector}, "limit": 50}, "query": {"formula": {"sum": ["$score", {"mult": [0.5, {"key": "tag", "match": {"any": ["h1", "h2", "h3", "h4"]}}]}, {"mult": [0.25, {"key": "tag", "match": {"any": ["p", "li"]}}]}]}}}`,
      `{"prefetch": {"query": ${vector}, "limit": 50}, "query": {"formula": {"sum": ["$score", {"exp_decay": {"x": {"datetime_key": "update_time"}, "target": {"datetime": "2026-10-03T00:00:00Z"}, "scale": 86400, "midpoint": 0.5}}]}}}`,
    ]) {
      expect(plan(query(text)).searches).toEqual([{ form: "formula", using: "" }]);
    }
  });
});
