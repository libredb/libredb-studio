/**
 * The Weaviate labels (#1566 spec 9): the statement-language sentence plan mode states, generated from the route
 * table and the dialect so the two cannot drift, and the words the panels show for this engine.
 */
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@/lib/db/console/dialect";
import {
  WEAVIATE_LABELS,
  WEAVIATE_REFUSED_CLASSES,
  WEAVIATE_STATEMENT_EXAMPLE,
  weaviateReadRoutes,
  weaviateStatementLanguage,
} from "@/lib/db/providers/vector/weaviate/labels";
import { refusedRouteSentence, WEAVIATE_CONSOLE, WEAVIATE_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";
import { plan } from "../../../helpers/weaviate-request-fixtures";

const ROUTES =
  "GET /v1/meta, GET /v1/schema, GET /v1/schema/{collection}, GET /v1/schema/{collection}/shards, GET /v1/schema/{collection}/tenants, GET /v1/schema/{collection}/tenants/{tenant}, GET /v1/aliases, GET /v1/aliases/{alias}, GET /v1/nodes, GET /v1/nodes/{collection}, GET /v1/objects, GET /v1/objects/{collection}/{id}, POST /v1/search/{collection}/bm25, POST /v1/search/{collection}/hybrid, POST /v1/search/{collection}/near-vector, POST /v1/search/{collection}/near-object and POST /v1/aggregate/{collection}";

const GOLDEN = [
  `A Weaviate REST request, one per run: optional comment lines starting with // or #, then a line METHOD /path naming one of ${ROUTES}, with every brace-enclosed segment replaced by a real name or id.`,
  `GET routes take no body; POST routes take one JSON object with that route's Weaviate REST body, for example ${WEAVIATE_STATEMENT_EXAMPLE}.`,
  "Filters are Weaviate where objects with operator, path and one value key such as valueText or valueInt; And, Or and Not take operands.",
  'A multi-tenant collection needs its tenant: ?tenant= on a GET, "tenant" in a body.',
  "Not requests: object, schema, tenant and alias writes, batch, backups, users and roles, near-text and the other searches that send text or media to a model, generative search and rerank, hybrid with an alpha other than 0 and GraphQL written by hand.",
].join(" ");

describe("statementLanguage", () => {
  test("the generated sentence, word for word", () => {
    expect(WEAVIATE_LABELS.statementLanguage).toBe(GOLDEN);
  });

  test("names the 17 routes of the table, in table order", () => {
    const routes = weaviateReadRoutes(WEAVIATE_CONSOLE, WEAVIATE_ROUTES);
    expect(routes).toHaveLength(17);
    expect(routes.join(", ").replace(/, (?=[^,]*$)/, " and ")).toBe(ROUTES);
  });

  test("a route of another class is never listed", () => {
    const write: RouteSpec = { ...WEAVIATE_ROUTES[0], method: "DELETE", template: "objects/{id}", class: "write" };
    expect(weaviateReadRoutes(WEAVIATE_CONSOLE, [...WEAVIATE_ROUTES, write])).not.toContain("DELETE /v1/objects/{id}");
  });

  test("a one-route table and a one-class refusal list are written without a conjunction", () => {
    const sentence = weaviateStatementLanguage(WEAVIATE_CONSOLE, [WEAVIATE_ROUTES[0]], ["batch"]);
    expect(sentence).toContain("naming one of GET /v1/meta, with every brace-enclosed segment");
    expect(sentence).toEndWith("Not requests: batch.");
  });

  test("the example is accepted by phase 0 as a bm25 search", () => {
    expect(plan(WEAVIATE_STATEMENT_EXAMPLE).route.op).toBe("search_bm25");
  });

  test.each([
    ["DELETE", "/v1/objects/Article/9e6866af-ef70-5a5a-9b61-1ae7a41bad0d"],
    ["POST", "/v1/batch/objects"],
    ["POST", "/v1/backups/filesystem"],
    ["GET", "/v1/users/own-info"],
    ["POST", "/v1/search/Article/near-text"],
    ["POST", "/v1/graphql"],
  ])("%s %s, a class the sentence names, is refused by what it is", (method, path) => {
    expect(refusedRouteSentence(method, path)).toContain("which this console does not run");
  });

  test("the refusal clause holds eight classes", () => {
    expect(WEAVIATE_REFUSED_CLASSES).toHaveLength(8);
  });
});

describe("the other labels", () => {
  test("the entity words, the actions and the captions", () => {
    expect(WEAVIATE_LABELS).toMatchObject({
      entityName: "Collection",
      entityNamePlural: "Collections",
      rowName: "Object",
      rowNamePlural: "Objects",
      selectAction: "Read Objects",
      generateAction: "Generate Request",
      searchPlaceholder: "Search collections...",
      tableStatsCaption:
        "The first 200 single-tenant collections, each with its exact object count (aggregate meta.count). A multi-tenant collection is counted per tenant: POST /v1/aggregate/{collection} with a tenant.",
    });
    expect(WEAVIATE_LABELS.slowQueriesEmptyState).toBe(
      "Weaviate reports no slow-query log over the routes Studio reads.",
    );
    expect(WEAVIATE_LABELS.sessionsEmptyState).toContain("Prometheus server that scrapes Weaviate's metrics");
  });

  test("the maintenance words say nothing runs", () => {
    expect(WEAVIATE_LABELS.analyzeGlobalTitle).toBe("Not available");
    expect(WEAVIATE_LABELS.vacuumGlobalTitle).toBe("Not available");
  });
});
