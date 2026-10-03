/**
 * The Milvus provider's labels: the statement language, built from routes.ts through
 * `routeListText` so the sentence and the route table cannot drift, read whole against its golden text; the routes parsed
 * back out of it equal the table's read routes; every example in it is accepted by the real parser; and the panel
 * captions say where Milvus keeps what Studio does not read.
 */
import { describe, expect, test } from "bun:test";
import {
  MILVUS_LABELS,
  MILVUS_STATEMENT_EXAMPLES,
  MILVUS_TABLE_STATS_CAPTION,
  milvusReadRoutes,
  milvusStatementLanguage,
} from "@/lib/db/providers/vector/milvus/labels";
import { milvusPhase0, parseMilvusRequest } from "@/lib/db/providers/vector/milvus/request";
import { MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";

/** The sentence, exactly. */
const GOLDEN =
  'A Milvus request, one per run: optional comment lines starting with #, then a line POST /v2/vectordb/<route> (POST <route> also works) naming one of databases/list, databases/describe, collections/list, collections/describe, collections/get_stats, collections/get_load_state, partitions/list, indexes/list, indexes/describe, aliases/list, aliases/describe, entities/query, entities/get, entities/search and entities/hybrid_search, then one JSON object with that route\'s Milvus REST v2 body keys, for example POST /v2/vectordb/entities/query {"collectionName": "docs", "filter": "year > 2020", "outputFields": ["title"], "limit": 10} or POST /v2/vectordb/entities/search {"collectionName": "docs", "annsField": "embedding", "data": [[0.1, 0.2]], "limit": 5}. Count rows with "outputFields": ["count(*)"] and no limit or offset. Filters are Milvus boolean expressions in the filter string. Query, get, count and search need a loaded collection. Not requests: writes, load, release, flush, compaction, users and roles, resource groups, snapshots and server-side functions.';

describe("statementLanguage", () => {
  test("reads the golden sentence whole", () => {
    expect(milvusStatementLanguage()).toBe(GOLDEN);
    expect(MILVUS_LABELS.statementLanguage).toBe(GOLDEN);
  });

  test("the routes parsed back out of the sentence equal the table's read routes, in its order", () => {
    const listed = GOLDEN.slice(
      GOLDEN.indexOf("naming one of ") + "naming one of ".length,
      GOLDEN.indexOf(", then one JSON"),
    );
    const parsed = listed.split(/, | and /);
    const reads = MILVUS_ROUTES.filter((route) => route.class === "read").map((route) => route.template);
    expect(parsed).toEqual(reads);
    expect(milvusReadRoutes()).toEqual(reads);
  });

  test.each(MILVUS_STATEMENT_EXAMPLES.map((example) => [example]))(
    "the example %s is accepted by the real parser",
    (example) => {
      expect(GOLDEN).toContain(example);
      const request = parseMilvusRequest(example);
      expect(request.route.class).toBe("read");
      expect(() => milvusPhase0(request, { database: "default" })).not.toThrow();
    },
  );
});

describe("the panel labels", () => {
  test("the Tables caption states the estimate and the 200-collection bound", () => {
    expect(MILVUS_TABLE_STATS_CAPTION).toBe(
      'The first 200 collections of the database. Row counts are server estimates of flushed segments and do not subtract deletes; POST entities/query with outputFields ["count(*)"] is exact on a loaded collection.',
    );
    expect(MILVUS_LABELS.tableStatsCaption).toBe(MILVUS_TABLE_STATS_CAPTION);
  });

  test("slow queries and sessions say Milvus keeps them on its management port, which Studio does not dial", () => {
    expect(MILVUS_LABELS.slowQueriesEmptyState).toBe(
      "Milvus keeps query statistics on its management port 9091, which Studio does not dial",
    );
    expect(MILVUS_LABELS.sessionsEmptyState).toBe(
      "Milvus reports client sessions on its management port 9091, which Studio does not dial",
    );
  });

  test("the object words are Milvus's", () => {
    expect(MILVUS_LABELS).toMatchObject({
      entityName: "Collection",
      entityNamePlural: "Collections",
      rowName: "Entity",
      rowNamePlural: "Entities",
      selectAction: "Query Entities",
      generateAction: "Generate Command",
      searchPlaceholder: "Search collections...",
    });
  });
});
