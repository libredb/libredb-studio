import type { NonFiniteWord } from "@/lib/non-finite";

/**
 * The SQL writing contract: what one engine states about the literals, identifiers and
 * binds a generated statement spells for it.
 *
 * This is the values subset, the inline edit fields, `InlineEditSpec`, and the result export's
 * SQL forms, `ExportSpec`.
 *
 * Every fact is required. A `null` is an answer, not an omission: it says the engine has
 * no form of that kind, and the reader turns it into today's fallback.
 */
export interface SqlWritingSpec {
  /** The whole quoted literal for `text`, prefix included where the engine needs one. */
  readonly escapeLiteral: (text: string) => string;
  /** The value of a whole literal as the engine reads it, or `undefined` when `literal` is not exactly one. */
  readonly unescapeLiteral: (literal: string) => string | undefined;
  /** The name quoted and escaped so its closing quote character cannot end it. */
  readonly quoteIdentifier: (name: string) => string;
  /** The bind placeholder for the 1-based `position`, or `null` where the engine quotes the value instead. */
  readonly placeholder: ((position: number) => string) | null;
  /** A date or timestamp text as this engine's literal of that kind, or `undefined` to quote it; `null` always quotes. */
  readonly temporalLiteral: ((text: string, kind: "date" | "timestamp") => string | undefined) | null;
  /** The key column kinds and bound edit the inline editor reads for this engine. */
  readonly inlineEdit: InlineEditSpec;
  /** The CREATE TABLE types and INSERT literals the result export writes for this engine. */
  readonly export: ExportSpec;
  /**
   * The request that inserts `documents` at `address`, for an engine whose console text is a JSON request rather than
   * a statement; the test data generator writes it in place of an INSERT. Absent where the engine declares none.
   */
  readonly insertDocuments?: (
    address: Readonly<Record<string, unknown>>,
    documents: readonly Readonly<Record<string, unknown>>[],
  ) => string;
}

/**
 * What one engine states about the inline edit's key columns and the value an edit writes.
 *
 * A key column's declared type is read down to its first word, and that word is looked up
 * here. The shared sets in `./shared` are the words most engines use; an engine that wants
 * one imports it by name.
 */
export interface InlineEditSpec {
  /** Type names that make a key column date-time. */
  readonly instantTypeNames: ReadonlySet<string>;
  /** Type names that make a key column exact decimal. */
  readonly exactDecimalTypeNames: ReadonlySet<string>;
  /** Type names that make a key column float64, or "all" where every declared key is float64. */
  readonly float64TypeNames: ReadonlySet<string> | "all";
  /** The SET right-hand side for one non-NULL edit, or undefined to bind the text unchanged. */
  readonly boundEdit?: (
    text: string,
    declaredType: string | undefined,
    bind: (value: string) => string,
  ) => string | undefined;
}

/** The kinds of column a value can be inferred to be, before an engine spells them. */
export type InferredKind = "text" | "integer" | "numeric" | "boolean" | "timestamp" | "binary";

/** The generic writer, for a scalar inside a composite value. */
export type ScalarLiteral = (value: unknown) => string;

/** One cell written from its column's declared type, or `undefined` to leave it to the generic writer. */
export type TypedWriter = (value: unknown, declared: string | undefined, scalar: ScalarLiteral) => string | undefined;

/** One column's literal writer, prepared from its declared type; undefined hands the cell to the generic writer. */
export type ColumnWriter = (value: unknown) => string | undefined;

/** The patterns a declared type is read with before the export decides how to write its cells. */
export interface ExportTypeVocabulary {
  /** The bare names that narrow below the value the wire hands back, each with the family it is re-spelled from. */
  readonly bareTypeFamily: Readonly<Record<string, InferredKind>>;
  /** A declared type that holds a binary float, spelled the way the providers report it. */
  readonly floatType: RegExp;
  /** The exact numeric types that can hold an infinity, with or without a precision. */
  readonly exactNumericType: RegExp;
  /** The wrappers that change nothing about whether the column holds numbers. */
  readonly numericWrapper: RegExp;
}

/**
 * What one engine states about the result export's SQL forms: the CREATE TABLE types and
 * the INSERT literals a generated file spells for it.
 */
export interface ExportSpec {
  /**
   * How the engine spells the inferred kinds, total over the six. The generic set is not
   * portable, and the statement is meant to be run against the engine it was read from;
   * engines on the standard spelling import `STANDARD_DDL_TYPES`.
   */
  readonly ddlTypes: Readonly<Record<InferredKind, string>>;
  /** The bare names the engine stands behind, so they are written through verbatim. */
  readonly standsAlone: readonly string[];
  /**
   * The bare names the engine narrows below the value its own driver hands back, each with
   * the spelling written instead, so the INSERT written beside the CREATE TABLE neither
   * fails nor rounds.
   */
  readonly bareSpelling: Readonly<Record<string, string>>;
  /** The patterns a declared type is read with, per engine. */
  readonly typeVocabulary: ExportTypeVocabulary;
  /** A binary value as a literal the engine accepts; there is no portable spelling. */
  readonly binaryLiteral: (bytes: Uint8Array) => string;
  /** NaN and the infinities as the engine reads them back into a float column; engines that write NULL import `NULL_NON_FINITE`. */
  readonly nonFinite: Readonly<Record<NonFiniteWord, string>>;
  /** Whether an INSERT is written `INSERT INTO t (...) VALUES (...);` or `INSERT INTO t (...) SELECT ...;`. */
  readonly insertForm: "values" | "select";
  /** A rewrite of a declared type the engine needs before a CREATE TABLE takes it, ahead of the bare-name completion. */
  readonly rewriteDeclared?: (declared: string) => string;
  /** A column type from the first sample; a defined result is the declaration, ahead of the bare-name completion. */
  readonly declareFromSample?: (declared: string, sample: unknown) => string | undefined;
  /** A literal that depends on the declared type, for the cells the generic writer spells in a form the engine refuses. */
  readonly typedLiteral?: TypedWriter;
  /** Per-column literal writers prepared from the declared types. */
  readonly columnWriters?: (declared: readonly (string | undefined)[]) => readonly (ColumnWriter | undefined)[];
  /** A key the result cannot supply: the note prepended to CREATE TABLE and the definition added. */
  readonly createTableKey?: { readonly note: string; readonly clause: (quotedColumns: readonly string[]) => string };
}
