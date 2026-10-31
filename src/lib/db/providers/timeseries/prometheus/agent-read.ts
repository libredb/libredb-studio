/**
 * What an agent's PromQL read answers: the console's instant query, its answer counted against the row budget before
 * it is shaped, shaped exactly as the console shapes it, and refused past the row or byte budget rather than cut, with
 * every failure worded by its category.
 *
 * HOW AN ANSWER COUNTS. A vector counts one row per series, the one sample each carries. A matrix counts every sample
 * of every series, float and native histogram points alike, since that is what reaches the model; a range vector or a
 * subquery at the top of the expression is a matrix. A scalar and a string count one. The query asks the server for
 * one series past the row budget (`limit`), so a server that cut its answer there is seen, and refused as an answer
 * past the budget, never shown in part. The console's grid writes a matrix as one row per instant and one column per
 * series, so an answer it would cut to fit its grid is refused too. Only the engine's own notices travel with the
 * rows, verbatim, inside the untrusted-content fence like every other result.
 *
 * WHAT IS WORDED BY CATEGORY. A refusal of Studio's own budget (rows, bytes, the time spent waiting) says it is
 * Studio's. A time-out the server reached at the deadline Studio sent with the query, and an evaluation the server
 * refused (its own sample limit, `--query.max-samples`, is one such refusal), are named by their category with the
 * read's time budget, never in the server's own text. A parse error keeps the server's sentence, which describes the
 * expression the model wrote. Every other failure keeps the provider's own classification.
 */
import { QueryError, TimeoutError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { QueryResult, QueryWarning, ReadOnlyStatementBudget } from "@/lib/db/types";
import { type ErrorContext, toDatabaseError } from "./errors";
import { RESPONSE_BYTE_CAP } from "./http-transport";
import { MATRIX_SAMPLE_BUDGET, shapeQueryResult } from "./results";
import { type PrometheusAnswer, type PrometheusQueryData, PrometheusTransportError } from "./transport";

const PROMETHEUS_TYPE = "prometheus";
const NO_SERVER_TEXT = "The server's own text is not quoted.";
const ASK_FOR_LESS = "Ask for less: a narrower selector, an aggregation, a shorter range or a larger subquery step.";

export const PROMETHEUS_AGENT_FAILURE_SENTENCES = {
  /** Studio stopped waiting at the read's time budget: the read waited for a query slot or the answer was late. */
  deadline: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: no answer within ${ms}ms, the read's time budget, so Studio stopped the read and refused it. This is Studio's refusal, not the server's answer. ${ASK_FOR_LESS}`,
  /** The server ended the evaluation at the time-out Studio sent with the query. */
  serverTimeout: (ms: number): string =>
    `The server stopped evaluating the expression at the time-out Studio sent with it, ${ms}ms, the read's time budget (category timeout). ${NO_SERVER_TEXT} ${ASK_FOR_LESS}`,
  /** The server refused to evaluate the expression. */
  execution: (ms: number): string =>
    `The server refused to evaluate the expression (category execution), within the read's time budget of ${ms}ms: an evaluation that would load more samples than the server's own limit allows, or one that matches many series to many, is refused this way. ${NO_SERVER_TEXT} ${ASK_FOR_LESS}`,
  /** The expression did not parse on the server; the server's sentence is about the model's own expression. */
  badData: (message: string): string => `The server could not parse the expression (category bad_data): ${message}`,
  /** The answer passed the response cap every request is read under. */
  tooLarge: (bytes: number): string =>
    `The server's answer passed ${bytes} bytes, the most Studio reads of one answer, so Studio stopped reading it and refused the read rather than answer part of it. This is Studio's refusal, not the server's answer. ${ASK_FOR_LESS}`,
  /** The console's grid would cut the matrix to fit. */
  grid: (cells: number): string =>
    `Read-only execution refused the answer: its matrix would fill more than ${cells} cells of the console's grid (one row per instant, one column per series), so it would be cut, and Studio refuses rather than cut. ${ASK_FOR_LESS}`,
} as const;

/** The rows an answer counts against the row budget (see the module docblock). */
function answerRowCount(data: PrometheusQueryData): number {
  switch (data.shape) {
    case "vector":
      return data.series.length;
    case "matrix":
      return data.series.reduce((total, series) => total + series.samples.length + series.histograms.length, 0);
    default:
      return 1;
  }
}

/**
 * The agent's result: refused past the row budget before it is shaped, shaped as the console shapes it, and refused
 * when the grid would cut it or its rows pass the byte budget.
 */
export function prometheusAgentResult(
  answer: PrometheusAnswer<PrometheusQueryData>,
  budget: ReadOnlyStatementBudget,
  executionTime: number,
): QueryResult {
  const counted = answerRowCount(answer.value);
  if (answer.truncatedByServer || counted > budget.maxResultRows) {
    // A server that cut at the requested limit holds at least one series past the budget.
    throw new QueryError(
      rowBudgetSentence(Math.max(counted, budget.maxResultRows + 1), budget.maxResultRows),
      PROMETHEUS_TYPE,
    );
  }
  const shaped = shapeQueryResult(answer, {
    seriesLimit: budget.maxResultRows,
    sampleBudget: MATRIX_SAMPLE_BUDGET,
    // The byte budget is applied below, as a refusal, so the shaper is never the one to cut for it.
    byteBudget: Number.MAX_SAFE_INTEGER,
  });
  if (shaped.wasLimited) {
    throw new QueryError(PROMETHEUS_AGENT_FAILURE_SENTENCES.grid(MATRIX_SAMPLE_BUDGET), PROMETHEUS_TYPE);
  }
  const bytes = measureResultBytes(shaped.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), PROMETHEUS_TYPE);
  }
  const warnings: QueryWarning[] = shaped.warnings;
  return {
    rows: shaped.rows,
    fields: shaped.fields,
    rowCount: shaped.rows.length,
    executionTime,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * VictoriaMetrics reports a failure's category as the HTTP status number rather than a word (measured on v1.152.0 in
 * the agent boundary capture: "400" for a parse error and "422" for its own points limit), so the agent reads those two
 * as the categories Prometheus names them by. Every other category is read as it is.
 */
const NUMBERED_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({ "400": "bad_data", "422": "execution" });

function agentCategory(category: string): string {
  return Object.hasOwn(NUMBERED_CATEGORIES, category) ? NUMBERED_CATEGORIES[category] : category;
}

/** A failure of an agent read, worded by its category (see the module docblock). */
export function prometheusAgentFailure(error: unknown, budget: ReadOnlyStatementBudget, context: ErrorContext): Error {
  const ms = budget.statementTimeoutMs;
  const { provider, query } = context;
  // The wait for a query slot ends on the read's own deadline, which rejects with the timer's DOMException.
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new TimeoutError(PROMETHEUS_AGENT_FAILURE_SENTENCES.deadline(ms), provider, ms, query);
  }
  if (error instanceof PrometheusTransportError) {
    switch (agentCategory(error.category)) {
      case "deadline":
        return new TimeoutError(PROMETHEUS_AGENT_FAILURE_SENTENCES.deadline(ms), provider, ms, query);
      case "timeout":
        return new TimeoutError(PROMETHEUS_AGENT_FAILURE_SENTENCES.serverTimeout(ms), provider, ms, query);
      case "execution":
        return new QueryError(PROMETHEUS_AGENT_FAILURE_SENTENCES.execution(ms), provider, query);
      case "bad_data":
        return new QueryError(PROMETHEUS_AGENT_FAILURE_SENTENCES.badData(error.message), provider, query);
      case "too_large":
        return new QueryError(
          PROMETHEUS_AGENT_FAILURE_SENTENCES.tooLarge(error.detail.limitBytes ?? RESPONSE_BYTE_CAP),
          provider,
          query,
        );
      default:
        break;
    }
  }
  return toDatabaseError(error, context);
}
