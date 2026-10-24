/**
 * The Weaviate object surface (#1566 spec 4, 6.1, 6.2) over a recording `send` that answers from the captures of the
 * seeded servers: the one kind, a listing sorted by name from one schema read, its count scoped to a credential,
 * `describeObject` with its one sampled object for the dimensions and none for a multi-tenant collection (W6),
 * `describeObjects` in one round trip with the caller's bound, the exact count over the path the version decides,
 * and the Source's reads.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import {
  countWeaviateCollection,
  countWeaviateObjects,
  describeWeaviateObject,
  describeWeaviateObjects,
  listWeaviateObjects,
  NO_COLLECTIONS_VISIBLE,
  parseAnswer,
  readWeaviateClasses,
  readWeaviateCollection,
  readWeaviateObjectSource,
  VISIBLE_TO_CREDENTIAL,
  WEAVIATE_OBJECT_KINDS,
  WEAVIATE_SURFACE_TIMEOUT_MS,
} from "@/lib/db/providers/vector/weaviate/objects";
import { readWeaviateClass, weaviateColumns } from "@/lib/db/providers/vector/weaviate/schema";
import { weaviateSourceParts } from "@/lib/db/providers/vector/weaviate/source";
import { expectCalls } from "../../../helpers/call-log";
import {
  answer,
  capturedServer,
  capturedText,
  json,
  overriding,
  pathMemory,
  rejection,
  renderedPart,
  surfaceContext,
} from "../../../helpers/weaviate-surface";

const SURFACE = capturedServer("weaviate/surface.json");
const SURFACE_1_37 = capturedServer("weaviate-1-37/surface.json");
const definitionOf = (name: string) =>
  readWeaviateClass(JSON.parse(capturedText("weaviate/surface.json", "GET", `/v1/schema/${name}`)), name);

const SORTED = ["Article", "Author", "EdgeValues", "Empty", "Product", "TenantNotes", "TenantNotesAuto"];

describe("the kind", () => {
  test("one kind, the collection, with columns and a JSON Source, its count the listing", () => {
    expect(WEAVIATE_OBJECT_KINDS).toEqual([
      {
        id: "collection",
        role: "relation",
        label: "Collection",
        labelPlural: "Collections",
        hasColumns: true,
        hasSource: true,
        sourceLanguage: "json",
        countIsListing: true,
      },
    ]);
    expect(Object.isFrozen(WEAVIATE_OBJECT_KINDS)).toBe(true);
    expect(WEAVIATE_SURFACE_TIMEOUT_MS).toBe(10_000);
  });

  test("another kind, or a path that is not [name], is refused before anything is sent", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    await expect(listWeaviateObjects(context, "view")).rejects.toThrow('Weaviate declares no object kind "view"');
    await expect(describeWeaviateObjects(context, "tenant")).rejects.toThrow(QueryError);
    await expect(describeWeaviateObject(context, ["Article", "acme"], "collection")).rejects.toThrow(
      'A Weaviate "collection" path is [name], received ["Article","acme"]',
    );
    await expect(readWeaviateObjectSource(context, [], "collection")).rejects.toThrow("is [name], received []");
    expectCalls(calls, []);
  });
});

describe("the listing", () => {
  test("one schema read, the collections sorted by name, names only", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    expect(await listWeaviateObjects(context, "collection")).toEqual(
      SORTED.map((name) => ({ path: [name], name, kind: "collection" })),
    );
    expectCalls(calls, [{ method: "schema", args: [{ op: "schema", params: {}, query: {} }] }]);
  });

  test("whatever order the server lists them in", async () => {
    const { context } = surfaceContext(() => json({ classes: ["b", "C", "a", "B"].map((name) => ({ class: name })) }));
    expect((await readWeaviateClasses(context)).map((entry) => entry.name)).toEqual(["B", "C", "a", "b"]);
  });

  test("the count: exact with no credential, what the credential may see with one, unavailable when empty", async () => {
    expect(await countWeaviateObjects(surfaceContext(SURFACE).context)).toEqual({ collection: { count: 7 } });
    expect(await countWeaviateObjects(surfaceContext(SURFACE, { scoped: true }).context)).toEqual({
      collection: { count: 7, sampledFrom: VISIBLE_TO_CREDENTIAL },
    });
    for (const empty of [{ classes: [] }, { classes: null }, {}]) {
      // oxlint-disable-next-line no-await-in-loop -- each answer has its own context.
      expect(await countWeaviateObjects(surfaceContext(() => json(empty), { scoped: true }).context)).toEqual({
        collection: { unavailable: NO_COLLECTIONS_VISIBLE },
      });
    }
  });

  test("a schema answer that is not JSON is refused by name", async () => {
    const { context } = surfaceContext(() => answer(200, "<html>proxy</html>", "text/html"));
    await expect(listWeaviateObjects(context, "collection")).rejects.toThrow(
      new QueryError("Weaviate's answer to the schema is not JSON Studio can read.", "weaviate"),
    );
    expect(() => parseAnswer(answer(200, ""), "the alias list")).toThrow(
      "Weaviate's answer to the alias list is not JSON Studio can read.",
    );
  });
});

describe("describeObject", () => {
  test("the definition, then one object with its vector for the dimension", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    const detail = await describeWeaviateObject(context, ["Article"], "collection");
    expectCalls(calls, [
      { method: "collection", args: [{ op: "collection", params: { collection: "Article" }, query: {} }] },
      {
        method: "objects",
        args: [{ op: "objects", params: {}, query: { class: "Article", limit: "1", include: "vector" } }],
      },
    ]);
    expect(detail.columns.at(-1)).toEqual({
      name: "$vector",
      type: "Vector(16, cosine, hnsw)",
      nullable: true,
      isPrimary: false,
    });
    expect(detail.indexes).toEqual([{ name: "$vector", columns: ["$vector"], unique: false }]);
    expect(detail.foreignKeys).toEqual([]);
  });

  test("named vectors take their dimensions from the object's vectors", async () => {
    const detail = await describeWeaviateObject(surfaceContext(SURFACE).context, ["Product"], "collection");
    expect(detail.columns.filter((column) => column.name.startsWith("$vector"))).toEqual([
      { name: "$vector.image", type: "Vector(8, cosine, hnsw)", nullable: true, isPrimary: false },
      { name: "$vector.text", type: "Vector(16, dot, flat)", nullable: true, isPrimary: false },
    ]);
  });

  test("a multi-tenant collection is never read past its schema, so no tenant is touched", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    const detail = await describeWeaviateObject(context, ["TenantNotes"], "collection");
    expectCalls(calls, ["collection"]);
    expect(detail.columns.at(-1)?.type).toBe("Vector(?, cosine, hnsw)");
  });

  test("a collection with no vector config reads no object", async () => {
    const plain = { class: "Plain", properties: [{ name: "label", dataType: ["text"] }] };
    const { context, calls } = surfaceContext(() => json(plain));
    const detail = await describeWeaviateObject(context, ["Plain"], "collection");
    expectCalls(calls, ["collection"]);
    expect(detail.columns.map((column) => column.name)).toEqual(["$id", "label"]);
    expect(detail.indexes).toEqual([]);
  });

  test("an empty collection, or an object without vectors, leaves the dimension unknown", async () => {
    const empty = await describeWeaviateObject(surfaceContext(SURFACE).context, ["Empty"], "collection");
    expect(empty.columns.at(-1)?.type).toBe("Vector(?, cosine, hnsw)");
    for (const objects of [
      { objects: [{ id: "x", vector: [], vectors: { image: "not a list" } }] },
      { objects: "none" },
      [],
    ]) {
      const { context } = surfaceContext(overriding(SURFACE, { objects: () => json(objects) }));
      // oxlint-disable-next-line no-await-in-loop -- each answer has its own context.
      const detail = await describeWeaviateObject(context, ["Product"], "collection");
      expect(
        detail.columns.filter((column) => column.type.startsWith("Vector(?")),
        JSON.stringify(objects),
      ).toHaveLength(2);
    }
  });

  test("a sampled object that is not JSON is refused, naming the collection", async () => {
    const { context } = surfaceContext(overriding(SURFACE, { objects: () => answer(200, "{") }));
    await expect(describeWeaviateObject(context, ["Article"], "collection")).rejects.toThrow(
      `Weaviate's answer to an object of "Article" is not JSON Studio can read.`,
    );
  });
});

describe("the definition read", () => {
  test("a refusal that does not name the collection is prefixed with it", async () => {
    const missing = new QueryError("The collection does not exist or is not visible to this credential.", "weaviate");
    const prefixed = await rejection(
      readWeaviateCollection(surfaceContext(() => Promise.reject(missing)).context, "Gone"),
    );
    expect(prefixed).toBeInstanceOf(QueryError);
    expect((prefixed as Error).message).toBe(
      'Collection "Gone": The collection does not exist or is not visible to this credential.',
    );
    const { context } = surfaceContext(() => answer(200, "not json"));
    await expect(readWeaviateCollection(context, "Gone")).rejects.toThrow(
      new QueryError(
        `Weaviate's answer to the definition of collection "Gone" is not JSON Studio can read.`,
        "weaviate",
      ),
    );
    const nameless = surfaceContext(() => json({ description: "no class" })).context;
    const error = await rejection(readWeaviateCollection(nameless, "Nameless"));
    expect((error as Error).message).toBe(`Weaviate's definition of "Nameless" holds no class name.`);
  });

  test("a QueryError that already names it, or any other error, passes as it is", async () => {
    const named = new QueryError('No collection "Gone" here', "weaviate");
    expect(await rejection(readWeaviateCollection(surfaceContext(() => Promise.reject(named)).context, "Gone"))).toBe(
      named,
    );
    const auth = new AuthenticationError("Weaviate refused the API key or token.", "weaviate");
    expect(await rejection(readWeaviateCollection(surfaceContext(() => Promise.reject(auth)).context, "Gone"))).toBe(
      auth,
    );
    const plain = new Error("boom");
    expect(await rejection(readWeaviateCollection(surfaceContext(() => Promise.reject(plain)).context, "X"))).toBe(
      plain,
    );
  });
});

describe("describeObjects", () => {
  test("every collection's columns from the one schema read, with no object read", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    const batch = await describeWeaviateObjects(context, "collection");
    expectCalls(calls, ["schema"]);
    expect(batch.details.map((detail) => detail.path[0])).toEqual(SORTED);
    expect(batch.truncated).toBeUndefined();
    expect(batch.details[0].columns).toEqual([...weaviateColumns(definitionOf("Article"))]);
  });

  test("the caller's bound cuts after the sort and says so; a bound not reached cuts nothing", async () => {
    const cut = await describeWeaviateObjects(surfaceContext(SURFACE).context, "collection", 2);
    expect(cut.details.map((detail) => detail.path[0])).toEqual(["Article", "Author"]);
    expect(cut.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
    const whole = await describeWeaviateObjects(surfaceContext(SURFACE).context, "collection", 7);
    expect(whole.details).toHaveLength(7);
    expect(whole.truncated).toBeUndefined();
  });
});

describe("the exact count", () => {
  test("over REST on 1.40: one aggregate with an empty body", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    expect(await countWeaviateCollection(context, definitionOf("Article"))).toBe(500);
    expectCalls(calls, [
      { method: "aggregate", args: [{ op: "aggregate", params: { collection: "Article" }, query: {}, body: "{}" }] },
    ]);
  });

  test("over GraphQL on 1.37: one meta count", async () => {
    const { context, calls } = surfaceContext(SURFACE_1_37, { version: "1.37.4" });
    expect(await countWeaviateCollection(context, definitionOf("Article"))).toBe(500);
    expectCalls(calls, [
      {
        method: "graphql",
        args: [
          {
            op: "graphql",
            params: {},
            query: {},
            body: JSON.stringify({ query: "{Aggregate{Article{meta{count}}}}" }),
          },
        ],
      },
    ]);
  });

  test("the path the session remembered wins over the version's", async () => {
    const { context, calls } = surfaceContext(SURFACE_1_37, { paths: pathMemory({ other: "graphql" }) });
    expect(await countWeaviateCollection(context, definitionOf("Empty"))).toBe(0);
    expectCalls(calls, ["graphql"]);
  });

  test("a multi-tenant collection is not counted, and nothing is sent", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    expect(await countWeaviateCollection(context, definitionOf("TenantNotes"))).toBeNull();
    expectCalls(calls, []);
  });

  test("a failed or unreadable count answers null, with no second attempt", async () => {
    const cases = [
      () => Promise.reject(new QueryError("rate-limited", "weaviate")),
      () => answer(200, "not json"),
      () => json(null),
      () => json({ count: "500" }),
    ];
    for (const answering of cases) {
      const { context, calls } = surfaceContext(answering);
      // oxlint-disable-next-line no-await-in-loop -- each answer has its own context.
      expect(await countWeaviateCollection(context, definitionOf("Article"))).toBeNull();
      expect(calls).toHaveLength(1);
    }
    for (const body of [{ data: { Aggregate: { Article: [] } } }, { data: { Aggregate: { Article: "x" } } }, {}]) {
      const { context } = surfaceContext(() => json(body), { version: "1.37.4" });
      // oxlint-disable-next-line no-await-in-loop -- each answer has its own context.
      expect(await countWeaviateCollection(context, definitionOf("Article"))).toBeNull();
    }
  });
});

describe("the Source", () => {
  test("a single-tenant collection: definition, aliases, shards, then the count", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    const source = await readWeaviateObjectSource(context, ["Article"], "collection");
    expectCalls(calls, [
      "collection",
      { method: "aliases", args: [{ op: "aliases", params: {}, query: {} }] },
      { method: "shards", args: [{ op: "shards", params: { collection: "Article" }, query: {} }] },
      "aggregate",
    ]);
    expect(source.path).toEqual(["Article"]);
    expect(source.kind).toBe("collection");
    const state = JSON.parse(renderedPart(source.parts[1]).text);
    expect(state).toMatchObject({
      multiTenant: false,
      aliases: ["Articles"],
      objectCount: 500,
      objectCountKind: "exact, aggregate meta.count",
    });
    expect(state.shards).toHaveLength(1);
  });

  test("a multi-tenant collection: its tenants, and no shard read and no count", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    const source = await readWeaviateObjectSource(context, ["TenantNotes"], "collection");
    expectCalls(calls, [
      "collection",
      "aliases",
      { method: "tenants", args: [{ op: "tenants", params: { collection: "TenantNotes" }, query: {} }] },
    ]);
    const tenants = JSON.parse(capturedText("weaviate/surface.json", "GET", "/v1/schema/TenantNotes/tenants"));
    expect(source.parts).toEqual(
      weaviateSourceParts({
        definition: definitionOf("TenantNotes"),
        aliases: JSON.parse(capturedText("weaviate/surface.json", "GET", "/v1/aliases")),
        shards: null,
        tenants,
        count: null,
      }),
    );
    expect(JSON.parse(renderedPart(source.parts[1]).text).tenantCount).toBe(tenants.length);
  });

  test("the caller's bound reaches both parts", async () => {
    const source = await readWeaviateObjectSource(surfaceContext(SURFACE).context, ["Article"], "collection", 64);
    expect(source.parts.every((part) => renderedPart(part).truncated !== undefined)).toBe(true);
  });

  test("an alias, shard or tenant answer that is not JSON is refused by what it is", async () => {
    const cases: [string, Parameters<typeof overriding>[1], string][] = [
      ["Article", { aliases: () => answer(200, "<") }, "the alias list"],
      ["Article", { shards: () => answer(200, "<") }, 'the shards of "Article"'],
      ["TenantNotes", { tenants: () => answer(200, "<") }, 'the tenants of "TenantNotes"'],
    ];
    for (const [name, answers, what] of cases) {
      const { context } = surfaceContext(overriding(SURFACE, answers));
      // oxlint-disable-next-line no-await-in-loop -- each answer has its own context.
      await expect(readWeaviateObjectSource(context, [name], "collection")).rejects.toThrow(
        `Weaviate's answer to ${what} is not JSON Studio can read.`,
      );
    }
  });

  test("a failed count leaves the Source standing, saying the count was not read", async () => {
    const { context } = surfaceContext(overriding(SURFACE, { aggregate: () => json({}, 500) }));
    const state = JSON.parse(
      renderedPart((await readWeaviateObjectSource(context, ["Article"], "collection")).parts[1]).text,
    );
    expect(state.objectCount).toBe("not read: the aggregate count failed or this server answered none");
    expect(state.objectCountKind).toBeUndefined();
  });
});
