/**
 * A Weaviate collection's Source (#1566 spec 4.4, 6.2): two JSON parts, `Schema` the class definition unedited and
 * `State` what the collection holds, the aliases pointing at it, then its shards and exact count for a single-tenant
 * collection, or its tenant count and the first 1,024 tenants by name for a multi-tenant one, each part cut at the
 * caller's bound through the shared helper.
 */
import { describe, expect, test } from "bun:test";
import { applySourceBound } from "@/lib/db/object-kinds";
import { readWeaviateClass } from "@/lib/db/providers/vector/weaviate/schema";
import {
  COUNT_NOT_READ,
  PER_TENANT_COUNT,
  weaviateSourceParts,
  weaviateStateDocument,
} from "@/lib/db/providers/vector/weaviate/source";
import { capturedText, renderedPart } from "../../../helpers/weaviate-surface";

const FILE = "weaviate/surface.json";
const text = (path: string) => capturedText(FILE, "GET", path);
const definitionOf = (name: string) => readWeaviateClass(JSON.parse(text(`/v1/schema/${name}`)), name);
const ALIASES = JSON.parse(text("/v1/aliases"));

describe("the State part", () => {
  test("a single-tenant collection: its aliases, its shards with their statuses, its exact count", () => {
    const state = weaviateStateDocument({
      definition: definitionOf("Article"),
      aliases: ALIASES,
      shards: JSON.parse(text("/v1/schema/Article/shards")),
      tenants: null,
      count: 500,
    });
    expect(state).toEqual({
      multiTenant: false,
      aliases: ["Articles"],
      shards: [{ name: expect.any(String), status: "READY", vectorQueueSize: 0 }],
      objectCount: 500,
      objectCountKind: "exact, aggregate meta.count",
    });
    expect(Object.keys(state)).toEqual(["multiTenant", "aliases", "shards", "objectCount", "objectCountKind"]);
  });

  test("a count not read says so, with no kind; a shard list that is not one lists none", () => {
    const state = weaviateStateDocument({
      definition: definitionOf("Empty"),
      aliases: ALIASES,
      shards: { shards: [] },
      tenants: null,
      count: null,
    });
    expect(state).toEqual({ multiTenant: false, aliases: [], shards: [], objectCount: COUNT_NOT_READ });
  });

  test("a shard entry keeps name and status only, its queue size where it reports one", () => {
    const state = weaviateStateDocument({
      definition: definitionOf("Empty"),
      aliases: null,
      shards: [{ name: "s1", status: "READONLY", per_node_status: { node1: "READONLY" } }, "junk"],
      tenants: null,
      count: 0,
    });
    expect(state.shards).toEqual([{ name: "s1", status: "READONLY" }]);
    expect(state.objectCount).toBe(0);
  });

  test("only the aliases that point at this collection, by name", () => {
    const aliases = {
      aliases: [
        { alias: "Articles", class: "Article" },
        { alias: "Other", class: "Product" },
        { alias: 7, class: "Article" },
        "junk",
      ],
    };
    const state = weaviateStateDocument({
      definition: definitionOf("Article"),
      aliases,
      shards: [],
      tenants: null,
      count: 1,
    });
    expect(state.aliases).toEqual(["Articles"]);
    for (const none of [null, [], { aliases: "x" }]) {
      expect(
        weaviateStateDocument({
          definition: definitionOf("Article"),
          aliases: none,
          shards: [],
          tenants: null,
          count: 1,
        }).aliases,
      ).toEqual([]);
    }
  });

  test("a multi-tenant collection: tenant count, tenants by name with their statuses, no per-tenant count", () => {
    const state = weaviateStateDocument({
      definition: definitionOf("TenantNotesAuto"),
      aliases: ALIASES,
      shards: null,
      tenants: [{ name: "umbrella", activityStatus: "COLD" }, { name: "acme" }, { activityStatus: "HOT" }, "junk"],
      count: null,
    });
    expect(state).toEqual({
      multiTenant: true,
      autoTenantActivation: true,
      aliases: [],
      tenantCount: 2,
      tenants: [
        { name: "acme", activityStatus: null },
        { name: "umbrella", activityStatus: "COLD" },
      ],
      objectCount: PER_TENANT_COUNT,
    });
  });

  test("past 1,024 tenants the first 1,024 by name are listed, and the State says so", () => {
    const tenants = Array.from({ length: 1_030 }, (_, index) => ({
      name: `t${String(1_030 - index).padStart(4, "0")}`,
      activityStatus: "HOT",
    }));
    const state = weaviateStateDocument({
      definition: definitionOf("TenantNotes"),
      aliases: ALIASES,
      shards: null,
      tenants,
      count: null,
    });
    expect(state.tenantCount).toBe(1_030);
    const listed = state.tenants as { name: string }[];
    expect(listed).toHaveLength(1_024);
    expect(listed[0].name).toBe("t0001");
    expect(listed.at(-1)?.name).toBe("t1024");
    expect(state.tenantsListed).toBe("the first 1024 of 1030 by name");
  });

  test("a tenant answer that is not a list holds no tenant", () => {
    const state = weaviateStateDocument({
      definition: definitionOf("TenantNotes"),
      aliases: ALIASES,
      shards: null,
      tenants: { tenants: [] },
      count: null,
    });
    expect(state).toMatchObject({ tenantCount: 0, tenants: [] });
    expect(state.tenantsListed).toBeUndefined();
  });
});

describe("the parts", () => {
  const input = {
    definition: definitionOf("Article"),
    aliases: ALIASES,
    shards: JSON.parse(text("/v1/schema/Article/shards")),
    tenants: null,
    count: 500,
  };

  test("Schema is the definition as the server sent it, State the document; both complete JSON", () => {
    const [schema, state] = weaviateSourceParts(input);
    expect(schema).toEqual({
      id: "schema",
      label: "Schema",
      text: JSON.stringify(JSON.parse(text("/v1/schema/Article")), null, 2),
      language: "json",
      form: "complete",
      origin: "rendered",
    });
    expect(state).toEqual({
      id: "state",
      label: "State",
      text: JSON.stringify(weaviateStateDocument(input), null, 2),
      language: "json",
      form: "complete",
      origin: "rendered",
    });
  });

  test("each part is cut at the caller's bound by the shared helper", () => {
    const [schema, state] = weaviateSourceParts(input, 100).map(renderedPart);
    const bounded = applySourceBound(JSON.stringify(input.definition.definition, null, 2), 100);
    expect(schema.text).toBe(bounded.text);
    expect(schema.truncated).toEqual(bounded.truncated);
    expect(state.truncated).toBeDefined();
    const [whole] = weaviateSourceParts(input, 1_000_000).map(renderedPart);
    expect(whole.truncated).toBeUndefined();
  });
});
