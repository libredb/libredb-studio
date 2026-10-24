/**
 * Phase 0 of the Weaviate console (#1566 spec 5.1 to 5.3, W1): the grammar's sentences for a route it does not run,
 * the collection, alias, tenant and id rules, the object list's query keys with their defaults, and the aggregate
 * body, each read from the text alone. A refusal is a `RequestRefusal` of phase 0 naming its key.
 */
import { describe, expect, test } from "bun:test";
import { ConsoleRefusal } from "@/lib/db/console/parser";
import { type TaggedJson, toJsonText } from "@/lib/db/console/tagged-json";
import {
  parseWeaviateRequest,
  serverClassName,
  weaviateClassNameRefusal,
  weaviateTenantNameRefusal,
} from "@/lib/db/providers/vector/weaviate/request";
import { WEAVIATE_RUNS } from "@/lib/db/providers/vector/weaviate/routes";
import { bodyText, plan, refused, refusalOf, searchOf } from "../../../helpers/weaviate-request-fixtures";

describe("the grammar", () => {
  test("a write route is refused by what it is, then what the console runs", () => {
    const error = refusalOf(() => parseWeaviateRequest("DELETE /v1/objects/Article"));
    expect(error).toBeInstanceOf(ConsoleRefusal);
    expect(error.message).toBe(
      `DELETE /v1/objects/Article is an object write, which this console does not run. ${WEAVIATE_RUNS} (line 1, column 1)`,
    );
  });

  test("near-text is refused as a search that sends its text to a model provider", () => {
    expect(refusalOf(() => parseWeaviateRequest("POST /v1/search/Article/near-text {}")).message).toBe(
      `POST /v1/search/Article/near-text is a search that sends its text or media to a model provider, which this console does not run. ${WEAVIATE_RUNS} (line 1, column 6)`,
    );
  });

  test("an unknown read path, and a method outside GET and POST, each get the console's sentence", () => {
    expect(refusalOf(() => parseWeaviateRequest("GET /v1/foo")).message).toBe(
      `GET /v1/foo is not a route this console runs. ${WEAVIATE_RUNS} (line 1, column 5)`,
    );
    expect(refusalOf(() => parseWeaviateRequest("PUT /v1/foo")).message).toBe(
      `PUT /v1/foo is not a request this console runs: it sends GET and POST only. ${WEAVIATE_RUNS} (line 1, column 1)`,
    );
  });

  test("a method with no route keeps the grammar's own sentence", () => {
    expect(refusalOf(() => parseWeaviateRequest("FOO")).message).toBe(
      "FOO is not a method this console takes: it takes GET and POST. (line 1, column 1)",
    );
    expect(refusalOf(() => parseWeaviateRequest("GET")).message).toBe("GET needs a route after it. (line 1, column 4)");
  });

  test("a refusal that is not about the route keeps the grammar's sentence", () => {
    expect(refusalOf(() => parseWeaviateRequest("GET /v1/meta {}")).message).toBe(
      "GET meta takes no body. (line 1, column 13)",
    );
    expect(refusalOf(() => parseWeaviateRequest("GET /v1/nodes?include=vector")).message).toBe(
      "GET nodes takes no query key include. (line 1, column 15)",
    );
  });

  test("the prefix may be left out", () => {
    expect(plan("GET schema").route.op).toBe("schema");
    expect(plan("GET /v1/meta").route.op).toBe("meta");
  });
});

describe("collection, alias, tenant and id names (W1)", () => {
  test("a collection name is spelled as the server spells it, first letter capitalised", () => {
    expect(plan("GET /v1/schema/article").collection).toBe("Article");
    expect(serverClassName("tenantNotes")).toBe("TenantNotes");
  });

  test("a name of 255 characters opens and one of 256 is refused", () => {
    const longest = `A${"b".repeat(254)}`;
    expect(weaviateClassNameRefusal(longest)).toBeUndefined();
    expect(weaviateClassNameRefusal(`${longest}b`)).toBe(
      `"${"A" + "b".repeat(79)}..." is not a Weaviate collection name: it starts with a letter and holds only letters, digits and _, at most 255 characters.`,
    );
  });

  test("the empty name has its own sentence", () => {
    expect(weaviateClassNameRefusal("")).toBe("A collection name cannot be empty.");
  });

  test("a collection name with a character Weaviate refuses is refused naming the path parameter", () => {
    expect(refused("GET /v1/schema/1abc")).toEqual({
      phase: 0,
      key: "collection",
      message:
        'collection: "1abc" is not a Weaviate collection name: it starts with a letter and holds only letters, digits and _, at most 255 characters.',
    });
  });

  test("an alias follows the collection rule", () => {
    expect(plan("GET /v1/aliases/Articles").route.op).toBe("alias");
    expect(refused("GET /v1/aliases/my-alias")).toEqual({
      phase: 0,
      key: "alias",
      message:
        'alias: "my-alias" is not a Weaviate collection name: it starts with a letter and holds only letters, digits and _, at most 255 characters.',
    });
  });

  test("a tenant holds letters, digits, - and _, 1 to 64 characters", () => {
    expect(weaviateTenantNameRefusal("acme-1_x")).toBeUndefined();
    expect(weaviateTenantNameRefusal("x".repeat(64))).toBeUndefined();
    expect(weaviateTenantNameRefusal("x".repeat(65))).toBe(
      `"${"x".repeat(65)}" is not a Weaviate tenant name: it holds only letters, digits, - and _, 1 to 64 characters.`,
    );
    expect(plan("GET /v1/schema/TenantNotes/tenants/acme").tenant).toBe("acme");
    expect(refused("GET /v1/schema/TenantNotes/tenants/a.b")).toEqual({
      phase: 0,
      key: "tenant",
      message:
        'tenant: "a.b" is not a Weaviate tenant name: it holds only letters, digits, - and _, 1 to 64 characters.',
    });
  });

  test("an object id is a UUID", () => {
    expect(plan("GET /v1/objects/Article/9e6866af-ef70-5a5a-9b61-1ae7a41bad0d").route.op).toBe("object");
    expect(refused("GET /v1/objects/Article/42")).toEqual({
      phase: 0,
      key: "id",
      message: 'id is "42", which is not a UUID: Weaviate\'s object ids are UUIDs.',
    });
  });

  test("a tenant in the query string is the plan's tenant", () => {
    expect(plan("GET /v1/schema/TenantNotes/shards?tenant=acme").tenant).toBe("acme");
    expect(refused("GET /v1/schema/TenantNotes/shards?tenant=a.b").key).toBe("tenant");
  });

  test("a route that names no collection plans none, and takes no body", () => {
    const meta = plan("GET /v1/meta");
    expect({ collection: meta.collection, tenant: meta.tenant, body: meta.body, search: meta.search }).toEqual({
      collection: null,
      tenant: null,
      body: null,
      search: null,
    });
    expect(meta.warnings).toEqual([]);
  });
});

describe("GET /v1/objects (spec 5.2, 5.3)", () => {
  test("names its class, which is the plan's collection, and is sent with the default limit 25", () => {
    const read = plan("GET /v1/objects?class=article");
    expect(read.collection).toBe("Article");
    expect(read.query).toEqual({ class: "article", limit: "25" });
  });

  test("keeps a limit the user wrote", () => {
    expect(plan("GET /v1/objects?class=Article&limit=50").query.limit).toBe("50");
  });

  test("without a class is refused", () => {
    expect(refused("GET /v1/objects")).toEqual({
      phase: 0,
      key: "class",
      message: "GET /v1/objects needs ?class=<collection>: without it Weaviate answers no objects.",
    });
  });

  test("a class that is no collection name is refused naming class", () => {
    expect(refused("GET /v1/objects?class=a-b").message).toBe(
      'class: "a-b" is not a Weaviate collection name: it starts with a letter and holds only letters, digits and _, at most 255 characters.',
    );
  });

  test.each([
    ["after=9e6866af-ef70-5a5a-9b61-1ae7a41bad0d&offset=3", "after"],
    ["after=9e6866af-ef70-5a5a-9b61-1ae7a41bad0d&sort=title", "after"],
  ])("after with %s is refused: after pages by id", (keys, key) => {
    expect(refused(`GET /v1/objects?class=Article&${keys}`)).toEqual({
      phase: 0,
      key,
      message: "after pages by id, so it takes neither offset nor sort.",
    });
  });

  test("after must be a UUID", () => {
    expect(refused("GET /v1/objects?class=Article&after=abc").message).toBe(
      'after is "abc", which is not a UUID: Weaviate\'s object ids are UUIDs.',
    );
  });

  test("order needs sort", () => {
    expect(refused("GET /v1/objects?class=Article&order=asc")).toEqual({
      phase: 0,
      key: "order",
      message: "order needs sort.",
    });
  });

  test("every sort entry is a property name", () => {
    expect(plan("GET /v1/objects?class=Article&sort=title,wordCount&order=desc").query.sort).toBe("title,wordCount");
    expect(refused("GET /v1/objects?class=Article&sort=title,9x")).toEqual({
      phase: 0,
      key: "sort[1]",
      message: 'sort[1] is "9x", which is not a Weaviate property name.',
    });
  });

  test("a tenant in the query string is checked and planned", () => {
    expect(plan("GET /v1/objects?class=TenantNotes&tenant=acme").tenant).toBe("acme");
    expect(refused("GET /v1/objects?class=TenantNotes&tenant=a.b").key).toBe("tenant");
  });

  test("limit plus offset is at most 1,000", () => {
    expect(plan("GET /v1/objects?class=Article&limit=990&offset=10").query).toEqual({
      class: "Article",
      limit: "990",
      offset: "10",
    });
    expect(refused("GET /v1/objects?class=Article&limit=1001")).toEqual({
      phase: 0,
      key: "limit",
      message: "limit plus offset is 1001, above the bound of 1000 rows.",
    });
    expect(refused("GET /v1/objects?class=Article&offset=980").message).toBe(
      "limit plus offset is 1005, above the bound of 1000 rows.",
    );
  });

  test("offset takes 0, which Weaviate reads as the first object, and refuses anything else that is not a count", () => {
    expect(plan("GET /v1/objects?class=Article&offset=0").query.offset).toBe("0");
    for (const value of ["-1", "01", "1.5", "x"]) {
      expect(refused(`GET /v1/objects?class=Article&offset=${value}`)).toEqual({
        phase: 0,
        key: "offset",
        message: `offset is "${value}"; it takes an integer from 0 to 1000.`,
      });
    }
  });

  test("a groupBy that names no limit is sent with the server's own 100, and an aggregate without one with none", () => {
    expect(bodyText('POST /v1/aggregate/Article {"groupBy": "category"}')).toBe('{"groupBy":"category","limit":100}');
    expect(bodyText('POST /v1/aggregate/Article {"groupBy": "category", "limit": 7}')).toBe(
      '{"groupBy":"category","limit":7}',
    );
    expect(bodyText("POST /v1/aggregate/Article {}")).toBe("{}");
  });

  test("include is a key of the two object reads only", () => {
    expect(plan("GET /v1/objects?class=Article&include=vector").query.include).toBe("vector");
    expect(plan("GET /v1/objects/Article/9e6866af-ef70-5a5a-9b61-1ae7a41bad0d?include=vector").query.include).toBe(
      "vector",
    );
  });
});

describe("GET /v1/nodes", () => {
  test("output takes one word", () => {
    expect(plan("GET /v1/nodes?output=verbose").query).toEqual({ output: "verbose" });
    expect(plan("GET /v1/nodes/Article?output=minimal").collection).toBe("Article");
    expect(refused("GET /v1/nodes?output=minimal,verbose")).toEqual({
      phase: 0,
      key: "output",
      message: "output takes one of minimal or verbose.",
    });
  });
});

describe("POST /v1/aggregate/{collection} (spec 5.2)", () => {
  test("an absent body is an empty aggregate, one count", () => {
    const read = plan("POST /v1/aggregate/Article");
    expect(bodyText("POST /v1/aggregate/Article")).toBe("{}");
    expect(read.search).toEqual({
      op: "aggregate",
      collection: "Article",
      tenant: null,
      where: null,
      limit: null,
      offset: null,
      autoLimit: null,
      consistencyLevel: null,
      returnProperties: null,
      returnMetadata: [],
      query: null,
      queryProperties: null,
      fusionType: null,
      maxVectorDistance: null,
      vector: null,
      id: null,
      targetVector: null,
      distance: null,
      certainty: null,
      groupBy: null,
    });
  });

  test("the body's tenant is the plan's tenant", () => {
    const read = plan('POST /v1/aggregate/TenantNotes {"tenant": "acme"}');
    expect(read.tenant).toBe("acme");
    expect(read.search?.tenant).toBe("acme");
    expect(bodyText('POST /v1/aggregate/TenantNotes {"tenant": "acme"}')).toBe('{"tenant":"acme"}');
  });

  test("a groupBy names a property, and a limit bounds its groups", () => {
    const read = searchOf('POST /v1/aggregate/Article {"groupBy": "category", "limit": 3, "returnMetrics": ["count"]}');
    expect(read.groupBy).toBe("category");
    expect(toJsonText(read.limit as TaggedJson)).toBe("3");
  });

  test("a limit without groupBy is refused, since an aggregate without groupBy has one row", () => {
    expect(refused('POST /v1/aggregate/Article {"limit": 3}')).toEqual({
      phase: 0,
      key: "limit",
      message: "limit bounds the groups of a groupBy; an aggregate without groupBy has one row.",
    });
  });

  test("a groupBy limit is bounded from 1 to 1000", () => {
    expect(refused('POST /v1/aggregate/Article {"groupBy": "category", "limit": 0}').message).toBe(
      "limit is 0; it takes an integer from 1 to 1000.",
    );
  });

  test("groupBy must be a property name, written as a string", () => {
    expect(refused('POST /v1/aggregate/Article {"groupBy": "9x"}')).toEqual({
      phase: 0,
      key: "groupBy",
      message: 'groupBy is "9x", which is not a Weaviate property name.',
    });
    expect(refused('POST /v1/aggregate/Article {"groupBy": ["category"]}').message).toBe(
      "groupBy must be a string, found a list.",
    );
  });

  test("returnMetrics takes count only", () => {
    expect(refused('POST /v1/aggregate/Article {"returnMetrics": ["mean"]}')).toEqual({
      phase: 0,
      key: "returnMetrics[0]",
      message: 'returnMetrics[0] takes one of count, not "mean".',
    });
    expect(refused('POST /v1/aggregate/Article {"returnMetrics": "count"}').message).toBe(
      "returnMetrics must be a list, found a string.",
    );
  });

  test("over and objectLimit are refused as reserved, an unknown key by the closed set", () => {
    expect(refused('POST /v1/aggregate/Article {"over": {}}')).toEqual({
      phase: 0,
      key: "over",
      message:
        'The body takes no key "over" in this console: aggregate over a search is reserved in Weaviate\'s REST aggregate.',
    });
    expect(refused('POST /v1/aggregate/Article {"filter": {}}').message).toBe(
      'The body takes no key "filter": Weaviate reads where, tenant, groupBy, limit, returnMetrics there and nothing else.',
    );
  });

  test("a where filter is read by the same rules as a search's", () => {
    const read = searchOf(
      'POST /v1/aggregate/Article {"where": {"path": ["category"], "operator": "Equal", "valueText": "alpha"}}',
    );
    expect(read.where).not.toBeNull();
  });
});
