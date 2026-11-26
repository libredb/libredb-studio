/**
 * What Studio's readers read for one engine's statement text: its grammar facts plus the per-engine readings beside
 * them (the update-target reader and completion quoting). The redaction the query event log keeps a statement by is no
 * member of a row: it is the engine record's grant, composed by `composeStatementRedaction`
 * (src/lib/db/sql-grammar/statement-redaction.ts) into a `SqlRedaction`. Each engine's row is composed from its declaration
 * (src/lib/db/sql-grammar/index.ts, `composeSqlGrammar`; docs/providers/CONTRACT.md, clause M-78), which states every
 * fact, so no engine inherits one from a base object. `SqlGrammar` itself still has optional facts (`dollarTags`,
 * `rawStrings`, `confirmForms` and others), which its readers default when a grammar leaves them out, and the
 * composition leaves out each fact a declaration states at the reading its absence has.
 */
import type { SqlGrammar } from "@libredb/provider-sdk/sql";

/** How a statement is redacted before it reaches the query event log. */
export type SqlRedaction =
  /** SQL text: literals become the placeholder; `nameQuote` is the identifier quote, null where the engine has none. */
  | { readonly kind: "sql"; readonly nameQuote: string | null }
  /** A command language with its own reader. */
  | { readonly kind: "command"; readonly read: (text: string) => string }
  /** Nothing of the text is kept. */
  | { readonly kind: "none" };

/** The grammar facts the update-target reader needs beyond `SqlGrammar`. */
export interface UpdateTargetGrammar {
  /** `--` opens a comment only when a space or control character follows it. */
  readonly dashCommentNeedsSeparator: boolean;
  /** Words besides the shared set that open a query. */
  readonly extraQueryOpeners: ReadonlySet<string>;
  /** Words besides the shared set that join two queries. */
  readonly extraSetOperators: ReadonlySet<string>;
}

/** How completion quotes and reads qualified names. */
export interface CompletionQuoting {
  /** Non-null: used instead of the connection's `quoteSegment`. */
  readonly formatSegment: ((segment: string) => string) | null;
  /** Reads the qualifier before the dot when it is quoted; null where the engine has no such reading. */
  readonly readQuotedQualifier: ((textToDot: string) => string | undefined) | null;
}

export interface SqlGrammarSpec {
  readonly grammar: SqlGrammar;
  /**
   * Whether this engine's statement text is SQL. `false` is a claim that loosens the confirmation gate, which then
   * neither asks about a run the SQL reader cannot read nor reads each statement the text splits into, so the gate
   * counts it only where Studio's review record lists it (`CONFIRMATION_CLAIM_REVIEW` in
   * `@/lib/db/confirmation-claim-review`) and otherwise reads the text as SQL. Every other reader reads it as declared.
   */
  readonly readsSqlText: boolean;
  readonly updateTarget: UpdateTargetGrammar;
  readonly completion: CompletionQuoting;
}

/** A command redaction's reader: from a statement's text, the text the query event log keeps. */
export type CommandRedactionReader = Extract<SqlRedaction, { readonly kind: "command" }>["read"];

/** A completion segment formatter: one name segment quoted as the engine quotes it. */
export type SegmentFormatter = NonNullable<CompletionQuoting["formatSegment"]>;

/** A completion quoted qualifier reader: from the text up to a dot, the qualifier before it when it is quoted. */
export type QuotedQualifierReader = NonNullable<CompletionQuoting["readQuotedQualifier"]>;
