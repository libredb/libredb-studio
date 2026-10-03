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
import { FILTER_IDENTIFIER, int64Digits, type TemplateParam } from "./expr";
import {
  endpointKeySentence,
  MILVUS_BOUNDS,
  MILVUS_CONSISTENCY_LEVELS,
  MILVUS_CONSOLE,
  MILVUS_DOCUMENTED_REFUSALS,
  MILVUS_ENDPOINT_KEYS,
  MILVUS_REFUSED_CONSISTENCY,
  MILVUS_REQUIRED_KEYS,
  MILVUS_RERANK_PARAMS,
  MILVUS_ROUTE_KEYS,
  MILVUS_ROUTES,
  MILVUS_SEARCH_PARAMETERS,
  MILVUS_SEARCH_PARAMS_KEYS,
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

const MILVUS_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

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

/**
 * The console text read by the shared grammar against the Milvus table (3.4). A route the table does not hold is
 * refused with Milvus's own sentence: the Operations routes point at the Operations controls (E9), a write says the
 * provider reads only, and any other names the routes Studio runs (5.4).
 */
export function parseMilvusRequest(text: string): ConsoleRequest<MilvusOp> {
  try {
    return parseConsole(MILVUS_CONSOLE, MILVUS_ROUTES, text);
  } catch (error) {
    if (!(error instanceof ConsoleRefusal) || error.reason !== "unknown-route") throw error;
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
