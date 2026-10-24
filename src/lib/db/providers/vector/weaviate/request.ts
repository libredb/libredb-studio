import { parseConsole, type ConsoleRequest, ConsoleRefusal, consoleTokens } from "@/lib/db/console/parser";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { utf8ByteLength } from "@/lib/db/console/bounds";
import {
  checkIntRange,
  isTaggedFloat,
  isTaggedInt,
  type TaggedJson,
  type TaggedObject,
  taggedNumber,
  toJsonText,
} from "@/lib/db/console/tagged-json";
import { checkDenseElements, vectorNumbers } from "@/lib/db/vector/dense";
import type { QueryWarning } from "@/lib/types";
import type { WeaviateConsoleOp, WeaviateEncodedOp } from "./client";
import {
  refusedRouteSentence,
  WEAVIATE_BOUNDS,
  WEAVIATE_CONSOLE,
  WEAVIATE_ENUMS,
  WEAVIATE_KEYS,
  WEAVIATE_REFUSED_KEYS,
  WEAVIATE_ROUTES,
  type WeaviateObjectName,
  type WeaviateRoute,
} from "./routes";
import type { WeaviateCollectionFacts } from "./schema";

/**
 * The Weaviate console's request rules (#1566 spec 5.1, W1, W3, W4, W6): one console text to one typed request, in
 * the phases every vector console validates in.
 *
 * Phase 0 reads the text alone and makes no call: the grammar (`parseWeaviateRequest`), then every rule that needs no
 * schema (`weaviatePhase0`): names, closed keys at every level, ids, the inference rule, enumerations, bounds, and the
 * defaults written in, so the REST and the GraphQL paths answer the same rows. Phase 1 (`weaviatePhase1`) reads the
 * collection's definition: the tenancy rule, every property and vector the request names, and the query vector's
 * numbers. The tenant's status (W6) is read by `execute.ts` after phase 1, since only the server holds it.
 *
 * Nothing here sends anything. The first two functions are what the browser runs before a statement leaves it.
 */

/** Weaviate's own name rules (`entities/schema/validation.go`, v1.40.2). A class name's first letter is capitalised by the server. */
const CLASS_NAME = /^[A-Za-z][_0-9A-Za-z]{0,254}$/;
const TENANT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PROPERTY_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,230}$/;
/** A BM25 or hybrid property with an optional boost, `title^2`. */
const BOOSTED_PROPERTY = /^([_A-Za-z][_0-9A-Za-z]{0,230})(?:\^[0-9]+(?:\.[0-9]+)?)?$/;
const VECTOR_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,230}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHOWN = 80;

/** A search's target: the vector it searches, or none for BM25. */
export type SearchKind = "bm25" | "hybrid" | "near-vector" | "near-object";

const SEARCH_KIND: Readonly<Record<Exclude<WeaviateEncodedOp, "aggregate">, SearchKind>> = {
  search_bm25: "bm25",
  search_hybrid: "hybrid",
  search_near_vector: "near-vector",
  search_near_object: "near-object",
};

/**
 * One search or aggregate as both encoders read it (spec 5.3). Every value is as the user wrote it, already checked:
 * a number keeps its literal text, so neither path rounds it.
 */
export interface WeaviateSearchModel {
  readonly op: WeaviateEncodedOp;
  readonly collection: string;
  readonly tenant: string | null;
  readonly where: TaggedObject | null;
  readonly limit: TaggedJson | null;
  readonly offset: TaggedJson | null;
  readonly autoLimit: TaggedJson | null;
  readonly consistencyLevel: string | null;
  /** The properties asked for, or null for every plain property. */
  readonly returnProperties: readonly string[] | null;
  readonly returnMetadata: readonly string[];
  /** BM25 and hybrid. */
  readonly query: string | null;
  readonly queryProperties: readonly string[] | null;
  /** Hybrid. */
  readonly fusionType: string | null;
  readonly maxVectorDistance: TaggedJson | null;
  /** near-vector: the vector's numbers as written. */
  readonly vector: readonly TaggedJson[] | null;
  /** near-object. */
  readonly id: string | null;
  readonly targetVector: string | null;
  readonly distance: TaggedJson | null;
  readonly certainty: TaggedJson | null;
  /** Aggregate. */
  readonly groupBy: string | null;
}

/** A request phase 0 accepted. */
export interface WeaviatePlan {
  readonly request: ConsoleRequest<WeaviateConsoleOp>;
  readonly route: WeaviateRoute;
  /** The collection the request reads, its first letter as the server spells it; null where it names none. */
  readonly collection: string | null;
  /** The tenant the request names, in the query string or the body; null where it names none. */
  readonly tenant: string | null;
  /** The query keys, with the defaults written in. */
  readonly query: Readonly<Record<string, string>>;
  /** The body with the defaults written in, or null where the route takes none. */
  readonly body: TaggedObject | null;
  /** The search model of a search or aggregate route; null for every other route. */
  readonly search: WeaviateSearchModel | null;
  readonly warnings: readonly QueryWarning[];
}

function refuse(message: string, key: string | null = null): never {
  throw new RequestRefusal(message, 0, key);
}

function refuseLater(message: string, key: string | null = null): never {
  throw new RequestRefusal(message, 1, key);
}

function shown(text: string): string {
  return JSON.stringify(text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text);
}

function kindOf(value: TaggedJson | undefined): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isTaggedInt(value) || isTaggedFloat(value)) return "a number";
  if (typeof value === "object") return "an object";
  return typeof value === "boolean" ? "a boolean" : `a ${typeof value}`;
}

const isObject = (value: TaggedJson | undefined): value is TaggedObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isTaggedInt(value) && !isTaggedFloat(value);

const has = (object: TaggedObject, key: string): boolean => Object.hasOwn(object, key) && object[key] !== null;

function objectAt(value: TaggedJson | undefined, where: string): TaggedObject {
  if (!isObject(value)) return refuse(`${where} must be an object, found ${kindOf(value)}.`, where);
  return value;
}

function listAt(value: TaggedJson | undefined, where: string): readonly TaggedJson[] {
  if (!Array.isArray(value)) return refuse(`${where} must be a list, found ${kindOf(value)}.`, where);
  return value;
}

function stringAt(value: TaggedJson | undefined, where: string): string {
  if (typeof value !== "string") return refuse(`${where} must be a string, found ${kindOf(value)}.`, where);
  return value;
}

function booleanAt(value: TaggedJson | undefined, where: string): boolean {
  if (typeof value !== "boolean") return refuse(`${where} must be true or false, found ${kindOf(value)}.`, where);
  return value;
}

/** The object's keys against the closed set of its schema: a refused key with its reason, an unknown key and a missing required key, each by name. */
function closed(object: TaggedObject, name: WeaviateObjectName, where: string): void {
  const set = WEAVIATE_KEYS[name];
  const keys: readonly string[] = set.keys;
  for (const key of Object.keys(object)) {
    if (keys.includes(key)) continue;
    if (Object.hasOwn(WEAVIATE_REFUSED_KEYS, key)) {
      refuse(`${where} takes no key ${shown(key)} in this console: ${WEAVIATE_REFUSED_KEYS[key]}.`, key);
    }
    refuse(`${where} takes no key ${shown(key)}: Weaviate reads ${keys.join(", ")} there and nothing else.`, key);
  }
  for (const key of set.required) {
    if (!has(object, key)) refuse(`${where} needs the key ${key}.`, key);
  }
}

function integerAt(value: TaggedJson | undefined, where: string, min: number, max: number): number {
  if (value === undefined || !isTaggedInt(value)) {
    return refuse(`${where} must be an integer, found ${kindOf(value)}.`, where);
  }
  if (!checkIntRange(value, "safe") || Number(value.digits) < min || Number(value.digits) > max) {
    return refuse(`${where} is ${value.digits}; it takes an integer from ${min} to ${max}.`, where);
  }
  return Number(value.digits);
}

function numberAt(value: TaggedJson | undefined, where: string): number {
  if (value !== undefined && isTaggedFloat(value)) return Number(value.text);
  if (value !== undefined && isTaggedInt(value)) return Number(value.digits);
  return refuse(`${where} must be a number, found ${kindOf(value)}.`, where);
}

function wordAt(value: TaggedJson | undefined, where: string, words: readonly string[]): string {
  if (typeof value !== "string" || !words.includes(value)) {
    return refuse(
      `${where} takes one of ${words.join(", ")}, not ${typeof value === "string" ? shown(value) : kindOf(value)}.`,
      where,
    );
  }
  return value;
}

/** Why a collection or alias name cannot reach a path or a GraphQL document, or undefined (spec W1). */
export function weaviateClassNameRefusal(name: string): string | undefined {
  if (CLASS_NAME.test(name)) return undefined;
  if (name === "") return "A collection name cannot be empty.";
  return `${shown(name)} is not a Weaviate collection name: it starts with a letter and holds only letters, digits and _, at most 255 characters.`;
}

export function weaviateTenantNameRefusal(name: string): string | undefined {
  if (TENANT_NAME.test(name)) return undefined;
  return `${shown(name)} is not a Weaviate tenant name: it holds only letters, digits, - and _, 1 to 64 characters.`;
}

/** The name as the server spells it: the first letter capitalised, as Weaviate does with every class name. */
export function serverClassName(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function classNameAt(value: string, where: string): string {
  const refusal = weaviateClassNameRefusal(value);
  return refusal === undefined ? serverClassName(value) : refuse(`${where}: ${refusal}`, where);
}

function tenantAt(value: TaggedJson | string | undefined, where: string): string {
  const name = typeof value === "string" ? value : stringAt(value, where);
  const refusal = weaviateTenantNameRefusal(name);
  return refusal === undefined ? name : refuse(`${where}: ${refusal}`, where);
}

function propertyNameAt(value: TaggedJson | string | undefined, where: string): string {
  const name = typeof value === "string" ? value : stringAt(value, where);
  if (!PROPERTY_NAME.test(name)) {
    refuse(`${where} is ${shown(name)}, which is not a Weaviate property name.`, where);
  }
  return name;
}

function uuidAt(value: TaggedJson | string | undefined, where: string): string {
  const id = typeof value === "string" ? value : stringAt(value, where);
  if (!UUID.test(id)) refuse(`${where} is ${shown(id)}, which is not a UUID: Weaviate's object ids are UUIDs.`, where);
  return id;
}

function propertyListAt(value: TaggedJson | undefined, where: string, boosted: boolean): readonly string[] {
  const list = listAt(value, where);
  if (list.length === 0 || list.length > WEAVIATE_BOUNDS.maxPropertyList) {
    refuse(`${where} holds ${list.length} properties; it takes 1 to ${WEAVIATE_BOUNDS.maxPropertyList}.`, where);
  }
  const seen = new Set<string>();
  return list.map((entry, index) => {
    const name = stringAt(entry, `${where}[${index}]`);
    const match = boosted ? BOOSTED_PROPERTY.exec(name) : PROPERTY_NAME.test(name) ? [name, name] : null;
    if (match === null) refuse(`${where}[${index}] is ${shown(name)}, which is not a Weaviate property name.`, where);
    if (seen.has(name)) refuse(`${where} names ${shown(name)} twice.`, where);
    seen.add(name);
    return name;
  });
}

/** What phase 0 counts while it walks a where filter. */
interface FilterWalk {
  conditions: number;
}

const LOGICAL = new Set(["And", "Or", "Not"]);
const VALUE_KEYS: Readonly<Record<string, "int" | "number" | "boolean" | "text" | "date" | "geo">> = {
  valueInt: "int",
  valueNumber: "number",
  valueBoolean: "boolean",
  valueString: "text",
  valueText: "text",
  valueDate: "date",
  valueIntArray: "int",
  valueNumberArray: "number",
  valueBooleanArray: "boolean",
  valueStringArray: "text",
  valueTextArray: "text",
  valueDateArray: "date",
  valueGeoRange: "geo",
};

function checkScalar(value: TaggedJson, kind: string, where: string): void {
  if (kind === "int") integerAt(value, where, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  else if (kind === "number") numberAt(value, where);
  else if (kind === "boolean") booleanAt(value, where);
  else stringAt(value, where);
}

function readGeoRange(value: TaggedJson, where: string): void {
  const range = objectAt(value, where);
  closed(range, "WhereFilterGeoRange", where);
  const coordinates = objectAt(range.geoCoordinates, `${where}.geoCoordinates`);
  closed(coordinates, "GeoCoordinates", `${where}.geoCoordinates`);
  const latitude = numberAt(coordinates.latitude, `${where}.geoCoordinates.latitude`);
  const longitude = numberAt(coordinates.longitude, `${where}.geoCoordinates.longitude`);
  if (latitude < -90 || latitude > 90) refuse(`${where}.geoCoordinates.latitude is outside -90 to 90.`, where);
  if (longitude < -180 || longitude > 180) refuse(`${where}.geoCoordinates.longitude is outside -180 to 180.`, where);
  const distance = objectAt(range.distance, `${where}.distance`);
  closed(distance, "GeoDistance", `${where}.distance`);
  if (numberAt(distance.max, `${where}.distance.max`) < 0) refuse(`${where}.distance.max cannot be negative.`, where);
}

/** A where filter (spec W4): every level closed, every operator's operands or path and one value, bounded. */
function readWhere(value: TaggedJson, where: string, walk: FilterWalk, depth: number): void {
  if (depth > WEAVIATE_BOUNDS.maxFilterDepth) {
    refuse(`${where} nests filters deeper than ${WEAVIATE_BOUNDS.maxFilterDepth} levels.`, "where");
  }
  walk.conditions += 1;
  if (walk.conditions > WEAVIATE_BOUNDS.maxFilterConditions) {
    refuse(`The filter holds more than ${WEAVIATE_BOUNDS.maxFilterConditions} conditions.`, "where");
  }
  const filter = objectAt(value, where);
  closed(filter, "WhereFilter", where);
  const operator = wordAt(filter.operator, `${where}.operator`, WEAVIATE_ENUMS.operator);
  const values = Object.keys(filter).filter((key) => Object.hasOwn(VALUE_KEYS, key) && has(filter, key));
  if (LOGICAL.has(operator)) {
    if (has(filter, "path") || values.length > 0) {
      refuse(`${where}: ${operator} takes operands only, never a path or a value.`, where);
    }
    const operands = listAt(filter.operands, `${where}.operands`);
    if (operands.length === 0) refuse(`${where}.operands: ${operator} needs at least one operand.`, where);
    if (operator === "Not" && operands.length !== 1) refuse(`${where}.operands: Not takes exactly one operand.`, where);
    operands.forEach((operand, index) => {
      readWhere(operand, `${where}.operands[${index}]`, walk, depth + 1);
    });
    return;
  }
  if (has(filter, "operands")) refuse(`${where}: ${operator} takes a path and a value, never operands.`, where);
  const path = listAt(filter.path, `${where}.path`);
  if (path.length === 0) refuse(`${where}.path names no property.`, where);
  path.forEach((segment, index) => {
    const name = stringAt(segment, `${where}.path[${index}]`);
    // A path through a cross-reference names the property, the target class, then the target's property.
    if (!PROPERTY_NAME.test(name) && !CLASS_NAME.test(name)) {
      refuse(`${where}.path[${index}] is ${shown(name)}, which is not a property or class name.`, where);
    }
  });
  if (values.length !== 1) {
    refuse(
      `${where}: ${operator} takes exactly one value key (valueText, valueInt and the rest), found ${values.length}.`,
      where,
    );
  }
  const key = values[0];
  const kind = VALUE_KEYS[key];
  if (operator === "WithinGeoRange" ? key !== "valueGeoRange" : key === "valueGeoRange") {
    refuse(`${where}: WithinGeoRange takes valueGeoRange, and valueGeoRange takes WithinGeoRange.`, where);
  }
  if (operator === "IsNull" && key !== "valueBoolean") refuse(`${where}: IsNull takes valueBoolean.`, where);
  if (kind === "geo") readGeoRange(filter[key], `${where}.${key}`);
  else if (key.endsWith("Array")) {
    const entries = listAt(filter[key], `${where}.${key}`);
    if (entries.length > WEAVIATE_BOUNDS.maxFilterListEntries) {
      refuse(`${where}.${key} holds ${entries.length} entries, above ${WEAVIATE_BOUNDS.maxFilterListEntries}.`, where);
    }
    entries.forEach((entry, index) => {
      checkScalar(entry, kind, `${where}.${key}[${index}]`);
    });
  } else checkScalar(filter[key], kind, `${where}.${key}`);
}

function readFilter(value: TaggedJson): TaggedObject {
  const bytes = utf8ByteLength(toJsonText(value));
  if (bytes > WEAVIATE_BOUNDS.maxFilterBytes) {
    refuse(`The filter is ${bytes} bytes, above the bound of ${WEAVIATE_BOUNDS.maxFilterBytes}.`, "where");
  }
  readWhere(value, "where", { conditions: 0 }, 1);
  return value as TaggedObject;
}

const integer = (value: number): TaggedJson => taggedNumber(String(value));

function withDefaults(body: TaggedObject, defaults: Readonly<Record<string, TaggedJson>>): TaggedObject {
  const copy: Record<string, TaggedJson> = Object.create(null);
  for (const key of Object.keys(body)) if (body[key] !== null) copy[key] = body[key];
  for (const [key, value] of Object.entries(defaults)) if (!Object.hasOwn(copy, key)) copy[key] = value;
  return Object.freeze(copy);
}

/** The rows a request asks for: its limit plus its offset, at most the console's bound (below QUERY_MAXIMUM_RESULTS). */
function rowsAt(limit: TaggedJson | undefined, offset: TaggedJson | undefined, defaultLimit: number): void {
  const rows = limit === undefined ? defaultLimit : integerAt(limit, "limit", 1, WEAVIATE_BOUNDS.maxRows);
  const skip = offset === undefined ? 0 : integerAt(offset, "offset", 0, WEAVIATE_BOUNDS.maxRows);
  if (rows + skip > WEAVIATE_BOUNDS.maxRows) {
    refuse(`limit plus offset is ${rows + skip}, above the bound of ${WEAVIATE_BOUNDS.maxRows} rows.`, "limit");
  }
}

/** Phase 0 of the four searches: the closed body, the inference rule, every value, the defaults (spec 5.1). */
function readSearchBody(route: WeaviateRoute, body: TaggedObject, collection: string): WeaviateSearchModel {
  const schema = route.schema as WeaviateObjectName;
  closed(body, schema, "The body");
  const value = (key: string): TaggedJson | undefined => (has(body, key) ? body[key] : undefined);
  rowsAt(value("limit"), value("offset"), WEAVIATE_BOUNDS.defaultSearchLimit);
  if (value("autoLimit") !== undefined) integerAt(body.autoLimit, "autoLimit", 1, WEAVIATE_BOUNDS.maxRows);
  const returnProperties =
    value("returnProperties") === undefined ? null : propertyListAt(body.returnProperties, "returnProperties", false);
  const returnMetadata =
    value("returnMetadata") === undefined
      ? []
      : listAt(body.returnMetadata, "returnMetadata").map((entry, index) =>
          wordAt(entry, `returnMetadata[${index}]`, WEAVIATE_ENUMS.returnMetadata),
        );
  const consistencyLevel =
    value("consistencyLevel") === undefined
      ? null
      : wordAt(body.consistencyLevel, "consistencyLevel", WEAVIATE_ENUMS.consistencyLevel);
  const tenant = value("tenant") === undefined ? null : tenantAt(body.tenant, "tenant");
  const where = value("where") === undefined ? null : readFilter(body.where);
  const op = route.op as Exclude<WeaviateEncodedOp, "aggregate">;
  const kind = SEARCH_KIND[op];
  let query: string | null = null;
  let queryProperties: readonly string[] | null = null;
  if (kind === "bm25" || kind === "hybrid") {
    query = stringAt(body.query, "query");
    if (query.trim() === "") refuse("query is empty: a keyword search needs words.", "query");
    if (value("queryProperties") !== undefined)
      queryProperties = propertyListAt(body.queryProperties, "queryProperties", true);
  }
  if (kind === "hybrid") {
    // The server's default alpha is 0.7, which embeds the query text with the collection's vectorizer (spec W3).
    if (numberAt(body.alpha, "alpha") !== 0) {
      refuse(
        'alpha must be 0 in this console: any other value makes Weaviate embed the query text with the collection\'s vectorizer, which sends it to a model provider. Write "alpha": 0 for a keyword-only hybrid search.',
        "alpha",
      );
    }
  }
  const fusionType =
    value("fusionType") === undefined ? null : wordAt(body.fusionType, "fusionType", WEAVIATE_ENUMS.fusionType);
  const maxVectorDistance = value("maxVectorDistance") ?? null;
  if (maxVectorDistance !== null) numberAt(maxVectorDistance, "maxVectorDistance");
  const targetVector = value("targetVector") === undefined ? null : stringAt(body.targetVector, "targetVector");
  if (targetVector !== null && !VECTOR_NAME.test(targetVector)) {
    refuse(`targetVector is ${shown(targetVector)}, which is not a Weaviate vector name.`, "targetVector");
  }
  const distance = value("distance") ?? null;
  const certainty = value("certainty") ?? null;
  if (distance !== null) numberAt(distance, "distance");
  if (certainty !== null) {
    const level = numberAt(certainty, "certainty");
    if (level < 0 || level > 1) refuse("certainty takes a number from 0 to 1.", "certainty");
  }
  if (distance !== null && certainty !== null) refuse("A search takes distance or certainty, not both.", "distance");
  let vector: readonly TaggedJson[] | null = null;
  if (kind === "near-vector") {
    vector = listAt(body.vector, "vector");
    if (vector.some((element) => Array.isArray(element))) {
      refuse("vector is a list of lists: this console searches with one dense vector, a list of numbers.", "vector");
    }
    if (vector.length === 0 || vector.length > WEAVIATE_BOUNDS.maxDenseSize) {
      refuse(`vector holds ${vector.length} numbers; it takes 1 to ${WEAVIATE_BOUNDS.maxDenseSize}.`, "vector");
    }
    vector.forEach((element, index) => {
      numberAt(element, `vector[${index}]`);
    });
  }
  const id = kind === "near-object" ? uuidAt(body.id, "id") : null;
  return {
    op,
    collection,
    tenant,
    where,
    limit: value("limit") ?? integer(WEAVIATE_BOUNDS.defaultSearchLimit),
    offset: value("offset") ?? null,
    autoLimit: value("autoLimit") ?? null,
    consistencyLevel,
    returnProperties,
    returnMetadata,
    query,
    queryProperties,
    fusionType,
    maxVectorDistance,
    vector,
    id,
    targetVector,
    distance,
    certainty,
    groupBy: null,
  };
}

function readAggregateBody(body: TaggedObject, collection: string): WeaviateSearchModel {
  closed(body, "AggregateRequest", "The body");
  const value = (key: string): TaggedJson | undefined => (has(body, key) ? body[key] : undefined);
  if (value("returnMetrics") !== undefined) {
    listAt(body.returnMetrics, "returnMetrics").forEach((entry, index) => {
      wordAt(entry, `returnMetrics[${index}]`, WEAVIATE_ENUMS.returnMetrics);
    });
  }
  const groupBy = value("groupBy") === undefined ? null : propertyNameAt(body.groupBy, "groupBy");
  if (value("limit") !== undefined) {
    if (groupBy === null)
      refuse("limit bounds the groups of a groupBy; an aggregate without groupBy has one row.", "limit");
    integerAt(body.limit, "limit", 1, WEAVIATE_BOUNDS.maxRows);
  }
  return {
    op: "aggregate",
    collection,
    tenant: value("tenant") === undefined ? null : tenantAt(body.tenant, "tenant"),
    where: value("where") === undefined ? null : readFilter(body.where),
    // Both paths answer at most 100 groups when no limit is given (measured on 1.37.4 and 1.40.2), so the bound is
    // written out and results.ts can say when the groups reached it.
    limit: value("limit") ?? (groupBy === null ? null : integer(WEAVIATE_BOUNDS.defaultGroupsLimit)),
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
    groupBy,
  };
}

/** The grammar's verdict on one console text, with the console's own sentence for a route it does not run. */
export function parseWeaviateRequest(text: string): ConsoleRequest<WeaviateConsoleOp> {
  try {
    return parseConsole(WEAVIATE_CONSOLE, WEAVIATE_ROUTES, text);
  } catch (error) {
    if (!(error instanceof ConsoleRefusal) || (error.reason !== "unknown-route" && error.reason !== "unknown-method")) {
      throw error;
    }
    const { method, target } = consoleTokens(WEAVIATE_CONSOLE, text).request;
    if (target === "") throw error;
    throw new ConsoleRefusal(error.reason, refusedRouteSentence(method, target), error.line, error.column);
  }
}

/** Phase 0 of `GET /v1/objects`: the class, the paging pair and the defaults (spec 5.1). */
function readObjectsQuery(query: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!Object.hasOwn(query, "class")) {
    refuse("GET /v1/objects needs ?class=<collection>: without it Weaviate answers no objects.", "class");
  }
  if (Object.hasOwn(query, "after") && (Object.hasOwn(query, "offset") || Object.hasOwn(query, "sort"))) {
    refuse("after pages by id, so it takes neither offset nor sort.", "after");
  }
  if (Object.hasOwn(query, "order") && !Object.hasOwn(query, "sort")) refuse("order needs sort.", "order");
  if (Object.hasOwn(query, "sort")) {
    query.sort.split(",").forEach((name, index) => {
      propertyNameAt(name, `sort[${index}]`);
    });
  }
  if (Object.hasOwn(query, "after")) uuidAt(query.after, "after");
  if (Object.hasOwn(query, "tenant")) tenantAt(query.tenant, "tenant");
  const limit = Object.hasOwn(query, "limit") ? Number(query.limit) : WEAVIATE_BOUNDS.defaultObjectsLimit;
  if (Object.hasOwn(query, "offset") && !/^(0|[1-9][0-9]*)$/.test(query.offset)) {
    refuse(`offset is ${shown(query.offset)}; it takes an integer from 0 to ${WEAVIATE_BOUNDS.maxRows}.`, "offset");
  }
  const offset = Object.hasOwn(query, "offset") ? Number(query.offset) : 0;
  if (limit > WEAVIATE_BOUNDS.maxRows || limit + offset > WEAVIATE_BOUNDS.maxRows) {
    refuse(`limit plus offset is ${limit + offset}, above the bound of ${WEAVIATE_BOUNDS.maxRows} rows.`, "limit");
  }
  return Object.freeze({ ...query, limit: String(limit) });
}

/**
 * Every rule that needs neither the schema nor the server. Throws a phase 0 `RequestRefusal` naming the first rule
 * the request breaks; makes no call.
 */
export function weaviatePhase0(request: ConsoleRequest<WeaviateConsoleOp>): WeaviatePlan {
  const route = WEAVIATE_ROUTES.find((entry) => entry.op === request.route.op) as WeaviateRoute;
  const params = request.params;
  let collection: string | null = Object.hasOwn(params, "collection")
    ? classNameAt(params.collection, "collection")
    : null;
  if (Object.hasOwn(params, "alias")) classNameAt(params.alias, "alias");
  let tenant: string | null = Object.hasOwn(params, "tenant") ? tenantAt(params.tenant, "tenant") : null;
  if (Object.hasOwn(params, "id")) uuidAt(params.id, "id");
  let query = request.query;
  if (route.op === "objects") {
    query = readObjectsQuery(query);
    collection = classNameAt(query.class, "class");
  }
  if (Object.hasOwn(query, "output") && query.output.includes(","))
    refuse("output takes one of minimal or verbose.", "output");
  if (tenant === null && Object.hasOwn(query, "tenant")) tenant = tenantAt(query.tenant, "tenant");
  let body: TaggedObject | null = null;
  let search: WeaviateSearchModel | null = null;
  if (route.schema === "AggregateRequest") {
    search = readAggregateBody(request.body, collection as string);
    body = search.limit === null ? request.body : withDefaults(request.body, { limit: search.limit });
  } else if (route.schema !== null) {
    search = readSearchBody(route, request.body, collection as string);
    body = withDefaults(request.body, { limit: search.limit as TaggedJson });
  }
  if (search !== null && search.tenant !== null) tenant = search.tenant;
  return { request, route, collection, tenant, query, body, search, warnings: [] };
}

function present(facts: WeaviateCollectionFacts): string {
  const names = facts.vectors.map((vector) => (vector.name === "" ? "the unnamed vector" : vector.name));
  return names.length === 0 ? "it has no vector" : `it has ${names.join(", ")}`;
}

/** The vector a search targets: the one it names, or the collection's only vector. */
function targetOf(plan: WeaviatePlan, facts: WeaviateCollectionFacts): string | null {
  const search = plan.search as WeaviateSearchModel;
  // A BM25 search reads no vector, and its body takes no targetVector (phase 0 refuses one), so none is sent.
  if (search.op === "search_bm25") return null;
  if (search.targetVector !== null) {
    if (!facts.vectors.some((vector) => vector.name === search.targetVector)) {
      refuseLater(
        `targetVector names ${shown(search.targetVector)}, which is no vector of ${shown(facts.name)}: ${present(facts)}.`,
        "targetVector",
      );
    }
    return search.targetVector;
  }
  if (facts.vectors.length === 0) {
    refuseLater(`The collection ${shown(facts.name)} has no vector to search.`, "targetVector");
  }
  if (facts.vectors.length > 1) {
    refuseLater(
      `The collection ${shown(facts.name)} has more than one vector, so the search needs targetVector: ${present(facts)}.`,
      "targetVector",
    );
  }
  return facts.vectors[0].name;
}

/**
 * Phase 1: the rules that read the collection's definition, described for this request. Throws a phase 1
 * `RequestRefusal`; makes no call. Answers the plan with the target vector's name filled in for the encoders.
 */
/** The routes that read a whole multi-tenant collection's own record, and so name no tenant. */
const COLLECTION_RECORD_OPS: ReadonlySet<WeaviateConsoleOp> = new Set(["collection", "tenants", "collection_nodes"]);

export function weaviatePhase1(plan: WeaviatePlan, facts: WeaviateCollectionFacts): WeaviatePlan {
  if (facts.multiTenant && plan.tenant === null && !COLLECTION_RECORD_OPS.has(plan.route.op)) {
    refuseLater(
      `The collection ${shown(facts.name)} is multi-tenant, so the request needs a tenant${plan.route.body === "none" ? " (?tenant=...)" : ' ("tenant": "...")'}. Nothing was read: GET /v1/schema/${facts.name}/tenants lists its tenants and which are HOT, without waking any.`,
      "tenant",
    );
  }
  if (!facts.multiTenant && plan.tenant !== null && plan.route.op !== "tenant") {
    refuseLater(`The collection ${shown(facts.name)} is not multi-tenant, so the request takes no tenant.`, "tenant");
  }
  const search = plan.search;
  if (search === null) return plan;
  const known = new Set([...facts.plainProperties, ...facts.referenceProperties]);
  const check = (names: readonly string[] | null, where: string, strip: boolean) => {
    for (const written of names ?? []) {
      const name = strip ? written.replace(/\^.*$/, "") : written;
      if (!known.has(name))
        refuseLater(`${where} names ${shown(name)}, which is no property of ${shown(facts.name)}.`, where);
      if (facts.referenceProperties.has(name)) {
        refuseLater(
          `${where} names ${shown(name)}, a cross-reference: returning cross-references is outside this version of the console.`,
          where,
        );
      }
    }
  };
  check(search.returnProperties, "returnProperties", false);
  check(search.queryProperties, "queryProperties", true);
  if (search.groupBy !== null) check([search.groupBy], "groupBy", false);
  if (search.op === "aggregate") return plan;
  const target = targetOf(plan, facts);
  // Hybrid at alpha 0 opens on a vectorized collection too (spec W3, WM1). MEASURED on 2026-10-23 with the egress
  // fixture, a collection whose `text2vec-openai` base URL is a listener on the bridge gateway: hybrid at alpha 0 sent
  // the listener nothing over REST on 1.40.2 and over GraphQL on 1.37.4 and 1.40.2, while alpha 0.5 and a nearText
  // control each sent it one request. A later release that embeds at alpha 0 brings this refusal back here.
  if (search.vector !== null) {
    const numbers = vectorNumbers(
      { name: target ?? "", kind: "dense", dtype: "float32", dimension: null },
      search.vector,
    );
    if (!Array.isArray(numbers)) refuseLater(`vector: ${(numbers as { sentence: string }).sentence}`, "vector");
    const refused = checkDenseElements(
      { name: target ?? "", kind: "dense", dtype: "float32", dimension: null },
      numbers as readonly number[],
    );
    if (refused !== null) refuseLater(`vector: ${refused.sentence}`, "vector");
  }
  return { ...plan, search: { ...search, targetVector: target === "" ? null : target } };
}
