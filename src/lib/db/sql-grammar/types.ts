/**
 * The contract every SQL-reading engine fills in once: its grammar facts plus the
 * per-engine readings that sit beside them today (redaction, the update-target
 * reader and completion quoting). Every field of `SqlGrammarSpec` is required, so an engine states
 * each of these rather than inheriting one from a base object. `SqlGrammar` itself is unchanged by
 * the move and still has optional facts (`dollarTags`, `rawStrings`, `confirmForms` and others),
 * which its readers default when a grammar leaves them out.
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
  /** Whether the engine supports a `TOP <n>` or `TOP (<expr>)` row-count clause directly after `SELECT`. */
  readonly supportsTopClause: boolean;
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
  readonly redaction: SqlRedaction;
  readonly updateTarget: UpdateTargetGrammar;
  readonly completion: CompletionQuoting;
}
