/**
 * The Milvus console request, from its text to the typed gRPC request the client sends (vector-family spec 5.4, 5.6,
 * 3.9). Pure; the phase 0 half runs in the browser through guard.ts, and both halves on the server.
 *
 * Phase 0 reads the text and the body alone and makes no call of any kind: the grammar, the route, closed keys at
 * every level, names, integer and number kinds, every cap of 5.6, the lone-count rule, consistency, templates, the
 * rerank table and the search arithmetic. The version gates are phase 0 too, but only the server holds the version,
 * so `milvusVersionGates` runs there with the gate function versions.ts provides. Phase 1 reads the DescribeCollection
 * fetched for this request, and on a search the DescribeIndex, and refuses what needs the schema: projection, vector
 * dtypes and ranges, text data, id types, partition keys, grouping fields, the metric and the per-index search
 * parameters. Then it lowers the request to the exact wire request, never forwarding text.
 *
 * Every refusal is a `RequestRefusal` carrying its phase and the key it names.
 */
import { utf8ByteLength } from "@/lib/db/console/bounds";
import { routeListText } from "@/lib/db/console/completion";
import { RequestRefusal, type ValidationPhase } from "@/lib/db/console/dialect";
import { ConsoleRefusal, type ConsoleRequest, parseConsole } from "@/lib/db/console/parser";
import {
  checkIntRange,
  isTaggedFloat,
  isTaggedInt,
  type TaggedJson,
  type TaggedObject,
  toJsonText,
} from "@/lib/db/console/tagged-json";
import { checkDenseElements, checkMultiVector, type VectorTarget, vectorNumbers } from "@/lib/db/vector/dense";
import { checkSparse, sparseFromIndexMap } from "@/lib/db/vector/sparse";
import type { VectorDType } from "@/lib/db/vector/types";
import type {
  DescribeAliasRequest,
  DescribeCollectionRequest,
  DescribeCollectionResponse,
  DescribeDatabaseRequest,
  DescribeIndexRequest,
  DescribeIndexResponse,
  GetCollectionStatisticsRequest,
  GetLoadStateRequest,
  HybridSearchRequest,
  ListAliasesRequest,
  QueryRequest,
  SearchRequest,
  ShowPartitionsRequest,
  WireCollectionSchema,
  WireFieldSchema,
  WireIDs,
  WireKeyValuePair,
} from "./client";
import { FILTER_IDENTIFIER, idsFilter, int64Digits, type TemplateParam, type TypedIds, templateValues } from "./expr";
import {
  encodePlaceholderGroup,
  floatVectorBytes,
  int8VectorBytes,
  type MilvusPlaceholderType,
  sparseVectorBytes,
  textBytes,
} from "./placeholder-group";
import {
  endpointKeySentence,
  MILVUS_BOUNDS,
  MILVUS_CONSISTENCY_LEVELS,
  MILVUS_CONSOLE,
  MILVUS_DISTANCE_METRICS,
  MILVUS_DOCUMENTED_REFUSALS,
  MILVUS_ENDPOINT_KEYS,
  MILVUS_INDEX_SEARCH_KEYS,
  MILVUS_REFUSED_CONSISTENCY,
  MILVUS_REQUIRED_KEYS,
  MILVUS_RERANK_PARAMS,
  MILVUS_ROUTE_KEYS,
  MILVUS_ROUTES,
  MILVUS_SEARCH_PARAMETERS,
  MILVUS_SEARCH_PARAMS_KEYS,
  MILVUS_SIMILARITY_METRICS,
  MILVUS_SUB_REQUEST_KEYS,
  MILVUS_SUB_REQUEST_REFUSALS,
  MILVUS_UNDOCUMENTED_REFUSALS,
  MILVUS_VERSION_GATED_KEYS,
  type MilvusOp,
  NORM_SCORE_REFUSAL,
  routeRefusalSentence,
  unknownKeySentence,
} from "./routes";
import type { MilvusVersionGate } from "./versions";

// -- refusals and readers ----------------------------------------------------------------------------------------

function refusal(phase: ValidationPhase, key: string | null, message: string): RequestRefusal {
  return new RequestRefusal(message, phase, key);
}

/** A typed value shown in a sentence, cut so a long one never fills the message. */
function shown(text: string): string {
  return JSON.stringify(text.length <= 64 ? text : `${text.slice(0, 64)}…`);
}

/** A table lookup by a key the user typed: an own property only, so `toString` or `constructor` finds nothing. */
function own<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

function isObject(value: TaggedJson | undefined): value is TaggedObject {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !isTaggedInt(value) && !isTaggedFloat(value)
  );
}

function isList(value: TaggedJson | undefined): value is readonly TaggedJson[] {
  return Array.isArray(value);
}

function readString(value: TaggedJson | undefined, key: string): string {
  if (typeof value !== "string") throw refusal(0, key, `${key} takes a string.`);
  return value;
}

export const MILVUS_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

/** A database, collection or alias name: Milvus's rule, exactly, never trimmed (R43 M10). */
function readName(value: TaggedJson | undefined, key: string): string {
  const name = readString(value, key);
  if (!MILVUS_NAME.test(name)) {
    throw refusal(
      0,
      key,
      `${key} ${shown(name)} is not a Milvus name: a letter or underscore, then letters, digits or underscores, at most 255 characters, as typed.`,
    );
  }
  return name;
}

/** A field, partition or index name: non-empty, at most 255 bytes, never trimmed; the schema decides the rest. */
function readFieldName(value: TaggedJson | undefined, key: string): string {
  const name = readString(value, key);
  if (name === "" || utf8ByteLength(name) > MILVUS_BOUNDS.maxNameBytes) {
    throw refusal(0, key, `${key} takes a name of 1 to 255 bytes.`);
  }
  return name;
}

/** An integer option: only a JSON integer literal, sent as canonical decimal (E12; ParseInt reads 010 as octal). */
function readInteger(value: TaggedJson | undefined, key: string, min: number, max: number): number {
  if (value === undefined || value === null || !isTaggedInt(value)) {
    throw refusal(0, key, `${key} takes a JSON integer such as 10, written without quotes, a fraction or an exponent.`);
  }
  const digits = toJsonText(value);
  const number = checkIntRange(value, "safe") ? Number(digits) : Number.NaN;
  if (!(number >= min && number <= max)) {
    throw refusal(0, key, `${key} is ${shown(digits)}; Studio accepts ${min} to ${max}.`);
  }
  return number;
}

/** A number option: any finite JSON number, sent as JSON number text (E12). */
function readNumber(value: TaggedJson | undefined, key: string): number {
  if (value === undefined || value === null || !(isTaggedInt(value) || isTaggedFloat(value))) {
    throw refusal(0, key, `${key} takes a JSON number, written without quotes.`);
  }
  const number = Number(toJsonText(value));
  if (!Number.isFinite(number)) throw refusal(0, key, `${key} must be a finite number.`);
  return number;
}

function readBoolean(value: TaggedJson | undefined, key: string): boolean {
  if (typeof value !== "boolean") throw refusal(0, key, `${key} takes true or false.`);
  return value;
}

function readList(value: TaggedJson | undefined, key: string, max: number): readonly TaggedJson[] {
  if (!isList(value)) throw refusal(0, key, `${key} takes a list.`);
  if (value.length > max) throw refusal(0, key, `${key} holds ${value.length} entries; Studio sends at most ${max}.`);
  return value;
}

function readObject(value: TaggedJson | undefined, key: string): TaggedObject {
  if (!isObject(value)) throw refusal(0, key, `${key} takes an object.`);
  return value;
}

/** The keys of `body` against the route's own schema, then the keys it needs (5.4, VF5). */
function checkKeys(op: MilvusOp, body: TaggedObject): void {
  const accepted = MILVUS_ROUTE_KEYS[op];
  for (const key of Object.keys(body)) {
    if (accepted.includes(key)) continue;
    const named = own(MILVUS_DOCUMENTED_REFUSALS[op], key) ?? own(MILVUS_UNDOCUMENTED_REFUSALS[op], key);
    throw refusal(0, key, named ?? unknownKeySentence(op, shown(key), accepted));
  }
  for (const key of MILVUS_REQUIRED_KEYS[op]) {
    if (body[key] === undefined) throw refusal(0, key, `${op} needs ${key}.`);
  }
}

/** A key that can name a service, at any depth of `value` (E34). */
function refuseEndpointKeys(value: TaggedJson, path: string): void {
  if (isList(value)) {
    value.forEach((item, index) => refuseEndpointKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const name of Object.keys(value)) {
    const child = `${path}.${name}`;
    if (MILVUS_ENDPOINT_KEYS.includes(name.toLowerCase())) throw refusal(0, child, endpointKeySentence(child));
    refuseEndpointKeys(value[name], child);
  }
}

// -- parsing -----------------------------------------------------------------------------------------------------

const ROUTE_WORDS = /^[a-z_]+(?:\/[a-z_]+)+$/;

/** The route a request line names, without the prefix, when it is plain route words; undefined otherwise. */
function namedRoute(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "" && !candidate.startsWith("#"));
  const target = line?.split(/\s+/)[1];
  if (target === undefined) return undefined;
  const route = target.startsWith(MILVUS_CONSOLE.pathPrefix) ? target.slice(MILVUS_CONSOLE.pathPrefix.length) : target;
  return ROUTE_WORDS.test(route) ? route : undefined;
}

const DATA_ARRAY = /"data"\s*:\s*\[/;
const NUMBER_START = /[-+0-9.]/;

/**
 * The query vectors of the first `data` array of a text too large to parse, when they are dense: how many, and the
 * element count of the first. One pass over the characters, no parse; anything that is not an array of number arrays
 * (a base64 string, a sparse map, an embedding list) gives undefined.
 */
function denseDataShape(text: string): { readonly nq: number; readonly dimension: number } | undefined {
  const match = DATA_ARRAY.exec(text);
  if (match === null) return undefined;
  let depth = 1;
  let nq = 0;
  let dimension = 0;
  let inNumber = false;
  for (let index = match.index + match[0].length; index < text.length && depth > 0; index += 1) {
    const char = text[index];
    const numeric: boolean = NUMBER_START.test(char) || (inNumber && (char === "e" || char === "E"));
    if (numeric && depth === 2 && !inNumber && nq === 1) dimension += 1;
    inNumber = numeric;
    if (numeric || char === "," || char.trim() === "") continue;
    if (char === "[") {
      depth += 1;
      if (depth > 2) return undefined;
      nq += 1;
    } else if (char === "]") {
      depth -= 1;
    } else {
      return undefined;
    }
  }
  return nq === 0 || dimension === 0 ? undefined : { nq, dimension };
}

const grouped = (value: number) => value.toLocaleString("en-US");

/**
 * The shared refusal of a text past the console's bound, with what has to shrink when the text is vector-heavy: the
 * number of query vectors times the dimension (5.6, R42 F16).
 */
function tooLargeRefusal(error: ConsoleRefusal, text: string): ConsoleRefusal {
  const shape = denseDataShape(text);
  if (shape === undefined) return error;
  const sentence = error.message.slice(0, error.message.lastIndexOf(" (line "));
  return new ConsoleRefusal(
    "too-large",
    `${sentence} Its data holds ${grouped(shape.nq)} query vector${shape.nq === 1 ? "" : "s"} of dimension ${grouped(shape.dimension)}, ${grouped(shape.nq)} times ${grouped(shape.dimension)} = ${grouped(shape.nq * shape.dimension)} numbers: send fewer query vectors or a smaller dimension, since nq 10 fits up to about dimension 8,192 and nq 1 or 2 fits dimension 32,768.`,
    error.line,
    error.column,
    error.key,
  );
}

/**
 * The console text read by the shared grammar against the Milvus table (3.4). A route the table does not hold is
 * refused with Milvus's own sentence: the Operations routes point at the Operations controls (E9), a write says the
 * provider reads only, and any other names the routes Studio runs (5.4). A text past the byte bound whose data is
 * dense query vectors is refused naming their count times their dimension (5.6).
 */
export function parseMilvusRequest(text: string): ConsoleRequest<MilvusOp> {
  try {
    return parseConsole(MILVUS_CONSOLE, MILVUS_ROUTES, text);
  } catch (error) {
    if (!(error instanceof ConsoleRefusal)) throw error;
    if (error.reason === "too-large") throw tooLargeRefusal(error, text);
    if (error.reason !== "unknown-route") throw error;
    const route = namedRoute(text);
    if (route === undefined) throw error;
    throw refusal(0, null, routeRefusalSentence(route, routeListText(MILVUS_CONSOLE, MILVUS_ROUTES, ["read"])));
  }
}

// -- phase 0 -----------------------------------------------------------------------------------------------------

/** What phase 0 needs from the connection. */
export interface MilvusRequestContext {
  /** The connection's database, or "default" when it names none; a body's dbName overrides it (E23). */
  readonly database: string;
}

export type MilvusConsistency =
  | { readonly kind: "default" }
  | { readonly kind: "level"; readonly level: "Strong" | "Bounded" | "Eventually" };

export type OutputSelection =
  | { readonly kind: "default" }
  | { readonly kind: "count" }
  | { readonly kind: "named"; readonly entries: readonly string[] };

export interface GroupingPhase0 {
  readonly field: string;
  readonly size: number | undefined;
  readonly strict: boolean | undefined;
}

interface Phase0Base {
  /** The database every call of this request names (E16). */
  readonly db: string;
  /** The keys of the body that a version gate covers (5.9). */
  readonly gatedKeys: readonly string[];
}

export interface QueryPhase0 extends Phase0Base {
  readonly op: "entities/query";
  readonly collection: string;
  readonly filter: string;
  readonly output: OutputSelection;
  readonly limit: number;
  readonly offset: number;
  readonly partitionNames: readonly string[];
  readonly templates: Readonly<Record<string, TemplateParam>>;
  readonly consistency: MilvusConsistency;
  readonly orderByFields: readonly string[];
}

export interface GetPhase0 extends Phase0Base {
  readonly op: "entities/get";
  readonly collection: string;
  /** Integers or strings as typed; their type is checked against the key in phase 1. */
  readonly ids: readonly TaggedJson[];
  readonly output: OutputSelection;
  readonly partitionNames: readonly string[];
  readonly consistency: MilvusConsistency;
}

export interface SearchParamsPhase0 {
  readonly metric: string | undefined;
  /** The validated index and range keys, in the order typed. */
  readonly params: TaggedObject | undefined;
  readonly roundDecimal: number;
}

export interface SearchPhase0 extends Phase0Base {
  readonly op: "entities/search";
  readonly collection: string;
  readonly annsField: string;
  readonly input: { readonly kind: "data" | "ids"; readonly values: readonly TaggedJson[] };
  readonly filter: string;
  readonly templates: Readonly<Record<string, TemplateParam>>;
  readonly limit: number;
  readonly offset: number;
  readonly output: OutputSelection;
  readonly searchParams: SearchParamsPhase0;
  readonly partitionNames: readonly string[];
  readonly consistency: MilvusConsistency;
  readonly grouping: GroupingPhase0 | undefined;
}

export interface SubRequestPhase0 {
  readonly annsField: string;
  readonly data: readonly TaggedJson[];
  readonly filter: string;
  readonly templates: Readonly<Record<string, TemplateParam>>;
  readonly limit: number;
  readonly params: TaggedObject | undefined;
  readonly metric: string | undefined;
}

export interface HybridPhase0 extends Phase0Base {
  readonly op: "entities/hybrid_search";
  readonly collection: string;
  readonly subRequests: readonly SubRequestPhase0[];
  readonly rerank: { readonly strategy: "rrf" | "weighted"; readonly params: TaggedObject | undefined };
  readonly limit: number;
  readonly offset: number;
  readonly output: OutputSelection;
  readonly partitionNames: readonly string[];
  readonly consistency: MilvusConsistency;
  readonly grouping: GroupingPhase0 | undefined;
}

export type MilvusPhase0 =
  | (Phase0Base & { readonly op: "databases/list" | "collections/list" | "databases/describe" })
  | (Phase0Base & {
      readonly op: "collections/describe" | "collections/get_stats" | "partitions/list" | "indexes/list";
      readonly collection: string;
    })
  | (Phase0Base & {
      readonly op: "collections/get_load_state";
      readonly collection: string;
      readonly partitionNames: readonly string[];
    })
  | (Phase0Base & { readonly op: "indexes/describe"; readonly collection: string; readonly indexName: string })
  | (Phase0Base & { readonly op: "aliases/list"; readonly collection: string | undefined })
  | (Phase0Base & { readonly op: "aliases/describe"; readonly alias: string })
  | QueryPhase0
  | GetPhase0
  | SearchPhase0
  | HybridPhase0;

/** The phase 0 rules of 5.4 and 5.6 over a parsed request; zero calls of any kind. */
export function milvusPhase0(request: ConsoleRequest<MilvusOp>, context: MilvusRequestContext): MilvusPhase0 {
  const op = request.route.op;
  const body = request.body;
  checkKeys(op, body);
  const base: Phase0Base = {
    db: body.dbName === undefined ? context.database : readName(body.dbName, "dbName"),
    gatedKeys: MILVUS_VERSION_GATED_KEYS.filter((row) => row.op === op && body[row.key] !== undefined).map(
      (row) => row.key,
    ),
  };
  switch (op) {
    case "databases/list":
    case "collections/list":
    case "databases/describe":
      return { ...base, op };
    case "collections/describe":
    case "collections/get_stats":
    case "partitions/list":
    case "indexes/list":
      return { ...base, op, collection: readName(body.collectionName, "collectionName") };
    case "collections/get_load_state":
      return {
        ...base,
        op,
        collection: readName(body.collectionName, "collectionName"),
        partitionNames: readPartitionNames(body.partitionNames),
      };
    case "indexes/describe":
      return {
        ...base,
        op,
        collection: readName(body.collectionName, "collectionName"),
        indexName: readFieldName(body.indexName, "indexName"),
      };
    case "aliases/list":
      return {
        ...base,
        op,
        collection: body.collectionName === undefined ? undefined : readName(body.collectionName, "collectionName"),
      };
    case "aliases/describe":
      return { ...base, op, alias: readName(body.aliasName, "aliasName") };
    case "entities/query":
      return queryPhase0(base, body);
    case "entities/get":
      return getPhase0(base, body);
    case "entities/search":
      return searchPhase0(base, body);
    case "entities/hybrid_search":
      return hybridPhase0(base, body);
  }
}

function readPartitionNames(value: TaggedJson | undefined): readonly string[] {
  if (value === undefined) return [];
  return readList(value, "partitionNames", MILVUS_BOUNDS.maxPartitionNames).map((name, index) =>
    readFieldName(name, `partitionNames[${index}]`),
  );
}

function readConsistency(value: TaggedJson | undefined): MilvusConsistency {
  if (value === undefined) return { kind: "default" };
  const level = readString(value, "consistencyLevel");
  if (level === "Strong" || level === "Bounded" || level === "Eventually") return { kind: "level", level };
  throw refusal(
    0,
    "consistencyLevel",
    own(MILVUS_REFUSED_CONSISTENCY, level) ??
      `consistencyLevel takes ${MILVUS_CONSISTENCY_LEVELS.join(", ")}, not ${shown(level)}.`,
  );
}

const COUNT_STAR = "count(*)";
const COUNT_TAKES_NO_PAGE =
  "A count takes no limit or offset: Milvus refuses a count with a limit (count entities with pagination is not allowed) and ignores an offset alone.";

/** outputFields in phase 0: the lone-count rule, server aggregation and the bracket form (5.4, R40 M23). */
function readOutput(value: TaggedJson | undefined, countAllowed: boolean): OutputSelection {
  if (value === undefined) return { kind: "default" };
  const entries = readList(value, "outputFields", MILVUS_BOUNDS.maxOutputFields).map((entry, index) =>
    readFieldName(entry, `outputFields[${index}]`),
  );
  if (entries.length === 0) {
    throw refusal(0, "outputFields", "outputFields is empty: leave it out for the default columns, or name fields.");
  }
  const isCount = (entry: string) => entry.trim().toLowerCase() === COUNT_STAR;
  if (entries.some(isCount)) {
    if (!countAllowed) throw refusal(0, "outputFields", "count(*) is read through entities/query only.");
    const other = entries.find((entry) => !isCount(entry));
    if (other !== undefined || entries.length > 1) {
      throw refusal(
        0,
        "outputFields",
        `count(*) is read alone, and this request also names ${shown(other ?? COUNT_STAR)}.`,
      );
    }
    return { kind: "count" };
  }
  for (const entry of entries) {
    const bracket = /^\$meta\["(.*)"\]$/.exec(entry);
    if (bracket !== null) {
      throw refusal(
        0,
        "outputFields",
        `${shown(entry)}: name the dynamic key bare, as ${shown(bracket[1])}, or name $meta for every dynamic key.`,
      );
    }
    if (entry.includes("(")) {
      throw refusal(
        0,
        "outputFields",
        `${shown(entry)} is a server aggregation, which Studio does not run: only a lone count(*) is read.`,
      );
    }
  }
  return { kind: "named", entries };
}

/** limit: absent is 100, 0 is refused, because REST reads 0 as every row (5.4, R03 F9). */
function readLimit(value: TaggedJson | undefined, key: string, max: number): number {
  if (value === undefined) return MILVUS_BOUNDS.defaultLimit;
  if (value !== null && isTaggedInt(value) && toJsonText(value) === "0") {
    throw refusal(0, key, `${key} 0 would read every row in REST; Studio takes 1 to ${max}.`);
  }
  return readInteger(value, key, 1, max);
}

function readOffset(value: TaggedJson | undefined, key: string): number {
  return value === undefined ? 0 : readInteger(value, key, 0, MILVUS_BOUNDS.queryWindow);
}

function readFilter(value: TaggedJson | undefined, key: string): string {
  return value === undefined ? "" : readString(value, key);
}

/** The sum of every filter of one request, which a cancel does not stop the server parsing (5.6, R42 F2). */
function checkFilterBytes(filters: readonly string[]): void {
  const bytes = filters.reduce((total, filter) => total + utf8ByteLength(filter), 0);
  if (bytes > MILVUS_BOUNDS.maxFilterBytes) {
    throw refusal(
      0,
      "filter",
      `The filters of this request are ${bytes} bytes; Studio sends at most 65,536 bytes of filter text in one request, because Milvus keeps parsing a filter after a cancel.`,
    );
  }
}

const RESERVED_TEMPLATE_NAMES = ["constructor", "prototype", "__proto__"];

/** exprParams: at most 32 identifier keys, each a scalar or a list of at most 1,000 scalars (5.4, E12). */
function readTemplates(value: TaggedJson | undefined, key: string): Readonly<Record<string, TemplateParam>> {
  const templates: Record<string, TemplateParam> = Object.create(null);
  if (value === undefined) return templates;
  const object = readObject(value, key);
  const names = Object.keys(object);
  if (names.length > MILVUS_BOUNDS.maxExprParamKeys) {
    throw refusal(0, key, `${key} holds ${names.length} values; Studio sends at most 32.`);
  }
  for (const name of names) {
    const path = `${key}.${name}`;
    if (RESERVED_TEMPLATE_NAMES.includes(name)) throw refusal(0, path, `${name} cannot name a template value.`);
    if (!FILTER_IDENTIFIER.test(name)) {
      throw refusal(0, path, `${shown(name)} cannot name a template value: a template name is an identifier.`);
    }
    templates[name] = readTemplateParam(object[name], path);
  }
  return templates;
}

type TemplateScalar = Extract<TemplateParam, { readonly kind: "bool" | "int64" | "double" | "string" }>;

function readTemplateScalar(value: TaggedJson | undefined, key: string): TemplateScalar {
  if (typeof value === "boolean") return { kind: "bool", value };
  if (typeof value === "string") return { kind: "string", value };
  if (value !== undefined && value !== null && isTaggedInt(value)) {
    const digits = checkIntRange(value, "int64") ? int64Digits(toJsonText(value)) : undefined;
    if (digits === undefined) {
      throw refusal(0, key, `${key} is outside the Int64 range or not written as plain digits.`);
    }
    return { kind: "int64", digits };
  }
  if (value !== undefined && value !== null && isTaggedFloat(value))
    return { kind: "double", value: readNumber(value, key) };
  throw refusal(0, key, `${key} takes a string, a number, true or false, or a list of them.`);
}

function readTemplateParam(value: TaggedJson | undefined, key: string): TemplateParam {
  if (!isList(value)) return readTemplateScalar(value, key);
  const items = readList(value, key, MILVUS_BOUNDS.maxExprParamArray).map((item, index) =>
    readTemplateScalar(item, `${key}[${index}]`),
  );
  if (items.length === 0) throw refusal(0, key, `${key} is an empty list, which has no element type to send.`);
  const bools = items.flatMap((item) => (item.kind === "bool" ? [item.value] : []));
  const digits = items.flatMap((item) => (item.kind === "int64" ? [item.digits] : []));
  const doubles = items.flatMap((item) => (item.kind === "double" ? [item.value] : []));
  const strings = items.flatMap((item) => (item.kind === "string" ? [item.value] : []));
  if (bools.length === items.length) return { kind: "bool-array", values: bools };
  if (digits.length === items.length) return { kind: "int64-array", values: digits };
  if (doubles.length === items.length) return { kind: "double-array", values: doubles };
  if (strings.length === items.length) return { kind: "string-array", values: strings };
  if (digits.length + doubles.length === items.length) {
    if (!digits.every((text) => Number.isSafeInteger(Number(text)))) {
      throw refusal(0, key, `${key} mixes fractions with an integer beyond 2^53, which no double holds exactly.`);
    }
    return {
      kind: "double-array",
      values: items.map((item) => (item.kind === "int64" ? Number(item.digits) : (item as { value: number }).value)),
    };
  }
  throw refusal(0, key, `${key} mixes value types: a template list holds one type.`);
}

const ORDER_BY = /^[A-Za-z_][A-Za-z0-9_]{0,254}(?::(?:asc|desc))?$/;

function queryPhase0(base: Phase0Base, body: TaggedObject): QueryPhase0 {
  const output = readOutput(body.outputFields, true);
  if (output.kind === "count") {
    if (body.limit !== undefined) throw refusal(0, "limit", COUNT_TAKES_NO_PAGE);
    if (body.offset !== undefined) throw refusal(0, "offset", COUNT_TAKES_NO_PAGE);
  }
  const limit = readLimit(body.limit, "limit", MILVUS_BOUNDS.maxRows);
  const offset = readOffset(body.offset, "offset");
  if (output.kind !== "count" && offset + limit > MILVUS_BOUNDS.queryWindow) {
    throw refusal(
      0,
      "offset",
      `offset plus limit is ${offset + limit}; Milvus reads at most 16,384 rows deep, so Studio refuses past it.`,
    );
  }
  const filter = readFilter(body.filter, "filter");
  checkFilterBytes([filter]);
  const orderByFields =
    body.orderByFields === undefined
      ? []
      : readList(body.orderByFields, "orderByFields", MILVUS_BOUNDS.maxOutputFields).map((entry, index) => {
          const text = readString(entry, `orderByFields[${index}]`);
          if (!ORDER_BY.test(text)) {
            throw refusal(
              0,
              `orderByFields[${index}]`,
              `orderByFields[${index}] ${shown(text)}: write a field name, optionally followed by :asc or :desc.`,
            );
          }
          return text;
        });
  return {
    ...base,
    op: "entities/query",
    collection: readName(body.collectionName, "collectionName"),
    filter,
    output,
    limit,
    offset,
    partitionNames: readPartitionNames(body.partitionNames),
    templates: readTemplates(body.exprParams, "exprParams"),
    consistency: readConsistency(body.consistencyLevel),
    orderByFields,
  };
}

function readIdList(value: TaggedJson | undefined, key: string, max: number): readonly TaggedJson[] {
  const ids = isList(value) ? value : [value as TaggedJson];
  if (ids.length === 0) throw refusal(0, key, `${key} names no entity: give one id or a list of ids.`);
  if (ids.length > max) throw refusal(0, key, `${key} names ${ids.length} ids; Studio sends at most ${max}.`);
  ids.forEach((id, index) => {
    if (typeof id !== "string" && !(id !== null && isTaggedInt(id))) {
      throw refusal(0, `${key}[${index}]`, `${key} takes integers or strings, as the primary key is typed.`);
    }
  });
  return ids;
}

function getPhase0(base: Phase0Base, body: TaggedObject): GetPhase0 {
  return {
    ...base,
    op: "entities/get",
    collection: readName(body.collectionName, "collectionName"),
    ids: readIdList(body.id, "id", MILVUS_BOUNDS.maxGetIds),
    output: readOutput(body.outputFields, false),
    partitionNames: readPartitionNames(body.partitionNames),
    consistency: readConsistency(body.consistencyLevel),
  };
}

/** The version gates of 5.9 on the server, where the version read at connect is held; still zero calls (3.9). */
export function milvusVersionGates(
  request: MilvusPhase0,
  refusalFor: (gate: MilvusVersionGate) => string | undefined,
): void {
  for (const row of MILVUS_VERSION_GATED_KEYS) {
    if (row.op !== request.op || !request.gatedKeys.includes(row.key)) continue;
    const sentence = refusalFor(row.gate);
    if (sentence !== undefined) throw refusal(0, row.key, sentence);
  }
}

/** The metadata phase 1 reads: one DescribeCollection per entities request, one DescribeIndex where 3.9 says. */
export interface MilvusMetadataReads {
  readonly describeCollection: boolean;
  readonly describeIndex: boolean;
}

export function milvusMetadataReads(request: MilvusPhase0): MilvusMetadataReads {
  switch (request.op) {
    case "entities/query":
    case "entities/get":
      return { describeCollection: true, describeIndex: false };
    case "entities/search":
      return { describeCollection: true, describeIndex: true };
    case "entities/hybrid_search":
      return {
        describeCollection: true,
        describeIndex: request.subRequests.some((sub) => sub.params !== undefined || sub.metric !== undefined),
      };
    default:
      return { describeCollection: false, describeIndex: false };
  }
}

/** `data` in phase 0: a list of query vectors, each a list, a string or an index map with no reserved key. */
function readData(value: TaggedJson | undefined, key: string): readonly TaggedJson[] {
  const data = readList(value, key, MILVUS_BOUNDS.maxNq);
  if (data.length === 0) throw refusal(0, key, `${key} holds no query vector.`);
  data.forEach((item, index) => {
    if (isObject(item)) {
      for (const name of Object.keys(item)) {
        if (RESERVED_TEMPLATE_NAMES.includes(name)) {
          throw refusal(0, `${key}[${index}].${name}`, `${name} cannot be a key of a sparse vector.`);
        }
      }
    } else if (!isList(item) && typeof item !== "string") {
      throw refusal(0, `${key}[${index}]`, `${key}[${index}] takes a vector: a list of numbers, an index map or text.`);
    }
  });
  return data;
}

function readGrouping(body: TaggedObject): GroupingPhase0 | undefined {
  if (body.groupingField === undefined) {
    for (const key of ["groupSize", "strictGroupSize"]) {
      if (body[key] !== undefined) {
        throw refusal(0, key, `${key} needs groupingField: without it Milvus ignores ${key}.`);
      }
    }
    return undefined;
  }
  return {
    field: readFieldName(body.groupingField, "groupingField"),
    size:
      body.groupSize === undefined
        ? undefined
        : readInteger(body.groupSize, "groupSize", 1, MILVUS_BOUNDS.maxGroupSize),
    strict: body.strictGroupSize === undefined ? undefined : readBoolean(body.strictGroupSize, "strictGroupSize"),
  };
}

/** A search parameter object (`searchParams.params`, a sub-request's `params`) against 5.6's table. */
function readIndexParams(value: TaggedJson | undefined, key: string, k: number): TaggedObject | undefined {
  if (value === undefined) return undefined;
  const params = readObject(value, key);
  for (const name of Object.keys(params)) {
    const path = `${key}.${name}`;
    const rule = own(MILVUS_SEARCH_PARAMETERS, name);
    if (rule === undefined) {
      throw refusal(
        0,
        path,
        `${shown(name)} is not a search parameter Studio sends; it sends ${Object.keys(MILVUS_SEARCH_PARAMETERS).join(", ")}, each to the index types that take it.`,
      );
    }
    if (rule.kind === "integer") {
      const number = readInteger(params[name], path, rule.min, rule.max);
      if (rule.atLeastK === true && number < k) {
        throw refusal(
          0,
          path,
          `${path} is ${number}, below the ${k} results this search asks for: Milvus needs ${name} at least offset plus limit.`,
        );
      }
    } else if (rule.kind === "number") {
      const number = readNumber(params[name], path);
      const compared = rule.float32 ? Math.fround(number) : number;
      const aboveMax = rule.maxExclusive === true ? compared >= rule.max : compared > rule.max;
      if (compared < rule.min || aboveMax) {
        const upper = rule.maxExclusive === true ? `below ${rule.max}` : `at most ${rule.max}`;
        throw refusal(
          0,
          path,
          `${path} is ${number}${compared === number ? "" : `, ${compared} as Milvus stores it`}; it must be at least ${rule.min} and ${upper}.`,
        );
      }
    } else {
      readNumber(params[name], path);
    }
  }
  if (params.range_filter !== undefined && params.radius === undefined) {
    throw refusal(0, `${key}.range_filter`, "range_filter needs radius: it bounds a range search that radius opens.");
  }
  return params;
}

function readSearchParams(value: TaggedJson | undefined, k: number): SearchParamsPhase0 {
  if (value === undefined) return { metric: undefined, params: undefined, roundDecimal: -1 };
  const object = readObject(value, "searchParams");
  refuseEndpointKeys(object, "searchParams");
  for (const name of Object.keys(object)) {
    if (!MILVUS_SEARCH_PARAMS_KEYS.includes(name)) {
      throw refusal(
        0,
        `searchParams.${name}`,
        unknownKeySentence("searchParams", shown(name), MILVUS_SEARCH_PARAMS_KEYS),
      );
    }
  }
  return {
    metric:
      object.metric_type === undefined ? undefined : readFieldName(object.metric_type, "searchParams.metric_type"),
    params: readIndexParams(object.params, "searchParams.params", k),
    roundDecimal:
      object.round_decimal === undefined ? -1 : readInteger(object.round_decimal, "searchParams.round_decimal", -1, 6),
  };
}

/** nq times the window times the group size: the server's candidate work and its answer, one bound (5.6, E28). */
function checkSearchEntries(nq: number, window: number, grouping: GroupingPhase0 | undefined, words: string): void {
  const group = grouping?.size ?? 1;
  const entries = nq * window * group;
  if (entries > MILVUS_BOUNDS.maxSearchEntries) {
    throw refusal(
      0,
      "limit",
      `This search asks Milvus for ${nq} times ${words} times ${group} = ${entries} results; Studio's bound is 10,240 (nq, times ${words}, times groupSize).`,
    );
  }
}

function searchPhase0(base: Phase0Base, body: TaggedObject): SearchPhase0 {
  if ((body.data === undefined) === (body.ids === undefined)) {
    throw refusal(
      0,
      "data",
      "entities/search takes data or ids, exactly one: data searches by vectors, ids by the stored vectors of those rows.",
    );
  }
  const input =
    body.data !== undefined
      ? { kind: "data" as const, values: readData(body.data, "data") }
      : { kind: "ids" as const, values: readIdList(body.ids, "ids", MILVUS_BOUNDS.maxSearchIds) };
  const limit = readLimit(body.limit, "limit", MILVUS_BOUNDS.maxTopK);
  const offset = readOffset(body.offset, "offset");
  const grouping = readGrouping(body);
  checkSearchEntries(input.values.length, offset + limit, grouping, "(offset plus limit)");
  const filter = readFilter(body.filter, "filter");
  checkFilterBytes([filter]);
  return {
    ...base,
    op: "entities/search",
    collection: readName(body.collectionName, "collectionName"),
    annsField: readFieldName(body.annsField, "annsField"),
    input,
    filter,
    templates: readTemplates(body.exprParams, "exprParams"),
    limit,
    offset,
    output: readOutput(body.outputFields, false),
    searchParams: readSearchParams(body.searchParams, offset + limit),
    partitionNames: readPartitionNames(body.partitionNames),
    consistency: readConsistency(body.consistencyLevel),
    grouping,
  };
}

function readSubRequest(value: TaggedJson, index: number): SubRequestPhase0 {
  const key = `search[${index}]`;
  const sub = readObject(value, key);
  for (const name of Object.keys(sub)) {
    if (MILVUS_SUB_REQUEST_KEYS.includes(name)) continue;
    const reason = own(MILVUS_SUB_REQUEST_REFUSALS, name);
    throw refusal(0, `${key}.${name}`, reason ?? unknownKeySentence(key, shown(name), MILVUS_SUB_REQUEST_KEYS));
  }
  if (sub.annsField === undefined) throw refusal(0, `${key}.annsField`, `${key} needs annsField.`);
  if (sub.data === undefined) throw refusal(0, `${key}.data`, `${key} needs data.`);
  if (sub.params !== undefined) refuseEndpointKeys(sub.params, `${key}.params`);
  const limit = readLimit(sub.limit, `${key}.limit`, MILVUS_BOUNDS.maxTopK);
  return {
    annsField: readFieldName(sub.annsField, `${key}.annsField`),
    data: readData(sub.data, `${key}.data`),
    filter: readFilter(sub.filter, `${key}.filter`),
    templates: readTemplates(sub.exprParams, `${key}.exprParams`),
    limit,
    params: readIndexParams(sub.params, `${key}.params`, limit),
    metric: sub.metricType === undefined ? undefined : readFieldName(sub.metricType, `${key}.metricType`),
  };
}

/** rerank: rrf with k, or weighted with one weight per sub-request, and nothing else (E35). */
function readRerank(value: TaggedJson | undefined, subRequests: number): HybridPhase0["rerank"] {
  const rerank = readObject(value, "rerank");
  if (rerank.params !== undefined) refuseEndpointKeys(rerank.params, "rerank.params");
  for (const name of Object.keys(rerank)) {
    if (name !== "strategy" && name !== "params") {
      throw refusal(0, `rerank.${name}`, unknownKeySentence("rerank", shown(name), ["strategy", "params"]));
    }
  }
  const strategy = readString(rerank.strategy, "rerank.strategy");
  if (strategy !== "rrf" && strategy !== "weighted") {
    throw refusal(
      0,
      "rerank.strategy",
      `rerank.strategy takes rrf or weighted, and ${shown(strategy)} is refused before the request: Studio sends no other ranker.`,
    );
  }
  if (rerank.params === undefined) {
    if (strategy === "weighted")
      throw refusal(0, "rerank.params", "weighted needs params.weights, one per sub-request.");
    return { strategy, params: undefined };
  }
  const params = readObject(rerank.params, "rerank.params");
  const expected = MILVUS_RERANK_PARAMS[strategy];
  for (const name of Object.keys(params)) {
    if (name === expected) continue;
    if (name === "norm_score") throw refusal(0, "rerank.params.norm_score", NORM_SCORE_REFUSAL);
    throw refusal(0, `rerank.params.${name}`, unknownKeySentence(`rerank ${strategy}`, shown(name), [expected]));
  }
  if (strategy === "rrf") {
    if (params.k !== undefined) {
      const k = readNumber(params.k, "rerank.params.k");
      if (!(k > 0 && k < MILVUS_BOUNDS.maxRrfK)) {
        throw refusal(0, "rerank.params.k", `rerank.params.k is ${k}; Milvus takes a k above 0 and below 16384.`);
      }
    }
    return { strategy, params };
  }
  const weights = readList(params.weights, "rerank.params.weights", MILVUS_BOUNDS.maxSubRequests);
  if (weights.length !== subRequests) {
    throw refusal(
      0,
      "rerank.params.weights",
      `rerank.params.weights holds ${weights.length} weights for ${subRequests} sub-requests: give one per sub-request.`,
    );
  }
  weights.forEach((weight, index) => {
    const number = readNumber(weight, `rerank.params.weights[${index}]`);
    if (number < 0 || number > 1) {
      throw refusal(
        0,
        `rerank.params.weights[${index}]`,
        `rerank.params.weights[${index}] is ${number}; a weight is 0 to 1.`,
      );
    }
  });
  return { strategy, params };
}

function hybridPhase0(base: Phase0Base, body: TaggedObject): HybridPhase0 {
  const list = readList(body.search, "search", MILVUS_BOUNDS.maxSubRequests);
  if (list.length === 0) throw refusal(0, "search", "search holds no sub-request.");
  const subRequests = list.map((item, index) => readSubRequest(item, index));
  const nq = subRequests[0].data.length;
  subRequests.forEach((sub, index) => {
    if (sub.data.length !== nq) {
      throw refusal(
        0,
        `search[${index}].data`,
        `search[0] holds ${nq} query vectors and search[${index}] holds ${sub.data.length}: Milvus needs the same number in every sub-request.`,
      );
    }
  });
  const rerank = readRerank(body.rerank, subRequests.length);
  const limit = readLimit(body.limit, "limit", MILVUS_BOUNDS.maxTopK);
  const offset = readOffset(body.offset, "offset");
  const grouping = readGrouping(body);
  const window = subRequests.reduce((total, sub) => total + sub.limit, 0) + offset + limit;
  checkSearchEntries(nq, window, grouping, "(the sub-request limits plus offset plus limit)");
  checkFilterBytes(subRequests.map((sub) => sub.filter));
  return {
    ...base,
    op: "entities/hybrid_search",
    collection: readName(body.collectionName, "collectionName"),
    subRequests,
    rerank,
    limit,
    offset,
    output: readOutput(body.outputFields, false),
    partitionNames: readPartitionNames(body.partitionNames),
    consistency: readConsistency(body.consistencyLevel),
    grouping,
  };
}

// -- phase 1 and lowering ----------------------------------------------------------------------------------------

/** How the DescribeIndex of a search was read: answered, refused for want of IndexDetail, or not read. */
export type IndexReading =
  | { readonly kind: "read"; readonly response: DescribeIndexResponse }
  | { readonly kind: "unreadable" }
  | { readonly kind: "not-read" };

export interface MilvusPhase1Reads {
  /** The DescribeCollection fetched for this request, never a cache (E12). */
  readonly collection?: DescribeCollectionResponse;
  readonly index: IndexReading;
}

/** Where the score column's meaning comes from (3.3, 5.5). */
export type ScoreSource =
  | { readonly kind: "metric"; readonly metric: string }
  | { readonly kind: "fused"; readonly strategy: "rrf" | "weighted" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unreported" };

/** What results.ts needs to turn a query or get answer into rows. */
export interface RowShape {
  readonly schema: WireCollectionSchema;
  readonly limit: number;
  readonly offset: number;
}

/** What results.ts needs to turn a search answer into rows. */
export interface SearchShape {
  readonly schema: WireCollectionSchema;
  readonly nq: number;
  readonly limit: number;
  readonly offset: number;
  readonly score: ScoreSource;
  readonly groupingField: WireFieldSchema | undefined;
}

/** One console request, lowered: the client call it makes and what its answer needs. */
export type MilvusOperation =
  | { readonly kind: "listDatabases"; readonly db: string }
  | { readonly kind: "describeDatabase"; readonly db: string; readonly request: DescribeDatabaseRequest }
  | { readonly kind: "showCollections"; readonly db: string }
  | { readonly kind: "describeCollection"; readonly db: string; readonly request: DescribeCollectionRequest }
  | {
      readonly kind: "getCollectionStatistics";
      readonly db: string;
      readonly request: GetCollectionStatisticsRequest;
    }
  | { readonly kind: "getLoadState"; readonly db: string; readonly request: GetLoadStateRequest }
  | { readonly kind: "showPartitions"; readonly db: string; readonly request: ShowPartitionsRequest }
  | { readonly kind: "describeIndex"; readonly db: string; readonly request: DescribeIndexRequest }
  | { readonly kind: "listAliases"; readonly db: string; readonly request: ListAliasesRequest }
  | { readonly kind: "describeAlias"; readonly db: string; readonly request: DescribeAliasRequest }
  | { readonly kind: "query"; readonly db: string; readonly request: QueryRequest; readonly shape: RowShape }
  | { readonly kind: "count"; readonly db: string; readonly request: QueryRequest }
  | { readonly kind: "search"; readonly db: string; readonly request: SearchRequest; readonly shape: SearchShape }
  | {
      readonly kind: "hybridSearch";
      readonly db: string;
      readonly request: HybridSearchRequest;
      readonly shape: SearchShape;
    };

const VECTOR_TYPES: readonly string[] = [
  "FloatVector",
  "Float16Vector",
  "BFloat16Vector",
  "Int8Vector",
  "BinaryVector",
  "SparseFloatVector",
  "ArrayOfVector",
];

function isVectorType(dataType: string): boolean {
  return VECTOR_TYPES.includes(dataType);
}

const DENSE_DTYPES: Readonly<Record<string, VectorDType>> = {
  FloatVector: "float32",
  Float16Vector: "float16",
  BFloat16Vector: "bfloat16",
  Int8Vector: "int8",
  BinaryVector: "binary",
};

function typeParam(field: WireFieldSchema, key: string): string | undefined {
  return field.type_params.find((pair) => pair.key === key)?.value;
}

function describedDimension(field: WireFieldSchema): number | null {
  const text = typeParam(field, "dim");
  return text !== undefined && /^[0-9]+$/.test(text) ? Number(text) : null;
}

/**
 * The vector target a described field declares, or undefined for a field that is not a vector: the dtype is the
 * value domain Studio reads and checks, the dimension the declared one (bits for a binary vector).
 */
export function vectorTargetOf(field: WireFieldSchema): VectorTarget | undefined {
  if (field.data_type === "SparseFloatVector") {
    return { name: field.name, kind: "sparse", dtype: "float32", dimension: null };
  }
  if (field.data_type === "ArrayOfVector") {
    return { name: field.name, kind: "multi", dtype: "float32", dimension: describedDimension(field) };
  }
  const dtype = own(DENSE_DTYPES, field.data_type);
  return dtype === undefined
    ? undefined
    : { name: field.name, kind: "dense", dtype, dimension: describedDimension(field) };
}

/** A described dimension outside the default server maximum is refused before it drives a check (5.6, R43 M10). */
function checkDescribedDimension(target: VectorTarget, key: string): void {
  const dimension = target.dimension;
  if (target.kind === "sparse") return;
  const binary = target.dtype === "binary";
  const valid =
    dimension !== null &&
    (binary
      ? dimension % 8 === 0 && dimension >= 8 && dimension <= MILVUS_BOUNDS.maxBinaryDimension
      : dimension >= MILVUS_BOUNDS.minDenseDimension && dimension <= MILVUS_BOUNDS.maxDenseDimension);
  if (!valid) {
    const range = binary ? "a multiple of 8 from 8 to 262,144 bits" : "2 to 32,768";
    throw refusal(
      1,
      key,
      `${target.name} declares the dimension ${dimension ?? "none"}, outside the default server maximum (${range}), so Studio does not search it.`,
    );
  }
}

function schemaOf(reads: MilvusPhase1Reads): WireCollectionSchema {
  const schema = reads.collection?.schema;
  if (schema === undefined || schema === null) {
    throw new TypeError("Phase 1 of an entities route needs the DescribeCollection answer fetched for it");
  }
  return schema;
}

/** Every name a projection can resolve: fields, struct arrays, and $meta whenever dynamic fields are enabled. */
function declaredNames(schema: WireCollectionSchema): ReadonlySet<string> {
  return new Set([
    ...schema.fields.map((field) => field.name),
    ...schema.struct_array_fields.map((field) => field.name),
    ...(schema.enable_dynamic_field ? ["$meta"] : []),
  ]);
}

/** outputFields after phase 1: the three projection rules of 5.4, or the default list of 5.4. */
function projectOutput(output: OutputSelection, schema: WireCollectionSchema, collection: string): string[] {
  if (output.kind === "default") {
    return [
      ...new Set([
        ...schema.fields.filter((field) => !isVectorType(field.data_type)).map((field) => field.name),
        ...(schema.enable_dynamic_field ? ["$meta"] : []),
      ]),
    ];
  }
  if (output.kind === "count") return [COUNT_STAR];
  const names = declaredNames(schema);
  return output.entries.map((entry) => {
    if (entry === "*" || names.has(entry)) return entry;
    if (!schema.enable_dynamic_field) {
      throw refusal(
        1,
        "outputFields",
        `${shown(entry)} is not a field of ${collection}, and ${collection} has no dynamic field.`,
      );
    }
    if (!FILTER_IDENTIFIER.test(entry)) {
      throw refusal(
        1,
        "outputFields",
        `${shown(entry)} is not a field of ${collection} and cannot be named as a dynamic key: name $meta to read every dynamic key.`,
      );
    }
    return entry;
  });
}

function primaryKeyOf(schema: WireCollectionSchema): WireFieldSchema {
  const key = schema.fields.find((field) => field.is_primary_key);
  if (key === undefined) throw new TypeError("A described collection has no primary key field");
  return key;
}

/** Ids typed by the freshly described key (E12, 5.4): Int64 digits under E12's rule, VarChar strings only. */
function typedIds(ids: readonly TaggedJson[], key: WireFieldSchema, path: string, refuseDuplicates: boolean): TypedIds {
  if (key.data_type === "Int64") {
    const values = ids.map((id, index) => {
      const digits =
        typeof id === "string"
          ? int64Digits(id)
          : id !== null && isTaggedInt(id) && checkIntRange(id, "int64")
            ? int64Digits(toJsonText(id))
            : undefined;
      if (digits === undefined) {
        throw refusal(
          1,
          `${path}[${index}]`,
          `${path}[${index}] is not an Int64 written as plain digits, and the primary key ${key.name} is Int64.`,
        );
      }
      return digits;
    });
    checkDuplicates(values, path, refuseDuplicates);
    return { kind: "int64", values };
  }
  const values = ids.map((id, index) => {
    if (typeof id !== "string") {
      throw refusal(1, `${path}[${index}]`, `The primary key ${key.name} is ${key.data_type}: give ids as strings.`);
    }
    return id;
  });
  checkDuplicates(values, path, refuseDuplicates);
  return { kind: "string", values };
}

function checkDuplicates(values: readonly string[], path: string, refuse: boolean): void {
  if (!refuse) return;
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw refusal(1, path, `${path} names ${shown(value)} twice.`);
    seen.add(value);
  }
}

/** partitionNames on a partition-key collection: Milvus refuses them with code 1100 (R42 M15). */
function checkPartitionKey(schema: WireCollectionSchema, partitionNames: readonly string[], collection: string): void {
  const key = schema.fields.find((field) => field.is_partition_key);
  if (key !== undefined && partitionNames.length > 0) {
    throw refusal(
      1,
      "partitionNames",
      `${collection} is partitioned by its key field ${key.name}, so Milvus refuses partitionNames: filter on ${key.name} instead.`,
    );
  }
}

function consistencyFields(consistency: MilvusConsistency): {
  readonly consistency_level?: string;
  readonly use_default_consistency: boolean;
} {
  return consistency.kind === "default"
    ? { use_default_consistency: true }
    : { consistency_level: consistency.level, use_default_consistency: false };
}

function partitionFields(partitionNames: readonly string[]): { readonly partition_names?: readonly string[] } {
  return partitionNames.length === 0 ? {} : { partition_names: partitionNames };
}

function templateFields(
  templates: Readonly<Record<string, TemplateParam>>,
): Pick<QueryRequest, "expr_template_values"> {
  return Object.keys(templates).length === 0 ? {} : { expr_template_values: templateValues(templates) };
}

function pair(key: string, value: string): WireKeyValuePair {
  return { key, value };
}

/** Phase 1 and the lowering of 5.4: the request a client call sends, with what its answer needs. */
export function milvusPhase1(request: MilvusPhase0, reads: MilvusPhase1Reads): MilvusOperation {
  const db = request.db;
  switch (request.op) {
    case "databases/list":
      return { kind: "listDatabases", db };
    case "databases/describe":
      return { kind: "describeDatabase", db, request: {} };
    case "collections/list":
      return { kind: "showCollections", db };
    case "collections/describe":
      return { kind: "describeCollection", db, request: { collection_name: request.collection } };
    case "collections/get_stats":
      return { kind: "getCollectionStatistics", db, request: { collection_name: request.collection } };
    case "collections/get_load_state":
      return {
        kind: "getLoadState",
        db,
        request: { collection_name: request.collection, ...partitionFields(request.partitionNames) },
      };
    case "partitions/list":
      return { kind: "showPartitions", db, request: { collection_name: request.collection } };
    case "indexes/list":
      return { kind: "describeIndex", db, request: { collection_name: request.collection } };
    case "indexes/describe":
      return {
        kind: "describeIndex",
        db,
        request: { collection_name: request.collection, index_name: request.indexName },
      };
    case "aliases/list":
      return {
        kind: "listAliases",
        db,
        request: request.collection === undefined ? {} : { collection_name: request.collection },
      };
    case "aliases/describe":
      return { kind: "describeAlias", db, request: { alias: request.alias } };
    case "entities/query":
      return lowerQuery(request, schemaOf(reads));
    case "entities/get":
      return lowerGet(request, schemaOf(reads));
    case "entities/search":
      return lowerSearch(request, schemaOf(reads), reads.index);
    case "entities/hybrid_search":
      return lowerHybrid(request, schemaOf(reads), reads.index);
  }
}

function lowerQuery(request: QueryPhase0, schema: WireCollectionSchema): MilvusOperation {
  checkPartitionKey(schema, request.partitionNames, request.collection);
  const common = {
    collection_name: request.collection,
    expr: request.filter,
    ...partitionFields(request.partitionNames),
    ...consistencyFields(request.consistency),
    ...templateFields(request.templates),
  };
  if (request.output.kind === "count") {
    // The canonical spelling, with no limit and no offset (R40 F14, M23).
    return { kind: "count", db: request.db, request: { ...common, output_fields: [COUNT_STAR], query_params: [] } };
  }
  const queryParams = [pair("limit", String(request.limit)), pair("offset", String(request.offset))];
  if (request.orderByFields.length > 0) queryParams.push(pair("order_by_fields", request.orderByFields.join(",")));
  return {
    kind: "query",
    db: request.db,
    request: {
      ...common,
      output_fields: projectOutput(request.output, schema, request.collection),
      query_params: queryParams,
    },
    shape: { schema, limit: request.limit, offset: request.offset },
  };
}

function lowerGet(request: GetPhase0, schema: WireCollectionSchema): MilvusOperation {
  checkPartitionKey(schema, request.partitionNames, request.collection);
  const key = primaryKeyOf(schema);
  if (!FILTER_IDENTIFIER.test(key.name)) {
    throw refusal(
      1,
      "id",
      `The primary key ${shown(key.name)} cannot be written in a filter, so Studio cannot get by it.`,
    );
  }
  const filter = idsFilter(key.name, typedIds(request.ids, key, "id", false));
  return {
    kind: "query",
    db: request.db,
    request: {
      collection_name: request.collection,
      expr: filter.expr,
      expr_template_values: filter.values,
      output_fields: projectOutput(request.output, schema, request.collection),
      ...partitionFields(request.partitionNames),
      ...consistencyFields(request.consistency),
      query_params: [pair("limit", String(MILVUS_BOUNDS.maxRows))],
    },
    shape: { schema, limit: request.ids.length, offset: 0 },
  };
}

/** The vector field a search names: a declared vector field, or `<struct>[<field>]` of an embedding list (5.4). */
function annsTarget(schema: WireCollectionSchema, annsField: string, key: string, collection: string) {
  const declared = schema.fields.find((field) => field.name === annsField);
  const element = /^(.+)\[(.+)\]$/.exec(annsField);
  const field =
    declared ??
    (element === null
      ? undefined
      : schema.struct_array_fields
          .find((struct) => struct.name === element[1])
          ?.fields.find((sub) => sub.name === element[2] || sub.name === annsField));
  const target = field === undefined ? undefined : vectorTargetOf(field);
  if (field === undefined || target === undefined) {
    throw refusal(1, key, `${shown(annsField)} is not a vector field of ${collection}.`);
  }
  if (field.data_type === "ArrayOfVector" && field.element_type !== "FloatVector") {
    throw refusal(
      1,
      key,
      `${annsField} is an embedding list of ${field.element_type}; Studio searches one of FloatVector only.`,
    );
  }
  checkDescribedDimension(target, key);
  return { field, target };
}

/** The function that produces a field, if any (5.4: text query data). */
function producingFunction(schema: WireCollectionSchema, field: WireFieldSchema): string | undefined {
  return schema.functions.find((fn) => fn.output_field_names.includes(field.name))?.type;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function numbersOf(target: VectorTarget, values: readonly TaggedJson[], path: string): readonly number[] {
  const numbers = vectorNumbers(target, values);
  if ("sentence" in numbers) throw refusal(1, path, numbers.sentence);
  const refused = checkDenseElements(target, numbers);
  if (refused !== null) throw refusal(1, path, refused.sentence);
  return numbers;
}

/** The query vectors of `data`, checked in the field's dtype against the fresh describe, as placeholder bytes. */
function placeholderOf(
  data: readonly TaggedJson[],
  field: WireFieldSchema,
  target: VectorTarget,
  schema: WireCollectionSchema,
  key: string,
): Uint8Array {
  let type: MilvusPlaceholderType | undefined;
  const values = data.map((item, index) => {
    const path = `${key}[${index}]`;
    const [itemType, bytes] = encodeItem(item, field, target, schema, path);
    if (type !== undefined && type !== itemType) {
      throw refusal(1, key, `${key} mixes kinds of query: every element searches ${field.name} the same way.`);
    }
    type = itemType;
    return bytes;
  });
  return encodePlaceholderGroup(type as MilvusPlaceholderType, values);
}

function encodeItem(
  item: TaggedJson,
  field: WireFieldSchema,
  target: VectorTarget,
  schema: WireCollectionSchema,
  path: string,
): readonly [MilvusPlaceholderType, Uint8Array] {
  if (typeof item === "string") {
    if (target.dtype === "binary") {
      if (!BASE64.test(item))
        throw refusal(1, path, `${path} is not base64: a BinaryVector query is base64 or a list of bytes.`);
      const bytes = Array.from(atob(item), (character) => character.charCodeAt(0));
      const refused = checkDenseElements(target, bytes);
      if (refused !== null) throw refusal(1, path, refused.sentence);
      return ["BinaryVector", Uint8Array.from(bytes)];
    }
    const producer = producingFunction(schema, field);
    if (producer === "BM25") return ["VarChar", textBytes(item)];
    if (producer === "TextEmbedding") {
      throw refusal(
        1,
        path,
        `${field.name} is produced by an embedding function, so text sent to it would make Milvus call the embedding provider; Studio never sends a request that reaches a service the server calls. Send the vector itself.`,
      );
    }
    throw refusal(
      1,
      path,
      `${path} is text, and only a field a BM25 function produces takes text; ${field.name} takes a vector.`,
    );
  }
  if (target.kind === "sparse") {
    if (!isObject(item))
      throw refusal(1, path, `${path}: ${field.name} is sparse and takes an index map such as {"17": 0.4}.`);
    const vector = sparseFromIndexMap(target, item, MILVUS_BOUNDS.sparseIndexBound);
    if ("sentence" in vector) throw refusal(1, path, vector.sentence);
    const refused = checkSparse(target, vector, MILVUS_BOUNDS.sparseIndexBound);
    if (refused !== null) throw refusal(1, path, refused.sentence);
    return ["SparseFloatVector", sparseVectorBytes(vector)];
  }
  if (!isList(item)) throw refusal(1, path, `${path}: ${field.name} takes a list of numbers.`);
  if (target.kind === "multi") {
    const rowTarget: VectorTarget = { ...target, kind: "dense" };
    const rows = item.map((row, index) => {
      if (!isList(row))
        throw refusal(1, `${path}[${index}]`, `${path}[${index}]: an embedding list holds rows of numbers.`);
      return numbersOf(rowTarget, row, `${path}[${index}]`);
    });
    const refused = checkMultiVector(target, rows, MILVUS_BOUNDS.maxEmbeddingElements);
    if (refused !== null) throw refusal(1, path, refused.sentence);
    return ["EmbListFloatVector", floatVectorBytes(rows.flat())];
  }
  const numbers = numbersOf(target, item, path);
  if (target.dtype === "binary") return ["BinaryVector", Uint8Array.from(numbers)];
  if (target.dtype === "int8") return ["Int8Vector", int8VectorBytes(numbers)];
  return ["FloatVector", floatVectorBytes(numbers)];
}

type IndexFound =
  | { readonly kind: "found"; readonly indexType: string; readonly metric: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

function indexOf(reading: IndexReading, annsField: string): IndexFound {
  if (reading.kind === "unreadable") return { kind: "unreadable" };
  if (reading.kind === "not-read") throw new TypeError("This search needs the DescribeIndex answer fetched for it");
  const description = reading.response.index_descriptions.find((entry) => entry.field_name === annsField);
  if (description === undefined) return { kind: "none" };
  const param = (key: string) => description.params.find((entry) => entry.key === key)?.value ?? "";
  return { kind: "found", indexType: param("index_type"), metric: param("metric_type") };
}

/** The metric and the search parameters against the field's index (E11, E28, 5.5: IndexDetail). */
function checkAgainstIndex(
  index: IndexFound,
  annsField: string,
  metric: string | undefined,
  params: TaggedObject | undefined,
  key: string,
): void {
  const named = Object.keys(params ?? {});
  if (index.kind === "unreadable") {
    if (metric !== undefined || named.length > 0) {
      throw refusal(
        1,
        key,
        `This search names a metric or a search parameter, which Studio checks against the index, and this Milvus user cannot read the index: grant IndexDetail, or leave both out.`,
      );
    }
    return;
  }
  if (index.kind === "none") {
    if (metric !== undefined || named.length > 0) {
      throw refusal(1, key, `${annsField} has no index, so it takes no metric and no search parameter.`);
    }
    return;
  }
  if (metric !== undefined && metric !== index.metric) {
    throw refusal(
      1,
      key,
      `${annsField} is indexed with ${index.metric}, and this request names ${shown(metric)}: Milvus answers a metric mismatch as if the collection were not loaded, so Studio refuses it here.`,
    );
  }
  const allowed = own(MILVUS_INDEX_SEARCH_KEYS, index.indexType);
  for (const name of named) {
    if (allowed === undefined) {
      throw refusal(
        1,
        `${key}.${name}`,
        `Studio sends no search parameter to a ${index.indexType} index, which it has not measured.`,
      );
    }
    if (!allowed.includes(name)) {
      const takes = allowed.length === 0 ? "no search parameter" : allowed.join(", ");
      throw refusal(1, `${key}.${name}`, `A ${index.indexType} index does not take ${name}; it takes ${takes}.`);
    }
  }
  if (params?.radius !== undefined && params.range_filter !== undefined) {
    const radius = Number(toJsonText(params.radius));
    const rangeFilter = Number(toJsonText(params.range_filter));
    const similarity = MILVUS_SIMILARITY_METRICS.includes(index.metric);
    if (!similarity && !MILVUS_DISTANCE_METRICS.includes(index.metric)) {
      throw refusal(1, `${key}.range_filter`, `Studio cannot order a range for the ${index.metric} metric.`);
    }
    const ordered = similarity ? rangeFilter > radius : rangeFilter < radius;
    if (!ordered) {
      const side = similarity ? "above" : "below";
      throw refusal(
        1,
        `${key}.range_filter`,
        `With ${index.metric}, range_filter must lie ${side} radius and never equal it; Milvus retries a reversed pair for seconds before it refuses.`,
      );
    }
  }
}

/**
 * The scalar types the server's group-by operator refuses, measured on 3.0.2 ("unsupported data type FLOAT for group
 * by operator"); Bool, the integers, VarChar, JSON and Timestamptz group.
 */
const UNGROUPED_SCALAR_TYPES: readonly string[] = ["Float", "Double", "Array", "Geometry"];

function groupingFieldOf(schema: WireCollectionSchema, grouping: GroupingPhase0 | undefined, collection: string) {
  if (grouping === undefined) return undefined;
  const field = schema.fields.find((candidate) => candidate.name === grouping.field);
  if (field === undefined)
    throw refusal(1, "groupingField", `${shown(grouping.field)} is not a field of ${collection}.`);
  if (isVectorType(field.data_type)) {
    throw refusal(1, "groupingField", `${field.name} is a vector field; Milvus groups by a scalar field.`);
  }
  if (UNGROUPED_SCALAR_TYPES.includes(field.data_type)) {
    throw refusal(1, "groupingField", `${field.name} has the type ${field.data_type}, which Milvus does not group by.`);
  }
  return field;
}

function groupingPairs(grouping: GroupingPhase0 | undefined): WireKeyValuePair[] {
  if (grouping === undefined) return [];
  const pairs = [pair("group_by_field", grouping.field)];
  if (grouping.size !== undefined) pairs.push(pair("group_size", String(grouping.size)));
  if (grouping.strict !== undefined) pairs.push(pair("strict_group_size", String(grouping.strict)));
  return pairs;
}

function paramsText(params: TaggedObject | undefined): string {
  return params === undefined ? "{}" : toJsonText(params);
}

function lowerSearch(request: SearchPhase0, schema: WireCollectionSchema, reading: IndexReading): MilvusOperation {
  checkPartitionKey(schema, request.partitionNames, request.collection);
  const { field, target } = annsTarget(schema, request.annsField, "annsField", request.collection);
  const groupingField = groupingFieldOf(schema, request.grouping, request.collection);
  const index = indexOf(reading, request.annsField);
  const { metric, params, roundDecimal } = request.searchParams;
  checkAgainstIndex(index, request.annsField, metric, params, "searchParams");
  let input: Pick<SearchRequest, "placeholder_group" | "ids">;
  if (request.input.kind === "ids") {
    const ids = typedIds(request.input.values, primaryKeyOf(schema), "ids", true);
    const wire: WireIDs = ids.kind === "int64" ? { int_id: { data: ids.values } } : { str_id: { data: ids.values } };
    input = { ids: wire };
  } else {
    input = { placeholder_group: placeholderOf(request.input.values, field, target, schema, "data") };
  }
  const searchParams = [
    pair("anns_field", request.annsField),
    pair("topk", String(request.limit)),
    pair("offset", String(request.offset)),
    pair("params", paramsText(params)),
    pair("round_decimal", String(roundDecimal)),
    ...(metric === undefined ? [] : [pair("metric_type", metric)]),
    ...groupingPairs(request.grouping),
  ];
  const score: ScoreSource =
    index.kind === "found"
      ? { kind: "metric", metric: index.metric }
      : index.kind === "unreadable"
        ? { kind: "unreadable" }
        : { kind: "unreported" };
  return {
    kind: "search",
    db: request.db,
    request: {
      collection_name: request.collection,
      ...partitionFields(request.partitionNames),
      dsl: request.filter,
      dsl_type: "BoolExprV1",
      ...input,
      output_fields: projectOutput(request.output, schema, request.collection),
      search_params: searchParams,
      nq: String(request.input.values.length),
      ...consistencyFields(request.consistency),
      ...templateFields(request.templates),
    },
    shape: {
      schema,
      nq: request.input.values.length,
      limit: request.limit,
      offset: request.offset,
      score,
      groupingField,
    },
  };
}

function lowerHybrid(request: HybridPhase0, schema: WireCollectionSchema, reading: IndexReading): MilvusOperation {
  checkPartitionKey(schema, request.partitionNames, request.collection);
  const groupingField = groupingFieldOf(schema, request.grouping, request.collection);
  const outputFields = projectOutput(request.output, schema, request.collection);
  const nq = request.subRequests[0].data.length;
  const requests = request.subRequests.map((sub, index) => {
    const key = `search[${index}]`;
    const { field, target } = annsTarget(schema, sub.annsField, `${key}.annsField`, request.collection);
    if (sub.params !== undefined || sub.metric !== undefined) {
      checkAgainstIndex(indexOf(reading, sub.annsField), sub.annsField, sub.metric, sub.params, `${key}.params`);
    }
    // No consistency and no ids in a sub-request: Milvus reads the top level only (R40 F3).
    return {
      collection_name: request.collection,
      ...partitionFields(request.partitionNames),
      dsl: sub.filter,
      dsl_type: "BoolExprV1" as const,
      placeholder_group: placeholderOf(sub.data, field, target, schema, `${key}.data`),
      output_fields: outputFields,
      search_params: [
        pair("anns_field", sub.annsField),
        pair("topk", String(sub.limit)),
        pair("params", paramsText(sub.params)),
        ...(sub.metric === undefined ? [] : [pair("metric_type", sub.metric)]),
      ],
      nq: String(nq),
      ...templateFields(sub.templates),
    };
  });
  const rankParams = [
    pair("strategy", request.rerank.strategy),
    pair("params", paramsText(request.rerank.params)),
    pair("limit", String(request.limit)),
    pair("offset", String(request.offset)),
    pair("round_decimal", "-1"),
    ...groupingPairs(request.grouping),
  ];
  return {
    kind: "hybridSearch",
    db: request.db,
    request: {
      collection_name: request.collection,
      ...partitionFields(request.partitionNames),
      requests,
      rank_params: rankParams,
      output_fields: outputFields,
      ...consistencyFields(request.consistency),
    },
    shape: {
      schema,
      nq,
      limit: request.limit,
      offset: request.offset,
      score: { kind: "fused", strategy: request.rerank.strategy },
      groupingField,
    },
  };
}
