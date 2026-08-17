/**
 * The statement a plan run drafted: read out of its closing prose, and checked
 * before anything offers it (the plan-mode SQL-generator design of 2026-08-15,
 * work item 5; `docs/BACKLOG.md` B44).
 *
 * Plan mode is toolless by construction, so its deliverable cannot arrive as a tool
 * call the way an agent run's `statement-drafted` does — the model's entire output is
 * prose, and the statement is a fenced block inside it. Until this module the block
 * was therefore never a FACT about the run: `src/components/rich-text.tsx` read SQL
 * out of a fence in the BROWSER (#389), which works when the model fences its SQL and
 * silently offers nothing when it does not, and leaves the ledger — the only record
 * that outlives the drive — with no statement in it at all.
 *
 * Two halves, and they are separate MODULES on purpose. Reading a block out of
 * markdown is a decision about TEXT and lives in `plan-draft.ts`; deciding whether that
 * block names tables this database has is a decision about a DATABASE and lives here.
 * Keeping them apart is what lets the verdict (work item 6) ask "did this run produce a
 * statement or an explicit refusal" without an inventory in its hands.
 *
 * They became two files rather than two functions when the rail had to reach the reader
 * (#396). This half imports the shared statement guard, which imports zod v4, which
 * probes `new Function("")` at module load — so a browser that imported this module for
 * its reader took a CSP `script-src` violation on every page showing an agent run. The
 * boundary is `plan-draft.ts` and it is pinned by a test, because a direct-import check
 * is what said this was safe in the first place.
 *
 * What this module deliberately does NOT claim, in code or in the event it feeds:
 *
 *  - **that a validated statement will run.** The inventory records what EXISTS, not
 *    what the user's role may select from, and a least-privilege role can be denied
 *    every table in it. The design says this in item 6 and the model is told it in
 *    its own rules; the field names here (`unknownTables`, not `valid`) say it too.
 *  - **that a read-only classification is a safety claim.** The classification is the
 *    shared guard in `src/lib/db/operations/statement-guard.ts`, whose own docblock
 *    states that a `null` violation means only that THAT layer found nothing. It is
 *    reused rather than reimplemented because two wordings of one rule is precisely
 *    how #350 happened.
 *
 * Nothing here blocks anything. A write is marked, an unknown table is recorded, and
 * the statement still reaches the ledger and the user — the owner ruled on that, and
 * it is consistent with the mode's actual promise: plan mode runs no statement of the
 * user's, and hands every statement it drafts to the user to run themselves.
 */

import { type AgentStatementViolation, inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import type { ProviderCapabilities } from "@/lib/db/types";
import { DEFAULT_SQL_GRAMMAR } from "@/lib/sql/grammar";
import { readSqlSpan, type SqlSpanKind } from "@/lib/sql/spans";
import { readSqlWord } from "@/lib/sql/words";
import type { TableSchema } from "@/lib/types";

// ============================================================================
// Reading the tables a statement names
// ============================================================================

/** Spans that sit BETWEEN tokens, as opposed to spans a name can be made of. */
const TRIVIA_SPANS: ReadonlySet<SqlSpanKind> = new Set(["whitespace", "line-comment", "block-comment"]);

/**
 * The keywords a table name follows, and what may follow the name.
 *
 * `relation` is the FROM/JOIN position, where a name followed by `(` is a
 * table-valued function rather than a table; `target` is the position a write names
 * (`INSERT INTO t (…)`, `UPDATE t SET …`, `DROP TABLE t`), where the very same
 * parenthesis is a column list and dropping the name would lose the one table a write
 * touches. `list` is the comma-separated FROM list, which JOIN has no form of.
 */
const TABLE_KEYWORDS: ReadonlyMap<string, { readonly list: boolean; readonly parenMeansFunction: boolean }> = new Map([
  ["FROM", { list: true, parenMeansFunction: true }],
  ["JOIN", { list: false, parenMeansFunction: true }],
  ["INTO", { list: false, parenMeansFunction: false }],
  ["UPDATE", { list: false, parenMeansFunction: false }],
  ["TABLE", { list: false, parenMeansFunction: false }],
]);

/**
 * Words that occupy a table position without being a table name.
 *
 * Read as "there is no table here" rather than skipped over, which is the direction
 * that costs a MISS instead of a FALSE ALARM: `FROM ONLY film` reports nothing rather
 * than reporting `ONLY` as a table this database does not have. A wrong unknown-table
 * claim shown to a user about a perfectly good statement is the overstatement this
 * whole design item exists to avoid; a missed name is caught by the same reading the
 * user does.
 */
const NOT_A_TABLE_NAME: ReadonlySet<string> = new Set(["ONLY", "LATERAL", "UNNEST", "VALUES", "SELECT", "DUAL"]);

/** Where the next token starts: past whitespace and comments, and nothing else. */
function skipTrivia(sql: string, index: number): number {
  let i = index;
  while (i < sql.length) {
    const span = readSqlSpan(sql, i, DEFAULT_SQL_GRAMMAR);
    if (span === null || !TRIVIA_SPANS.has(span.kind)) return i;
    i = span.end;
  }
  return i;
}

/** One dot-separated part of a name: a bare word, or a quoted identifier. */
function readNamePart(sql: string, index: number): { readonly text: string; readonly end: number } | null {
  const span = readSqlSpan(sql, index, DEFAULT_SQL_GRAMMAR);
  if (span !== null) {
    if (span.kind !== "quoted-identifier") return null;
    // The delimiters are one character each in every grammar this reader is given,
    // and a doubled delimiter inside is how all of them spell one literal character.
    const inner = sql.slice(index + 1, span.terminated ? span.end - 1 : span.end);
    // EVERY doubled delimiter, not the first (#396 review): `replace` with a string
    // pattern rewrites one occurrence, so `"a""b""c"` came back as `a"b""c` and the
    // name never matched the inventory — a real table reported as unknown.
    return { text: inner.replaceAll(sql[index] + sql[index], sql[index]), end: span.end };
  }
  const word = readSqlWord(sql, index);
  // Sliced rather than taken from `word.text`, which is upper-cased for keyword
  // comparison: a name is reported as the model wrote it.
  return word === null ? null : { text: sql.slice(index, word.end), end: word.end };
}

/**
 * A possibly qualified name at `index`, or `null` when one does not start there.
 *
 * A trailing dot with nothing readable after it yields what was read so far rather
 * than nothing: `film.` is a malformed statement, and losing `film` from the reading
 * would report the whole statement as naming no table at all.
 */
function readQualifiedName(sql: string, index: number): { readonly text: string; readonly end: number } | null {
  const parts: string[] = [];
  let i: number | null = index;
  let end = index;

  while (i !== null) {
    const part = readNamePart(sql, i);
    if (part === null) {
      i = null;
      continue;
    }
    parts.push(part.text);
    end = part.end;
    const dot = skipTrivia(sql, part.end);
    i = sql[dot] === "." ? skipTrivia(sql, dot + 1) : null;
  }

  return parts.length === 0 ? null : { text: parts.join("."), end };
}

/**
 * Whether a comma introduces another table after the one just read.
 *
 * A lookahead and not a cursor move: everything it steps over — an `AS`, an alias —
 * is stepped over again by the caller's own walk, so a `JOIN` mistaken for an alias
 * here costs nothing. It only ever answers "is the next thing a comma".
 */
function nextInList(sql: string, after: number): number | null {
  let i = skipTrivia(sql, after);
  const alias = readSqlWord(sql, i);
  if (alias !== null) {
    i = skipTrivia(sql, alias.end);
    // `t AS x, u`: the alias is one word further on than in `t x, u`.
    if (alias.text === "AS") {
      // Read with the NAME reader and not the word one (#396 review): an alias may be
      // quoted, `readSqlWord` sees nothing at the quote, and the cursor stopped short
      // of the comma — so `FROM film AS "f", payments` ended the list at `film` and an
      // invented `payments` escaped the unknown-table finding entirely.
      const named = readNamePart(sql, i);
      if (named !== null) i = skipTrivia(sql, named.end);
    }
  } else {
    // A bare quoted alias, `t "x", u`: not a word either, and the same walk-off.
    const quoted = readNamePart(sql, i);
    if (quoted !== null) i = skipTrivia(sql, quoted.end);
  }
  return sql[i] === "," ? i + 1 : null;
}

/**
 * Reads the table names in one keyword's position, and returns where the last name
 * ended so the caller's walk resumes inside the statement rather than past it.
 */
function readTablePosition(
  sql: string,
  after: number,
  rule: { readonly list: boolean; readonly parenMeansFunction: boolean },
  into: string[],
): number {
  let i: number | null = skipTrivia(sql, after);
  let cursor = i;

  while (i !== null) {
    const name = readQualifiedName(sql, i);
    if (name === null) {
      i = null;
      continue;
    }
    cursor = name.end;
    if (NOT_A_TABLE_NAME.has(name.text.toUpperCase())) {
      i = null;
      continue;
    }
    // `generate_series(1, 10)` in a FROM position is a function call, and there is no
    // such table to be missing from an inventory.
    if (!(rule.parenMeansFunction && sql[skipTrivia(sql, name.end)] === "(")) into.push(name.text);
    const next = rule.list ? nextInList(sql, name.end) : null;
    i = next === null ? null : skipTrivia(sql, next);
  }

  return cursor;
}

/**
 * The tables a statement names, in the order it names them, as it wrote them.
 *
 * Reads the statement's own CODE through the shared span and word readers rather than
 * matching text, for the reason `src/lib/sql/words.ts` records four defects of: a
 * keyword or a name a statement merely MENTIONS — inside a string, a comment, a
 * quoted literal — is not the statement doing it, and `SELECT 'FROM ghosts'` names no
 * table called `ghosts`.
 *
 * Names the statement DEFINES for itself are excluded: a CTE is not a table this
 * database has, and reporting one as unknown would be a false alarm on a perfectly
 * good statement. They are recognised by shape — a name at a parenthesis depth,
 * followed by `AS (` at that same depth — which is what keeps `WITH recent (id) AS
 * (…)` from recording its column list instead of its name.
 *
 * This is a READER, not a parser, and the honest limit is stated where it is spent:
 * it recognises the shapes the plan contract asks for. A name it did not recognise is
 * not evidence that the statement named no table, which is exactly why the caller
 * reports "tables named that the inventory does not hold" rather than "the statement
 * is valid".
 */
export function readStatementTables(sql: string): readonly string[] {
  const referenced: string[] = [];
  const defined = new Set<string>();
  /** The last name read at each parenthesis depth, for the `name AS (` shape. */
  const pending: (string | undefined)[] = [];
  let depth = 0;
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, DEFAULT_SQL_GRAMMAR);
    if (span !== null) {
      if (span.kind === "quoted-identifier") pending[depth] = sql.slice(i + 1, Math.max(i + 1, span.end - 1));
      i = span.end;
      continue;
    }

    if (sql[i] === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (sql[i] === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    const word = readSqlWord(sql, i);
    if (word === null) {
      i += 1;
      continue;
    }

    const rule = TABLE_KEYWORDS.get(word.text);
    if (rule !== undefined) {
      i = readTablePosition(sql, word.end, rule, referenced);
      continue;
    }

    const name = pending[depth];
    if (word.text === "AS" && name !== undefined && sql[skipTrivia(sql, word.end)] === "(") {
      defined.add(name.toLowerCase());
    }
    pending[depth] = sql.slice(i, word.end);
    i = word.end;
  }

  const seen = new Set<string>();
  return referenced.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key) || defined.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * What was checked against the captured inventory, and what was not.
 *
 * `no-inventory` is a variant rather than an empty list, because an empty list of
 * unknown tables is a claim: it says every table this statement names exists. A run
 * on an engine this server cannot ground, or one whose catalog read failed, checked
 * nothing and has to say so.
 *
 * `not-applicable` is a THIRD absence and arrived with #414, when plan mode started
 * being grounded on engines that speak no SQL. `readStatementTables` is a SQL reader:
 * asked for the tables in `db.orders.aggregate([...])` it answers `[]`, which the
 * `checked` variant would render as "every table it names is in the inventory" — a
 * vacuous affirmative about a draft whose collection names were never looked at. The
 * inventory may well be present on this path; what is missing is a reader that can
 * find a name in this engine's language. Purely additive, so no ledger written before
 * #414 can carry it.
 */
export type PlanStatementIdentifiers =
  | { readonly kind: "checked"; readonly unknownTables: readonly string[] }
  | { readonly kind: "no-inventory" }
  | { readonly kind: "not-applicable" };

export interface PlanStatementValidation {
  /**
   * Whether the shared agent statement guard had no objection to this text.
   *
   * NOT a safety claim and not a promise about what the statement does — that guard's
   * own docblock says `null` means only that that layer found nothing — and not
   * limited to writes either: two statements, or text no single dialect reading
   * settles, are objections too, which is why the reason travels beside the flag.
   *
   * `false` when `guardApplicable` is `false`, and that pairing is deliberate: the
   * only two honest answers on an engine the guard cannot read are "false" and a
   * separate field saying why, because `true` would be the guard vouching for text it
   * never examined. It stays a REQUIRED boolean rather than becoming optional, because
   * every ledger under `.workflow-data` already carries it and the store reads those
   * back verbatim.
   */
  readonly readOnly: boolean;
  /**
   * Whether the statement guard could read this draft's language at all (#414).
   *
   * Written on every validation from now on and absent only in ledgers recorded before
   * #414, where it reads as `true` — which is what those runs meant, since plan mode
   * was grounded on PostgreSQL and SQLite alone and every draft it recorded was SQL.
   * Consumers therefore test `=== false`.
   *
   * It exists because `inspectAgentStatement` reads every string as SQL and has no
   * verdict for "this is not SQL". `db.orders.aggregate([...])` leads with the word
   * `DB`, `INFO memory` with `INFO`, `SCAN 0 MATCH ...` with `SCAN`; none is in the
   * guard's read allowlist, so all three come back `NON_READ_STATEMENT` and every
   * correct MongoDB and Redis draft would have been marked as not classified as a
   * read. That is the guard's reach and not a property of the draft, and the three
   * surfaces that render it say so in those terms.
   */
  readonly guardApplicable: boolean;
  /** The guard's own reason, present exactly when `readOnly` is false AND the guard applied. */
  readonly guardViolation?: AgentStatementViolation;
  readonly identifiers: PlanStatementIdentifiers;
}

/** The last dot-separated part of a name, lower-cased. */
const leafOf = (name: string): string => {
  const lower = name.toLowerCase();
  return lower.slice(lower.lastIndexOf(".") + 1);
};

/**
 * The tables this statement names that the captured inventory does not hold.
 *
 * Matching is on the whole name OR on its last part, and the leniency is deliberate
 * and bounded: the engines qualify their inventories differently — PostgreSQL records
 * `public.film` and SQLite records `film` — so a strict comparison would report every
 * SQLite statement's tables as unknown, which is a false alarm on every run of one of
 * the two engines this milestone grounds. What it costs is the other direction: a
 * name that matches a same-named table in a schema the statement did not mean is
 * accepted. That is the right trade for what this list is FOR — catching a table the
 * model invented, not adjudicating schema resolution, which only the engine can do.
 */
function unknownTables(sql: string, inventory: readonly TableSchema[]): readonly string[] {
  const whole = new Set(inventory.map((table) => table.name.toLowerCase()));
  const leaves = new Set(inventory.map((table) => leafOf(table.name)));
  return readStatementTables(sql).filter((name) => !whole.has(name.toLowerCase()) && !leaves.has(leafOf(name)));
}

/**
 * Everything the server can say about a drafted statement without running it.
 *
 * Which is less than it sounds, and the type says so: an unknown table is recorded,
 * a statement the guard objects to is marked with the objection, and a run with no
 * inventory reports that it checked nothing. None of it is permission to run — the
 * inventory records what EXISTS, not what the user's role may select from — and none
 * of it blocks anything: the owner ruled that a write is marked rather than dropped,
 * because the user is the one who runs it.
 *
 * `language` is the connection's own `queryLanguage`, and it decides whether either
 * half runs at all. Both of them are SQL readers, and until #414 that was invisible
 * because plan mode was grounded on PostgreSQL and SQLite alone; grounding the mode on
 * MongoDB and Redis made both halves wrong at once on a correct draft — the guard
 * marking it as not classified as a read, and the identifier check affirming that
 * every table it names exists. Declining to judge is the answer rather than teaching
 * this module a second language: what an unexamined draft costs is one honest sentence
 * on three surfaces, and what a half-taught reader costs is a wrong verdict on the one
 * statement a user is most likely to run.
 */
export function validatePlanStatement(
  sql: string,
  inventory: readonly TableSchema[] | null,
  language: ProviderCapabilities["queryLanguage"],
): PlanStatementValidation {
  if (language !== "sql") {
    // No `guardViolation`: there was no objection, only a reader that does not speak
    // this language, and recording one of the guard's own reason codes here would
    // attribute a finding to a check that never ran.
    return { readOnly: false, guardApplicable: false, identifiers: { kind: "not-applicable" } };
  }
  const violation = inspectAgentStatement(sql);
  return {
    readOnly: violation === null,
    guardApplicable: true,
    ...(violation === null ? {} : { guardViolation: violation }),
    identifiers:
      inventory === null ? { kind: "no-inventory" } : { kind: "checked", unknownTables: unknownTables(sql, inventory) },
  };
}
