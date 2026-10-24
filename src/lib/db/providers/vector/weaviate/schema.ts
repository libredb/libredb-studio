/**
 * A Weaviate class definition read into what the tree, the Source, the console and the monitoring panels need
 * (#1566 spec 4.2). Pure: it receives the parsed answer of `GET /v1/schema` or `GET /v1/schema/{collection}` and
 * never a client.
 *
 * A collection has either one unnamed vector (`vectorizer`, `vectorIndexType` and `vectorIndexConfig` at its top
 * level) or named vectors (`vectorConfig`, each with its own vectorizer, index type and distance), measured on 1.37.4
 * and 1.40.2. The schema declares no dimension, so a vector's dimension is unknown until an object is read
 * (`describeObject` reads one, spec 4.2). A property's type is Weaviate's own `dataType` word; a cross-reference's
 * `dataType` names its target classes.
 *
 * Weaviate stores an `int` property as a float64 (spec A.3), so a column typed `int` is a number and the grid shows
 * it as one; on the GraphQL path a value outside int32 answers null, which `results.ts` marks.
 */
import { QueryError } from "@/lib/db/errors";
import type { VectorFieldInfo, VectorIndexKind, VectorMetric } from "@/lib/db/vector/types";
import type { ColumnSchema, DatabaseType, IndexSchema } from "@/lib/types";

const PROVIDER: DatabaseType = "weaviate";

/** The data types Weaviate declares for a primitive property; any other `dataType` names a cross-reference target. */
export const WEAVIATE_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  "text",
  "text[]",
  "string",
  "string[]",
  "int",
  "int[]",
  "number",
  "number[]",
  "boolean",
  "boolean[]",
  "date",
  "date[]",
  "uuid",
  "uuid[]",
  "geoCoordinates",
  "phoneNumber",
  "blob",
  "object",
  "object[]",
]);

export interface WeaviateProperty {
  readonly name: string;
  /** Weaviate's `dataType` list as declared: one primitive word, or the target classes of a cross-reference. */
  readonly dataType: readonly string[];
  /** Whether the property is a cross-reference. */
  readonly reference: boolean;
  /** An `object` or `object[]` property's own properties, as declared; empty for every other type. */
  readonly nested: readonly WeaviateProperty[];
}

/**
 * One field of a GraphQL selection: a name, and the fields it needs selected under it. GraphQL refuses an object,
 * a geo coordinate or a phone number with no sub-selection (measured on 1.37.4), so the selection is built from
 * the schema and the two paths answer the same properties.
 */
export interface SelectionField {
  readonly name: string;
  readonly fields?: readonly SelectionField[];
}

const GEO_FIELDS: readonly SelectionField[] = Object.freeze([{ name: "latitude" }, { name: "longitude" }]);
const PHONE_FIELDS: readonly SelectionField[] = Object.freeze(
  ["input", "internationalFormatted", "countryCode", "national", "nationalFormatted", "valid", "defaultCountry"].map(
    (name) => ({ name }),
  ),
);

/** A property's GraphQL selection; undefined for a cross-reference, which this version never selects. */
export function selectionOf(property: WeaviateProperty): SelectionField | undefined {
  if (property.reference) return undefined;
  const type = property.dataType[0];
  if (type === "geoCoordinates") return { name: property.name, fields: GEO_FIELDS };
  if (type === "phoneNumber") return { name: property.name, fields: PHONE_FIELDS };
  if (type === "object" || type === "object[]") {
    const fields = property.nested.flatMap((child) => {
      const field = selectionOf(child);
      return field === undefined ? [] : [field];
    });
    return fields.length === 0 ? undefined : { name: property.name, fields };
  }
  return { name: property.name };
}

export interface WeaviateVector {
  /** "" for the unnamed vector. */
  readonly name: string;
  /** The vectorizer module's name, `none` where vectors are supplied by the writer. */
  readonly vectorizer: string;
  /** `hnsw`, `flat`, `dynamic`, `hfresh`, or what the server declares. */
  readonly indexType: string;
  /** `cosine`, `dot`, `l2-squared`, `hamming`, `manhattan`; null where the server declares none. */
  readonly distance: string | null;
  /** The compression the index declares enabled, or null. */
  readonly quantization: string | null;
}

export interface WeaviateClass {
  readonly name: string;
  readonly properties: readonly WeaviateProperty[];
  readonly vectors: readonly WeaviateVector[];
  readonly multiTenant: boolean;
  readonly autoTenantActivation: boolean;
  /** The definition as the server sent it, for the Source. */
  readonly definition: Readonly<Record<string, unknown>>;
}

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The compression an index config declares enabled: `pq`, `bq`, `sq` or `rq`, the first one found. */
function quantizationOf(config: unknown): string | null {
  if (!isObject(config)) return null;
  for (const kind of ["pq", "bq", "sq", "rq"]) {
    const entry = config[kind];
    if (isObject(entry) && entry.enabled === true) return kind;
  }
  return null;
}

/** A named vector's vectorizer is `{ "<module>": {...} }`; the unnamed vector's is the module name itself. */
function vectorizerName(value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (isObject(value)) {
    const names = Object.keys(value);
    if (names.length > 0) return names[0];
  }
  return "none";
}

function vectorsOf(definition: JsonObject): readonly WeaviateVector[] {
  const vectors: WeaviateVector[] = [];
  const unnamedIndex = text(definition.vectorIndexType);
  if (unnamedIndex !== null) {
    const config = definition.vectorIndexConfig;
    vectors.push({
      name: "",
      vectorizer: vectorizerName(definition.vectorizer),
      indexType: unnamedIndex,
      distance: isObject(config) ? text(config.distance) : null,
      quantization: quantizationOf(config),
    });
  }
  if (isObject(definition.vectorConfig)) {
    for (const [name, entry] of Object.entries(definition.vectorConfig)) {
      if (!isObject(entry)) continue;
      const config = entry.vectorIndexConfig;
      vectors.push({
        name,
        vectorizer: vectorizerName(entry.vectorizer),
        indexType: text(entry.vectorIndexType) ?? "hnsw",
        distance: isObject(config) ? text(config.distance) : null,
        quantization: quantizationOf(config),
      });
    }
  }
  return vectors;
}

function propertiesOf(list: unknown): readonly WeaviateProperty[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown): WeaviateProperty[] => {
    if (!isObject(entry) || typeof entry.name !== "string") return [];
    const dataType = Array.isArray(entry.dataType)
      ? entry.dataType.filter((word): word is string => typeof word === "string")
      : [];
    const reference = dataType.length > 0 && dataType.every((word) => !WEAVIATE_PRIMITIVE_TYPES.has(word));
    return [{ name: entry.name, dataType, reference, nested: propertiesOf(entry.nestedProperties) }];
  });
}

/** One class definition, or a refusal naming what is missing. `fallbackName` names it in that refusal. */
export function readWeaviateClass(definition: unknown, fallbackName: string): WeaviateClass {
  if (!isObject(definition) || typeof definition.class !== "string") {
    throw new QueryError(`Weaviate's definition of ${JSON.stringify(fallbackName)} holds no class name.`, PROVIDER);
  }
  const tenancy = isObject(definition.multiTenancyConfig) ? definition.multiTenancyConfig : {};
  return {
    name: definition.class,
    properties: propertiesOf(definition.properties),
    vectors: vectorsOf(definition),
    multiTenant: tenancy.enabled === true,
    autoTenantActivation: tenancy.autoTenantActivation === true,
    definition,
  };
}

/** The classes of a `GET /v1/schema` answer, in the order the server lists them. */
export function readWeaviateSchema(answer: unknown): readonly WeaviateClass[] {
  const classes = isObject(answer) ? answer.classes : undefined;
  if (classes === null || classes === undefined) return [];
  if (!Array.isArray(classes)) throw new QueryError("Weaviate's schema holds no classes list.", PROVIDER);
  return classes.map((entry, index) => readWeaviateClass(entry, `class ${index}`));
}

const METRICS: Readonly<Record<string, VectorMetric>> = {
  cosine: "cosine",
  dot: "dot",
  "l2-squared": "euclidean_squared",
  manhattan: "manhattan",
  hamming: "hamming",
};

const INDEX_KINDS: Readonly<Record<string, VectorIndexKind>> = { hnsw: "hnsw", flat: "flat" };

/** A vector's column: `$vector` for the unnamed one, `$vector.` and its name for a named one. */
export function vectorColumnName(name: string): string {
  return name === "" ? "$vector" : `$vector.${name}`;
}

/** The vector's type text, `Vector(16, cosine, hnsw)`, with `?` for a dimension no object has shown. */
export function vectorTypeText(vector: WeaviateVector, dimension: number | null): string {
  const parts = [
    dimension === null ? "?" : String(dimension),
    vector.distance ?? "distance not declared",
    vector.indexType,
  ];
  if (vector.quantization !== null) parts.push(vector.quantization);
  return `Vector(${parts.join(", ")})`;
}

/** A vector as the vector family's shared field, for the dense checks and the grid. */
export function vectorField(vector: WeaviateVector, dimension: number | null): VectorFieldInfo {
  return {
    name: vector.name,
    kind: "dense",
    dtype: "float32",
    dimension,
    metric: vector.distance === null ? null : (METRICS[vector.distance] ?? "other"),
    nativeMetric: vector.distance,
    indexKind: INDEX_KINDS[vector.indexType] ?? "opaque",
    nativeType: vectorTypeText(vector, dimension),
  };
}

/** A property's column type: the primitive word, or `ref → Target` for a cross-reference. */
export function propertyTypeText(property: WeaviateProperty): string {
  if (property.reference) return `ref → ${property.dataType.join(" | ")}`;
  return property.dataType.join(", ") || "unknown";
}

const ID_COLUMN: ColumnSchema = { name: "$id", type: "uuid", nullable: false, isPrimary: true };

/** The columns: `$id`, every property in schema order, then every vector, its dimension where an object showed it. */
export function weaviateColumns(
  definition: WeaviateClass,
  dimensions: ReadonlyMap<string, number> = new Map(),
): readonly ColumnSchema[] {
  return [
    ID_COLUMN,
    ...definition.properties.map(
      (property): ColumnSchema => ({
        name: property.name,
        type: propertyTypeText(property),
        nullable: true,
        isPrimary: false,
      }),
    ),
    ...definition.vectors.map(
      (vector): ColumnSchema => ({
        name: vectorColumnName(vector.name),
        type: vectorTypeText(vector, dimensions.get(vector.name) ?? null),
        nullable: true,
        isPrimary: false,
      }),
    ),
  ];
}

/** One index per vector, named by its column. Inverted indexes are per-property flags in the Source. */
export function weaviateIndexes(definition: WeaviateClass): readonly IndexSchema[] {
  return definition.vectors.map(
    (vector): IndexSchema => ({
      name: vectorColumnName(vector.name),
      columns: [vectorColumnName(vector.name)],
      unique: false,
    }),
  );
}

/** What a console request reads from the collection it names (spec 5.3, W3, W6, W11). */
export interface WeaviateCollectionFacts {
  readonly name: string;
  readonly multiTenant: boolean;
  readonly autoTenantActivation: boolean;
  readonly vectors: readonly WeaviateVector[];
  /** Every top-level property's GraphQL selection, by name; a cross-reference has none. */
  readonly selections: ReadonlyMap<string, SelectionField>;
  /** The non-reference properties, in schema order: what REST answers when a request names no property. */
  readonly plainProperties: readonly string[];
  /** The properties typed `int` or `int[]`, whose GraphQL nulls outside int32 are marked (spec 5.2). */
  readonly intProperties: ReadonlySet<string>;
  /** The reference properties, which a request may not select in this version. */
  readonly referenceProperties: ReadonlySet<string>;
}

export function weaviateCollectionFacts(definition: WeaviateClass): WeaviateCollectionFacts {
  const selections = new Map<string, SelectionField>();
  for (const property of definition.properties) {
    const field = selectionOf(property);
    if (field !== undefined) selections.set(property.name, field);
  }
  return {
    name: definition.name,
    multiTenant: definition.multiTenant,
    autoTenantActivation: definition.autoTenantActivation,
    vectors: definition.vectors,
    selections,
    plainProperties: definition.properties.filter((property) => !property.reference).map((property) => property.name),
    intProperties: new Set(
      definition.properties
        .filter((property) => property.dataType.some((word) => word === "int" || word === "int[]"))
        .map((property) => property.name),
    ),
    referenceProperties: new Set(definition.properties.filter((property) => property.reference).map((p) => p.name)),
  };
}
