/**
 * The Firestore console statement, read into a typed statement (spec 5.4): value expressions, and the call chain
 * as the Admin SDK's state machine. Pure and browser-safe; it reads JavaScript-shaped text and never evaluates it,
 * and every refusal is a QueryError naming its line, column and excerpt.
 */
import { QueryError } from "@/lib/db/errors";
import { LIMITS } from "../constants";
import { DOCUMENT_ID, type FieldPathSegments, fieldPathOf, parseFieldPathString } from "../field-path";
import { idRefusal, isDocumentPath, splitPath } from "../names";
import type { Literal } from "../values";
import { firestoreQueryError, lex, type Token } from "./lexer";

export type Operator =
  | "<"
  | "<="
  | "=="
  | "!="
  | ">="
  | ">"
  | "array-contains"
  | "in"
  | "not-in"
  | "array-contains-any";
export interface FieldRef {
  readonly path: FieldPathSegments;
  readonly at: number;
}
export type FilterNode =
  | {
      readonly kind: "compare";
      readonly field: FieldRef;
      readonly op: Operator;
      readonly value: Literal;
      readonly at: number;
    }
  | { readonly kind: "and" | "or"; readonly filters: readonly FilterNode[]; readonly at: number };
export interface CursorBound {
  readonly values: readonly Literal[];
  readonly before: boolean;
  readonly at: number;
}
export interface QueryOps {
  readonly where: readonly FilterNode[];
  readonly orderBy: readonly { field: FieldRef; direction: "ASCENDING" | "DESCENDING" }[];
  readonly limit?: { value: number; at: number };
  readonly offset?: { value: number; at: number };
  readonly select?: readonly FieldRef[];
  readonly start?: CursorBound;
  readonly end?: CursorBound;
}
export type QuerySource =
  | { readonly kind: "collection"; readonly path: readonly string[]; readonly at: number }
  | { readonly kind: "collectionGroup"; readonly collectionId: string; readonly at: number };
export interface NearestSpec {
  readonly field: FieldRef;
  readonly queryVector: readonly number[];
  readonly limit: number;
  readonly distanceMeasure: "EUCLIDEAN" | "COSINE" | "DOT_PRODUCT";
  readonly distanceResultField?: FieldRef;
  readonly distanceThreshold?: number;
  readonly at: number;
}
export interface AggregationSpec {
  readonly key: string;
  readonly op: "count" | "sum" | "avg";
  readonly field?: FieldRef;
  readonly at: number;
}
export interface ExplainCall {
  readonly analyze: boolean;
  readonly at: number;
}
export type Statement =
  | { readonly kind: "query"; readonly source: QuerySource; readonly ops: QueryOps; readonly explain?: ExplainCall }
  | {
      readonly kind: "vector";
      readonly source: QuerySource;
      readonly ops: QueryOps;
      readonly nearest: NearestSpec;
      readonly explain?: ExplainCall;
    }
  | {
      readonly kind: "aggregate";
      readonly source: QuerySource;
      readonly ops: QueryOps;
      readonly aggregations: readonly AggregationSpec[];
      readonly explain?: ExplainCall;
    }
  | { readonly kind: "getDocument"; readonly path: readonly string[]; readonly at: number }
  | { readonly kind: "listCollections"; readonly parent: readonly string[]; readonly at: number }
  | { readonly kind: "listDocuments"; readonly collection: readonly string[]; readonly at: number }
  | { readonly kind: "getAll"; readonly refs: readonly (readonly string[])[] };

/** A value expression as written, before its meaning is read. */
export type Expr =
  | { readonly t: "string"; readonly value: string; readonly at: number }
  | { readonly t: "number"; readonly text: string; readonly at: number }
  | { readonly t: "word"; readonly name: WordName; readonly at: number }
  | { readonly t: "array"; readonly items: readonly Expr[]; readonly at: number }
  | { readonly t: "object"; readonly entries: readonly ObjectEntry[]; readonly at: number }
  | {
      readonly t: "call";
      readonly name: string;
      readonly isNew: boolean;
      readonly args: readonly Expr[];
      readonly at: number;
    };
export interface ObjectEntry {
  readonly key: string;
  readonly keyAt: number;
  readonly value: Expr;
}
type WordName = "true" | "false" | "null" | "NaN" | "Infinity" | "-Infinity";
type NumberExpr = Extract<Expr, { t: "number" }>;
type CallExpr = Extract<Expr, { t: "call" }>;

export const PARSER_SENTENCES = {
  oneChain: "Studio runs one chain starting at db; write it inline",
  modular: "Use the namespaced form, db.collection(...)",
  root: "Start the chain at db",
  runsItself: "Studio runs the query itself; end the chain at the query or .get()",
  readOnly: "Studio is read-only for Firestore in this version",
  emptyChain: 'Write a call after db, such as db.collection("users")',
  minus: "A minus sign goes only before a number or Infinity",
  objectKey: "An object key is a name or a quoted string",
  integerRange: "An integer must lie between -9223372036854775808 and 9223372036854775807",
  doubleRange: "This number is too large for a double",
  dateCall: 'Timestamp.fromDate() takes new Date("...") with one quoted date',
  dateText:
    'Timestamp.fromDate(new Date(...)) takes an RFC 3339 date-time with Z or an offset, such as "2026-10-12T09:30:00Z", or a date such as "2026-10-12"; Studio never reads a date in the server\'s time zone',
  timestampRange: "A timestamp must lie between 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999999999Z",
  nanosRange: "Nanoseconds run from 0 to 999,999,999",
  latitude: "A latitude runs from -90 to 90",
  longitude: "A longitude runs from -180 to 180",
  vectorElements: "A vector holds numbers only",
  vectorSize: "A vector holds at most 2,048 numbers",
  referencePath: "db.doc() takes a document path, with an even number of segments",
  fieldPath: 'A field is a string such as "address.city", new FieldPath("a", "b") or FieldPath.documentId()',
  fieldSegment: "new FieldPath() takes one or more non-empty strings",
  filter: "A filter is Filter.where(field, operator, value), Filter.and(...) or Filter.or(...)",
  aggregateField:
    "An aggregation is AggregateField.count(), AggregateField.sum(field) or AggregateField.average(field)",
  collectionPath: "collection() takes a collection path, with an odd number of segments; use doc() for a document",
  documentPath:
    "doc() takes a document path, with an even number of segments from the database; use collection() for a collection",
  groupId: "collectionGroup() takes one collection id, without /",
  newDoc: "doc() without an id names a new document, which Studio does not create",
  getAllRefs: 'getAll() takes 1 to 1,000 db.doc("path") references',
  limitToLast: "limitToLast() is not supported; order the other way and use limit()",
  direction: 'orderBy() takes "asc" or "desc" as its direction',
  whereArguments: "where() takes a field, an operator and a value, or one Filter",
  nearestShape: "findNearest() takes one object: { vectorField, queryVector, limit, distanceMeasure }",
  measure: 'distanceMeasure is "EUCLIDEAN", "COSINE" or "DOT_PRODUCT"',
  queryVector: "queryVector is an array of numbers or FieldValue.vector([...])",
  aggregateShape: 'aggregate() takes one object of named aggregations, such as { total: AggregateField.sum("price") }',
  explainShape: "explain() takes { analyze: true } or { analyze: false }",
  expected: (what: string): string => `Expected ${what} here`,
  variable: (name: string): string => `Studio reads no variables; write the value of ${name} itself`,
  notAValue: (name: string): string => `${name}(...) is not a value Studio reads`,
  writeValue: (name: string): string =>
    `${name}() writes a value, and Studio is read-only for Firestore in this version`,
  duplicateKey: (key: string): string => `The key ${JSON.stringify(key)} appears twice in this object`,
  arguments: (call: string, count: string): string => `${call} takes ${count}`,
  integerExpected: (what: string): string => `${what} takes an integer`,
  numberExpected: (what: string): string => `${what} takes a number`,
  operator: (op: string | undefined): string =>
    `${op === undefined ? "This" : JSON.stringify(op)} is not an operator Firestore reads; use <, <=, ==, !=, >=, >, array-contains, in, not-in or array-contains-any`,
  notOn: (name: string, noun: string, allowed: string): string =>
    `${name}() cannot be called on ${noun}; it takes ${allowed}`,
  afterEnd: (name: string): string => `The chain ends at ${name}(); remove what follows it`,
  parens: (name: string): string => `Call ${name} with parentheses, as ${name}(...)`,
  afterCursor: (name: string): string =>
    `${name}() cannot follow startAt(), startAfter(), endAt() or endBefore(); move it before the cursor`,
  cursorValues: (name: string): string => `${name}() takes one or more values, one per orderBy() field`,
  nearestOption: (key: string): string => `findNearest() does not take the option ${key}`,
  nearestMissing: (key: string): string => `findNearest() needs ${key}`,
  noArgs: (name: string): string => `${name}() takes no arguments`,
} as const;

const WORDS: ReadonlySet<string> = new Set(["true", "false", "null", "NaN", "Infinity"]);
const NAMESPACE = "admin.firestore.";
const NAMESPACE_MEMBERS: ReadonlySet<string> = new Set([
  "Timestamp",
  "FieldValue",
  "FieldPath",
  "Filter",
  "AggregateField",
  "GeoPoint",
]);
const OPERATORS: ReadonlySet<string> = new Set([
  "<",
  "<=",
  "==",
  "!=",
  ">=",
  ">",
  "array-contains",
  "in",
  "not-in",
  "array-contains-any",
]);
const INTEGER_TEXT = /^-?\d+$/;
const MIN_SECONDS = BigInt("-62135596800");
const MAX_SECONDS = BigInt("253402300799");
const THOUSAND = BigInt(1000);
const MAX_NANOS = BigInt(999_999_999);
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** The token stream with one token of lookahead and the text every refusal quotes. */
export class Reader {
  private index = 0;
  constructor(
    readonly text: string,
    private readonly tokens: readonly Token[],
  ) {}
  peek(ahead = 0): Token {
    return this.tokens[Math.min(this.index + ahead, this.tokens.length - 1)];
  }
  next(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.index++;
    return token;
  }
  isPunct(text: string, ahead = 0): boolean {
    const token = this.peek(ahead);
    return token.kind === "punctuation" && token.text === text;
  }
  isIdent(text: string, ahead = 0): boolean {
    const token = this.peek(ahead);
    return token.kind === "identifier" && token.text === text;
  }
  expect(text: string): Token {
    if (!this.isPunct(text)) throw this.fail(this.peek().start, PARSER_SENTENCES.expected(JSON.stringify(text)));
    return this.next();
  }
  fail(offset: number, sentence: string): QueryError {
    return firestoreQueryError(this.text, offset, sentence);
  }
}

/** Expressions up to `close`, separated by commas, a trailing comma allowed; the close is consumed. */
export function parseList(reader: Reader, close: string): Expr[] {
  const items: Expr[] = [];
  while (!reader.isPunct(close)) {
    items.push(parseExpr(reader));
    if (reader.isPunct(",")) reader.next();
    else if (!reader.isPunct(close))
      throw reader.fail(reader.peek().start, PARSER_SENTENCES.expected(`"," or "${close}"`));
  }
  reader.next();
  return items;
}

function parseEntries(reader: Reader): ObjectEntry[] {
  const entries: ObjectEntry[] = [];
  const seen = new Set<string>();
  while (!reader.isPunct("}")) {
    const key = reader.peek();
    if (key.kind !== "identifier" && key.kind !== "string") throw reader.fail(key.start, PARSER_SENTENCES.objectKey);
    reader.next();
    const name = key.kind === "string" ? (key.value ?? "") : key.text;
    if (seen.has(name)) throw reader.fail(key.start, PARSER_SENTENCES.duplicateKey(name));
    seen.add(name);
    reader.expect(":");
    entries.push({ key: name, keyAt: key.start, value: parseExpr(reader) });
    if (reader.isPunct(",")) reader.next();
    else if (!reader.isPunct("}")) throw reader.fail(reader.peek().start, PARSER_SENTENCES.expected('"," or "}"'));
  }
  reader.next();
  return entries;
}

function stripNamespace(name: string): string {
  if (!name.startsWith(NAMESPACE)) return name;
  const rest = name.slice(NAMESPACE.length);
  return NAMESPACE_MEMBERS.has(rest.split(".")[0]) ? rest : name;
}

function readDottedName(reader: Reader): string {
  const first = reader.peek();
  if (first.kind !== "identifier") throw reader.fail(first.start, PARSER_SENTENCES.expected("a name"));
  reader.next();
  let name = first.text;
  while (reader.isPunct(".") && reader.peek(1).kind === "identifier") {
    reader.next();
    name += `.${reader.next().text}`;
  }
  return name;
}

function parseExpr(reader: Reader): Expr {
  const token = reader.peek();
  if (token.kind === "string") {
    reader.next();
    return { t: "string", value: token.value ?? "", at: token.start };
  }
  if (token.kind === "number") {
    reader.next();
    return { t: "number", text: token.text, at: token.start };
  }
  if (token.kind === "punctuation" && token.text === "-") {
    reader.next();
    const after = reader.peek();
    if (after.kind === "number") {
      reader.next();
      return { t: "number", text: `-${after.text}`, at: token.start };
    }
    if (after.kind === "identifier" && after.text === "Infinity") {
      reader.next();
      return { t: "word", name: "-Infinity", at: token.start };
    }
    throw reader.fail(token.start, PARSER_SENTENCES.minus);
  }
  if (token.kind === "punctuation" && token.text === "[") {
    reader.next();
    return { t: "array", items: parseList(reader, "]"), at: token.start };
  }
  if (token.kind === "punctuation" && token.text === "{") {
    reader.next();
    return { t: "object", entries: parseEntries(reader), at: token.start };
  }
  if (token.kind === "identifier" && WORDS.has(token.text) && !reader.isPunct("(", 1)) {
    reader.next();
    return { t: "word", name: token.text as WordName, at: token.start };
  }
  if (token.kind === "identifier") {
    const isNew = token.text === "new";
    if (isNew) reader.next();
    const name = readDottedName(reader);
    if (!reader.isPunct("(")) throw reader.fail(token.start, PARSER_SENTENCES.variable(name));
    reader.next();
    return { t: "call", name: stripNamespace(name), isNew, args: parseList(reader, ")"), at: token.start };
  }
  throw reader.fail(token.start, PARSER_SENTENCES.expected("a value"));
}

/** One value expression and nothing after it; the unit the expression tests and the fuzz corpus read. */
export function parseExpressionText(text: string): Expr {
  const reader = new Reader(text, lex(text));
  const expr = parseExpr(reader);
  const rest = reader.peek();
  if (rest.kind !== "eof") throw reader.fail(rest.start, PARSER_SENTENCES.expected("the end of the value"));
  return expr;
}

const callKey = (expr: CallExpr): string => (expr.isNew ? `new ${expr.name}` : expr.name);

export function arity(expr: CallExpr, count: number, text: string): void {
  if (expr.args.length === count) return;
  const words = count === 0 ? "no arguments" : count === 1 ? "exactly one argument" : `exactly ${count} arguments`;
  throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.arguments(`${callKey(expr)}()`, words));
}

export function stringOf(expr: Expr, text: string, sentence: string): string {
  if (expr.t !== "string") throw firestoreQueryError(text, expr.at, sentence);
  return expr.value;
}

function finiteNumber(expr: NumberExpr, text: string): number {
  const value = Number(expr.text);
  if (!Number.isFinite(value)) throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.doubleRange);
  return value;
}

export function numberOf(expr: Expr, text: string, what: string): number {
  if (expr.t !== "number") throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.numberExpected(what));
  return finiteNumber(expr, text);
}

export function integerOf(expr: Expr, text: string, what: string): bigint {
  if (expr.t !== "number" || !INTEGER_TEXT.test(expr.text)) {
    throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.integerExpected(what));
  }
  return BigInt(expr.text);
}

export function vectorNumbers(expr: Expr, text: string): number[] {
  if (expr.t !== "array") throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.vectorElements);
  if (expr.items.length > LIMITS.maxVectorDimensions)
    throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.vectorSize);
  return expr.items.map((item) => {
    if (item.t !== "number") throw firestoreQueryError(text, item.at, PARSER_SENTENCES.vectorElements);
    return finiteNumber(item, text);
  });
}

/** `splitPath`, with its refusal placed at `at`. */
export function splitText(value: string, at: number, text: string): string[] {
  try {
    return splitPath(value);
  } catch (error) {
    throw error instanceof QueryError ? firestoreQueryError(text, at, error.message) : error;
  }
}

const daysInMonth = (year: number, month: number): number =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

/** Days from 1970-01-01 to a proleptic Gregorian date, without Date, so no time zone is ever read. */
function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/**
 * An RFC 3339 date-time with Z or an offset, or a date-only YYYY-MM-DD read as UTC midnight, as epoch seconds and
 * nanos; null for anything else. Digits past the millisecond are dropped, as `new Date(text)` drops them.
 */
export function parseDateText(value: string): { seconds: bigint; nanos: number } | null {
  const date = DATE_ONLY.exec(value);
  const match = date ?? DATE_TIME.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const days = daysFromCivil(year, month, day);
  if (date !== null) return { seconds: BigInt(days * 86_400), nanos: 0 };
  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6])];
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (match[9] !== undefined) {
    const [offsetHours, offsetMinutes] = [Number(match[10]), Number(match[11])];
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offset = (match[9] === "-" ? -1 : 1) * (offsetHours * 3_600 + offsetMinutes * 60);
  }
  const millis = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  return { seconds: BigInt(days * 86_400 + hour * 3_600 + minute * 60 + second - offset), nanos: millis * 1_000_000 };
}

function timestampOf(seconds: bigint, nanos: number, at: number, text: string): Literal {
  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS)
    throw firestoreQueryError(text, at, PARSER_SENTENCES.timestampRange);
  return { kind: "timestamp", seconds: seconds.toString(), nanos };
}

function dateOf(expr: Expr, text: string): { seconds: bigint; nanos: number } {
  const arg = expr.t === "call" ? expr.args[0] : undefined;
  if (
    expr.t !== "call" ||
    !expr.isNew ||
    expr.name !== "Date" ||
    expr.args.length !== 1 ||
    arg === undefined ||
    arg.t !== "string"
  ) {
    throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.dateCall);
  }
  const parsed = parseDateText(arg.value);
  if (parsed === null) throw firestoreQueryError(text, arg.at, PARSER_SENTENCES.dateText);
  return parsed;
}

function numberLiteral(expr: NumberExpr, text: string): Literal {
  if (!INTEGER_TEXT.test(expr.text)) return { kind: "double", value: finiteNumber(expr, text) };
  const value = BigInt(expr.text);
  // A Firestore integer is a signed 64-bit value: asIntN wraps anything outside that range to a different number.
  if (BigInt.asIntN(64, value) !== value) throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.integerRange);
  return { kind: "integer", text: value.toString() };
}

function wordLiteral(name: WordName): Literal {
  if (name === "true" || name === "false") return { kind: "boolean", value: name === "true" };
  if (name === "null") return { kind: "null" };
  return { kind: "double", value: name };
}

/** The document path of one `db.doc("path")` call, or the reference-path refusal. */
function referenceOf(expr: CallExpr, text: string): string[] {
  arity(expr, 1, text);
  const segments = splitText(stringOf(expr.args[0], text, PARSER_SENTENCES.referencePath), expr.args[0].at, text);
  if (!isDocumentPath(segments)) throw firestoreQueryError(text, expr.args[0].at, PARSER_SENTENCES.referencePath);
  return segments;
}

function callLiteral(expr: CallExpr, text: string): Literal {
  switch (callKey(expr)) {
    case "Timestamp.fromDate": {
      arity(expr, 1, text);
      const { seconds, nanos } = dateOf(expr.args[0], text);
      return timestampOf(seconds, nanos, expr.at, text);
    }
    case "Timestamp.fromMillis": {
      arity(expr, 1, text);
      const millis = integerOf(expr.args[0], text, "Timestamp.fromMillis()");
      const truncated = millis / THOUSAND;
      const seconds = millis % THOUSAND < BigInt(0) ? truncated - BigInt(1) : truncated;
      return timestampOf(seconds, Number(millis - seconds * THOUSAND) * 1_000_000, expr.at, text);
    }
    case "new Timestamp": {
      arity(expr, 2, text);
      const seconds = integerOf(expr.args[0], text, "new Timestamp()");
      const nanos = integerOf(expr.args[1], text, "new Timestamp()");
      if (nanos < BigInt(0) || nanos > MAX_NANOS)
        throw firestoreQueryError(text, expr.args[1].at, PARSER_SENTENCES.nanosRange);
      return timestampOf(seconds, Number(nanos), expr.at, text);
    }
    case "new GeoPoint": {
      arity(expr, 2, text);
      const latitude = numberOf(expr.args[0], text, "new GeoPoint()");
      const longitude = numberOf(expr.args[1], text, "new GeoPoint()");
      if (latitude < -90 || latitude > 90) throw firestoreQueryError(text, expr.args[0].at, PARSER_SENTENCES.latitude);
      if (longitude < -180 || longitude > 180)
        throw firestoreQueryError(text, expr.args[1].at, PARSER_SENTENCES.longitude);
      return { kind: "geopoint", latitude, longitude };
    }
    case "FieldValue.vector":
      arity(expr, 1, text);
      return { kind: "vector", values: vectorNumbers(expr.args[0], text) };
    case "db.doc":
      return { kind: "reference", segments: referenceOf(expr, text) };
  }
  if (!expr.isNew && expr.name.startsWith("FieldValue.")) {
    throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.writeValue(expr.name));
  }
  throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.notAValue(callKey(expr)));
}

/** A value expression as a console literal (spec 5.4 literal rules). */
export function literalOf(expr: Expr, text: string): Literal {
  switch (expr.t) {
    case "string":
      return { kind: "string", value: expr.value };
    case "number":
      return numberLiteral(expr, text);
    case "word":
      return wordLiteral(expr.name);
    case "array":
      return { kind: "array", items: expr.items.map((item) => literalOf(item, text)) };
    case "object":
      return { kind: "map", entries: expr.entries.map((entry) => [entry.key, literalOf(entry.value, text)] as const) };
    case "call":
      return callLiteral(expr, text);
  }
}

/** A field path: a dotted string, `new FieldPath(...)` with verbatim segments, or `FieldPath.documentId()`. */
export function fieldRefOf(expr: Expr, text: string): FieldRef {
  if (expr.t === "string") {
    try {
      return { path: parseFieldPathString(expr.value), at: expr.at };
    } catch (error) {
      throw error instanceof QueryError ? firestoreQueryError(text, expr.at, error.message) : error;
    }
  }
  if (expr.t === "call" && !expr.isNew && expr.name === "FieldPath.documentId") {
    arity(expr, 0, text);
    return { path: DOCUMENT_ID, at: expr.at };
  }
  if (expr.t === "call" && expr.isNew && expr.name === "FieldPath") {
    if (expr.args.length === 0) throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.fieldSegment);
    const path = expr.args.map((arg) => {
      const segment = stringOf(arg, text, PARSER_SENTENCES.fieldSegment);
      if (segment === "") throw firestoreQueryError(text, arg.at, PARSER_SENTENCES.fieldSegment);
      return segment;
    });
    try {
      return { path: fieldPathOf(path), at: expr.at };
    } catch (error) {
      throw error instanceof QueryError ? firestoreQueryError(text, expr.at, error.message) : error;
    }
  }
  throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.fieldPath);
}

function operatorOf(expr: Expr, text: string): Operator {
  const op = expr.t === "string" ? expr.value : undefined;
  if (op === "=") return "==";
  if (op === undefined || !OPERATORS.has(op)) throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.operator(op));
  return op as Operator;
}

/** A comparison node: the shared reading of `where(f, op, v)` and `Filter.where(f, op, v)`. */
export function compareNode(field: Expr, op: Expr, value: Expr, at: number, text: string): FilterNode {
  return {
    kind: "compare",
    field: fieldRefOf(field, text),
    op: operatorOf(op, text),
    value: literalOf(value, text),
    at,
  };
}

/** `Filter.where`, `Filter.and` and `Filter.or`, nested as written. */
export function filterOf(expr: Expr, text: string): FilterNode {
  if (expr.t === "call" && !expr.isNew && expr.name === "Filter.where") {
    arity(expr, 3, text);
    return compareNode(expr.args[0], expr.args[1], expr.args[2], expr.at, text);
  }
  if (
    expr.t === "call" &&
    !expr.isNew &&
    (expr.name === "Filter.and" || expr.name === "Filter.or") &&
    expr.args.length > 0
  ) {
    return {
      kind: expr.name === "Filter.and" ? "and" : "or",
      filters: expr.args.map((arg) => filterOf(arg, text)),
      at: expr.at,
    };
  }
  throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.filter);
}

/** `AggregateField.count()`, `.sum(field)` or `.average(field)`. */
export function aggregateOf(expr: Expr, text: string): { op: "count" | "sum" | "avg"; field?: FieldRef } {
  if (expr.t === "call" && !expr.isNew && expr.name === "AggregateField.count") {
    arity(expr, 0, text);
    return { op: "count" };
  }
  if (
    expr.t === "call" &&
    !expr.isNew &&
    (expr.name === "AggregateField.sum" || expr.name === "AggregateField.average")
  ) {
    arity(expr, 1, text);
    return { op: expr.name === "AggregateField.sum" ? "sum" : "avg", field: fieldRefOf(expr.args[0], text) };
  }
  throw firestoreQueryError(text, expr.at, PARSER_SENTENCES.aggregateField);
}

const DECLARATIONS: ReadonlySet<string> = new Set(["const", "let", "var", "import", "export", "function"]);
const ROOT_CALLS: ReadonlySet<string> = new Set(["firestore", "getFirestore"]);
const MODULAR_READS: ReadonlySet<string> = new Set([
  "query",
  "collection",
  "collectionGroup",
  "doc",
  "getDoc",
  "getDocs",
  "getDocFromServer",
  "getDocsFromServer",
  "getCountFromServer",
  "getAggregateFromServer",
  "onSnapshot",
  "where",
  "orderBy",
  "limit",
  "documentId",
  "and",
  "or",
]);
const MODULAR_WRITES: ReadonlySet<string> = new Set([
  "setDoc",
  "addDoc",
  "updateDoc",
  "deleteDoc",
  "writeBatch",
  "runTransaction",
]);
const RUNS_ITSELF: ReadonlySet<string> = new Set(["then", "catch", "finally", "onSnapshot", "stream", "withConverter"]);
const WRITES: ReadonlySet<string> = new Set([
  "set",
  "add",
  "update",
  "delete",
  "create",
  "batch",
  "runTransaction",
  "bulkWriter",
  "recursiveDelete",
]);
const MEASURES: ReadonlySet<string> = new Set(["EUCLIDEAN", "COSINE", "DOT_PRODUCT"]);
const QUERY_CALLS =
  "where(), orderBy(), limit(), offset(), startAt(), startAfter(), endAt(), endBefore(), select(), findNearest(), count(), aggregate(), explain() or get()";
const ALLOWED = {
  db: "collection(), collectionGroup(), doc(), listCollections() or getAll()",
  document: "collection(), get() or listCollections()",
  collection: `doc(), listDocuments(), ${QUERY_CALLS}`,
  query: QUERY_CALLS,
} as const;

type CollectionSource = Extract<QuerySource, { kind: "collection" }>;
interface OpsDraft {
  where: FilterNode[];
  orderBy: { field: FieldRef; direction: "ASCENDING" | "DESCENDING" }[];
  limit?: { value: number; at: number };
  offset?: { value: number; at: number };
  select?: FieldRef[];
  start?: CursorBound;
  end?: CursorBound;
  /** Where the first cursor call stood; a later where() or orderBy() is refused. */
  cursorAt?: number;
}
interface QueryChain {
  readonly source: QuerySource;
  readonly ops: OpsDraft;
}
type Chain =
  | { readonly s: "db" }
  | { readonly s: "document"; readonly path: string[]; readonly at: number }
  | { readonly s: "collection"; readonly source: CollectionSource; readonly ops: OpsDraft }
  | { readonly s: "query"; readonly source: QuerySource; readonly ops: OpsDraft }
  | { readonly s: "vector"; readonly source: QuerySource; readonly ops: OpsDraft; readonly nearest: NearestSpec }
  | {
      readonly s: "aggregation";
      readonly source: QuerySource;
      readonly ops: OpsDraft;
      readonly aggregations: AggregationSpec[];
    }
  | { readonly s: "end"; readonly statement: Statement; readonly name: string };
interface Call {
  readonly name: string;
  readonly at: number;
  readonly args: readonly Expr[];
}

const fail = (text: string, at: number, sentence: string): QueryError => firestoreQueryError(text, at, sentence);
const emptyOps = (): OpsDraft => ({ where: [], orderBy: [] });
const end = (statement: Statement, call: Call): Chain => ({ s: "end", statement, name: call.name });

function one(call: Call, text: string): Expr {
  if (call.args.length !== 1)
    throw fail(text, call.at, PARSER_SENTENCES.arguments(`${call.name}()`, "exactly one argument"));
  return call.args[0];
}

function none(call: Call, text: string): void {
  if (call.args.length !== 0) throw fail(text, call.at, PARSER_SENTENCES.noArgs(call.name));
}

/** A path relative to `base`, validated from the database root so each segment meets its own id rule. */
function joinedPath(base: readonly string[], expr: Expr, text: string, sentence: string): string[] {
  return splitText(`${base.join("/")}/${stringOf(expr, text, sentence)}`, expr.at, text);
}

function freezeOps(ops: OpsDraft): QueryOps {
  return {
    where: ops.where,
    orderBy: ops.orderBy,
    ...(ops.limit === undefined ? {} : { limit: ops.limit }),
    ...(ops.offset === undefined ? {} : { offset: ops.offset }),
    ...(ops.select === undefined ? {} : { select: ops.select }),
    ...(ops.start === undefined ? {} : { start: ops.start }),
    ...(ops.end === undefined ? {} : { end: ops.end }),
  };
}

function queryStatement(chain: QueryChain, explain?: ExplainCall): Statement {
  return {
    kind: "query",
    source: chain.source,
    ops: freezeOps(chain.ops),
    ...(explain === undefined ? {} : { explain }),
  };
}

function terminalStatement(chain: Extract<Chain, { s: "vector" | "aggregation" }>, explain?: ExplainCall): Statement {
  const base = { source: chain.source, ops: freezeOps(chain.ops), ...(explain === undefined ? {} : { explain }) };
  return chain.s === "vector"
    ? { kind: "vector", ...base, nearest: chain.nearest }
    : { kind: "aggregate", ...base, aggregations: chain.aggregations };
}

function refuseLeadingNearMiss(reader: Reader): void {
  const first = reader.peek();
  if (first.kind !== "identifier") return;
  const calls = reader.isPunct("(", 1);
  if (DECLARATIONS.has(first.text) || reader.isPunct("=", 1)) throw reader.fail(first.start, PARSER_SENTENCES.oneChain);
  const adminRoot =
    first.text === "admin" && reader.isPunct(".", 1) && reader.isIdent("firestore", 2) && reader.isPunct("(", 3);
  if (adminRoot || (calls && ROOT_CALLS.has(first.text))) throw reader.fail(first.start, PARSER_SENTENCES.root);
  if (calls && MODULAR_WRITES.has(first.text)) throw reader.fail(first.start, PARSER_SENTENCES.readOnly);
  if (calls && MODULAR_READS.has(first.text)) throw reader.fail(first.start, PARSER_SENTENCES.modular);
}

function fromDb(call: Call, text: string): Chain {
  switch (call.name) {
    case "collection": {
      const arg = one(call, text);
      const path = splitText(stringOf(arg, text, PARSER_SENTENCES.collectionPath), arg.at, text);
      if (path.length % 2 !== 1) throw fail(text, arg.at, PARSER_SENTENCES.collectionPath);
      return { s: "collection", source: { kind: "collection", path, at: arg.at }, ops: emptyOps() };
    }
    case "collectionGroup": {
      const arg = one(call, text);
      const id = stringOf(arg, text, PARSER_SENTENCES.groupId);
      if (id.includes("/")) throw fail(text, arg.at, PARSER_SENTENCES.groupId);
      const refusal = idRefusal(id, "collection");
      if (refusal !== null) throw fail(text, arg.at, refusal);
      return { s: "query", source: { kind: "collectionGroup", collectionId: id, at: arg.at }, ops: emptyOps() };
    }
    case "doc": {
      if (call.args.length === 0) throw fail(text, call.at, PARSER_SENTENCES.newDoc);
      const arg = one(call, text);
      const path = splitText(stringOf(arg, text, PARSER_SENTENCES.documentPath), arg.at, text);
      if (!isDocumentPath(path)) throw fail(text, arg.at, PARSER_SENTENCES.documentPath);
      return { s: "document", path, at: arg.at };
    }
    case "listCollections":
      none(call, text);
      return end({ kind: "listCollections", parent: [], at: call.at }, call);
    case "getAll": {
      if (call.args.length === 0 || call.args.length > LIMITS.maxGetAllRefs)
        throw fail(text, call.at, PARSER_SENTENCES.getAllRefs);
      const refs = call.args.map((arg) => {
        if (arg.t !== "call" || arg.isNew || arg.name !== "db.doc")
          throw fail(text, arg.at, PARSER_SENTENCES.getAllRefs);
        return referenceOf(arg, text);
      });
      return end({ kind: "getAll", refs }, call);
    }
    default:
      throw fail(text, call.at, PARSER_SENTENCES.notOn(call.name, "db", ALLOWED.db));
  }
}

function fromDocument(chain: Extract<Chain, { s: "document" }>, call: Call, text: string): Chain {
  switch (call.name) {
    case "collection": {
      const arg = one(call, text);
      const path = joinedPath(chain.path, arg, text, PARSER_SENTENCES.collectionPath);
      if (path.length % 2 !== 1) throw fail(text, arg.at, PARSER_SENTENCES.collectionPath);
      return { s: "collection", source: { kind: "collection", path, at: arg.at }, ops: emptyOps() };
    }
    case "get":
      none(call, text);
      return end({ kind: "getDocument", path: chain.path, at: chain.at }, call);
    case "listCollections":
      none(call, text);
      return end({ kind: "listCollections", parent: chain.path, at: call.at }, call);
    default:
      throw fail(text, call.at, PARSER_SENTENCES.notOn(call.name, "a document", ALLOWED.document));
  }
}

function fromCollection(chain: Extract<Chain, { s: "collection" }>, call: Call, text: string): Chain {
  if (call.name === "doc") {
    if (call.args.length === 0) throw fail(text, call.at, PARSER_SENTENCES.newDoc);
    const arg = one(call, text);
    const path = joinedPath(chain.source.path, arg, text, PARSER_SENTENCES.documentPath);
    if (!isDocumentPath(path)) throw fail(text, arg.at, PARSER_SENTENCES.documentPath);
    return { s: "document", path, at: arg.at };
  }
  if (call.name === "listDocuments") {
    none(call, text);
    return end({ kind: "listDocuments", collection: chain.source.path, at: call.at }, call);
  }
  return fromQuery(chain, call, text, ALLOWED.collection);
}

function notAfterCursor(ops: OpsDraft, call: Call, text: string): void {
  if (ops.cursorAt !== undefined) throw fail(text, call.at, PARSER_SENTENCES.afterCursor(call.name));
}

function directionOf(expr: Expr, text: string): "ASCENDING" | "DESCENDING" {
  const value = expr.t === "string" ? expr.value : undefined;
  if (value !== "asc" && value !== "desc") throw fail(text, expr.at, PARSER_SENTENCES.direction);
  return value === "asc" ? "ASCENDING" : "DESCENDING";
}

function queryVectorOf(expr: Expr, text: string): number[] {
  if (expr.t === "array") return vectorNumbers(expr, text);
  if (expr.t === "call" && !expr.isNew && expr.name === "FieldValue.vector") {
    arity(expr, 1, text);
    return vectorNumbers(expr.args[0], text);
  }
  throw fail(text, expr.at, PARSER_SENTENCES.queryVector);
}

function measureOf(expr: Expr, text: string): NearestSpec["distanceMeasure"] {
  const value = expr.t === "string" ? expr.value : "";
  if (!MEASURES.has(value)) throw fail(text, expr.at, PARSER_SENTENCES.measure);
  return value as NearestSpec["distanceMeasure"];
}

function nearestOf(call: Call, text: string): NearestSpec {
  const [options] = call.args;
  if (call.args.length !== 1 || options.t !== "object") throw fail(text, call.at, PARSER_SENTENCES.nearestShape);
  let field: FieldRef | undefined;
  let queryVector: number[] | undefined;
  let limit: number | undefined;
  let distanceMeasure: NearestSpec["distanceMeasure"] | undefined;
  let distanceResultField: FieldRef | undefined;
  let distanceThreshold: number | undefined;
  for (const entry of options.entries) {
    switch (entry.key) {
      case "vectorField":
        field = fieldRefOf(entry.value, text);
        break;
      case "queryVector":
        queryVector = queryVectorOf(entry.value, text);
        break;
      case "limit":
        limit = Number(integerOf(entry.value, text, "findNearest() limit"));
        break;
      case "distanceMeasure":
        distanceMeasure = measureOf(entry.value, text);
        break;
      case "distanceResultField":
        distanceResultField = fieldRefOf(entry.value, text);
        break;
      case "distanceThreshold":
        distanceThreshold = numberOf(entry.value, text, "distanceThreshold");
        break;
      default:
        throw fail(text, entry.keyAt, PARSER_SENTENCES.nearestOption(entry.key));
    }
  }
  if (field === undefined) throw fail(text, call.at, PARSER_SENTENCES.nearestMissing("vectorField"));
  if (queryVector === undefined) throw fail(text, call.at, PARSER_SENTENCES.nearestMissing("queryVector"));
  if (limit === undefined) throw fail(text, call.at, PARSER_SENTENCES.nearestMissing("limit"));
  if (distanceMeasure === undefined) throw fail(text, call.at, PARSER_SENTENCES.nearestMissing("distanceMeasure"));
  return {
    field,
    queryVector,
    limit,
    distanceMeasure,
    ...(distanceResultField === undefined ? {} : { distanceResultField }),
    ...(distanceThreshold === undefined ? {} : { distanceThreshold }),
    at: call.at,
  };
}

function aggregationsOf(call: Call, text: string): AggregationSpec[] {
  const [spec] = call.args;
  if (call.args.length !== 1 || spec.t !== "object") throw fail(text, call.at, PARSER_SENTENCES.aggregateShape);
  return spec.entries.map((entry) => {
    const { op, field } = aggregateOf(entry.value, text);
    return field === undefined
      ? { key: entry.key, op, at: entry.keyAt }
      : { key: entry.key, op, field, at: entry.keyAt };
  });
}

function explainOf(call: Call, text: string): ExplainCall {
  if (call.args.length === 0) return { analyze: false, at: call.at };
  const [options] = call.args;
  if (call.args.length === 1 && options.t === "object" && options.entries.length === 0)
    return { analyze: false, at: call.at };
  const entry = options.t === "object" && options.entries.length === 1 ? options.entries[0] : undefined;
  const value = entry?.key === "analyze" && entry.value.t === "word" ? entry.value.name : undefined;
  if (call.args.length !== 1 || (value !== "true" && value !== "false"))
    throw fail(text, call.at, PARSER_SENTENCES.explainShape);
  return { analyze: value === "true", at: call.at };
}

function fromQuery(chain: QueryChain, call: Call, text: string, allowed: string): Chain {
  const { source, ops } = chain;
  const next: Chain = { s: "query", source, ops };
  switch (call.name) {
    case "where":
      notAfterCursor(ops, call, text);
      if (call.args.length === 1) ops.where.push(filterOf(call.args[0], text));
      else if (call.args.length === 3)
        ops.where.push(compareNode(call.args[0], call.args[1], call.args[2], call.at, text));
      else throw fail(text, call.at, PARSER_SENTENCES.whereArguments);
      return next;
    case "orderBy": {
      notAfterCursor(ops, call, text);
      if (call.args.length !== 1 && call.args.length !== 2) {
        throw fail(text, call.at, PARSER_SENTENCES.arguments("orderBy()", "a field and an optional direction"));
      }
      const direction = call.args.length === 2 ? directionOf(call.args[1], text) : "ASCENDING";
      ops.orderBy.push({ field: fieldRefOf(call.args[0], text), direction });
      return next;
    }
    case "limit":
    case "offset": {
      const arg = one(call, text);
      const value = { value: Number(integerOf(arg, text, `${call.name}()`)), at: arg.at };
      if (call.name === "limit") ops.limit = value;
      else ops.offset = value;
      return next;
    }
    case "limitToLast":
      throw fail(text, call.at, PARSER_SENTENCES.limitToLast);
    case "startAt":
    case "startAfter":
    case "endAt":
    case "endBefore": {
      if (call.args.length === 0) throw fail(text, call.at, PARSER_SENTENCES.cursorValues(call.name));
      const values = call.args.map((arg) => literalOf(arg, text));
      const bound: CursorBound = { values, before: call.name === "startAt" || call.name === "endBefore", at: call.at };
      if (call.name.startsWith("start")) ops.start = bound;
      else ops.end = bound;
      ops.cursorAt ??= call.at;
      return next;
    }
    case "select":
      ops.select = call.args.map((arg) => fieldRefOf(arg, text));
      return next;
    case "findNearest":
      return { s: "vector", source, ops, nearest: nearestOf(call, text) };
    case "count":
      none(call, text);
      return { s: "aggregation", source, ops, aggregations: [{ key: "count", op: "count", at: call.at }] };
    case "aggregate":
      return { s: "aggregation", source, ops, aggregations: aggregationsOf(call, text) };
    case "explain":
      return end(queryStatement(chain, explainOf(call, text)), call);
    case "get":
      none(call, text);
      return end(queryStatement(chain), call);
    default:
      throw fail(text, call.at, PARSER_SENTENCES.notOn(call.name, "a query", allowed));
  }
}

function fromTerminal(chain: Extract<Chain, { s: "vector" | "aggregation" }>, call: Call, text: string): Chain {
  if (call.name === "get") {
    none(call, text);
    return end(terminalStatement(chain), call);
  }
  if (call.name === "explain") return end(terminalStatement(chain, explainOf(call, text)), call);
  const noun = chain.s === "vector" ? "a vector query" : "an aggregation";
  throw fail(text, call.at, PARSER_SENTENCES.notOn(call.name, noun, "get() or explain()"));
}

function step(chain: Chain, call: Call, text: string): Chain {
  switch (chain.s) {
    case "end":
      throw fail(text, call.at, PARSER_SENTENCES.afterEnd(chain.name));
    case "db":
      return fromDb(call, text);
    case "document":
      return fromDocument(chain, call, text);
    case "collection":
      return fromCollection(chain, call, text);
    case "query":
      return fromQuery(chain, call, text, ALLOWED.query);
    case "vector":
    case "aggregation":
      return fromTerminal(chain, call, text);
  }
}

/** The statement an unfinished chain runs as: spec 5.4's implicit get(). */
function finish(chain: Chain, text: string, endAt: number): Statement {
  switch (chain.s) {
    case "db":
      throw fail(text, endAt, PARSER_SENTENCES.emptyChain);
    case "end":
      return chain.statement;
    case "document":
      return { kind: "getDocument", path: chain.path, at: chain.at };
    case "collection":
    case "query":
      return queryStatement(chain);
    case "vector":
    case "aggregation":
      return terminalStatement(chain);
  }
}

/** One console statement: `[await] db { .call(...) } [;]`, read into a typed statement or refused with a position. */
export function parseStatement(text: string): Statement {
  const reader = new Reader(text, lex(text));
  refuseLeadingNearMiss(reader);
  if (reader.isIdent("await")) {
    reader.next();
    refuseLeadingNearMiss(reader);
  }
  if (!reader.isIdent("db")) throw reader.fail(reader.peek().start, PARSER_SENTENCES.root);
  reader.next();
  let chain: Chain = { s: "db" };
  while (reader.isPunct(".")) {
    reader.next();
    const name = reader.peek();
    if (name.kind !== "identifier") throw reader.fail(name.start, PARSER_SENTENCES.expected("a method name"));
    reader.next();
    if (RUNS_ITSELF.has(name.text)) throw reader.fail(name.start, PARSER_SENTENCES.runsItself);
    if (WRITES.has(name.text)) throw reader.fail(name.start, PARSER_SENTENCES.readOnly);
    if (!reader.isPunct("(")) throw reader.fail(reader.peek().start, PARSER_SENTENCES.parens(name.text));
    reader.next();
    chain = step(chain, { name: name.text, at: name.start, args: parseList(reader, ")") }, text);
  }
  if (reader.isPunct(";")) reader.next();
  const rest = reader.peek();
  if (rest.kind === "identifier") throw reader.fail(rest.start, PARSER_SENTENCES.oneChain);
  if (rest.kind !== "eof") throw reader.fail(rest.start, PARSER_SENTENCES.expected('"." or the end of the statement'));
  return finish(chain, text, rest.start);
}
