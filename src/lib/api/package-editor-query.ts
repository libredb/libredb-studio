/**
 * The editor query on a session of an engine an admitted provider package serves (docs/providers/CONTRACT.md, clause
 * C-113): the steps of `runEditorQuery` (./editor-query) over the package's contract session rather than a legacy
 * provider's bridged one, which `POST /api/db/query` runs for such an engine.
 *
 * The run goes through the host core the process's composition root installed (`hostCore`), with the session's handle
 * bound and the package's declared environment in every call's context. The execute is asked for one row past the page
 * (#1440), whether or not the package applies the page, so a next page is known to exist; the host pumps the first
 * result within that row count and the page's 32 MiB. A session that offers `console.endScope` is sent a scope, ended
 * after the run under a cleanup context (clause C-60). A caller that leaves while the package runs is answered at once,
 * and the core sends the package's `console.cancel` with the run's id where the session offers it (clause C-48).
 *
 * The answer is today's body: the page's rows as records keyed by their column names, each cell in the value codec's
 * wire form (plain JSON values as themselves), its fields, the declared types of the columns that state one, and its
 * pagination. A next page is offered only where the session honours `offset`, since Studio can ask for no other page
 * otherwise. The package's warnings go through core's scrub of the connection.
 */
import {
  BATCH_MAX_BYTES,
  type Column,
  checkConsoleFacet,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type PumpLimits,
} from "@libredb/provider-sdk/calls";
import { encodeValue } from "@libredb/provider-sdk/values";
import {
  callContext,
  type EditorQueryAnswer,
  type EditorQueryRun,
  endAfterRun,
  endRunScope,
  executeDeadlineFor,
  executeViewsFor,
  hostPorts,
} from "@/lib/api/editor-query";
import type { CachedPackageSession } from "@/lib/db/package-sessions";
import { type ProviderTextScrub, scrubProviderWarnings } from "@/lib/db/operations/provider-text";
import { DEFAULT_QUERY_TIMEOUT, newQueryCallScope } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { refusalError, stopError } from "@/lib/provider-host/access";
import type { ExecuteRecord, PageRecord } from "@/lib/provider-host/core/console";
import { hostCore } from "@/lib/provider-host/instance";
import type { QueryWarning } from "@/lib/types";

/** One run on a package's session: `runEditorQuery`'s run, and the connection's own statement timeout. */
export interface PackageQueryRun extends EditorQueryRun {
  /** The connection's `queryTimeout`, which the route checked; Studio's default when absent. */
  readonly queryTimeout: number | undefined;
}

/** The page a run asks for, and whether its session can be asked for the page after it. */
export interface PackagePage {
  readonly limit: number;
  readonly offset: number;
  /** Whether the session honours `offset`, so a next page can be asked for. */
  readonly honoursOffset: boolean;
}

/** Why a package's columns cannot key a row: a name that is not text, an empty one, or one repeated. */
function columnDefect(columns: readonly Column[]): string | null {
  const seen = new Set<string>();
  for (const column of columns) {
    const name: unknown = column.name;
    if (typeof name !== "string" || name === "") return "a column with no name";
    if (seen.has(name)) return "two columns of one name";
    seen.add(name);
  }
  return null;
}

/**
 * The answer body of the page `record` holds, under `columns`, the first result's columns the package answered, and
 * `page`, its warnings through `scrub`; the record is released once, in a `finally`, whether or not the body was built.
 *
 * @throws {Error} Naming the package's defect, for columns whose names cannot key a row.
 */
function packagePageBody(
  record: PageRecord,
  columns: readonly Column[],
  page: PackagePage,
  scrub: ProviderTextScrub,
): EditorQueryAnswer {
  try {
    const defect = columnDefect(columns);
    if (defect !== null) {
      throw new Error(`The provider package answered ${defect}, so Studio cannot key its rows; this is its defect.`);
    }
    const fields = columns.map((column) => column.name);
    const pumped = record.page.rows;
    // The probe row is the proof that a next page exists (#1440), and a page the host cut by bytes ends before the
    // rows ran out; either is a next page only where the session takes an offset.
    const probed = pumped.length > page.limit;
    const byteCut = record.page.end === "byte-limit";
    const hasMore = page.honoursOffset && (probed || byteCut);
    const rows = pumped
      .slice(0, page.limit)
      .map((row) => Object.fromEntries(fields.map((field, index) => [field, encodeValue(row[index])])));
    const typed = columns.filter((column) => typeof column.type === "string");
    const warnings =
      record.warnings.length === 0 ? [] : scrubProviderWarnings(scrub, record.warnings as QueryWarning[]);
    return {
      body: {
        rows,
        fields,
        ...(typed.length > 0 && {
          columnTypes: Object.fromEntries(typed.map((column) => [column.name, column.type as string])),
        }),
        // The provider's own count where the page holds every row it answered; the rows answered otherwise.
        rowCount: probed || byteCut || record.rowCount === undefined ? rows.length : record.rowCount,
        executionTime: record.executionTimeMs,
        ...(warnings.length > 0 && { warnings }),
        pagination: {
          limit: page.limit,
          offset: page.offset,
          hasMore,
          totalReturned: rows.length,
          wasLimited: probed || byteCut || record.boundApplied === true,
        },
      },
      resultSetCount: record.resultCount,
    };
  } finally {
    record.release();
  }
}

/**
 * Runs one statement on `cached`, a package's session, and answers its first result's page. The session counts the run
 * while its call runs, so the idle sweep keeps it: until the record answers, or until the call a stop answered has
 * settled. The package's own errors reach the caller by reference (clause C-31); the route answers them with Studio's
 * sentence (`packageCallError` in ./package-errors).
 *
 * @throws {QueryCancelledError} When the caller left.
 * @throws {StudioTimeoutRefusal} When the deadline ended the run.
 * @throws {FacetNotOfferedError} Not-sent, for bound params the session does not honour.
 * @throws {OffsetUnsupportedError} Not-sent, for a non-zero offset the session does not honour.
 */
export async function runPackageEditorQuery(
  cached: CachedPackageSession,
  run: PackageQueryRun,
): Promise<EditorQueryAnswer> {
  const core = hostCore();
  const { session, env } = cached;
  const timeout = run.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
  const deadline = executeDeadlineFor(timeout, Date.now());
  const views = executeViewsFor(timeout, run.signal);
  const limit = run.options.limit ?? DEFAULT_QUERY_LIMIT;
  const offset = run.options.offset ?? 0;
  const scope = checkConsoleFacet(session.calls, "endScope").length === 0 ? newQueryCallScope() : undefined;
  const end = () => endRunScope(core, session, scope, run, env);
  const request: ExecuteRequest = {
    statement: run.statement,
    page: { limit: limit + 1, offset },
    ...(run.params === undefined ? {} : { params: [...run.params] }),
    ...(run.queryId === undefined ? {} : { runId: run.queryId }),
    ...(scope === undefined ? {} : { scope }),
  };
  // The first result's columns: a page record carries none, so they are kept from the answer the pump reads.
  let columns: readonly Column[] = [];
  const pumpLimits = (answer: ExecuteAnswer): PumpLimits => {
    columns = answer.results[0]?.columns ?? [];
    return { maxRows: limit + 1, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };
  };
  cached.running += 1;
  let record: ExecuteRecord | undefined;
  try {
    try {
      record = await core.executeCall(
        session,
        request,
        callContext(deadline, run.signal, env),
        pumpLimits,
        hostPorts(run.route),
      );
    } catch (error) {
      await end();
      throw error;
    }
    const openTransaction = await endAfterRun(record, end, run.route);
    if (record.kind === "refused") throw refusalError(record, views.view);
    if (record.kind === "stopped") throw stopError(record.reason, views.stopView(record));
    const honoursOffset = session.calls.console.execute.honours.includes("offset");
    const answer = packagePageBody(record, columns, { limit, offset, honoursOffset }, run.scrub);
    if (openTransaction !== "rolled-back") return answer;
    return { ...answer, body: { ...answer.body, openTransaction } };
  } finally {
    cached.lastUsed = Date.now();
    if (record?.kind === "stopped") {
      void record.settled.then(() => {
        cached.running -= 1;
      });
    } else {
      cached.running -= 1;
    }
  }
}
