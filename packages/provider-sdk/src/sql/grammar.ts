/**
 * The SQL grammar facts: what a handful of characters and forms mean in one engine's SQL, the type Studio's SQL
 * readers in `src/lib/sql/` read a statement's structure with (docs/providers/CONTRACT.md, "SQL grammar").
 *
 * Each engine states its facts in a grammar row beside its provider, and Studio resolves the row by engine id
 * (`resolveSqlGrammar` in `src/lib/sql/grammar.ts`), whose module header gives the two rules the facts keep. This
 * module holds what needs no row: the type, the compatibility default a call naming no dialect reads with, and
 * the one reading of a grammar that needs nothing but the grammar.
 */

/**
 * What a `#` opens.
 *
 * - `comment` - it opens a line comment, always. MySQL, MariaDB, ClickHouse.
 * - `code` - it never opens one; it is an operator character, part of an
 *   identifier, or a variable prefix. PostgreSQL, Oracle, SQL Server, SQLite.
 * - `comment-unless-operator` - the compatibility default, and neither of the
 *   honest readings: a comment unless the next character makes a PostgreSQL
 *   jsonb/geometric operator. It is what Studio's SQL readers in `src/lib/sql/` did before the dialect
 *   reached them, and it is kept exactly so that a call naming no dialect answers
 *   what it always answered.
 */
export type HashGrammar = "comment" | "code" | "comment-unless-operator";

/**
 * What a `[…]` run is.
 *
 * - `quoted-identifier` - everything between the brackets is a NAME and the run
 *   does not nest. SQL Server, SQLite. The doubled `]` this reading honours is SQL
 *   SERVER's escape; SQLite's own tokenizer stops at the first `]` and has no
 *   escape at all, so this reads `[a]]b]` as one name where SQLite reads `[a]`
 *   followed by junk. SQLite rejects that text either way, so the longer reading
 *   can only cost a bound on a statement the server refuses - the fail-safe
 *   direction, pinned by a test in the SQLite provider suite rather than left to
 *   be discovered. Since #297 it can cost that statement a confirmation prompt as
 *   well, where the doubled bracket swallows the real closer and the run therefore
 *   never terminates (`SELECT [a]] FROM t`).
 * - `subscript` - an array literal or a subscript. It NESTS, nothing inside it is
 *   escaped, and a literal inside it is a literal. ClickHouse, PostgreSQL.
 *
 * The two are mutually exclusive rather than two spellings of one rule, which is
 * why this is a dialect fact and not something the text could settle: `['a]b']` is
 * a subscript whose key carries a close bracket under one reading and a name that
 * ends at that bracket under the other, and `[a]]b]` is one name under the first
 * and a closed run followed by junk under the second.
 */
export type BracketGrammar = "quoted-identifier" | "subscript";

/**
 * Where a block comment ENDS when a second `/*` is written inside it.
 *
 * - `flat` - the first `*\/` closes the run, whatever is inside it. MySQL,
 *   MariaDB, SQLite, Oracle.
 * - `nesting` - a `/*` inside a comment opens another one, so the run continues
 *   until the depth returns to zero. PostgreSQL, SQL Server, ClickHouse. A run
 *   short of a closer is then undeterminable rather than closed early, which costs
 *   a bound and asks for a confirmation instead of hiding a write.
 *
 * The two readings put the comment's end in different places, and everything
 * between the first `*\/` and the real end is either comment text or the
 * statement's own code depending on which one applies - so a `)` written there
 * either closes a CTE body or does not, and the keyword that types the statement
 * changes with it (#300).
 */
export type BlockCommentGrammar = "flat" | "nesting";

/**
 * Which statements carry a procedural BODY, inside which a `;` ends a body statement
 * rather than the statement the engine receives.
 *
 * - `none` - no statement does, or every body is a literal the span reader already
 *   holds whole (PostgreSQL's `$$ … $$`). Every `;` that is code ends a statement.
 * - `trigger-body` - `CREATE [TEMP|TEMPORARY] TRIGGER … BEGIN … END` is the one
 *   statement with a body. SQLite and libSQL. `BEGIN` alone stays the statement that
 *   opens a transaction there, which is why this is not `pl-sql`.
 * - `pl-sql` - an anonymous block (`DECLARE` or `BEGIN` first) and every
 *   `CREATE [OR REPLACE] PROCEDURE | FUNCTION | PACKAGE [BODY] | TRIGGER | TYPE BODY`
 *   is one PL/SQL unit, and the `;` after its closing `END` belongs to the unit:
 *   Oracle refuses the unit without it (`PLS-00103`, "end-of-file"). Oracle.
 */
export type ProceduralBlockGrammar = "none" | "trigger-body" | "pl-sql";

/**
 * How a SCRIPT is cut into what the engine receives, beyond the `;` the span rules
 * already find. Three facts, held together because the splitter reads them together and
 * a dialect that has none of them is one value (`DEFAULT_SQL_GRAMMAR.script`).
 */
export interface ScriptGrammar {
  readonly blocks: ProceduralBlockGrammar;
  /**
   * A line holding only this token (case-insensitive, then optional blanks and a `--`
   * comment) ends the statement in progress and is never sent: `GO` is sqlcmd's and
   * SSMS's batch separator, `/` is SQL*Plus's "run the buffer". Inside a literal or a
   * comment it is text like any other. `GO 5`, sqlcmd's repeat count, is not read as a
   * separator: it reaches the server, which refuses it, rather than running once where
   * five runs were asked for.
   */
  readonly separatorLine: "GO" | "/" | null;
  /**
   * What ONE request to the engine carries.
   *
   * - `statement` - one statement per request, which is how every engine but one here is
   *   driven.
   * - `batch` - everything between two separator lines, sent whole. T-SQL scopes a
   *   variable to its batch and a `#temp` table to its session, and the provider borrows
   *   a pooled connection per request, so a `DECLARE @x` sent apart from the `SELECT @x`
   *   after it is gone by then (`Must declare the scalar variable "@x"`, measured on SQL
   *   Server 2025). A `CREATE PROCEDURE` body likewise runs to the end of its batch.
   */
  readonly unit: "statement" | "batch";
  /**
   * The operative keywords whose statement the engine refuses without its own terminating `;`, so the splitter keeps
   * that `;` on the statement instead of dropping it. T-SQL's `MERGE` (Msg 10713, "A MERGE statement must be
   * terminated by a semi-colon (;)", measured on SQL Server 2025 and through sqlcmd, SF-046). Absent means none: every
   * statement drops its `;`.
   */
  readonly terminatedStatements?: readonly string[];
}

/** The grammar facts that differ between the engines this product supports. */
export interface SqlGrammar {
  readonly hash: HashGrammar;
  readonly bracket: BracketGrammar;
  readonly blockComment: BlockCommentGrammar;
  /**
   * Whether `q'…'` opens a string literal - Oracle's alternate quoting.
   *
   * Not a disagreement about a character like `hash` is, but a form ONE dialect
   * has: `q'{it's}'` is how Oracle writes a literal carrying apostrophes without
   * doubling them, and everywhere else those characters really are a name
   * followed by an ordinary string. So the fact is whether the reader has the
   * form at all, and reading it where the dialect does not have it would take a
   * literal out of ordinary code.
   */
  readonly alternateQuoting: boolean;
  /**
   * Whether `//` opens a line comment.
   *
   * A form some dialects simply HAVE rather than a disagreement about a character,
   * the same shape of question as `alternateQuoting` - except that engines with
   * unrelated lexers have this one: where it holds, `//` runs to the end of the line,
   * and elsewhere those two characters are refused outright or - in PostgreSQL,
   * where `//` is a real operator NAME - are code the server tries to resolve.
   *
   * It is the fact this record said it could not carry, and the splitter is where
   * that cost was live rather than merely inconvenient. A comment is what a `;` can
   * hide inside, `src/lib/sql/statement-splitter.ts` reads its boundaries through `spans.ts`,
   * and `/api/db/multi-query` RUNS every fragment the splitter returns - so on the
   * engines that have the form, `SELECT … // note; DROP …` was cut into a read
   * and a bare DROP out of text the server reads as one statement. Measured, not
   * argued: the probes are quoted on the engines' grammar rows and in `tests/unit/sql/grammar.test.ts`.
   */
  readonly doubleSlashComment: boolean;
  /**
   * Whether a backslash ALWAYS escapes the next character inside `'…'` and `"…"`.
   *
   * Where it does, `\x` is one escaped pair and `'it\'s'` is a terminated literal, except
   * that a backslash before a line feed is no pair and leaves the literal unterminated:
   * Databend's string token (`token.rs`) escapes with `\\.`, whose `.` excludes a line
   * feed but matches a carriage return. Where
   * this is false the span reader keeps its dialect-independent answer: a closing quote
   * behind an odd backslash run is undeterminable, because some dialects escape there and
   * others close the literal, and guessing moves the end of every construct after it.
   * Backtick and bracket runs never take the escape.
   *
   * True only on a row whose lexer escapes with a backslash in both quotes under every
   * session setting. MySQL is the dialect that escapes by default, and it is still
   * false there: `NO_BACKSLASH_ESCAPES` in `sql_mode` turns the escape off per session, so
   * no row can state it for every connection (BACKLOG S2).
   */
  readonly backslashAlwaysEscapes: boolean;
  /**
   * Whether `'''…'''` and `"""…"""` are string literals that run to the next unescaped triple, newlines and lone
   * quotes included. GoogleSQL's form, and the only dialect here with it; absent means false.
   *
   * It is a fact the text cannot settle: `'''a'b'''` is one literal where the doubling rule reads an empty string, a
   * quote and a string, so a `;` or a `DROP` after the lone quote would be code under that reading.
   */
  readonly tripleQuotedStrings?: boolean;
  /**
   * Whether a backslash escapes the next character inside a backtick identifier (a\`b is one name). Absent means
   * false, and only a doubled backtick escapes; where true, a doubled backtick still escapes too.
   *
   * It is a fact the text cannot settle: `a\` WHERE x = '` is one identifier here and an identifier plus code
   * under the doubling reading, so a `;` after it would hide inside the name or run as a statement.
   */
  readonly backtickBackslashEscapes?: boolean;
  /**
   * Whether a tagged run (`$tag$ … $tag$`, the tag non-empty) is a string literal; absent means true, the reading
   * every row had before the fact existed, which deliberately inverts its neighbours' absent-means-false because the
   * fact is an opt-out. False: the `$` that would open a tagged run is code, and the untagged `$$ … $$` is still a
   * dollar string.
   *
   * It is a fact the text cannot settle: `$t$x; DELETE FROM t; $t$` is one string where the tagged form exists and
   * code holding a `DELETE` where it does not, so under the wrong reading the `DELETE` would hide inside a literal
   * or a string would be cut into statements.
   */
  readonly dollarTags?: boolean;
  /**
   * Whether a backslash escapes the next character inside `"…"`; absent means the reading `backslashAlwaysEscapes`
   * gives both quotes. False: a backslash there is an ordinary character, so `"a\"` is a terminated name. True: it
   * escapes there.
   *
   * It is a fact the text cannot settle: `"a\"; DELETE FROM t --"` is a name and a DELETE where the backslash is part
   * of the name, and one quoted run to the trailing quote where it escapes.
   */
  readonly doubleQuoteBackslashEscapes?: boolean;
  /**
   * Whether a backslash escapes the next character inside `'…'`; absent means the reading `backslashAlwaysEscapes`
   * gives both quotes. False: a backslash there is an ordinary character, so `'a\'` is a terminated string. True: it
   * escapes there.
   *
   * It is a fact the text cannot settle: `'a\' FROM ".x" --'` is a string and code naming `.x` where the backslash is
   * ordinary, and one string to the trailing quote where it escapes.
   */
  readonly singleQuoteBackslashEscapes?: boolean;
  /**
   * Whether `r'...'`, `R'...'`, `r"..."` and `R"..."` are string literals that take no escapes and end at the first
   * quote of their own kind, line feeds included; absent means false. Only where the `r` does not continue a word:
   * the engine's lexer takes the longest token, so `abr'x'` is a name followed by a string.
   *
   * It is a fact the text cannot settle: `r'C:\'` is a closed literal where the form exists and an escaping literal
   * that never closes where it does not, so a `;` or a `DROP` written after it is code under one reading and string
   * text under the other.
   */
  readonly rawStrings?: boolean;
  /**
   * Whether `/*+` opens an optimizer hint the engine lexes as code rather than a block comment; absent means false.
   * Where true, `/*+` at a code position opens no span, so the hint's opener, its body and its closing `*\/` are read
   * as code, with strings and comments inside it read as spans, and inside a nesting block comment a `/*+` opens no
   * nested level. The engine lexes every `*\/` in code as that closer, so a `/` right after a code `*` opens no comment
   * either: `*\/*` is the closer and a `*`.
   *
   * It is a fact the text cannot settle: in `/* a /*+ b *\/ DELETE FROM t; -- *\/`, a nesting reader that counts the
   * `/*+` keeps the DELETE inside the comment, while the engine ends the comment at the first `*\/` and runs it.
   */
  readonly hintsAreCode?: boolean;
  /**
   * Whether a line comment continues onto the next line when a backslash stands immediately before the line feed
   * that would end it, as often as its lines end so; absent means false. A backslash before a carriage return and line
   * feed does not continue it, and a backslash anywhere else in the line is comment text.
   *
   * It is a fact the text cannot settle: in `WITH c AS (SELECT 1 -- note \`, a line feed, `) SELECT 1 --`, a line
   * feed and `) DELETE FROM u`, the second line is comment text where the fact holds, so the statement is a CTE-led
   * DELETE, and code where it does not, so it reads as a SELECT.
   */
  readonly lineCommentBackslashContinues?: boolean;
  /**
   * Whether a carriage return ends a line comment as a line feed does, with the line feed right after it when one
   * follows, so a carriage return and line feed end it once; absent means false, and a carriage return is then comment
   * text. A backslash before a carriage return does not continue the comment, under `lineCommentBackslashContinues` too.
   *
   * It is a fact the text cannot settle: in `WITH c AS (SELECT 1) -- note`, a carriage return, `INSERT INTO u`, a line
   * feed and `SELECT 1`, the second line is code where the fact holds, so the statement is a CTE-led INSERT, and
   * comment text where it does not, so it reads as a SELECT.
   */
  readonly lineCommentEndsAtCarriageReturn?: boolean;
  /**
   * How a script is cut into the units the engine receives (E2E pass of 2026-10-03/04,
   * #1312). Before this fact existed every code `;` was a boundary in every dialect, so a
   * PL/SQL procedure, a SQLite trigger and a T-SQL batch were each cut at their inner `;`
   * and the multi-statement route RAN the fragments: Oracle stored the procedure INVALID
   * while the route reported its first fragment `success`.
   */
  readonly script: ScriptGrammar;
  /**
   * Clauses that must FOLLOW the row bound on this dialect (#1398).
   *
   * Each entry is a pattern that matches ONE such clause at the very END of a
   * statement - leading whitespace, the clause's own words, `\s*` to the end - and
   * the shared limiter does two things with them: it places the bound BEFORE the
   * run it matches, re-attaching the matched text verbatim, and it reads an
   * existing bound followed by such a run as the bound it is. Without the
   * declaration the limiter appends, so on the dialects that have one of these
   * clauses every bounded read was refused outright: Materialize
   * `Expected end of statement, found LIMIT`, ScyllaDB `line 1:38 : Syntax error`.
   *
   * Every pattern opens with `\s+`: the limiter anchors it behind a non-space, so
   * a match starts only where a whitespace run starts and a long run is read once
   * instead of once per character. A run longer than 64 clauses is refused.
   *
   * The patterns accept word-runs alone, and where the clause carries an argument
   * (Materialize's timestamp, ScyllaDB's duration) it is a number, a single-quoted
   * literal or one bracket-free token - never a free expression - so a closing
   * quote or a `)` after it always ends the match. That is what keeps a
   * clause-shaped run inside a literal (`… WHERE note = 'BYPASS CACHE'`), an alias
   * followed by statement text (`SELECT a AS of FROM t`) and a clause written
   * inside a subquery (`… (SELECT … AS OF 123) t`) from reading as the clause.
   *
   * Empty on every row whose dialect has no such clause. A dialect without a clause
   * keeps today's answer for its words: the limiter appends after them and the
   * engine refuses the statement, which it refused before the bound was there too.
   */
  readonly trailingLimitClauses: readonly RegExp[];
  /**
   * The values other than a digit run this dialect accepts as a `LIMIT` or `FETCH` count and as an `OFFSET`, each
   * spelled as the statement writes it (a word is matched in any case). A count among them means no limit and an
   * offset among them skips nothing, so the shared limiter reads `LIMIT <value>` as the statement's own bound and
   * appends none. Absent means none: every other dialect keeps reading only digits, and a second `LIMIT` after such
   * a value is that engine's own refusal, as it was before.
   */
  readonly nonNumericRowBounds?: readonly string[];
  /**
   * Keyword sequences that ask for a confirmation when they OPERATE a statement, read where the shared
   * dangerous-keyword set is read: at the operative keyword, after leading comments, labels and a `WITH` clause, and
   * anywhere in the code of a control-flow block. Words are compared case-insensitively and may be separated by
   * comments. For a dialect whose own destructive or billed forms are not in the shared set; absent means none.
   */
  readonly confirmForms?: readonly (readonly string[])[];
  /**
   * Forms that ask for a confirmation wherever they appear in a statement's code, strings and comments skipped: a
   * word sequence, the start of an identifier (`{ prefix: "SYSTEM$" }` matches `SYSTEM$CLUSTERING_INFORMATION`),
   * a word whose next code, past whitespace and comments, is a string literal (`{ wordThenLiteral: "USING" }`
   * matches `TRANSFORM (a) USING 'cat'` and not `JOIN u USING (id)`), a word whose next code is a routine body, a string
   * literal or a dollar-quoted run (`{ wordThenBody: "DO" }` matches `DO $$ ... $$` and not `ON CONFLICT DO NOTHING`),
   * a closed quoted name whose text is the name,
   * compared without case, that a `(` follows (`{ quotedCall: "REFLECT" }` matches `` `Reflect`('a') ``), a word
   * followed by a parenthesised run and then a `(` (`{ computedCall: "IDENTIFIER" }` matches `IDENTIFIER('f')(1)`, a
   * call whose function name the run computes), or a dollar-quoted run, read at each character (`{ dollarQuoted: true }`
   * matches `$$...$$` and `$tag$...$tag$`, a body the gate does not read). Absent means none.
   */
  readonly confirmCodeForms?: readonly ConfirmCodeForm[];
  /**
   * Keyword sequences that ask only when the code word `when` also appears in the statement's code after them, read
   * where `confirmForms` is read. For a form harmless in one variant and not in the other, which a word of the
   * statement tells apart: Snowflake's `CREATE STAGE` keeps files in the account unless it names a `URL`. Absent means
   * none.
   */
  readonly confirmFormsWhen?: readonly ConfirmFormWhen[];
  /**
   * Keyword sequences led by a shared dangerous keyword that do NOT ask on this dialect, read where that keyword is
   * read: at the operative keyword and inside a control-flow block. For a form whose effect cannot outlive the
   * statement on this engine: Snowflake runs each statement in its own session, so `ALTER SESSION SET` changes nothing
   * a later statement sees. Absent means none, and every shared keyword asks. Each form is a claim that loosens the
   * confirmation gate, so the gate counts a form only where Studio's review record lists it
   * (`CONFIRMATION_CLAIM_REVIEW` in `@/lib/db/confirmation-claim-review`), and reads any other form as if it were not
   * declared.
   */
  readonly confirmExemptForms?: readonly (readonly string[])[];
  /**
   * The sql-formatter language the editor's Format uses for this dialect. Absent means `postgresql`, the language
   * every dialect formatted with before a dialect declared one (SF-041).
   */
  readonly formatterLanguage?: "snowflake";
  /**
   * Keywords and functions the editor's completion offers on this dialect beside the shared lists (SF-042). A function
   * is inserted as a call. Absent means the shared lists alone.
   */
  readonly completionWords?: { readonly keywords: readonly string[]; readonly functions: readonly string[] };
  /**
   * Session configuration keys whose SET or RESET asks for a confirmation, compared without case; an entry ending in
   * `.` matches every key under it. Read where the operative keyword is SET or RESET, past white space and comments,
   * which Spark's lexer hides; white space is every character JavaScript's `\s` matches and every character at or
   * below U+0020. A key in backticks, or in double quotes where Spark reads double quotes as identifier quotes
   * (`spark.sql.ansi.enabled` and `spark.sql.ansi.doubleQuotedIdentifiers` both on), is one token, as Spark's
   * `configKey` rule reads it: its inner text, a doubled quote collapsed to one, and nothing after the closing quote.
   * Studio reads double quotes that way under every setting, so such a key asks whether or not the session reads it
   * as a key. Any other key is the code text up to `=`, white space, `;` or the end, as Spark's `String.trim` of that
   * text reads it. A SET asks only when `=` follows the key, past white space and comments, since a SET without `=`
   * only shows the key's value; a RESET of a listed key asks, and so does a RESET with no key, which restores every
   * key. Absent means none.
   */
  readonly confirmConfigKeys?: readonly string[];
  /**
   * Whether `EXPLAIN ANALYZE` executes the explained statement.
   *
   * True on PostgreSQL: `EXPLAIN` only plans unless `ANALYZE` (or the British `ANALYSE`) is enabled, and then it runs
   * the statement. CockroachDB connections are the `postgres` type-id and share that grammar. Absent means false, and
   * a plain `EXPLAIN` describes without running, so the confirmation gate must not treat the word `EXPLAIN` itself as
   * a write and must not ask about a statement that is only planned.
   *
   * It is a fact the text cannot settle: `EXPLAIN ANALYZE DELETE FROM t` deletes the rows where the option executes
   * and is a plan where it does not, so under the wrong reading the `DELETE` would run with no confirmation, or a
   * plan would ask.
   */
  readonly explainExecutesWithAnalyze?: boolean;
}

/** A form `SqlGrammar.confirmFormsWhen` looks for: a keyword sequence and the code word that makes it ask. */
export interface ConfirmFormWhen {
  readonly form: readonly string[];
  readonly when: string;
}

/**
 * A form `SqlGrammar.confirmCodeForms` looks for: a word sequence, an identifier prefix, a word a literal follows, a
 * word a routine body follows, a quoted name called as a function, a word whose parenthesised run names the function
 * called, or a dollar-quoted run.
 */
export type ConfirmCodeForm =
  | readonly string[]
  | { readonly prefix: string }
  | { readonly wordThenLiteral: string }
  | { readonly wordThenBody: string }
  | { readonly quotedCall: string }
  | { readonly computedCall: string }
  | { readonly dollarQuoted: true };

/**
 * What a call that names no dialect gets.
 *
 * Deliberately today's reading rather than a stricter "report undeterminable
 * wherever the dialects disagree". The strict default is the more honest one in
 * the abstract, but every fixture written for #275, #280, #287, #291 and #294
 * calls these readers without a dialect, and rewriting the meaning of that whole
 * suite in the same change that introduces the channel would leave nothing
 * pinning the old behaviour. Pinned by its own tests instead, so it is a decision
 * rather than an accident.
 *
 * Frozen to its leaves, so no module that imports it changes it for another: many grammar rows hold this record,
 * its `script` or its `trailingLimitClauses` by identity, and an assignment to one of them throws a TypeError.
 */
export const DEFAULT_SQL_GRAMMAR: SqlGrammar = Object.freeze({
  hash: "comment-unless-operator",
  bracket: "quoted-identifier",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: Object.freeze({ blocks: "none", separatorLine: null, unit: "statement" }),
  trailingLimitClauses: Object.freeze([]),
});

/**
 * Whether a `#` run this grammar read as a comment might be code in the dialect
 * actually meant.
 *
 * `src/lib/sql/statement-end.ts` asks, because it decides whether the statement may be CUT
 * there, and cutting on the wrong reading emits `SELECT * FROM LIMIT 500 #tmp`.
 * Only the compatibility default is ambiguous: the other two readings ARE the
 * dialect's answer, so there is nothing left to be wrong about.
 */
export function hashRunIsAmbiguous(grammar: SqlGrammar): boolean {
  return grammar.hash === "comment-unless-operator";
}
