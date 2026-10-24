/**
 * A Weaviate class definition read into the tree's columns, the vector family's fields and a console request's facts
 * (#1566 spec 4.2, 3.6, 5.6, 6.1), over the definitions the seeded servers answered and hand-written ones in their
 * shape: the unnamed vector and named vectors, the compression enabled, a cross-reference typed `ref → Target`, the
 * GraphQL selection a geo, phone or object property needs, and the `int` properties whose GraphQL nulls are marked.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  propertyTypeText,
  readWeaviateClass,
  readWeaviateSchema,
  selectionOf,
  vectorColumnName,
  vectorField,
  vectorTypeText,
  WEAVIATE_PRIMITIVE_TYPES,
  type WeaviateVector,
  weaviateCollectionFacts,
  weaviateColumns,
  weaviateIndexes,
} from "@/lib/db/providers/vector/weaviate/schema";
import { capturedText } from "../../../helpers/weaviate-surface";

const captured = (name: string, file = "weaviate/surface.json") =>
  readWeaviateClass(JSON.parse(capturedText(file, "GET", `/v1/schema/${name}`)), name);

const vector = (over: Partial<WeaviateVector> = {}): WeaviateVector => ({
  name: "",
  vectorizer: "none",
  indexType: "hnsw",
  distance: "cosine",
  quantization: null,
  ...over,
});

describe("a class definition", () => {
  test("Article: one unnamed vector, every property in schema order, a cross-reference", () => {
    const article = captured("Article");
    expect(article.name).toBe("Article");
    expect(article.multiTenant).toBe(false);
    expect(article.autoTenantActivation).toBe(false);
    expect(article.vectors).toEqual([vector()]);
    expect(article.properties.map((property) => property.name)).toEqual([
      "title",
      "body",
      "category",
      "tags",
      "wordCount",
      "rating",
      "published",
      "publishedAt",
      "location",
      ...article.properties.slice(9).map((property) => property.name),
    ]);
    const references = article.properties.filter((property) => property.reference);
    expect(references.length).toBeGreaterThan(0);
    expect(article.definition).toEqual(JSON.parse(capturedText("weaviate/surface.json", "GET", "/v1/schema/Article")));
  });

  test("Product: two named vectors, each with its own index type and distance", () => {
    expect(captured("Product").vectors.map(({ name, indexType, distance }) => ({ name, indexType, distance }))).toEqual(
      [
        { name: "image", indexType: "hnsw", distance: "cosine" },
        { name: "text", indexType: "flat", distance: "dot" },
      ],
    );
  });

  test("the tenancy flags, as declared", () => {
    expect(captured("TenantNotes")).toMatchObject({ multiTenant: true, autoTenantActivation: false });
    expect(captured("TenantNotesAuto")).toMatchObject({ multiTenant: true, autoTenantActivation: true });
    expect(readWeaviateClass({ class: "A", multiTenancyConfig: "on" }, "A")).toMatchObject({
      multiTenant: false,
      autoTenantActivation: false,
    });
  });

  test("the vectorizer: a module name, the first key of a named vector's, else none", () => {
    const definition = readWeaviateClass(
      {
        class: "V",
        vectorizer: "text2vec-openai",
        vectorIndexType: "hnsw",
        vectorIndexConfig: { distance: "l2-squared", pq: { enabled: false }, bq: { enabled: true } },
        vectorConfig: {
          a: { vectorizer: { "text2vec-cohere": {} }, vectorIndexConfig: { sq: { enabled: true } } },
          b: { vectorizer: {}, vectorIndexType: "dynamic", vectorIndexConfig: "x" },
          c: { vectorizer: "" },
          skipped: "not an object",
        },
      },
      "V",
    );
    expect(definition.vectors).toEqual([
      { name: "", vectorizer: "text2vec-openai", indexType: "hnsw", distance: "l2-squared", quantization: "bq" },
      { name: "a", vectorizer: "text2vec-cohere", indexType: "hnsw", distance: null, quantization: "sq" },
      { name: "b", vectorizer: "none", indexType: "dynamic", distance: null, quantization: null },
      { name: "c", vectorizer: "none", indexType: "hnsw", distance: null, quantization: null },
    ]);
  });

  test("a definition with no vector config has no vector", () => {
    expect(readWeaviateClass({ class: "Plain" }, "Plain").vectors).toEqual([]);
  });

  test("properties that are not objects or have no name are skipped; a non-string type word is dropped", () => {
    const definition = readWeaviateClass(
      { class: "P", properties: [null, { dataType: ["text"] }, { name: "n", dataType: ["int", 7] }, { name: "u" }] },
      "P",
    );
    expect(definition.properties).toEqual([
      { name: "n", dataType: ["int"], reference: false, nested: [] },
      { name: "u", dataType: [], reference: false, nested: [] },
    ]);
    expect(readWeaviateClass({ class: "Q", properties: "none" }, "Q").properties).toEqual([]);
  });

  test("a definition with no class name is refused, naming what was asked for", () => {
    for (const value of [null, [], { class: 1 }, "Article"]) {
      expect(() => readWeaviateClass(value, "Article")).toThrow(
        new QueryError(`Weaviate's definition of "Article" holds no class name.`, "weaviate"),
      );
    }
  });
});

describe("the schema", () => {
  test("every class, in the server's order; none where it lists none", () => {
    expect(readWeaviateSchema({ classes: [{ class: "B" }, { class: "A" }] }).map((entry) => entry.name)).toEqual([
      "B",
      "A",
    ]);
    expect(readWeaviateSchema({ classes: null })).toEqual([]);
    expect(readWeaviateSchema({})).toEqual([]);
    expect(readWeaviateSchema("not an object")).toEqual([]);
  });

  test("a classes field that is not a list is refused; a nameless class is refused by its index", () => {
    expect(() => readWeaviateSchema({ classes: {} })).toThrow("Weaviate's schema holds no classes list.");
    expect(() => readWeaviateSchema({ classes: [{ class: "A" }, {}] })).toThrow(
      `Weaviate's definition of "class 1" holds no class name.`,
    );
  });
});

describe("columns and indexes", () => {
  test("$id, the properties typed by Weaviate's word, then the vectors with the dimension an object showed", () => {
    const product = captured("Product");
    expect(weaviateColumns(product, new Map([["image", 8]]))).toEqual([
      { name: "$id", type: "uuid", nullable: false, isPrimary: true },
      { name: "name", type: "text", nullable: true, isPrimary: false },
      { name: "price", type: "number", nullable: true, isPrimary: false },
      { name: "sku", type: "uuid", nullable: true, isPrimary: false },
      { name: "$vector.image", type: "Vector(8, cosine, hnsw)", nullable: true, isPrimary: false },
      { name: "$vector.text", type: "Vector(?, dot, flat)", nullable: true, isPrimary: false },
    ]);
    expect(weaviateIndexes(product)).toEqual([
      { name: "$vector.image", columns: ["$vector.image"], unique: false },
      { name: "$vector.text", columns: ["$vector.text"], unique: false },
    ]);
  });

  test("a cross-reference is `ref → Target`; a property with no type word is unknown", () => {
    expect(propertyTypeText({ name: "r", dataType: ["Author", "Editor"], reference: true, nested: [] })).toBe(
      "ref → Author | Editor",
    );
    expect(propertyTypeText({ name: "u", dataType: [], reference: false, nested: [] })).toBe("unknown");
    expect(propertyTypeText({ name: "l", dataType: ["text[]"], reference: false, nested: [] })).toBe("text[]");
  });

  test("the vector's column and type text", () => {
    expect(vectorColumnName("")).toBe("$vector");
    expect(vectorColumnName("image")).toBe("$vector.image");
    expect(vectorTypeText(vector({ quantization: "pq" }), 16)).toBe("Vector(16, cosine, hnsw, pq)");
    expect(vectorTypeText(vector({ distance: null }), null)).toBe("Vector(?, distance not declared, hnsw)");
  });

  test("a vector as the family's dense field: Weaviate's distances mapped, the rest other or opaque", () => {
    expect(vectorField(vector({ name: "image" }), 8)).toEqual({
      name: "image",
      kind: "dense",
      dtype: "float32",
      dimension: 8,
      metric: "cosine",
      nativeMetric: "cosine",
      indexKind: "hnsw",
      nativeType: "Vector(8, cosine, hnsw)",
    });
    const metrics = ["dot", "l2-squared", "manhattan", "hamming", "jaccard"].map(
      (distance) => vectorField(vector({ distance }), null).metric,
    );
    expect(metrics).toEqual(["dot", "euclidean_squared", "manhattan", "hamming", "other"]);
    expect(vectorField(vector({ distance: null }), null).metric).toBeNull();
    expect(vectorField(vector({ indexType: "flat" }), null).indexKind).toBe("flat");
    expect(vectorField(vector({ indexType: "dynamic" }), null).indexKind).toBe("opaque");
  });
});

describe("the GraphQL selection and the facts", () => {
  test("a geo coordinate, a phone number and an object property are selected with their fields", () => {
    const geo = selectionOf({ name: "location", dataType: ["geoCoordinates"], reference: false, nested: [] });
    expect(geo).toEqual({ name: "location", fields: [{ name: "latitude" }, { name: "longitude" }] });
    const phone = selectionOf({ name: "phone", dataType: ["phoneNumber"], reference: false, nested: [] });
    expect(phone?.fields?.map((field) => field.name)).toEqual([
      "input",
      "internationalFormatted",
      "countryCode",
      "national",
      "nationalFormatted",
      "valid",
      "defaultCountry",
    ]);
    const nested = {
      name: "meta",
      dataType: ["object[]"],
      reference: false,
      nested: [
        { name: "a", dataType: ["text"], reference: false, nested: [] },
        { name: "r", dataType: ["Author"], reference: true, nested: [] },
      ],
    };
    expect(selectionOf(nested)).toEqual({ name: "meta", fields: [{ name: "a" }] });
  });

  test("a cross-reference, and an object with nothing to select, have no selection", () => {
    expect(selectionOf({ name: "r", dataType: ["Author"], reference: true, nested: [] })).toBeUndefined();
    expect(selectionOf({ name: "o", dataType: ["object"], reference: false, nested: [] })).toBeUndefined();
  });

  test("the facts: plain properties in order, the int properties, the references, every selection", () => {
    const facts = weaviateCollectionFacts(captured("EdgeValues", "weaviate/reads.json"));
    expect(facts.name).toBe("EdgeValues");
    expect(facts.plainProperties).toEqual(["label", "big", "bigs"]);
    expect([...facts.intProperties]).toEqual(["big", "bigs"]);
    expect([...facts.referenceProperties]).toEqual([]);
    expect([...facts.selections.keys()]).toEqual(["label", "big", "bigs"]);
    const article = weaviateCollectionFacts(captured("Article"));
    expect(article.referenceProperties.size).toBeGreaterThan(0);
    for (const name of article.referenceProperties) {
      expect(article.plainProperties).not.toContain(name);
      expect(article.selections.has(name)).toBe(false);
    }
    expect(article.selections.get("location")?.fields).toHaveLength(2);
  });

  test("the primitive words are Weaviate's own", () => {
    for (const word of ["text", "int", "number", "boolean", "date", "uuid", "geoCoordinates", "phoneNumber", "blob"]) {
      expect(WEAVIATE_PRIMITIVE_TYPES.has(word), word).toBe(true);
    }
    expect(WEAVIATE_PRIMITIVE_TYPES.has("Article")).toBe(false);
  });
});
