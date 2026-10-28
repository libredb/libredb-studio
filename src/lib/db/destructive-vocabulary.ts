import type { TypedConfirmationAsk } from "@/lib/db/types";

/**
 * The shape of one row of the confirmation gate's vocabulary, for an engine whose query text is NOT SQL.
 *
 * Each row is declared beside its provider, in a `destructive.ts` module, and `NON_SQL_DESTRUCTIVE_VOCABULARY` in
 * `./destructive-commands.ts` only collects them. This module is a leaf: it imports nothing but a type, so a row
 * module and the gate can both import it in the browser.
 */

/**
 * The names a query would run, or `undefined` when the text cannot be read as one.
 *
 * `undefined` is not "nothing to run": it means the reader could not tell WHAT would
 * run, and the gate turns it into a prompt.
 */
export type OperationReader = (query: string) => readonly string[] | undefined;

export interface DestructiveVocabulary {
  /** The names that ask for a confirmation. */
  readonly operations: ReadonlySet<string>;
  /** How this engine's query text names the operations it would run. */
  readonly read: OperationReader;
  /**
   * Whether this row is the gate's whole answer, so the gate's SQL keyword test never
   * reads the text.
   *
   * False keeps that test in front of the row as a backstop: a SQL write keyword in a
   * MongoDB or Redis buffer asks, although the provider would refuse the text. The
   * backstop is not free on Redis, where a read whose arguments are `update` and then
   * `set` (`MGET update set`) meets its `UPDATE ... SET` probe and asks.
   *
   * True where reading the text as SQL is wrong rather than cautious. A PromQL
   * expression can start with a metric name the server's data chooses, `update`,
   * `delete` and `drop` are legal names, and read as SQL the tree's own selector for
   * such a metric is a write. A Kafka read request names its topic, which can carry
   * any of those names too, in text that can only ever read that topic. An etcd command
   * names its keys, which can be spelled like any SQL keyword, and `guard.ts` reads it with
   * the parser the provider runs, so what asks and what runs are one parse (#1089).
   */
  readonly decidesAlone: boolean;
  /**
   * What a statement this row asks about makes the person type before it runs, or undefined where the one-click
   * dialog is the whole confirmation (#1089, section 5.5).
   *
   * Absent means one click for every statement the row asks about. `QuerySafetyDialog` reads it through
   * `vocabularyTypedConfirmation`, for a statement the gate already stopped, and draws the shared typed field for
   * the answer: the text itself, or the connection's name with every target listed.
   */
  readonly typedConfirmation?: (text: string) => TypedConfirmationAsk | undefined;
  /**
   * False keeps this row's statements from the AI safety analysis: the confirmation gate then posts nothing to
   * `/api/ai/query-safety` and calls no adapter in its place (#1089, E10).
   *
   * Absent means the gate sends the statement, as it does for every engine today. A row declares `false` where the
   * text carries what a write stores, as an etcd `put` carries its value, which must not leave the deployment
   * through the gate.
   */
  readonly safetyAnalysis?: false;
  /**
   * The sentence this connection type's editor refuses a statement with, or undefined to send it.
   *
   * Absent means the editor sends every statement, as it does for every engine today. A row declares it where the
   * dialect has a browser-safe verdict of its own, and a statement it refuses is never sent to any route or host
   * callback and never written to query history, on every path either shell can take (`statementRefusal`).
   */
  readonly refuse?: (text: string) => string | undefined;
  /**
   * The bound on a statement's text in UTF-8 bytes, the same constant the provider's own dialect declares.
   *
   * Absent means no bound of this kind. A row that declares it is refused past it in the browser, answered 413 by
   * `POST /api/db/query`, and refused by `POST /api/db/multi-query` outright, whose SQL splitter would turn one
   * console text into several requests.
   */
  readonly maxTextBytes?: number;
}

/** Whether `value` is a JSON object - not an array, not null. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
