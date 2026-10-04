import { utf8ByteLength } from "@/lib/db/console/bounds";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { ConsoleRefusal, type ConsoleRequest, consoleTokens, parseConsole } from "@/lib/db/console/parser";
import {
  checkIntRange,
  isTaggedFloat,
  isTaggedInt,
  type TaggedJson,
  type TaggedObject,
  taggedNumber,
  toJsonText,
} from "@/lib/db/console/tagged-json";
import {
  checkDenseElements,
  checkMultiVector,
  type VectorRefusal,
  type VectorTarget,
  vectorNumbers,
} from "@/lib/db/vector/dense";
import { sparseFromIndicesValues } from "@/lib/db/vector/sparse";
import type { VectorFieldInfo } from "@/lib/db/vector/types";
import type { QueryWarning } from "@/lib/types";
import type { QdrantOp } from "./client";
import {
  QDRANT_BOUNDS,
  QDRANT_CONSOLE,
  QDRANT_ENUMS,
  QDRANT_GATES,
  QDRANT_KEYS,
  QDRANT_LOCAL_MODELS,
  QDRANT_QUERY_ALIAS,
  QDRANT_ROUTES,
  QDRANT_VECTOR_NAME_FORBIDDEN,
  type QdrantGateId,
  type QdrantObjectName,
  type QdrantRoute,
  refusedRouteSentence,
} from "./routes";

/**
 * The Qdrant console's request rules: one console text to one typed request, in the phases every vector console
 * validates in.
 *
 * Phase 0 reads the text alone and makes no call: the grammar (`parseQdrantRequest`), then every rule that needs
 * no schema (`qdrantPhase0`): names, closed keys at every level, ids, the inference rule, enumerations, caps and
 * budget arithmetic, and the engine's documented defaults written in. The version gates are phase 0 too, but only
 * the server holds the version, so they are a call of their own (`qdrantVersionGates`), which the browser's
 * verdict leaves out. Phase 1 (`qdrantPhase1`) checks every query vector against the collection described for
 * this request and writes the body's text from the parser's tokens.
 *
 * Nothing here sends anything. The first two functions are what the browser runs before a statement leaves it.
 */

/** What a described collection tells a request and its result: written by the provider's schema module. */
export interface QdrantCollectionFacts {
  /** Every vector of the collection, the unnamed one under the name "". */
  readonly vectors: readonly VectorFieldInfo[];
  /** Each vector's column type text, `Dense(384, float32, Cosine; stored normalised)` and the rest, by vector name. */
  readonly typeTexts: ReadonlyMap<string, string>;
  /** The names of the vectors the server answers as a reconstruction of what was stored (datatype turbo4). */
  readonly reconstructed: ReadonlySet<string>;
  /** Each indexed payload key and its index type. */
  readonly payloadIndexTypes: ReadonlyMap<string, string>;
}

/** The form of a search's final stage, which decides what its score means. */
export type QdrantQueryForm =
  | "none"
  | "vector"
  | "id"
  | "nearest"
  | "recommend"
  | "discover"
  | "context"
  | "order_by"
  | "fusion.rrf"
  | "fusion.dbsf"
  | "rrf"
  | "formula"
  | "sample"
  | "relevance_feedback";

/** One search of a request: a query, each entry of a batch, or a grouped query. */
export interface QdrantSearch {
  readonly form: QdrantQueryForm;
  /** The vector its final stage searches, "" for the unnamed one. */
  readonly using: string;
}

/** A query vector typed in the body, kept by identity so phase 1 can check it and write it back. */
interface VectorLiteral {
  readonly where: string;
  readonly using: string;
  readonly node: TaggedJson;
  readonly kind: "dense" | "multi" | "sparse" | "text";
}

/** A place that names a vector a collection must have. */
interface UsingUse {
  readonly where: string;
  readonly using: string;
  /** False where the name was left out and the stage searches no vector, so nothing needs to exist. */
  readonly needed: boolean;
  /** The collection that must have it: the request's own, or the one a `lookup_from` names. */
  readonly collection: string | null;
}

/** A request phase 0 accepted. */
export interface QdrantPhase0 {
  readonly request: ConsoleRequest<QdrantOp>;
  readonly route: QdrantRoute;
  /** The body with the engine's defaults written in, or null where the route takes none. */
  readonly body: TaggedObject | null;
  /**
   * The collections phase 1 describes, each once, in order: the request's own for every route that answers
   * points, then each collection a `lookup_from` names. Empty for every other route.
   */
  readonly collections: readonly string[];
  readonly searches: readonly QdrantSearch[];
  readonly gates: readonly QdrantGateId[];
  readonly warnings: readonly QueryWarning[];
  readonly literals: readonly VectorLiteral[];
  readonly usings: readonly UsingUse[];
}

/** What a result needs to know about the request that asked for it. */
export interface QdrantResultShape {
  readonly op: QdrantOp;
  readonly facts: QdrantCollectionFacts | null;
  readonly searches: readonly QdrantSearch[];
  /** Whether a count, or a facet's counts, were asked for exactly. */
  readonly exact: boolean;
  readonly warnings: readonly QueryWarning[];
}

/** A request ready for the wire. `query` holds the user's keys; the runner sets `timeout`. */
export interface QdrantWire {
  readonly op: QdrantOp;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly shape: QdrantResultShape;
}

/** A UUID as the server reads one: 32 hex digits, or the hyphenated form; a form with only some hyphens is refused. */
const UUID = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const DIGITS = /^[0-9]+$/;
const SHOWN = 80;

const INFERENCE_RULE =
  'Studio sends no inference input except a text for the local BM25 model: {"text": "...", "model": "qdrant/bm25"} ' +
  'or "bm25", in lower case, with no options, aimed at a sparse vector.';
const INFERENCE_KEYS: readonly string[] = ["model", "text", "image", "object"];
const FILTER_CLAUSES: readonly string[] = ["must", "should", "must_not"];
const CONDITION_FORMS =
  "a condition holds key (with match, range, geo_bounding_box, geo_radius, geo_polygon, values_count, is_empty or " +
  "is_null), or is_empty, is_null, has_id, has_vector, slice or nested, or is itself a filter of must, should, " +
  "must_not and min_should";
const QUERY_FORMS: readonly string[] = [
  "nearest",
  "recommend",
  "discover",
  "context",
  "order_by",
  "fusion",
  "rrf",
  "formula",
  "sample",
  "relevance_feedback",
];
const EXPRESSION_FORMS: Readonly<Record<string, QdrantObjectName>> = {
  geo_distance: "GeoDistance",
  datetime: "DatetimeExpression",
  datetime_key: "DatetimeKeyExpression",
  mult: "MultExpression",
  sum: "SumExpression",
  max: "MaxExpression",
  min: "MinExpression",
  neg: "NegExpression",
  abs: "AbsExpression",
  div: "DivExpression",
  sqrt: "SqrtExpression",
  pow: "PowExpression",
  exp: "ExpExpression",
  log10: "Log10Expression",
  ln: "LnExpression",
  acosh: "AcoshExpression",
  lin_decay: "LinDecayExpression",
  exp_decay: "ExpDecayExpression",
  gauss_decay: "GaussDecayExpression",
};
const MATCH_FORMS: Readonly<Record<string, QdrantObjectName>> = {
  value: "MatchValue",
  text: "MatchText",
  text_any: "MatchTextAny",
  phrase: "MatchPhrase",
  prefix: "MatchPrefix",
  any: "MatchAny",
  except: "MatchExcept",
};
/** The forms whose final stage searches a vector, so the vector they name must exist. */
const VECTOR_FORMS: ReadonlySet<QdrantQueryForm> = new Set([
  "vector",
  "id",
  "nearest",
  "recommend",
  "discover",
  "context",
  "relevance_feedback",
]);

/** The routes that answer points, whose columns and scores are read from the described collection. */
const POINT_ROUTES: ReadonlySet<QdrantOp> = new Set([
  "get_points",
  "get_point",
  "scroll_points",
  "query_points",
  "query_batch_points",
  "query_points_groups",
]);

function refuse(message: string, key: string | null = null): never {
  throw new RequestRefusal(message, 0, key);
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

/** Whether the object holds the key with a value: a key written as null is a key left out. */
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

/** The object's keys against the closed set of its schema: an unknown key and a missing required key by name. */
function closed(object: TaggedObject, name: QdrantObjectName, where: string): void {
  const set = QDRANT_KEYS[name];
  const keys: readonly string[] = set.keys;
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) {
      refuse(`${where} takes no key ${shown(key)}: Qdrant reads ${keys.join(", ")} there and nothing else.`, key);
    }
  }
  for (const key of set.required) {
    if (!has(object, key)) refuse(`${where} needs the key ${key}.`, key);
  }
}

/** A whole number written as an integer literal, from `min` to `max`. */
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

/** A point id as a body takes it: an integer literal in the unsigned 64-bit range, or a UUID string. */
function pointIdAt(value: TaggedJson | undefined, where: string): void {
  if (value !== undefined && isTaggedInt(value)) {
    if (!checkIntRange(value, "uint64")) {
      refuse(`${where} is ${value.digits}, outside the range of a point id, 0 to 18446744073709551615.`, where);
    }
    return;
  }
  if (typeof value === "string") {
    if (UUID.test(value)) return;
    if (DIGITS.test(value)) {
      refuse(
        `${where} is the string ${shown(value)}: write the id as a bare number, because Qdrant refuses a digit string.`,
        where,
      );
    }
    refuse(`${where} is ${shown(value)}, which is neither an unsigned integer nor a UUID.`, where);
  }
  refuse(`${where} must be a point id, an unsigned integer or a UUID string, found ${kindOf(value)}.`, where);
}

/**
 * Why a collection or alias name cannot reach a path, or undefined: the server's own read-path rule. Every other
 * character is the client's to percent-encode, so a name reaches the server as typed.
 */
export function qdrantCollectionNameRefusal(name: string): string | undefined {
  if (name === "") return "A collection name cannot be empty.";
  if (name === "." || name === "..") return `${shown(name)} is not a collection name: Qdrant serves no dot name.`;
  if (name.includes("/") || name.includes("\u0000")) {
    return `The collection name ${shown(name)} holds a character Qdrant refuses in a name: / or NUL.`;
  }
  const length = Array.from(name).length;
  if (length > QDRANT_BOUNDS.maxCollectionNameLength) {
    return `The collection name is ${length} characters long; Qdrant takes at most ${QDRANT_BOUNDS.maxCollectionNameLength}.`;
  }
  return undefined;
}

/** Why a vector name is not one Qdrant takes, or undefined. The unnamed vector's name, "", is refused here. */
export function qdrantVectorNameRefusal(name: string): string | undefined {
  if (name === "") return "A vector name cannot be empty.";
  if (name === "." || name === "..") return `${shown(name)} is not a vector name.`;
  const forbidden = QDRANT_VECTOR_NAME_FORBIDDEN.find((character) => name.includes(character));
  if (forbidden !== undefined) {
    return `The vector name ${shown(name)} holds ${JSON.stringify(forbidden)}, a character Qdrant refuses in a vector name.`;
  }
  const bytes = utf8ByteLength(name);
  if (bytes > QDRANT_BOUNDS.maxVectorNameBytes) {
    return `The vector name is ${bytes} bytes long; Qdrant takes at most ${QDRANT_BOUNDS.maxVectorNameBytes}.`;
  }
  return undefined;
}

function collectionNameAt(value: TaggedJson | undefined, where: string): string {
  const name = stringAt(value, where);
  const refusal = qdrantCollectionNameRefusal(name);
  return refusal === undefined ? name : refuse(`${where}: ${refusal}`, where);
}

function vectorNameAt(value: TaggedJson | undefined, where: string): string {
  const name = stringAt(value, where);
  const refusal = qdrantVectorNameRefusal(name);
  return refusal === undefined ? name : refuse(`${where}: ${refusal}`, where);
}

/** What phase 0 gathers while it walks one request. */
class Walk {
  readonly gates = new Set<QdrantGateId>();
  readonly warnings: QueryWarning[] = [];
  readonly literals: VectorLiteral[] = [];
  readonly usings: UsingUse[] = [];
  readonly searches: QdrantSearch[] = [];
  filterBytes = 0;
  prefetchNodes = 0;
  candidates = 0;
  rows = 0;
  readonly lookups = new Set<string>();
  private rangeWarned = false;

  filter(value: TaggedJson, where: string): void {
    this.filterBytes += utf8ByteLength(toJsonText(value));
    if (this.filterBytes > QDRANT_BOUNDS.maxFilterBytes) {
      refuse(
        `The request's filters are ${this.filterBytes} bytes together, above the bound of ${QDRANT_BOUNDS.maxFilterBytes} bytes.`,
        where,
      );
    }
    readFilter(this, value, where, { conditions: 0 }, 0);
  }

  rangeBound(where: string): void {
    if (this.rangeWarned) return;
    this.rangeWarned = true;
    this.warnings.push({
      message: `${where} is an integer above 2^53: Qdrant compares range bounds as doubles, so a bound that large is rounded. A match on the value is exact.`,
    });
  }

  candidate(count: number, where: string): void {
    this.candidates += count;
    if (this.candidates > QDRANT_BOUNDS.maxCandidates) {
      refuse(
        `The request asks its searches for ${this.candidates} candidates in all (each stage's offset plus limit, times its oversampling), above the bound of ${QDRANT_BOUNDS.maxCandidates}: lower a limit, an offset or an oversampling at or before ${where}.`,
        where,
      );
    }
  }

  row(count: number, what: string): void {
    this.rows += count;
    if (this.rows > QDRANT_BOUNDS.maxRows) {
      refuse(`The request asks for ${this.rows} rows (${what}), above the bound of ${QDRANT_BOUNDS.maxRows}.`, "limit");
    }
  }
}

interface FilterCount {
  conditions: number;
}

function readFilter(walk: Walk, value: TaggedJson, where: string, count: FilterCount, nested: number): void {
  const filter = objectAt(value, where);
  closed(filter, "Filter", where);
  for (const clause of FILTER_CLAUSES) {
    if (!has(filter, clause)) continue;
    const conditions = Array.isArray(filter[clause]) ? (filter[clause] as readonly TaggedJson[]) : [filter[clause]];
    conditions.forEach((condition, index) => {
      readCondition(walk, condition, `${where}.${clause}[${index}]`, count, nested);
    });
  }
  if (has(filter, "min_should")) {
    const minShould = objectAt(filter.min_should, `${where}.min_should`);
    closed(minShould, "MinShould", `${where}.min_should`);
    integerAt(minShould.min_count, `${where}.min_should.min_count`, 1, Number.MAX_SAFE_INTEGER);
    listAt(minShould.conditions, `${where}.min_should.conditions`).forEach((condition, index) => {
      readCondition(walk, condition, `${where}.min_should.conditions[${index}]`, count, nested);
    });
  }
}

function readCondition(walk: Walk, value: TaggedJson, where: string, count: FilterCount, nested: number): void {
  const condition = objectAt(value, where);
  const keys = Object.keys(condition);
  const form = ["key", "is_empty", "is_null", "has_id", "has_vector", "slice", "nested"].find((key) =>
    Object.hasOwn(condition, key),
  );
  if (form === undefined) {
    const filterKeys: readonly string[] = QDRANT_KEYS.Filter.keys;
    const stray = keys.find((key) => !filterKeys.includes(key));
    if (stray !== undefined) refuse(`${where} takes no key ${shown(stray)}: ${CONDITION_FORMS}.`, stray);
    readFilter(walk, condition, where, count, nested);
    return;
  }
  count.conditions += 1;
  if (count.conditions > QDRANT_BOUNDS.maxFilterConditions) {
    refuse(`The filter holds more than ${QDRANT_BOUNDS.maxFilterConditions} conditions, the console's bound.`, where);
  }
  if (form === "key") {
    readFieldCondition(walk, condition, where);
  } else if (form === "is_empty" || form === "is_null") {
    closed(condition, form === "is_empty" ? "IsEmptyCondition" : "IsNullCondition", where);
    const field = objectAt(condition[form], `${where}.${form}`);
    closed(field, "PayloadField", `${where}.${form}`);
    stringAt(field.key, `${where}.${form}.key`);
  } else if (form === "has_id") {
    closed(condition, "HasIdCondition", where);
    const ids = listAt(condition.has_id, `${where}.has_id`);
    if (ids.length > QDRANT_BOUNDS.maxFilterListEntries) {
      refuse(
        `${where}.has_id holds ${ids.length} ids, above the bound of ${QDRANT_BOUNDS.maxFilterListEntries}.`,
        "has_id",
      );
    }
    ids.forEach((id, index) => {
      pointIdAt(id, `${where}.has_id[${index}]`);
    });
  } else if (form === "has_vector") {
    closed(condition, "HasVectorCondition", where);
    const name = stringAt(condition.has_vector, `${where}.has_vector`);
    // The unnamed vector is asked for by the empty name, the one place a request writes it.
    if (name !== "") vectorNameAt(name, `${where}.has_vector`);
  } else if (form === "slice") {
    closed(condition, "SliceCondition", where);
    const slice = objectAt(condition.slice, `${where}.slice`);
    closed(slice, "Slice", `${where}.slice`);
    const total = integerAt(slice.total, `${where}.slice.total`, 1, 4_294_967_295);
    integerAt(slice.index, `${where}.slice.index`, 0, total - 1);
    walk.gates.add("slice");
  } else {
    closed(condition, "NestedCondition", where);
    const inner = objectAt(condition.nested, `${where}.nested`);
    closed(inner, "Nested", `${where}.nested`);
    stringAt(inner.key, `${where}.nested.key`);
    if (nested + 1 > QDRANT_BOUNDS.maxNestedLevels) {
      refuse(
        `${where}.nested is more than ${QDRANT_BOUNDS.maxNestedLevels} nested conditions deep, the console's bound.`,
        "nested",
      );
    }
    readFilter(walk, inner.filter, `${where}.nested.filter`, count, nested + 1);
  }
}

function readGeoPoint(value: TaggedJson | undefined, where: string): void {
  const point = objectAt(value, where);
  closed(point, "GeoPoint", where);
}

function readLineString(value: TaggedJson | undefined, where: string): void {
  const line = objectAt(value, where);
  closed(line, "GeoLineString", where);
  listAt(line.points, `${where}.points`).forEach((point, index) => {
    readGeoPoint(point, `${where}.points[${index}]`);
  });
}

function readFieldCondition(walk: Walk, condition: TaggedObject, where: string): void {
  closed(condition, "FieldCondition", where);
  stringAt(condition.key, `${where}.key`);
  if (has(condition, "match")) readMatch(walk, condition.match, `${where}.match`);
  if (has(condition, "range")) {
    const range = objectAt(condition.range, `${where}.range`);
    closed(range, "Range", `${where}.range`);
    for (const bound of Object.keys(range)) {
      const value = range[bound];
      if (value === null || typeof value === "string" || isTaggedFloat(value)) continue;
      if (!isTaggedInt(value)) {
        refuse(`${where}.range.${bound} must be a number or a date-time string, found ${kindOf(value)}.`, bound);
      }
      if (!checkIntRange(value, "safe")) walk.rangeBound(`${where}.range.${bound}`);
    }
  }
  if (has(condition, "geo_bounding_box")) {
    const box = objectAt(condition.geo_bounding_box, `${where}.geo_bounding_box`);
    closed(box, "GeoBoundingBox", `${where}.geo_bounding_box`);
    readGeoPoint(box.top_left, `${where}.geo_bounding_box.top_left`);
    readGeoPoint(box.bottom_right, `${where}.geo_bounding_box.bottom_right`);
  }
  if (has(condition, "geo_radius")) {
    const radius = objectAt(condition.geo_radius, `${where}.geo_radius`);
    closed(radius, "GeoRadius", `${where}.geo_radius`);
    readGeoPoint(radius.center, `${where}.geo_radius.center`);
  }
  if (has(condition, "geo_polygon")) {
    const polygon = objectAt(condition.geo_polygon, `${where}.geo_polygon`);
    closed(polygon, "GeoPolygon", `${where}.geo_polygon`);
    readLineString(polygon.exterior, `${where}.geo_polygon.exterior`);
    if (has(polygon, "interiors")) {
      listAt(polygon.interiors, `${where}.geo_polygon.interiors`).forEach((line, index) => {
        readLineString(line, `${where}.geo_polygon.interiors[${index}]`);
      });
    }
  }
  if (has(condition, "values_count")) {
    closed(objectAt(condition.values_count, `${where}.values_count`), "ValuesCount", `${where}.values_count`);
  }
}

/** An integer a match compares: Qdrant matches payload integers as signed 64-bit values. */
function matchInteger(value: TaggedJson, where: string): void {
  if (isTaggedInt(value) && !checkIntRange(value, "int64")) {
    refuse(`${where} is ${value.digits}, outside the signed 64-bit range a match compares.`, where);
  }
}

function readMatch(walk: Walk, value: TaggedJson, where: string): void {
  const match = objectAt(value, where);
  const keys = Object.keys(match);
  const form = keys.length === 1 ? MATCH_FORMS[keys[0]] : undefined;
  if (form === undefined || !Object.hasOwn(MATCH_FORMS, keys[0])) {
    refuse(
      `${where} takes exactly one of ${Object.keys(MATCH_FORMS).join(", ")}; found ${keys.length === 0 ? "no key" : keys.map(shown).join(", ")}.`,
      keys[0] ?? "match",
    );
  }
  const key = keys[0];
  if (key === "value") matchInteger(match.value, `${where}.value`);
  else if (key === "any" || key === "except") {
    const entries = listAt(match[key], `${where}.${key}`);
    if (entries.length > QDRANT_BOUNDS.maxFilterListEntries) {
      refuse(
        `${where}.${key} holds ${entries.length} entries, above the bound of ${QDRANT_BOUNDS.maxFilterListEntries}.`,
        key,
      );
    }
    entries.forEach((entry, index) => {
      matchInteger(entry, `${where}.${key}[${index}]`);
    });
  } else {
    stringAt(match[key], `${where}.${key}`);
    if (key === "prefix") walk.gates.add("matchPrefix");
  }
}

interface FormulaCount {
  nodes: number;
}

function readExpression(
  walk: Walk,
  value: TaggedJson | undefined,
  where: string,
  count: FormulaCount,
  depth: number,
): void {
  if (depth > QDRANT_BOUNDS.maxFormulaDepth) {
    refuse(
      `${where} is more than ${QDRANT_BOUNDS.maxFormulaDepth} expressions deep, the console's bound for a formula.`,
      "formula",
    );
  }
  count.nodes += 1;
  if (count.nodes > QDRANT_BOUNDS.maxFormulaNodes) {
    refuse(`The formula holds more than ${QDRANT_BOUNDS.maxFormulaNodes} expressions, the console's bound.`, "formula");
  }
  if (typeof value === "string" || (value !== undefined && (isTaggedInt(value) || isTaggedFloat(value)))) return;
  const expression = objectAt(value, where);
  const key = Object.keys(expression).find((name) => Object.hasOwn(EXPRESSION_FORMS, name));
  if (key === undefined) {
    readCondition(walk, expression, where, { conditions: 0 }, 0);
    return;
  }
  closed(expression, EXPRESSION_FORMS[key], where);
  const inner = `${where}.${key}`;
  const operand = expression[key];
  if (key === "mult" || key === "sum" || key === "max" || key === "min") {
    if (key === "max") walk.gates.add("formulaMax");
    if (key === "min") walk.gates.add("formulaMin");
    listAt(operand, inner).forEach((entry, index) => {
      readExpression(walk, entry, `${inner}[${index}]`, count, depth + 1);
    });
  } else if (key === "div") {
    const div = objectAt(operand, inner);
    closed(div, "DivParams", inner);
    readExpression(walk, div.left, `${inner}.left`, count, depth + 1);
    readExpression(walk, div.right, `${inner}.right`, count, depth + 1);
  } else if (key === "pow") {
    const pow = objectAt(operand, inner);
    closed(pow, "PowParams", inner);
    readExpression(walk, pow.base, `${inner}.base`, count, depth + 1);
    readExpression(walk, pow.exponent, `${inner}.exponent`, count, depth + 1);
  } else if (key === "geo_distance") {
    const distance = objectAt(operand, inner);
    closed(distance, "GeoDistanceParams", inner);
    readGeoPoint(distance.origin, `${inner}.origin`);
    stringAt(distance.to, `${inner}.to`);
  } else if (key === "datetime" || key === "datetime_key") {
    stringAt(operand, inner);
  } else if (key === "lin_decay" || key === "exp_decay" || key === "gauss_decay") {
    const decay = objectAt(operand, inner);
    closed(decay, "DecayParamsExpression", inner);
    readExpression(walk, decay.x, `${inner}.x`, count, depth + 1);
    if (has(decay, "target")) readExpression(walk, decay.target, `${inner}.target`, count, depth + 1);
  } else {
    if (key === "acosh") walk.gates.add("formulaAcosh");
    readExpression(walk, operand, inner, count, depth + 1);
  }
}

/** A vector's numbers as phase 0 can check them with no schema: every element a number a float32 can hold. */
function checkLiteralNumbers(values: readonly TaggedJson[], where: string, using: string): void {
  const target: VectorTarget = { name: using, kind: "dense", dtype: "float32", dimension: null };
  const empty = values.indexOf(null);
  if (empty !== -1) {
    refuse(
      `${where}: element ${empty} is null. Qdrant prints a float16 element that overflowed as null, and a vector with one cannot be sent back as a query.`,
      where,
    );
  }
  const numbers = vectorNumbers(target, values);
  const refused = "sentence" in numbers ? numbers : checkDenseElements(target, numbers);
  if (refused !== null) refuse(`${where}: ${(refused as VectorRefusal).sentence}`, where);
}

/**
 * One vector input: a dense list, a list of lists, a point id, a sparse pair, or a text for the local model. Every
 * other inference object is refused here, by name, before anything else about it is read.
 */
function readVectorInput(walk: Walk, value: TaggedJson | undefined, where: string, using: string): void {
  if (Array.isArray(value)) {
    if (value.length === 0) refuse(`${where} is an empty list: a query vector holds at least one number.`, where);
    if (value.every((row) => Array.isArray(row))) {
      (value as readonly (readonly TaggedJson[])[]).forEach((row, index) => {
        if (row.length === 0)
          refuse(`${where}[${index}] is an empty row: a multivector row holds at least one number.`, where);
        checkLiteralNumbers(row, `${where}[${index}]`, using);
      });
      walk.literals.push({ where, using, node: value, kind: "multi" });
    } else {
      checkLiteralNumbers(value, where, using);
      walk.literals.push({ where, using, node: value, kind: "dense" });
    }
    return;
  }
  if (!isObject(value)) {
    pointIdAt(value, where);
    return;
  }
  if (INFERENCE_KEYS.some((key) => Object.hasOwn(value, key))) {
    const model = value.model;
    if (typeof model !== "string" || !QDRANT_LOCAL_MODELS.includes(model)) {
      const named =
        typeof model === "string" ? `names the model ${shown(model)}` : "is an inference input with no model name";
      refuse(`${where} ${named}, which this console does not send. ${INFERENCE_RULE}`, "model");
    }
    if (Object.hasOwn(value, "options")) refuse(`${where} holds options. ${INFERENCE_RULE}`, "options");
    if (Object.hasOwn(value, "image") || Object.hasOwn(value, "object")) {
      refuse(`${where} hands the local model an image or an object, and it reads a text. ${INFERENCE_RULE}`, "model");
    }
    closed(value, "Document", where);
    stringAt(value.text, `${where}.text`);
    walk.literals.push({ where, using, node: value, kind: "text" });
    return;
  }
  closed(value, "SparseVector", where);
  const sparse = sparseFromIndicesValues(
    { name: using, kind: "sparse", dtype: "float32", dimension: null },
    listAt(value.indices, `${where}.indices`),
    listAt(value.values, `${where}.values`),
    QDRANT_BOUNDS.sparseIndexBoundExclusive,
  );
  if ("sentence" in sparse) refuse(`${where}: ${sparse.sentence}`, where);
  walk.literals.push({ where, using, node: value, kind: "sparse" });
}

function readContext(walk: Walk, value: TaggedJson | undefined, where: string, using: string): void {
  const pairs = Array.isArray(value) ? value : [value];
  pairs.forEach((entry, index) => {
    const at = Array.isArray(value) ? `${where}[${index}]` : where;
    const pair = objectAt(entry, at);
    closed(pair, "ContextPair", at);
    readVectorInput(walk, pair.positive, `${at}.positive`, using);
    readVectorInput(walk, pair.negative, `${at}.negative`, using);
  });
}

function readOrderBy(value: TaggedJson | undefined, where: string): void {
  if (typeof value === "string") return;
  const order = objectAt(value, where);
  closed(order, "OrderBy", where);
  stringAt(order.key, `${where}.key`);
  if (has(order, "direction")) wordAt(order.direction, `${where}.direction`, QDRANT_ENUMS.Direction);
  const start = order.start_from;
  if (start !== undefined && isTaggedInt(start) && !checkIntRange(start, "int64")) {
    refuse(`${where}.start_from is ${start.digits}, outside the signed 64-bit range.`, "start_from");
  }
}

interface QueryRead {
  readonly form: QdrantQueryForm;
  /** An MMR candidates_limit, which stands in for the stage's limit in the candidate sum. */
  readonly mmrCandidates: number | null;
}

function readQuery(walk: Walk, value: TaggedJson | undefined, where: string, using: string): QueryRead {
  if (value === undefined || value === null) return { form: "none", mmrCandidates: null };
  if (!isObject(value)) {
    readVectorInput(walk, value, where, using);
    return { form: Array.isArray(value) ? "vector" : "id", mmrCandidates: null };
  }
  const forms = QUERY_FORMS.filter((key) => Object.hasOwn(value, key));
  if (forms.length === 0) {
    const vectorKeys: readonly string[] = [
      ...QDRANT_KEYS.SparseVector.keys,
      ...QDRANT_KEYS.Document.keys,
      ...QDRANT_KEYS.Image.keys,
      ...QDRANT_KEYS.InferenceObject.keys,
    ];
    const stray = Object.keys(value).find((key) => !vectorKeys.includes(key));
    if (stray !== undefined || Object.keys(value).length === 0) {
      refuse(
        `${where} is not a query Qdrant reads: a query is a vector, a point id, {"indices", "values"}, or one of ${QUERY_FORMS.join(", ")}${stray === undefined ? "" : `; found the key ${shown(stray)}`}.`,
        stray ?? "query",
      );
    }
    readVectorInput(walk, value, where, using);
    return { form: "vector", mmrCandidates: null };
  }
  if (forms.length > 1) refuse(`${where} holds ${forms.join(" and ")}: a query takes one form.`, forms[1]);
  const form = forms[0];
  const inner = `${where}.${form}`;
  let mmrCandidates: number | null = null;
  if (form === "nearest") {
    closed(value, "NearestQuery", where);
    readVectorInput(walk, value.nearest, inner, using);
    if (has(value, "mmr")) {
      const mmr = objectAt(value.mmr, `${where}.mmr`);
      closed(mmr, "Mmr", `${where}.mmr`);
      if (has(mmr, "diversity")) numberAt(mmr.diversity, `${where}.mmr.diversity`);
      if (has(mmr, "candidates_limit")) {
        mmrCandidates = integerAt(
          mmr.candidates_limit,
          `${where}.mmr.candidates_limit`,
          1,
          QDRANT_BOUNDS.maxMmrCandidates,
        );
      }
    }
    return { form, mmrCandidates };
  }
  if (form === "recommend") {
    closed(value, "RecommendQuery", where);
    const recommend = objectAt(value.recommend, inner);
    closed(recommend, "RecommendInput", inner);
    for (const side of ["positive", "negative"]) {
      if (!has(recommend, side)) continue;
      listAt(recommend[side], `${inner}.${side}`).forEach((example, index) => {
        readVectorInput(walk, example, `${inner}.${side}[${index}]`, using);
      });
    }
    if (has(recommend, "strategy")) wordAt(recommend.strategy, `${inner}.strategy`, QDRANT_ENUMS.RecommendStrategy);
    return { form, mmrCandidates };
  }
  if (form === "discover") {
    closed(value, "DiscoverQuery", where);
    const discover = objectAt(value.discover, inner);
    closed(discover, "DiscoverInput", inner);
    readVectorInput(walk, discover.target, `${inner}.target`, using);
    readContext(walk, discover.context, `${inner}.context`, using);
    return { form, mmrCandidates };
  }
  if (form === "context") {
    closed(value, "ContextQuery", where);
    readContext(walk, value.context, inner, using);
    return { form, mmrCandidates };
  }
  if (form === "order_by") {
    closed(value, "OrderByQuery", where);
    readOrderBy(value.order_by, inner);
    return { form, mmrCandidates };
  }
  if (form === "fusion") {
    closed(value, "FusionQuery", where);
    return {
      form: wordAt(value.fusion, inner, QDRANT_ENUMS.Fusion) === "rrf" ? "fusion.rrf" : "fusion.dbsf",
      mmrCandidates,
    };
  }
  if (form === "rrf") {
    closed(value, "RrfQuery", where);
    const rrf = objectAt(value.rrf, inner);
    closed(rrf, "Rrf", inner);
    if (has(rrf, "k")) integerAt(rrf.k, `${inner}.k`, 1, Number.MAX_SAFE_INTEGER);
    if (has(rrf, "weights")) {
      listAt(rrf.weights, `${inner}.weights`).forEach((weight, index) => {
        numberAt(weight, `${inner}.weights[${index}]`);
      });
      walk.gates.add("rrfWeights");
    }
    return { form, mmrCandidates };
  }
  if (form === "formula") {
    closed(value, "FormulaQuery", where);
    readExpression(walk, value.formula, inner, { nodes: 0 }, 1);
    if (has(value, "defaults")) objectAt(value.defaults, `${where}.defaults`);
    return { form, mmrCandidates };
  }
  if (form === "sample") {
    closed(value, "SampleQuery", where);
    wordAt(value.sample, inner, QDRANT_ENUMS.Sample);
    return { form, mmrCandidates };
  }
  closed(value, "RelevanceFeedbackQuery", where);
  walk.gates.add("relevanceFeedback");
  const feedback = objectAt(value.relevance_feedback, inner);
  closed(feedback, "RelevanceFeedbackInput", inner);
  readVectorInput(walk, feedback.target, `${inner}.target`, using);
  listAt(feedback.feedback, `${inner}.feedback`).forEach((entry, index) => {
    const item = objectAt(entry, `${inner}.feedback[${index}]`);
    closed(item, "FeedbackItem", `${inner}.feedback[${index}]`);
    readVectorInput(walk, item.example, `${inner}.feedback[${index}].example`, using);
    numberAt(item.score, `${inner}.feedback[${index}].score`);
  });
  const strategy = objectAt(feedback.strategy, `${inner}.strategy`);
  closed(strategy, "NaiveFeedbackStrategy", `${inner}.strategy`);
  closed(objectAt(strategy.naive, `${inner}.strategy.naive`), "NaiveFeedbackStrategyParams", `${inner}.strategy.naive`);
  return { form: "relevance_feedback", mmrCandidates };
}

function readShardKey(value: TaggedJson, where: string): void {
  const one = (key: TaggedJson | undefined, at: string): void => {
    if (typeof key === "string") return;
    if (key === undefined || !isTaggedInt(key) || !checkIntRange(key, "uint64")) {
      refuse(`${at} must be a shard key, a string or an unsigned integer, found ${kindOf(key)}.`, "shard_key");
    }
  };
  if (Array.isArray(value)) {
    value.forEach((key, index) => {
      one(key, `${where}[${index}]`);
    });
  } else if (isObject(value)) {
    closed(value, "ShardKeyWithFallback", where);
    one(value.target, `${where}.target`);
    one(value.fallback, `${where}.fallback`);
  } else one(value, where);
}

function readWithPayload(value: TaggedJson, where: string): void {
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((key, index) => {
      stringAt(key, `${where}[${index}]`);
    });
    return;
  }
  const selector = objectAt(value, where);
  const form = Object.hasOwn(selector, "exclude") ? "exclude" : "include";
  closed(selector, form === "exclude" ? "PayloadSelectorExclude" : "PayloadSelectorInclude", where);
  listAt(selector[form], `${where}.${form}`).forEach((key, index) => {
    stringAt(key, `${where}.${form}[${index}]`);
  });
}

function readWithVector(value: TaggedJson, where: string): void {
  if (typeof value === "boolean") return;
  listAt(value, where).forEach((name, index) => {
    stringAt(name, `${where}[${index}]`);
  });
}

/** The search parameters of one stage; the oversampling it asks for, 1 where it asks for none. */
function readParams(walk: Walk, value: TaggedJson, where: string): number {
  const params = objectAt(value, where);
  closed(params, "SearchParams", where);
  if (has(params, "hnsw_ef")) integerAt(params.hnsw_ef, `${where}.hnsw_ef`, 1, QDRANT_BOUNDS.maxHnswEf);
  if (has(params, "acorn")) closed(objectAt(params.acorn, `${where}.acorn`), "AcornSearchParams", `${where}.acorn`);
  if (has(params, "idf")) {
    walk.gates.add("paramsIdf");
    if (isObject(params.idf)) {
      closed(params.idf, "IdfCorpusParams", `${where}.idf`);
      walk.filter(params.idf.corpus, `${where}.idf.corpus`);
    } else wordAt(params.idf, `${where}.idf`, QDRANT_ENUMS.IdfScope);
  }
  if (!has(params, "quantization")) return 1;
  const quantization = objectAt(params.quantization, `${where}.quantization`);
  closed(quantization, "QuantizationSearchParams", `${where}.quantization`);
  if (!has(quantization, "oversampling")) return 1;
  const oversampling = numberAt(quantization.oversampling, `${where}.quantization.oversampling`);
  if (!(oversampling >= 1 && oversampling <= QDRANT_BOUNDS.maxOversampling)) {
    refuse(
      `${where}.quantization.oversampling is ${oversampling}; it takes a number from 1 to ${QDRANT_BOUNDS.maxOversampling}.`,
      "oversampling",
    );
  }
  return oversampling;
}

/** The keys a query, a prefetch entry and a grouped query share; what the stage is and what it costs. */
function readStage(
  walk: Walk,
  stage: TaggedObject,
  where: string,
  depth: number,
  rows: (limit: number | null) => { readonly limit: number; readonly offset: number },
): QdrantSearch {
  const at = (key: string) => (where === "" ? key : `${where}.${key}`);
  const using = has(stage, "using") ? vectorNameAt(stage.using, at("using")) : "";
  if (has(stage, "filter")) walk.filter(stage.filter, at("filter"));
  const oversampling = has(stage, "params") ? readParams(walk, stage.params, at("params")) : 1;
  if (has(stage, "score_threshold")) numberAt(stage.score_threshold, at("score_threshold"));
  if (has(stage, "lookup_from")) {
    const lookup = objectAt(stage.lookup_from, at("lookup_from"));
    closed(lookup, "LookupLocation", at("lookup_from"));
    const collection = collectionNameAt(lookup.collection, at("lookup_from.collection"));
    const vector = has(lookup, "vector") ? vectorNameAt(lookup.vector, at("lookup_from.vector")) : using;
    if (has(lookup, "shard_key")) readShardKey(lookup.shard_key, at("lookup_from.shard_key"));
    walk.lookups.add(collection);
    walk.usings.push({ where: at("lookup_from.vector"), using: vector, needed: true, collection });
  }
  if (has(stage, "prefetch")) {
    if (depth + 1 > QDRANT_BOUNDS.maxPrefetchDepth) {
      refuse(
        `${at("prefetch")} nests prefetch more than ${QDRANT_BOUNDS.maxPrefetchDepth} levels deep, the console's bound.`,
        "prefetch",
      );
    }
    const entries = Array.isArray(stage.prefetch) ? (stage.prefetch as readonly TaggedJson[]) : [stage.prefetch];
    if (entries.length > QDRANT_BOUNDS.maxPrefetchPerList) {
      refuse(
        `${at("prefetch")} holds ${entries.length} entries, above the bound of ${QDRANT_BOUNDS.maxPrefetchPerList} in one list.`,
        "prefetch",
      );
    }
    entries.forEach((entry, index) => {
      const inner = Array.isArray(stage.prefetch) ? `${at("prefetch")}[${index}]` : at("prefetch");
      const prefetch = objectAt(entry, inner);
      closed(prefetch, "Prefetch", inner);
      walk.prefetchNodes += 1;
      if (walk.prefetchNodes > QDRANT_BOUNDS.maxPrefetchNodes) {
        refuse(
          `The request holds more than ${QDRANT_BOUNDS.maxPrefetchNodes} prefetch entries in all, every search counted together, the console's bound.`,
          "prefetch",
        );
      }
      readStage(walk, prefetch, inner, depth + 1, (limit) => ({
        limit: limit ?? QDRANT_BOUNDS.countedPrefetchLimit,
        offset: 0,
      }));
    });
  }
  const query = readQuery(walk, stage.query, at("query"), using);
  walk.usings.push({
    where: at("using"),
    using,
    needed: VECTOR_FORMS.has(query.form) || has(stage, "using"),
    collection: null,
  });
  const limit = has(stage, "limit") ? integerAt(stage.limit, at("limit"), 1, QDRANT_BOUNDS.maxCandidates) : null;
  const asked = rows(limit);
  walk.candidate(
    (asked.offset + (query.mmrCandidates ?? asked.limit)) * oversampling,
    where === "" ? "the request" : where,
  );
  return { form: query.form, using };
}

/** A copy of the body with a default written in where the key was left out, or written as null. */
function withDefaults(body: TaggedObject, defaults: Readonly<Record<string, TaggedJson>>): TaggedObject {
  const copy: Record<string, TaggedJson> = Object.create(null);
  for (const key of Object.keys(body)) {
    if (!(Object.hasOwn(defaults, key) && body[key] === null)) copy[key] = body[key];
  }
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(copy, key)) copy[key] = defaults[key];
  }
  return Object.freeze(copy);
}

const integer = (value: number): TaggedJson => taggedNumber(String(value));

/** A copy of the object without one key, to check the rest against a closed set. */
function withoutKey(object: TaggedObject, key: string): TaggedObject {
  if (!Object.hasOwn(object, key)) return object;
  const copy: Record<string, TaggedJson> = Object.create(null);
  for (const name of Object.keys(object)) if (name !== key) copy[name] = object[name];
  return copy;
}

function readSelectors(body: TaggedObject): void {
  if (has(body, "shard_key")) readShardKey(body.shard_key, "shard_key");
  if (has(body, "with_payload")) readWithPayload(body.with_payload, "with_payload");
  if (has(body, "with_vector")) readWithVector(body.with_vector, "with_vector");
}

/** One search, a query or an entry of a batch: its keys, its rows and its defaults. */
function readSearch(walk: Walk, search: TaggedObject, where: string, rows: string): TaggedObject {
  const prefix = where === "" ? "" : `${where}.`;
  if (Object.hasOwn(search, QDRANT_QUERY_ALIAS.alias)) {
    if (Object.hasOwn(search, QDRANT_QUERY_ALIAS.key)) {
      refuse(
        `${prefix}${QDRANT_QUERY_ALIAS.alias} and ${QDRANT_QUERY_ALIAS.key} are one key to Qdrant: write one of them.`,
        QDRANT_QUERY_ALIAS.alias,
      );
    }
    readWithVector(search[QDRANT_QUERY_ALIAS.alias], `${prefix}${QDRANT_QUERY_ALIAS.alias}`);
  }
  closed(withoutKey(search, QDRANT_QUERY_ALIAS.alias), "QueryRequest", where === "" ? "The body" : where);
  if (has(search, "shard_key")) readShardKey(search.shard_key, `${prefix}shard_key`);
  if (has(search, "with_payload")) readWithPayload(search.with_payload, `${prefix}with_payload`);
  if (has(search, "with_vector")) readWithVector(search.with_vector, `${prefix}with_vector`);
  const offset = has(search, "offset")
    ? integerAt(search.offset, `${prefix}offset`, 0, QDRANT_BOUNDS.maxCandidates)
    : 0;
  walk.searches.push(
    readStage(walk, search, where, 0, (limit) => {
      walk.row(limit ?? QDRANT_BOUNDS.defaultLimit, rows);
      return { limit: limit ?? QDRANT_BOUNDS.defaultLimit, offset };
    }),
  );
  return withDefaults(search, { limit: integer(QDRANT_BOUNDS.defaultLimit) });
}

/**
 * Refuses a key named `options` at any depth, wherever the closed keys did not already: it is where an inference
 * input carries a model's settings, and nothing the console sends has one.
 */
function refuseOptions(body: TaggedObject): void {
  const pending: TaggedJson[] = [body];
  while (pending.length > 0) {
    const value = pending.pop() as TaggedJson;
    if (Array.isArray(value)) pending.push(...value);
    else if (isObject(value)) {
      if (Object.hasOwn(value, "options")) {
        refuse(`A request holds no key "options", at any depth. ${INFERENCE_RULE}`, "options");
      }
      for (const key of Object.keys(value)) pending.push(value[key]);
    }
  }
}

/** The grammar's verdict on one console text, with the console's own sentence for a route it does not run. */
export function parseQdrantRequest(text: string): ConsoleRequest<QdrantOp> {
  try {
    return parseConsole(QDRANT_CONSOLE, QDRANT_ROUTES, text);
  } catch (error) {
    if (!(error instanceof ConsoleRefusal) || (error.reason !== "unknown-route" && error.reason !== "unknown-method")) {
      throw error;
    }
    const { method, target } = consoleTokens(QDRANT_CONSOLE, text).request;
    if (target === "") throw error;
    throw new ConsoleRefusal(error.reason, refusedRouteSentence(method, target), error.line, error.column);
  }
}

/**
 * Every rule that needs neither the schema nor the server's version. Throws a phase 0 `RequestRefusal` naming the
 * first rule the request breaks; makes no call.
 */
export function qdrantPhase0(request: ConsoleRequest<QdrantOp>): QdrantPhase0 {
  const route = QDRANT_ROUTES.find((entry) => entry.op === request.route.op) as QdrantRoute;
  if (Object.hasOwn(request.params, "collection_name")) {
    const refusal = qdrantCollectionNameRefusal(request.params.collection_name);
    if (refusal !== undefined) refuse(refusal, "collection_name");
  }
  const walk = new Walk();
  const original = request.body;
  let body: TaggedObject | null = null;
  if (route.schema !== null && route.op !== "query_points" && route.op !== "query_batch_points") {
    closed(original, route.schema, "The body");
  }
  if (route.op === "get_points") {
    const ids = listAt(original.ids, "ids");
    walk.row(ids.length, "one per id");
    ids.forEach((id, index) => {
      pointIdAt(id, `ids[${index}]`);
    });
    readSelectors(original);
    body = original;
  } else if (route.op === "scroll_points") {
    if (has(original, "limit")) walk.row(integerAt(original.limit, "limit", 1, QDRANT_BOUNDS.maxRows), "limit");
    if (has(original, "offset")) pointIdAt(original.offset, "offset");
    if (has(original, "filter")) walk.filter(original.filter, "filter");
    if (has(original, "order_by")) readOrderBy(original.order_by, "order_by");
    readSelectors(original);
    body = withDefaults(original, { limit: integer(QDRANT_BOUNDS.defaultLimit) });
  } else if (route.op === "count_points") {
    if (has(original, "filter")) walk.filter(original.filter, "filter");
    if (has(original, "shard_key")) readShardKey(original.shard_key, "shard_key");
    body = withDefaults(original, { exact: true });
  } else if (route.op === "facet") {
    if (stringAt(original.key, "key") === "")
      refuse("key names the payload field to count by; it cannot be empty.", "key");
    if (has(original, "limit")) integerAt(original.limit, "limit", 1, QDRANT_BOUNDS.maxFacetLimit);
    if (has(original, "filter")) walk.filter(original.filter, "filter");
    if (has(original, "shard_key")) readShardKey(original.shard_key, "shard_key");
    body = withDefaults(original, { limit: integer(QDRANT_BOUNDS.defaultLimit) });
  } else if (route.op === "query_points") {
    body = readSearch(walk, original, "", "limit");
  } else if (route.op === "query_batch_points") {
    closed(original, "QueryRequestBatch", "The body");
    const searches = listAt(original.searches, "searches");
    if (searches.length === 0 || searches.length > QDRANT_BOUNDS.maxBatchSearches) {
      refuse(
        `searches holds ${searches.length} searches; a batch takes 1 to ${QDRANT_BOUNDS.maxBatchSearches}.`,
        "searches",
      );
    }
    const written = searches.map((search, index) =>
      readSearch(walk, objectAt(search, `searches[${index}]`), `searches[${index}]`, "the sum of the searches' limits"),
    );
    const copy: Record<string, TaggedJson> = Object.create(null);
    copy.searches = Object.freeze(written);
    body = Object.freeze(copy);
  } else if (route.op === "query_points_groups") {
    if (stringAt(original.group_by, "group_by") === "") {
      refuse("group_by names the payload field to group by; it cannot be empty.", "group_by");
    }
    readSelectors(original);
    const size = has(original, "group_size")
      ? integerAt(original.group_size, "group_size", 1, QDRANT_BOUNDS.maxRows)
      : QDRANT_BOUNDS.defaultGroupSize;
    if (has(original, "with_lookup") && typeof original.with_lookup !== "string") {
      const lookup = objectAt(original.with_lookup, "with_lookup");
      closed(lookup, "WithLookup", "with_lookup");
      collectionNameAt(lookup.collection, "with_lookup.collection");
      if (has(lookup, "with_payload")) readWithPayload(lookup.with_payload, "with_lookup.with_payload");
      if (has(lookup, "with_vectors")) readWithVector(lookup.with_vectors, "with_lookup.with_vectors");
    } else if (has(original, "with_lookup")) collectionNameAt(original.with_lookup, "with_lookup");
    walk.searches.push(
      readStage(walk, original, "", 0, (limit) => {
        const groups = limit ?? QDRANT_BOUNDS.defaultLimit;
        walk.row(groups * size, "limit times group_size");
        return { limit: groups * size, offset: 0 };
      }),
    );
    body = withDefaults(original, {
      limit: integer(QDRANT_BOUNDS.defaultLimit),
      group_size: integer(QDRANT_BOUNDS.defaultGroupSize),
    });
  }
  refuseOptions(original);
  return {
    request,
    route,
    body,
    collections: POINT_ROUTES.has(route.op) ? [...new Set([request.params.collection_name, ...walk.lookups])] : [],
    searches: walk.searches,
    gates: [...walk.gates],
    warnings: walk.warnings,
    literals: walk.literals,
    usings: walk.usings,
  };
}

const PLAIN_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function refuseLater(message: string, key: string | null = null): never {
  throw new RequestRefusal(message, 1, key);
}

function atLeast(version: string, needs: string): boolean {
  const have = version.split(".").map(Number);
  const want = needs.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (have[index] !== want[index]) return have[index] > want[index];
  }
  return true;
}

/**
 * The version gates: a key newer than the server is refused by name with the version it needs, with no call. A
 * version that is missing or is not a plain `major.minor.patch` refuses every gated key.
 */
export function qdrantVersionGates(plan: QdrantPhase0, version: string | null): void {
  const plain = version !== null && PLAIN_VERSION.test(version);
  for (const id of plan.gates) {
    const gate = QDRANT_GATES[id];
    if (plain && atLeast(version, gate.needs)) continue;
    const server = plain
      ? `this server is ${version}`
      : `this server reported ${version === null ? "no version" : `the version ${shown(version)}, which is not a plain major.minor.patch`}`;
    refuse(
      `${gate.key} needs Qdrant ${gate.needs} or later, and ${server}. An older server ignores the key or answers an error that names no key, so Studio refuses it.`,
      gate.key,
    );
  }
}

function vectorOf(
  facts: QdrantCollectionFacts,
  use: { readonly where: string; readonly using: string },
  collection: string,
): VectorFieldInfo {
  const found = facts.vectors.find((vector) => vector.name === use.using);
  if (found !== undefined) return found;
  const names = facts.vectors.map((vector) => (vector.name === "" ? "the unnamed vector" : vector.name));
  const holds = names.length === 0 ? "it has no vector" : `it has ${names.join(", ")}`;
  if (use.using === "") {
    return refuseLater(
      `The collection ${shown(collection)} has no unnamed vector, so the search needs "using" with a vector's name: ${holds}.`,
      "using",
    );
  }
  return refuseLater(
    `${use.where} names ${shown(use.using)}, which is no vector of the collection ${shown(collection)}: ${holds}.`,
    "using",
  );
}

const named = (vector: VectorFieldInfo): string => (vector.name === "" ? "the unnamed vector" : shown(vector.name));

/** The literal checked against its vector, and what is written in its place: its numbers as doubles. */
function checkedLiteral(literal: VectorLiteral, vector: VectorFieldInfo): TaggedJson | undefined {
  const target: VectorTarget = vector;
  const mismatch = (written: string, hint: string) =>
    refuseLater(
      `${literal.where} is ${written}, and ${named(vector)} is a ${vector.kind === "multi" ? "multivector" : `${vector.kind} vector`}: ${hint}.`,
      "query",
    );
  if (literal.kind === "text") {
    if (vector.kind !== "sparse") {
      mismatch(
        "a text for the local BM25 model, which writes a sparse vector",
        'aim it at a sparse vector with "using"',
      );
    }
    return undefined;
  }
  if (literal.kind === "sparse") {
    if (vector.kind !== "sparse") mismatch("a sparse vector", "write a list of numbers");
    return undefined;
  }
  if (vector.kind === "sparse") mismatch("a list of numbers", 'write {"indices": [...], "values": [...]}');
  if (vector.dimension !== null && (vector.dimension < 1 || vector.dimension > QDRANT_BOUNDS.maxDenseSize)) {
    refuseLater(
      `${named(vector)} declares the size ${vector.dimension}, outside 1 to ${QDRANT_BOUNDS.maxDenseSize}, so no query vector fits it.`,
      "query",
    );
  }
  const numbers = (values: readonly TaggedJson[]) => vectorNumbers(target, values) as readonly number[];
  let refused: VectorRefusal | null;
  let written: TaggedJson;
  if (literal.kind === "multi") {
    if (vector.kind !== "multi") mismatch("a list of lists", "write one list of numbers");
    const rows = (literal.node as readonly (readonly TaggedJson[])[]).map(numbers);
    refused = checkMultiVector(target, rows, QDRANT_BOUNDS.maxMultivectorElements);
    written = rows;
  } else {
    const values = numbers(literal.node as readonly TaggedJson[]);
    // A flat list aimed at a multivector is one row of it: the row's length and elements are checked as a row's.
    refused = checkDenseElements({ ...target, kind: "dense" }, values);
    written = values;
  }
  if (refused !== null) refuseLater(`${literal.where}: ${refused.sentence}`, "query");
  return written;
}

function rewritten(value: TaggedJson, replacements: ReadonlyMap<TaggedJson, TaggedJson>): TaggedJson {
  const replacement = replacements.get(value);
  if (replacement !== undefined) return replacement;
  if (Array.isArray(value)) return value.map((entry) => rewritten(entry, replacements));
  if (!isObject(value)) return value;
  const copy: Record<string, TaggedJson> = Object.create(null);
  for (const key of Object.keys(value)) copy[key] = rewritten(value[key], replacements);
  return copy;
}

/**
 * Phase 1: every vector the request names exists, every query vector fits the vector it is aimed at, and the body
 * is written. `facts` holds each collection `collections` named, described for this request. Throws a phase 1
 * `RequestRefusal`; makes no call.
 */
export function qdrantPhase1(plan: QdrantPhase0, facts: ReadonlyMap<string, QdrantCollectionFacts>): QdrantWire {
  const factsOf = (collection: string): QdrantCollectionFacts => {
    const found = facts.get(collection);
    if (found === undefined) throw new Error(`The collection ${collection} was not described for this request`);
    return found;
  };
  const replacements = new Map<TaggedJson, TaggedJson>();
  const own = plan.collections.length === 0 ? null : factsOf(plan.collections[0]);
  if (own !== null) {
    const main = plan.collections[0];
    for (const use of plan.usings) {
      if (use.needed) vectorOf(factsOf(use.collection ?? main), use, use.collection ?? main);
    }
    for (const literal of plan.literals) {
      const written = checkedLiteral(literal, vectorOf(own, literal, main));
      if (written !== undefined) replacements.set(literal.node, written);
    }
  }
  const exact = plan.body !== null && plan.body.exact === true;
  return {
    op: plan.route.op,
    params: plan.request.params,
    query: plan.request.query,
    ...(plan.body === null ? {} : { body: toJsonText(rewritten(plan.body, replacements)) }),
    shape: { op: plan.route.op, facts: own, searches: plan.searches, exact, warnings: plan.warnings },
  };
}
