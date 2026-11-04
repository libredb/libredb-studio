import { consoleTextByteLimit, statementRefusal, vocabularyTypedConfirmation } from "@/lib/db/destructive-commands";
import type { ProviderCapabilities, TypedConfirmationAsk } from "@/lib/db/types";
import { editorLanguageOf } from "@/lib/editor/tab-language";
import { hasUnreadableRun, isDangerousQuery } from "@/lib/sql/dangerous-query";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { type RunTargetRange, runnableTarget } from "@/lib/sql/run-target";
import { isMultiStatement } from "@/lib/sql/statement-splitter";
import type { DatabaseType } from "@/lib/types";

/**
 * What Run does with the editor's text, decided as the web editor decides it, in parts that hold no component, no React
 * and no Monaco, so that a caller outside the browser reads the same answers.
 *
 * The web editor calls the parts one by one: `QueryEditor.tsx` picks the target, `use-query-execution.ts` asks the
 * refusal, the confirmation gate and `runsAsScript`, and `QuerySafetyDialog` reads `typedConfirmationExpected` and
 * `hasUnreadableRun`. `analyzeStatement` composes the same parts, in the same order, into one answer.
 */

/** A `[start, end)` pair of UTF-16 code unit offsets into the analysed text. */
export interface OffsetRange {
  start: number;
  end: number;
}

/** The route a run outside a transaction, without bound params and not an explain, takes: `/api/db/<route>`. */
export type StatementRoute = "query" | "multi-query";

/** What the person types before a confirmed statement runs, compared exactly, case and whitespace included. */
export type TypedConfirmation =
  | { type: "text"; expected: string }
  | { type: "connection-name"; expected: string; targets: string[] };

/**
 * What Run does with the text. Every key a variant lists is present, and no other key is.
 *
 * - `nothing`: the target holds no code, so nothing is sent.
 * - `refuse`: the connection type refuses the statement, so nothing is sent and `refusal` is shown as it is. It may
 *   quote a word of the text.
 * - `run`: `statement` is sent without asking.
 * - `confirm`: `statement` is sent once the person confirms, and has typed the expected value where
 *   `typedConfirmation` is not null. `unreadable` says that part of the statement could not be read, which is a reason
 *   the gate asks. It is false wherever the gate does not read the text as SQL (`readsSqlText`), whatever the editor
 *   language: the embedded store's text is read as SQL, so its unclosed literal is unreadable.
 *
 * `statement` is the exact text to send. It is not always the text `range` covers: a one-statement selection on an
 * engine whose `statementTerminator` is `none` is sent without its `;` and the blanks around it.
 */
export type StatementAnalysis =
  | { decision: "nothing" }
  | { decision: "refuse"; statement: string; range: OffsetRange; refusal: string }
  | { decision: "run"; statement: string; range: OffsetRange; route: StatementRoute }
  | {
      decision: "confirm";
      statement: string;
      range: OffsetRange;
      route: StatementRoute;
      unreadable: boolean;
      typedConfirmation: TypedConfirmation | null;
    };

export interface StatementAnalysisInput {
  /** The editor's whole text, as written. */
  text: string;
  /** The selection; `start === end` is no selection. */
  selection: RunTargetRange;
  cursor: number;
  databaseType: DatabaseType;
  /** The connection's provider's capabilities: its editor language, its terminator and its query language. */
  capabilities: ProviderCapabilities;
  /** The connection's name, which a typed confirmation of the connection asks for. */
  connectionName: string | undefined;
}

/**
 * The refusal of a statement that is confirmed by typing the connection's name, on a connection with no name: an
 * empty expected value would let an empty field confirm it.
 */
export const TYPED_NAME_MISSING_REFUSAL =
  "This statement is confirmed by typing the connection's name, and this connection has no name, so it cannot run.";

/**
 * Whether Run sends this statement to `POST /api/db/multi-query`, the route that cuts a script into its statements and
 * runs them one by one, rather than to `POST /api/db/query`.
 *
 * Only the statement's own question: a run inside a transaction, with bound params or of an explain never takes the
 * script route, and those conditions stay with the caller, which knows them.
 *
 * Only SQL text is a script. The splitter is a SQL splitter: it cuts on `;` outside quotes. A dialect that is not SQL
 * has no such separator, so every cut it makes there is an invented fragment. Measured on Redis (#427): the generated
 * cheatsheet carried a `;` inside a `#` comment, so the buffer was split, and the first "statement" was comments only -
 * the run failed with "No command to run" and the panel reported a successful empty result. JSON, and PromQL since
 * #1085, whose single expression the splitter would cut at a `;` inside a `#` comment exactly as it cut Redis's, are
 * declared not to be SQL by `queryLanguage`. A type whose vocabulary row declares a console text bound is never SQL
 * either, and that declaration is static, so it holds even where `queryLanguage` is a caller's default: the web editor
 * passes `"sql"` while the provider's metadata is still loading, the window in which that default would send one
 * console text to the splitter.
 *
 * Read under the connection's own dialect, the same record the confirmation gate reads the statement with: whether a
 * `;` is code depends on the engine's comment, quoting and bracket rules, and a fragment this disagrees about is a
 * fragment the route RUNS (S1). The same record says where a procedural body holds its `;` and which line is a script
 * separator (#1312), so a PL/SQL unit alone stays on the single-statement route, and one followed by `/` goes to the
 * route that strips the `/`.
 */
export function runsAsScript(
  statement: string,
  databaseType: DatabaseType,
  queryLanguage: ProviderCapabilities["queryLanguage"],
): boolean {
  return (
    consoleTextByteLimit(databaseType) === undefined &&
    queryLanguage === "sql" &&
    isMultiStatement(statement, resolveSqlGrammar(databaseType))
  );
}

/**
 * The text a typed confirmation is compared with (#1089, section 5.5): the ask's own text, or the connection's name, or
 * undefined where the ask is the name and there is none to type.
 *
 * An empty name is no name: an exact comparison would let an empty field confirm it. The safety dialog answers
 * undefined with a refusal in place of the typed field and a Proceed button that stays disabled, and
 * `analyzeStatement` with TYPED_NAME_MISSING_REFUSAL.
 */
export function typedConfirmationExpected(
  ask: TypedConfirmationAsk,
  connectionName: string | undefined,
): string | undefined {
  if (ask.type === "text") return ask.text;
  return connectionName === "" ? undefined : connectionName;
}

/**
 * What Run does with this text, its selection and its caret on this connection, decided in the web editor's order:
 *
 * 1. The target, by `runnableTarget` under the connection's editor language, terminator and grammar: a non-blank
 *    selection, then the caret's statement, then the whole text, which the range then covers.
 * 2. A target that holds no code is nothing to run. The web editor sends such a target, after asking first where it is
 *    an unclosed comment, which is the one place the two differ in what reaches the engine (`docs/BACKLOG.md` U200).
 * 3. The connection type's refusal, before anything else is asked of the statement.
 * 4. The route, and whether the confirmation gate asks; a statement it does not ask about runs.
 * 5. What the person types, and whether part of the statement could not be read. A name to type on a connection with
 *    no name is refused here, where the web's safety dialog says so in place of the typed field and keeps Proceed
 *    disabled: neither sends the statement, and only the answer's shape differs.
 *
 * The gate reads the statement that is sent, not the whole text, as the web gate reads the query it is about to run.
 * Nothing here opens a connection or depends on anything but its input. What the web editor also decides from its own
 * state is the caller's: Proceed, an explain run, a later page and playground mode skip the gate there, and a
 * transaction takes every statement whatever the route says.
 *
 * Throws the run target's `RangeError` on offsets it cannot honour.
 */
export function analyzeStatement(input: StatementAnalysisInput): StatementAnalysis {
  const { text, selection, cursor, databaseType, capabilities, connectionName } = input;
  const target = runnableTarget({
    text,
    selection,
    cursor,
    editorLanguage: editorLanguageOf(capabilities),
    statementTerminator: capabilities.statementTerminator,
    grammar: resolveSqlGrammar(databaseType),
  });
  const { statement } = target;
  if (statement.trim() === "") return { decision: "nothing" };
  const range: OffsetRange = target.range ?? { start: 0, end: text.length };

  const refusal = statementRefusal(statement, databaseType);
  if (refusal !== undefined) return { decision: "refuse", statement, range, refusal };

  const route: StatementRoute = runsAsScript(statement, databaseType, capabilities.queryLanguage)
    ? "multi-query"
    : "query";
  if (!isDangerousQuery(statement, databaseType)) return { decision: "run", statement, range, route };

  const ask = vocabularyTypedConfirmation(databaseType, statement);
  let typedConfirmation: TypedConfirmation | null = null;
  if (ask !== undefined) {
    const expected = typedConfirmationExpected(ask, connectionName);
    if (expected === undefined) return { decision: "refuse", statement, range, refusal: TYPED_NAME_MISSING_REFUSAL };
    typedConfirmation =
      ask.type === "text"
        ? { type: "text", expected }
        : { type: "connection-name", expected, targets: [...ask.targets] };
  }
  return {
    decision: "confirm",
    statement,
    range,
    route,
    unreadable: hasUnreadableRun(statement, databaseType),
    typedConfirmation,
  };
}
