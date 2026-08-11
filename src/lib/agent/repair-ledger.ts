/**
 * The bounded repair loop, and the statement fingerprint it keys on (#329, epic #325).
 *
 * An agent that drafts SQL will get some of it wrong, and repairing a failed
 * statement is the useful half of the loop. The failure mode this module exists to
 * prevent is the other half: a model that re-sends the same broken statement,
 * burning the run's statement budget and the database's time on a call whose
 * answer is already known.
 *
 * Two bounds, and they are not the same bound:
 *
 *  1. **A statement that has already failed is never admitted again.** Keyed on a
 *     CANONICAL form, because a ledger a model can evade by deleting a space is
 *     not a ledger. `fingerprintStatement` reads the statement through the shared
 *     SQL span/word readers (`src/lib/sql`) and rebuilds it as a token stream, so
 *     whitespace, comments, a trailing terminator and the case of the statement's
 *     own code all normalise away, while a literal's and a quoted name's exact
 *     spelling are preserved.
 *  2. **At most `AGENT_MAX_REPAIR_ATTEMPTS` statements that failed AT THE DATABASE
 *     may be repaired.** A policy denial or an approval requirement does not
 *     consume one: nothing ran, and a boundary decision is not a defect in a
 *     statement the model could fix. It is still recorded as unrepeatable, so the
 *     model cannot ask for the same denied thing twice.
 *
 * What is deliberately NOT bounded here is the number of distinct statements a
 * model may have DENIED. That is not an oversight, but it IS narrower than it looks:
 * a denial costs no database work, and `execution.ts` returns before
 * `tracker.beginExecution` on any non-allow, so a denied call never reaches the
 * statement budget either. The run's wall-clock deadline (`deadline.ts`, consulted
 * before every call) is therefore the only thing bounding a denial loop. Adding a
 * third counter here would be a number nobody has chosen; the deadline is one the
 * owner did.
 *
 * A successful statement is not recorded. Re-running a verified read is legitimate
 * — a report may want to cite it again — and the statement budget bounds how often.
 *
 * ## What this fingerprint cannot do, and why it does not try
 *
 * It does not decide whether two SPELLINGS of a name are the same name. `"orders"`
 * and `orders` are one relation on both engines here, and merging them was tried and
 * REVERTED, because deciding it requires the engine's reserved-word list and this
 * reader is dialect-less. The counter-case is not exotic: the statement guard refuses
 * `SELECT copy FROM ads` (`copy` reads as a side-effect word) and admits
 * `SELECT "copy" FROM ads`, and the ENGINE refuses `SELECT select FROM t` while
 * accepting `SELECT "select" FROM t` — quoting is the documented repair for the first
 * and the only repair for the second. Canonicalising quotes away gave both repairs the
 * fingerprint of the statement that had just failed, so the ledger refused the very
 * fix the layer had just invited, and any column named with a keyword became
 * unreachable for the rest of the run. Excluding the words the GUARD knows about would
 * not have been enough either: `select` and `order` are engine-reserved and appear in
 * none of its sets (both verified).
 *
 * So the residual is real and is an UNDER-refusal, not a safe one: a re-spelling this
 * reader cannot see through (`"orders"`, `` `orders` ``, `[orders]`, a different case
 * inside quotes) is admitted and runs again. What bounds it is the repair budget below
 * — the second failure costs an attempt, so a run still performs at most
 * `AGENT_MAX_REPAIR_ATTEMPTS` failing executions however many spellings it invents.
 * Trading a bounded amount of wasted database work for never blocking a legitimate
 * repair is the direction this layer chooses, and it is the choice, not an accident.
 */

import { createHash } from "node:crypto";
import { DEFAULT_SQL_GRAMMAR } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import { readSqlWord } from "@/lib/sql/words";
import { AGENT_MAX_REPAIR_ATTEMPTS } from "./execution-policy";

/** Why the ledger refused a statement. The two are not interchangeable: after
 * `STATEMENT_ALREADY_FAILED` a different statement may still run, while after
 * `REPAIR_BUDGET_EXHAUSTED` no further drafting will be admitted. */
export type AgentRepairDenyCode = "STATEMENT_ALREADY_FAILED" | "REPAIR_BUDGET_EXHAUSTED";

/**
 * How a statement failed. Only `database-error` consumes a repair attempt — see
 * the module doc for why a boundary decision does not.
 */
export type AgentRepairFailureClass = "database-error" | "policy-denied" | "approval-required";

export type AgentRepairAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reasonCode: AgentRepairDenyCode };

/**
 * Raised when the ledger is asked about a fingerprint it cannot key on. A
 * server-side programming error — fingerprints come from `fingerprintStatement`,
 * never from a model — so it fails loud rather than admitting the call.
 */
export class AgentRepairLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRepairLedgerError";
    Object.setPrototypeOf(this, AgentRepairLedgerError.prototype);
  }
}

/** Spans that are trivia between tokens rather than part of the statement's text. */
const TRIVIA_SPANS: ReadonlySet<string> = new Set(["whitespace", "line-comment", "block-comment"]);

/**
 * A numeric run, grouped so `SELECT 12` cannot canonicalise like `SELECT 1 2`.
 *
 * The grouping is deliberately naive and does collide in one direction: `SELECT 1e5`
 * and `SELECT 1 e5` canonicalise alike, because the exponent is read as a word. That
 * is over-refusal of a statement nobody tried, which is the safe direction — the
 * unsafe one would be admitting a statement that has already failed.
 */
const NUMERIC = /[0-9.]/;

/**
 * The statement as a canonical token stream.
 *
 * Tokens are joined with a single space rather than reproduced with their original
 * separators. That is what closes the evasion: `SELECT'x'` and `SELECT 'x'` are the
 * same statement, and a form that preserved "was there a space here" would give
 * them different fingerprints and let a retry through.
 *
 * A span that never terminates is emitted verbatim as one token. The statement
 * guard refuses such text (`UNDETERMINABLE_TEXT`), but the ledger is consulted
 * BEFORE the policy pipeline, so the fingerprint has to be defined for it.
 */
function canonicalTokens(sql: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < sql.length) {
    const span = readSqlSpan(sql, index, DEFAULT_SQL_GRAMMAR);
    if (span !== null) {
      // Literals, quoted names and subscripts are the statement's own text and keep
      // their EXACT spelling; trivia contributes nothing. Quoting is deliberately not
      // canonicalised away — see the module doc's "what this fingerprint cannot do".
      if (!TRIVIA_SPANS.has(span.kind)) tokens.push(sql.slice(index, span.end));
      index = span.end;
      continue;
    }

    const word = readSqlWord(sql, index);
    if (word !== null) {
      // Already upper-cased by the reader: unquoted names are case-insensitive on
      // both engines this milestone serves, so two spellings are one statement.
      tokens.push(word.text);
      index = word.end;
      continue;
    }

    const character = sql[index];

    if (NUMERIC.test(character)) {
      let end = index + 1;
      while (end < sql.length && NUMERIC.test(sql[end])) end += 1;
      tokens.push(sql.slice(index, end));
      index = end;
      continue;
    }

    tokens.push(character);
    index += 1;
  }

  // Only a TRAILING terminator is dropped, so `SELECT 1` and `SELECT 1;` are one
  // statement while an interior `;` stays a token that separates two.
  //
  // Dropping it everywhere was tried and is wrong. It gave `SELECT 1; SELECT 2` and
  // `SELECT 1 SELECT 2` one fingerprint, and those are NOT both refused: the guard
  // answers `MULTIPLE_STATEMENTS` for the first and admits the second (verified —
  // `inspectAgentStatement` returns null for it, since it leads with SELECT and
  // carries no side-effect word or bare terminator). So the concatenation could run,
  // fail at the engine, and enter the ledger, after which the genuine multi-statement
  // probe came back as `STATEMENT_ALREADY_FAILED` rather than being denied and
  // AUDITED as an input-validation failure — the one case where this layer's
  // unaudited refusals would have lost information instead of restating it.
  while (tokens.length > 0 && tokens[tokens.length - 1] === ";") tokens.pop();

  return tokens;
}

/**
 * A stable digest of the statement's canonical form.
 *
 * A digest rather than the normalised text: it is a fixed, bounded length, so it
 * can sit in a durable run record and in an `AgentToolRefusal` without carrying a
 * second copy of the statement around (the `statement-drafted` event already holds
 * the statement itself).
 */
export function fingerprintStatement(sql: string): string {
  return createHash("sha256").update(canonicalTokens(sql).join(" ")).digest("hex");
}

function assertFingerprint(fingerprint: string): string {
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
    throw new AgentRepairLedgerError("statement fingerprint must be a non-empty string");
  }
  return fingerprint;
}

/**
 * One run's repair accounting. Constructed with the run, consulted before every
 * statement, told about every failure.
 */
export class AgentRepairLedger {
  private readonly failed = new Set<string>();
  private attempts = 0;

  /** Database-error repairs consumed so far. */
  get attemptsUsed(): number {
    return this.attempts;
  }

  /**
   * Whether this statement may be attempted. The already-failed answer takes
   * precedence over an exhausted budget on purpose: they tell the model different
   * things, and the more specific one is the more useful.
   */
  admit(fingerprint: string): AgentRepairAdmission {
    const key = assertFingerprint(fingerprint);
    if (this.failed.has(key)) return { admitted: false, reasonCode: "STATEMENT_ALREADY_FAILED" };
    if (this.attempts >= AGENT_MAX_REPAIR_ATTEMPTS) {
      return { admitted: false, reasonCode: "REPAIR_BUDGET_EXHAUSTED" };
    }
    return { admitted: true };
  }

  /** Records a failure. Every class is unrepeatable; only a database error costs an attempt. */
  recordFailure(fingerprint: string, failureClass: AgentRepairFailureClass): void {
    this.failed.add(assertFingerprint(fingerprint));
    if (failureClass === "database-error") this.attempts += 1;
  }
}
