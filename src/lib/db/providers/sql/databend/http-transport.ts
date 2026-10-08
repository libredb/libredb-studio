/**
 * The Databend HTTP transport (design 3): one statement of the query API, end to end, over the shared node transport.
 *
 * This is the I/O loop only. Every decision it makes is a pure module's: the ids and the end-open plan are
 * `session.ts`'s, a link is followed only when `routes.ts` accepts it, an answer is read by `answer.ts`, a failure is
 * retried only when `retry.ts` says so, and every error and sentence is `errors.ts`'s. What is left here is the order
 * of the requests (design 3.4):
 *
 * - The sign-in latch is consulted before any socket (design 3.5): a latched key is refused with no request, and an
 *   unproven key held by another run waits for it. Only an answer read as one proves the key; every refusal, of the
 *   POST, a page or a close, a gateway's over HTTP 200 included, is reported to the latch, which latches the ones
 *   `latchesSignIn` names, and after that the run sends nothing more. An unproven key passes to a waiting run only
 *   after this run's last close, so a refused password is sent once.
 * - The statement POST carries a closed body built field by field (design 3.3) and new ids from `session.ts`. Its
 *   first answer must be for our query id and our session, from a node id of the accepted shape; a fail-to-start answer
 *   (`id` empty) has nothing to close. Every later page must be for our query id and our session too, and one that
 *   holds a schema or rows must hold the schema the rows so far were kept under; a page with neither is a long poll.
 * - The loop keeps the last echoed session, the first non-empty schema, the rows, the first 100 different warnings
 *   with a count of the rest, and the affect; it follows `next_uri` alone, and stops at the row, cell and byte budgets
 *   of design 3.12 or past the poll bound. Every answer is read within the page the POST asked for and the columns the
 *   cell budget keeps, so what one answer costs before the budgets apply is bounded by them, not by the 16 MiB an
 *   answer may be.
 * - Every exit after the server registered the statement, or may have, sends one close: the final link when the
 *   server already ended it (an in-body error, a budget cut, a complete result), else the kill. A final or a kill is
 *   best effort under its own 5 s, off the statement's signal, and acknowledged only by a 200 that is not a gateway's
 *   refusal; a failed final of a complete result is a notice, never an error, which would report a committed write as
 *   failed [X02]. A POST that may have reached the server with no answer read, its 200 unreadable included, also sends
 *   one logout, since the session id is ours [X13]; a POST another status refused (`server`) is killed alone. An auth
 *   refusal, of the POST, a page or a close, a middleware 400 or a fail-to-start sends nothing more: a kill, ROLLBACK or
 *   logout would carry the refused credential again and count toward a lockout, and a logout left unsent so is told
 *   apart from one unanswered.
 * - The end-open reads the server's flags, never SQL text: an `Active` transaction is rolled back under a new query
 *   id with its links followed inside the same 5 s, and a session still needing keep-alive is logged out, which drops
 *   its temporary tables. A ROLLBACK link answered with a 200 it cannot read was answered, and so was a close whose
 *   answer the node transport refused to read, so each is a refused close, never an unanswered one. The echoed session
 *   never leaves `run()`.
 * - A cancel before the first answer can miss the statement, so a kill answered 404 is sent again at 250, 500 and
 *   1000 ms; after the first answer a cancel is `cancelled`, and a user statement's deadline `timeout`, only when
 *   Databend acknowledged the kill or an answer reported 1043, and otherwise the statement may still finish [X02]; a
 *   statement Studio sends itself is `timeout` at its deadline whatever the kill answered, or `unavailable`, the
 *   resuming outcome, on a named warehouse.
 * - A statement Studio sends itself is the process's own from before anything is sent until its last close ends,
 *   under its query id, and its outcome names every own statement in flight meanwhile, its own included, which a
 *   read of running statements leaves out (design 5.5); a user statement is never one.
 *
 * Time, sleep, randomness, ids and deadlines are injected deps with production defaults, so no test waits on a real
 * timer [X16]. Every request goes through `createNodeTransport`, the one socket path.
 */
import { randomUUID } from "node:crypto";
import { endpointUrl } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import { serverText } from "@/lib/db/utils/server-text";
import {
  type AnswerBounds,
  type DatabendAnswer,
  type DatabendAnswerError,
  type DatabendReading,
  type DatabendRefusal,
  type DatabendSessionEcho,
  readAnswer,
  readCloseAnswer,
  resultModeNotice,
} from "./answer";
import { type AuthAttempt, type AuthLatch, createAuthLatch } from "./auth-latch";
import type { DatabendConnectionOptions } from "./connection-options";
import {
  answerError,
  DATABEND_ERROR_SENTENCES,
  DATABEND_PROTOCOL_FAULTS,
  type DatabendFailureContext,
  type DatabendStop,
  protocolError,
  refusalError,
  serverWords,
  signInAnswerOf,
  stopError,
  transportFailure,
  unsentStopError,
} from "./errors";
import { type RetryRequest, retryDecision } from "./retry";
import { acceptNextUri, finalPath, killPath, LOGOUT_PATH, QUERY_PATH } from "./routes";
import {
  createOwnStatements,
  endOpenPlan,
  newQueryId,
  rollbackBody,
  rollbackNotice,
  type StatementIds,
  sessionHeader,
  sessionNotices,
  statementIds,
} from "./session";
import {
  type DatabendAffect,
  type DatabendCell,
  type DatabendCloseStep,
  type DatabendColumn,
  DatabendError,
  type DatabendNotice,
  type DatabendTransport,
  type DatabendTruncation,
  type StatementOutcome,
  type StatementRequest,
} from "./transport";

/**
 * What failed when a page gave no answer within its attempt timer twice with statement time left (design 3.11): not
 * the statement deadline.
 */
export const DATABEND_PAGE_UNANSWERED = "a page of the result did not arrive in two attempts";

/**
 * The different server warnings one statement keeps (design 3.12): past them each warning is counted and never kept,
 * so a server sending distinct warnings on every page costs a count, not the statement's byte budget in warnings.
 */
export const DATABEND_WARNING_LIMIT = 100;

/** What the transport takes from outside, each with a production default [12 #6] [X16]. */
export interface DatabendHttpTransportDeps {
  /** The one socket path. */
  readonly createNodeTransport: (options: NodeTransportOptions) => NodeTransport;
  /** The process's sign-in latch (design 3.5). */
  readonly latch: AuthLatch;
  /** Waits `ms`, or less when `signal` fires first. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A value in [0, 1), for the backoff's jitter and the route hint's nonce. */
  readonly random: () => number;
  /** The clock, in ms since the epoch. */
  readonly now: () => number;
  /** A new UUID. */
  readonly newId: () => string;
  /** A signal that fires after `ms` with a `TimeoutError` reason, as `AbortSignal.timeout()` does. */
  readonly deadline: (ms: number) => AbortSignal;
}

/** The long poll of every statement GET: fewest polls for a long statement (`0` made 112 requests in 2 s, M04b). */
const WAIT_TIME_SECS = 10;
/** A page is never larger, and never 0, which panics the server (M04e). */
const MAX_ROWS_PER_PAGE = 10_000;
/** A page GET attempt waits the long poll and this much more before it is requested again (design 3.12) [X15]. */
const PAGE_ATTEMPT_SLACK_MS = 15_000;
/** The polls a statement may take beyond one per second of its deadline (design 3.4) [13 #19]. */
const POLL_ALLOWANCE = 100;
/** The shape a `node_id` must have before it is sent back as `x-databend-sticky-node` (design 3.2). */
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** When a kill answered 404 before the first answer is sent again: the statement may not be registered yet. */
const KILL_RESENDS_MS = [250, 500, 1000] as const;
/** The settings every statement pins (design 3.3, section 4) [X01]. */
const STATEMENT_SETTINGS = Object.freeze({
  format_null_as_str: "0",
  http_json_result_mode: "display",
  binary_output_format: "hex",
});
/** What a statement Studio writes itself also pins, whatever the user's global settings say [05 C17]. */
const PROVIDER_SETTINGS = Object.freeze({
  sql_dialect: "PostgreSQL",
  quoted_ident_case_sensitive: "1",
  timezone: "UTC",
});

/** The polls a chain may take under a deadline of `ms`: one per second of it, and the allowance (design 3.4). */
function pollBound(ms: number): number {
  return POLL_ALLOWANCE + Math.ceil(ms / 1000);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The query ids of this process's provider statements in flight, shared by every Databend provider as the latch is:
 * Studio's own, which a read of running statements leaves out (design 5.5).
 */
const OWN_STATEMENTS = createOwnStatements();

const PRODUCTION_DEPS: DatabendHttpTransportDeps = {
  createNodeTransport,
  // The process's one latch, shared by every Databend provider (design 3.5).
  latch: createAuthLatch({ now: Date.now }),
  sleep,
  random: Math.random,
  now: Date.now,
  newId: () => randomUUID(),
  deadline: (ms) => AbortSignal.timeout(ms),
};

/** One request of a statement, and how it is retried. */
interface Exchange {
  readonly request: RetryRequest;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The signal of one attempt: the statement's, a page's attempt timer, or a close's own 5 s. */
  readonly attempt: () => AbortSignal;
  /** What ends every attempt and a backoff: the statement's signal, or a close's own 5 s. */
  readonly signal: AbortSignal;
  /** When the attempts must end, in `now()` ms. */
  readonly endsAt: number;
  /** Whether a 200 is read as an answer; a close's 200 is read only for a gateway's refusal. */
  readonly read: boolean;
}

interface Exchanged {
  readonly response: NodeResponse;
  /** Null for a close's 200 that acknowledged it. */
  readonly reading: DatabendReading | null;
}

/** How the poll loop ended: a result, cut or whole; an in-body error; or a link or poll count it refused. */
type LoopEnd =
  | { readonly kind: "done"; readonly truncated: DatabendTruncation | null; readonly final: boolean }
  | { readonly kind: "failed"; readonly id: string; readonly error: DatabendAnswerError; readonly final: boolean }
  | { readonly kind: "refused"; readonly error: DatabendError };

/** What one statement's loop gathered. */
interface Gathered {
  session: DatabendSessionEcho | null;
  schema: readonly DatabendColumn[];
  rows: DatabendCell[][];
  affect: DatabendAffect | null;
  hasResultSet: boolean;
  /** The first `DATABEND_WARNING_LIMIT` different warnings, through `serverText`. */
  readonly warnings: Set<string>;
  /** The warnings past those, counted and never kept. */
  warningsLeftOut: number;
}

/**
 * A stop that fired in the backoff between two attempts of the statement POST. Only a gateway
 * `ProvisionWarehouseTimeout` resends a POST, and the gateway answers it without forwarding (design 3.11), so nothing
 * that was sent can run: the run is the stop itself, with no kill and no logout.
 */
class StoppedBetweenAttempts extends Error {
  constructor() {
    super("A stop between two attempts of the statement POST");
  }
}

/**
 * An answer a close got and could not read: a 200 a read close (the ROLLBACK and its links) could not read, malformed
 * or past a bound of design 3.12, or one the node transport refused to read. An answer arrived, so the close was
 * refused, never left unanswered.
 */
const UNREADABLE = "unreadable";

/** What one close got: what it was answered, an answer it could not read, or null when nothing arrived. */
type CloseAnswer = Exchanged | typeof UNREADABLE | null;

/** The node transport's failures that come after an answer arrived, which it refused to read. */
const UNREAD_ANSWER_KINDS: ReadonlySet<TransportError["kind"]> = new Set(["too-large", "encoding", "redirect"]);

/**
 * Whether a close's failure still proves an answer arrived: a read close's 200 that threw `protocol`, or an answer the
 * node transport refused to read, past the cap, under another content-encoding, a redirect, or cut short once it began.
 */
function answerArrived(error: unknown): boolean {
  if (error instanceof DatabendError) return true;
  return error instanceof TransportError && (UNREAD_ANSWER_KINDS.has(error.kind) || error.truncated);
}

/** A close Databend acknowledged: answered 200, and not with a gateway's refusal over HTTP 200. */
function acknowledged(answer: CloseAnswer): boolean {
  return answer !== UNREADABLE && answer?.response.status === 200 && answer.reading?.kind !== "refusal";
}

/** The notice of a close that was not acknowledged: refused when an answer came, read or not, failed when none did. */
function closeNotice(answer: CloseAnswer, step: DatabendCloseStep): DatabendNotice {
  return { kind: answer === null ? "close-failed" : "close-refused", step };
}

/** The answer a read close got, when one arrived and read as an answer. */
function answerOf(answer: CloseAnswer): DatabendAnswer | null {
  return answer !== UNREADABLE && answer?.reading?.kind === "answer" ? answer.reading.answer : null;
}

/** A kill answered 404: the statement is not registered yet, so before the first answer it is sent again. */
function notFound(answer: CloseAnswer): boolean {
  return answer !== UNREADABLE && answer?.response.status === 404;
}

/** Whether two schemas name the same columns with the same types, in the same order. */
function sameSchema(one: readonly DatabendColumn[], other: readonly DatabendColumn[]): boolean {
  return (
    one.length === other.length &&
    one.every((column, index) => column.name === other[index].name && column.type === other[index].type)
  );
}

/** A refusal of the node transport before any socket, such as the egress guard's, which names no address. */
function configError(error: unknown): DatabendError {
  return new DatabendError("config", (error as Error).message, { cause: error });
}

/** The rows one page holds: one past the row cut, so that a cut is seen, and never more than a page. */
function pageRows(request: StatementRequest): number {
  return Math.min(request.rowCut + 1, MAX_ROWS_PER_PAGE);
}

/**
 * The closed statement body of design 3.3: nothing from a caller is spread, and `stage_attachment`, `params` and the
 * Arrow fields are never sent [05 C6].
 */
function statementBody(request: StatementRequest, timeoutMs: number, database: string | undefined): string {
  const settings = {
    ...STATEMENT_SETTINGS,
    max_execute_time_in_seconds: String(Math.ceil(timeoutMs / 1000)),
    ...(request.origin === "provider" ? PROVIDER_SETTINGS : {}),
  };
  const page = pageRows(request);
  return JSON.stringify({
    sql: request.sql,
    session: { ...(database === undefined ? {} : { database }), settings },
    pagination: { wait_time_secs: WAIT_TIME_SECS, max_rows_per_page: page, max_rows_in_buffer: 2 * page },
  });
}

class StatementRun {
  private readonly ids: StatementIds;
  private readonly session: string;
  private readonly timeoutMs: number;
  private readonly endsAt: number;
  /** What one answer of this run may hold: the page the POST asks for, and the columns the cell budget keeps. */
  private readonly bounds: AnswerBounds;
  private readonly notices: DatabendNotice[] = [];
  private nodeId: string | null = null;
  private hold: AuthAttempt | null = null;
  /** Set once a refusal of this run latched its sign-in: the run sends nothing after it (design 3.5). */
  private signInRefused = false;

  constructor(
    private readonly options: DatabendConnectionOptions,
    private readonly deps: DatabendHttpTransportDeps,
    private readonly node: NodeTransport,
    private readonly request: StatementRequest,
    private readonly signal: AbortSignal,
  ) {
    this.timeoutMs = request.origin === "user" ? options.callTimeoutMs : options.surfaceTimeoutMs;
    this.endsAt = deps.now() + this.timeoutMs;
    this.ids = statementIds(deps.newId, deps.random());
    this.session = sessionHeader(this.ids.sessionId, deps.now());
    this.bounds = { rows: pageRows(request), columns: options.cellBudget };
  }

  /**
   * The run; a statement Studio sends itself is the process's own from before anything is sent until its last close
   * ends, and its outcome names every own statement in flight meanwhile (design 5.5).
   */
  async run(): Promise<StatementOutcome & { readonly role: string | null }> {
    if (this.request.origin === "user") return this.signedIn();
    const own = OWN_STATEMENTS.begin(this.ids.queryId);
    try {
      const outcome = await this.signedIn();
      return { ...outcome, ownQueryIds: own.seen() };
    } finally {
      own.end();
    }
  }

  /** The statement under the sign-in latch's hold (design 3.5), released after its last close. */
  private async signedIn(): Promise<StatementOutcome & { readonly role: string | null }> {
    let hold: AuthAttempt;
    try {
      hold = await this.deps.latch.acquire(this.options.latchKey, this.signal);
    } catch (error) {
      if (error instanceof DatabendError) throw error;
      // The wait was cut short by the run's own signal: nothing was sent.
      throw unsentStopError(this.stop(), this.context("post"));
    }
    this.hold = hold;
    try {
      return await this.post();
    } finally {
      // An unproven key passes to the next waiter only now, after every close of this run.
      hold.release();
    }
  }

  /** The statement POST and everything after it, under the run's hold. */
  private async post(): Promise<StatementOutcome & { readonly role: string | null }> {
    if (this.signal.aborted) throw unsentStopError(this.stop(), this.context("post"));
    let first: Exchanged;
    try {
      first = await this.exchange({
        request: "query",
        method: "POST",
        path: QUERY_PATH,
        body: statementBody(this.request, this.timeoutMs, this.options.database),
        headers: this.headers(this.ids.queryId),
        attempt: () => this.signal,
        signal: this.signal,
        endsAt: this.endsAt,
        read: true,
      });
    } catch (error) {
      throw await this.postFailed(error);
    }
    const reading = first.reading as DatabendReading;
    if (reading.kind === "refusal") {
      this.refused(reading.refusal);
      const error = refusalError(reading.refusal, this.context("post"));
      // A status that says nothing about whether the POST reached Databend: the statement may be running.
      if (error.category === "outcome-unknown" || error.category === "network") await this.closeUnanswered();
      // Another status from the query server: the statement may be registered, and a kill is idempotent.
      if (error.category === "server") await this.kill(false);
      throw error;
    }
    (this.hold as AuthAttempt).prove();
    return this.follow(reading.answer, first.response);
  }

  /** Reports a refusal to the latch (design 3.5); once one latches, the run sends nothing more. */
  private refused(refusal: DatabendRefusal): void {
    if ((this.hold as AuthAttempt).refuse(signInAnswerOf(refusal))) this.signInRefused = true;
  }

  /** A POST that ended with no answer read: by the run's stop, the network, a cap, or a malformed 200. */
  private async postFailed(error: unknown): Promise<DatabendError> {
    if (error instanceof StoppedBetweenAttempts) return unsentStopError(this.stop(), this.context("post"));
    if (error instanceof DatabendError) {
      // A 200 that could not be read, malformed or past a bound: the server may hold the statement and a temporary
      // table in our session, so it is closed as a POST with no answer is.
      await this.closeUnanswered();
      return error;
    }
    if (!(error instanceof TransportError)) return configError(error);
    const unanswered = { answered: false, killAcknowledged: false };
    // A TLS failure or a redirect never reached the query server's handler.
    if (error.kind === "tls" || error.kind === "redirect")
      return transportFailure(error, unanswered, this.context("post"));
    const killAcknowledged = await this.closeUnanswered();
    return transportFailure(error, { answered: false, killAcknowledged }, this.context("post"));
  }

  /** The close of a POST that may have registered with no answer: the kill, resent on 404, then one logout [X13]. */
  private async closeUnanswered(): Promise<boolean> {
    const killAcknowledged = await this.kill(true);
    await this.logout();
    return killAcknowledged;
  }

  private async follow(
    answer: DatabendAnswer,
    response: NodeResponse,
  ): Promise<StatementOutcome & { role: string | null }> {
    if (answer.id === "" && answer.error !== null) {
      throw answerError({ id: answer.id, error: answer.error }, this.context("post"), null);
    }
    const identity = this.identityFault(answer);
    if (identity !== null) throw await this.abandon(protocolError(identity), null);
    if (answer.nodeId === null || !NODE_ID.test(answer.nodeId)) {
      throw await this.abandon(protocolError(DATABEND_PROTOCOL_FAULTS.field("node_id")), null);
    }
    this.nodeId = answer.nodeId;
    // I6: a server below the floor drops the result mode it does not know. The mode it echoed is server text.
    const mode = resultModeNotice(answer);
    if (mode !== null) this.notices.push({ ...mode, mode: serverWords(mode.mode, this.options.secretForms) });

    const gathered: Gathered = {
      session: null,
      schema: [],
      rows: [],
      affect: null,
      hasResultSet: false,
      warnings: new Set(),
      warningsLeftOut: 0,
    };
    const end = await this.loop(answer, Buffer.byteLength(response.text), gathered);
    if (end.kind === "refused") throw await this.abandon(end.error, gathered.session);
    if (end.final) await this.final();
    await this.endOpen(gathered.session);
    if (end.kind === "failed") {
      const stop = this.signal.aborted ? this.stop() : null;
      throw answerError({ id: end.id, error: end.error }, this.context("get"), stop);
    }
    const warnings: DatabendNotice[] = [...gathered.warnings].map((text) => ({ kind: "server-warning", text }));
    if (gathered.warningsLeftOut > 0) warnings.push({ kind: "warnings-left-out", count: gathered.warningsLeftOut });
    return {
      schema: gathered.schema,
      rows: gathered.rows,
      truncated: end.truncated,
      notices: [...warnings, ...this.notices],
      hasResultSet: gathered.hasResultSet,
      affect: gathered.affect,
      role: gathered.session?.role ?? null,
    };
  }

  /**
   * The poll loop of design 3.4, from the first answer to the end, a budget, an in-body error or a refused link. A
   * page that fails closes the statement and throws; every other exit is returned, for `follow` to close.
   */
  private async loop(first: DatabendAnswer, firstBytes: number, gathered: Gathered): Promise<LoopEnd> {
    const maxPolls = pollBound(this.timeoutMs);
    let current = first;
    let bytes = firstBytes;
    let polls = 0;
    for (;;) {
      if (current.session !== null) gathered.session = current.session;
      if (gathered.schema.length === 0) gathered.schema = current.schema;
      if (current.affect !== null) gathered.affect = current.affect;
      gathered.hasResultSet ||= current.hasResultSet;
      for (const warning of current.warnings) this.keepWarning(gathered, warning);
      // The server already ended a failed statement, and a cut one is ended by its final.
      const final = current.nextUri !== null;
      // Rows of a failed statement are discarded (M05g).
      if (current.error !== null) return { kind: "failed", id: current.id, error: current.error, final };
      const truncated =
        bytes > this.options.statementBytes
          ? { bound: "bytes" as const, limit: this.options.statementBytes }
          : this.keep(gathered.rows, current.data, gathered.schema.length);
      if (truncated !== null || current.nextUri === null) return { kind: "done", truncated, final };
      const link = acceptNextUri(current.nextUri, this.ids.queryId);
      if (link.kind === "refused") return { kind: "refused", error: protocolError(link.reason) };
      // The result is complete: the final link only closes it [X02].
      if (link.kind === "final") return { kind: "done", truncated: null, final: true };
      polls += 1;
      if (polls > maxPolls) return { kind: "refused", error: protocolError(DATABEND_PROTOCOL_FAULTS.pollBound) };
      // oxlint-disable-next-line no-await-in-loop -- each page names the next.
      const page = await this.page(link.path, gathered.session);
      // Checked before anything of it is kept, so the close reads the last session of this statement's own answers.
      const fault = this.pageFault(page.answer, gathered.schema);
      if (fault !== null) return { kind: "refused", error: protocolError(fault) };
      current = page.answer;
      bytes += page.bytes;
    }
  }

  /** Why an answer is not this statement's: one for another query id, or for another session than ours. */
  private identityFault(answer: DatabendAnswer): string | null {
    if (answer.id !== this.ids.queryId) return DATABEND_PROTOCOL_FAULTS.queryId;
    if (answer.sessionId === this.ids.sessionId) return null;
    // An empty echo is a session Databend made itself: the header did not arrive.
    return answer.sessionId ? DATABEND_PROTOCOL_FAULTS.sessionId : DATABEND_PROTOCOL_FAULTS.proxySession;
  }

  /**
   * Why a later page is not this statement's, checked as its first answer is: another query id or session, or a
   * schema unlike the one the rows so far were kept under, names and types in order. Until a schema is kept, a page's
   * schema is not compared, and a page with no schema and no rows is a long poll still running.
   */
  private pageFault(answer: DatabendAnswer, kept: readonly DatabendColumn[]): string | null {
    const identity = this.identityFault(answer);
    if (identity !== null || kept.length === 0) return identity;
    if (answer.schema.length === 0 && answer.data.length === 0) return null;
    return sameSchema(answer.schema, kept) ? null : DATABEND_PROTOCOL_FAULTS.pageSchema;
  }

  /** Keeps a server warning, once, among the first `DATABEND_WARNING_LIMIT` different ones; one past them is counted. */
  private keepWarning(gathered: Gathered, warning: string): void {
    const text = serverText(warning, this.options.secretForms);
    if (gathered.warnings.has(text)) return;
    if (gathered.warnings.size < DATABEND_WARNING_LIMIT) gathered.warnings.add(text);
    else gathered.warningsLeftOut += 1;
  }

  /** Keeps a page's rows up to the row cut and the cell budget, first reached; the cut, or null. */
  private keep(
    rows: DatabendCell[][],
    data: readonly (readonly DatabendCell[])[],
    width: number,
  ): DatabendTruncation | null {
    for (const row of data) rows.push(row as DatabendCell[]);
    const { rowCut } = this.request;
    const cellRows = width === 0 ? Number.POSITIVE_INFINITY : Math.floor(this.options.cellBudget / width);
    if (rows.length > rowCut && rowCut <= cellRows) {
      rows.length = rowCut;
      return { bound: "rows", limit: rowCut };
    }
    if (rows.length > cellRows) {
      rows.length = cellRows;
      return { bound: "cells", limit: this.options.cellBudget };
    }
    return null;
  }

  /** One page GET under its attempt timer; a failure closes the statement and throws. */
  private async page(
    path: string,
    last: DatabendSessionEcho | null,
  ): Promise<{ answer: DatabendAnswer; bytes: number }> {
    let exchanged: Exchanged;
    try {
      exchanged = await this.exchange({
        request: "page",
        method: "GET",
        path,
        headers: this.headers(),
        attempt: () =>
          AbortSignal.any([
            this.signal,
            this.deps.deadline(
              Math.max(1, Math.min(this.endsAt - this.deps.now(), WAIT_TIME_SECS * 1000 + PAGE_ATTEMPT_SLACK_MS)),
            ),
          ]),
        signal: this.signal,
        endsAt: this.endsAt,
        read: true,
      });
    } catch (error) {
      throw await this.pageFailed(error, last);
    }
    const reading = exchanged.reading as DatabendReading;
    if (reading.kind === "refusal") {
      // After a refused sign-in the closes are skipped: they would carry the refused credential again, only to be
      // refused and counted toward a lockout.
      this.refused(reading.refusal);
      throw await this.abandon(refusalError(reading.refusal, this.context("get")), last);
    }
    return { answer: reading.answer, bytes: Buffer.byteLength(exchanged.response.text) };
  }

  private async pageFailed(error: unknown, last: DatabendSessionEcho | null): Promise<DatabendError> {
    const killAcknowledged = await this.kill(false);
    await this.endOpen(last);
    if (this.signal.aborted) return stopError(this.stop(), { answered: true, killAcknowledged }, this.context("get"));
    if (error instanceof DatabendError) return error;
    if (error instanceof TransportError) {
      // The page attempt timer expired again with statement time left: the page gave no answer, the deadline did not.
      if (error.kind === "timeout" && this.endsAt - this.deps.now() > 0) {
        return new DatabendError("outcome-unknown", DATABEND_ERROR_SENTENCES.noAnswer(DATABEND_PAGE_UNANSWERED), {
          cause: error,
        });
      }
      return transportFailure(error, { answered: true, killAcknowledged }, this.context("get"));
    }
    return configError(error);
  }

  /** The close of design 3.4 for an exit the server did not end itself: kill, end-open, the error. */
  private async abandon(error: DatabendError, last: DatabendSessionEcho | null): Promise<DatabendError> {
    await this.kill(false);
    await this.endOpen(last);
    return error;
  }

  /** One request with the retries of design 3.11: an answer, a refusal past its retries, or the failure thrown. */
  private async exchange(exchange: Exchange): Promise<Exchanged> {
    let pageTimerRetried = false;
    for (let attempt = 1; ; attempt += 1) {
      let failure: TransportError | null = null;
      let exchanged: Exchanged | null = null;
      try {
        // oxlint-disable-next-line no-await-in-loop -- a retry follows its failed attempt.
        const response = await this.node.request({
          method: exchange.method,
          url: endpointUrl(this.options.origin, exchange.path),
          ...(exchange.body === undefined ? {} : { body: exchange.body }),
          headers: exchange.headers,
          signal: exchange.attempt(),
          maxResponseBytes: this.options.responseCapBytes,
        });
        const reading =
          response.status === 200 && !exchange.read ? readCloseAnswer(response) : readAnswer(response, this.bounds);
        if (reading?.kind !== "refusal") return { response, reading };
        exchanged = { response, reading };
      } catch (error) {
        if (!(error instanceof TransportError) || exchange.signal.aborted) throw error;
        failure = error;
      }
      const refusal = exchanged?.reading?.kind === "refusal" ? exchanged.reading.refusal : null;
      const decision = retryDecision({
        request: exchange.request,
        status: refusal?.status ?? null,
        gatewayKind: refusal?.gatewayKind ?? null,
        transportKind: failure?.kind ?? null,
        attempt,
        msLeft: exchange.endsAt - this.deps.now(),
        retryAfter: exchanged?.response.retryAfter ?? null,
        random: this.deps.random(),
        pageTimerRetried,
      });
      if (!decision.retry) {
        if (exchanged === null) throw failure;
        return exchanged;
      }
      if (failure?.kind === "timeout") pageTimerRetried = true;
      // oxlint-disable-next-line no-await-in-loop -- the backoff between two attempts.
      if (decision.delayMs > 0) await this.deps.sleep(decision.delayMs, exchange.signal);
      if (exchange.request === "query" && exchange.signal.aborted) throw new StoppedBetweenAttempts();
    }
  }

  /** A close request's own budget, off the statement's signal (design 3.12). */
  private closeBudget(): { signal: AbortSignal; endsAt: number } {
    return {
      signal: this.deps.deadline(this.options.closeTimeoutMs),
      endsAt: this.deps.now() + this.options.closeTimeoutMs,
    };
  }

  /**
   * One close under its budget: what it was answered, `UNREADABLE` for an answer it could not read, or null when
   * nothing arrived or the run's sign-in was refused, which sends nothing. A refusal of the close is reported to the
   * latch like one of the POST.
   */
  private async closeExchange(
    request: RetryRequest,
    method: "GET" | "POST",
    path: string,
    budget: { signal: AbortSignal; endsAt: number },
    extra: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly read?: boolean;
    } = {},
  ): Promise<CloseAnswer> {
    if (this.signInRefused) return null;
    const answer = await this.exchange({
      request,
      method,
      path,
      body: extra.body,
      headers: extra.headers ?? this.headers(),
      attempt: () => budget.signal,
      signal: budget.signal,
      endsAt: budget.endsAt,
      read: extra.read ?? false,
    }).catch((error: unknown): CloseAnswer => (answerArrived(error) ? UNREADABLE : null));
    if (answer !== UNREADABLE && answer?.reading?.kind === "refusal") this.refused(answer.reading.refusal);
    return answer;
  }

  /**
   * Stops the statement; true when Databend acknowledged the kill, with a 200 that is not a gateway's refusal. Before
   * the first answer a 404 is resent (design 3.10).
   */
  private async kill(beforeAnswer: boolean): Promise<boolean> {
    const resends: number[] = beforeAnswer ? [...KILL_RESENDS_MS] : [];
    const budget = this.closeBudget();
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a resent kill follows a 404.
      const answer = await this.closeExchange("kill", "GET", killPath(this.ids.queryId), budget);
      if (acknowledged(answer)) return true;
      const wait = notFound(answer) ? resends.shift() : undefined;
      if (wait === undefined) return false;
      // oxlint-disable-next-line no-await-in-loop -- the wait before the kill is resent.
      await this.deps.sleep(wait, budget.signal);
    }
  }

  /** Closes a statement the server already ended; its failure is a notice, never an error [X02]. */
  private async final(): Promise<void> {
    const answer = await this.closeExchange("final", "GET", finalPath(this.ids.queryId), this.closeBudget());
    if (!acknowledged(answer)) this.notices.push(closeNotice(answer, "final"));
  }

  private async logout(): Promise<CloseAnswer> {
    return this.closeExchange("logout", "POST", LOGOUT_PATH, this.closeBudget());
  }

  /** What the last echoed session left open, closed from the server's flags (design 3.4). */
  private async endOpen(last: DatabendSessionEcho | null): Promise<void> {
    const plan = endOpenPlan({ txnState: last?.txnState ?? null, needKeepAlive: last?.needKeepAlive ?? false });
    let keepAlive = true;
    if (plan.includes("rollback")) keepAlive = await this.rollback(last as DatabendSessionEcho);
    if (plan.includes("logout") && keepAlive) {
      // A logout a refused sign-in left unsent never went unanswered.
      const skipped = this.signInRefused;
      const answer = await this.logout();
      if (acknowledged(answer)) this.notices.push({ kind: "temp-tables-dropped" });
      else this.notices.push(skipped ? { kind: "close-skipped", step: "logout" } : closeNotice(answer, "logout"));
    }
  }

  /**
   * ROLLBACK under a new query id with the session echoed verbatim, its links followed to the end inside the same
   * 5 s and the poll bound of that 5 s, with no nested end-open [X13]; whether the session still needs keep-alive
   * afterwards.
   */
  private async rollback(session: DatabendSessionEcho): Promise<boolean> {
    const queryId = newQueryId(this.deps.newId);
    const budget = this.closeBudget();
    const posted = await this.closeExchange("rollback", "POST", QUERY_PATH, budget, {
      headers: this.headers(queryId),
      body: rollbackBody(session.raw),
      read: true,
    });
    const answer = answerOf(posted);
    this.notices.push(rollbackNotice(queryId, answer && { id: answer.id, txnState: answer.session?.txnState ?? null }));
    if (answer === null) return true;
    let next = answer.nextUri;
    const maxPolls = pollBound(this.options.closeTimeoutMs);
    for (let polls = 1; next !== null; polls += 1) {
      const link = acceptNextUri(next, queryId);
      const followed =
        // oxlint-disable-next-line no-await-in-loop -- each answer names the next link.
        link.kind === "refused" || polls > maxPolls ? null : await this.followRollback(link.path, budget);
      const followedAnswer = answerOf(followed);
      if (followedAnswer === null) {
        this.notices.push(closeNotice(followed, "rollback"));
        break;
      }
      next = followedAnswer.nextUri;
    }
    return answer.session?.needKeepAlive ?? true;
  }

  /**
   * One GET of the ROLLBACK's chain inside its budget: what it was answered, a 200 it could not read, or null when
   * nothing arrived.
   */
  private async followRollback(path: string, budget: { signal: AbortSignal; endsAt: number }): Promise<CloseAnswer> {
    return this.closeExchange("rollback", "GET", path, budget, { read: true });
  }

  /** The headers of one request: the client session and route hint, a POST's query id, and the sticky node once known. */
  private headers(queryId?: string): Record<string, string> {
    return {
      "x-databend-session": this.session,
      "x-databend-route-hint": this.ids.routeHint,
      ...(queryId === undefined ? {} : { "x-databend-query-id": queryId }),
      ...(this.nodeId === null ? {} : { "x-databend-sticky-node": this.nodeId }),
    };
  }

  /** Which of Studio's own stops fired: the deadline carries a `TimeoutError` reason, anything else is a cancel. */
  private stop(): DatabendStop {
    const reason: unknown = this.signal.reason;
    return reason instanceof DOMException && reason.name === "TimeoutError" ? "deadline" : "cancel";
  }

  private context(request: "post" | "get"): DatabendFailureContext {
    return {
      request,
      origin: this.request.origin,
      sql: this.request.sql,
      warehouse: this.options.warehouse,
      endpoint: this.options.endpoint,
      timeoutMs: this.timeoutMs,
      secretForms: this.options.secretForms,
    };
  }
}

/**
 * The transport of one connection: one node transport, built here, which opens nothing until the first request.
 * `close()` cancels every run in flight, each with its own kill, waits for them, then releases the sockets [X31].
 *
 * The statement deadline is the connection's query timeout for a user statement and the surface timeout for a
 * provider statement: it sets `max_execute_time_in_seconds`, the poll bound and the time retries may take, and the
 * caller folds the same deadline into the request's signal (design 2.3). The SET ROLE warning compares against the
 * role the first provider statement echoed, which is the connect probe's (design 3.7).
 */
export function createDatabendHttpTransport(
  options: DatabendConnectionOptions,
  deps: Partial<DatabendHttpTransportDeps> = {},
): DatabendTransport {
  const resolved: DatabendHttpTransportDeps = { ...PRODUCTION_DEPS, ...deps };
  const node = resolved.createNodeTransport({
    origin: options.origin,
    tls: options.tls,
    maxSockets: options.maxSockets,
    headers: options.headers,
    requestHeaderNames: options.requestHeaderNames,
  });
  const runs = new Set<{ readonly cancel: () => void; readonly done: Promise<unknown> }>();
  let closed = false;
  /** The role the first provider statement echoed, the connect probe's, against which SET ROLE is told (design 3.7). */
  let probeRole: string | null | undefined;

  return {
    async run(request) {
      const controller = new AbortController();
      if (closed) controller.abort();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const done = new StatementRun(options, resolved, node, request, signal).run();
      const entry = { cancel: () => controller.abort(), done };
      runs.add(entry);
      const forget = () => runs.delete(entry);
      done.then(forget, forget);
      const { role, ...outcome } = await done;
      if (request.origin === "provider" && probeRole === undefined) probeRole = role;
      const session = sessionNotices(outcome.affect, role, probeRole ?? null, options.secretForms);
      return { ...outcome, notices: [...session, ...outcome.notices] };
    },
    async close() {
      closed = true;
      for (const run of runs) run.cancel();
      await Promise.allSettled([...runs].map((run) => run.done));
      node.close();
    },
  };
}
