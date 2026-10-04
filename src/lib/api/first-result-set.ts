import type { QueryResult } from "@/lib/types";

/**
 * A query result as the single-statement routes send it: without `resultSets`.
 *
 * A text that produced several result sets carries all of them (#1312) so that
 * `POST /api/db/multi-query` can choose which one a T-SQL batch shows. The routes that run
 * one statement answer with the first set, as they always did, and sending a copy of every
 * set beside it would only double the response.
 */
export function firstResultSet(result: QueryResult): Omit<QueryResult, "resultSets"> {
  const first = { ...result };
  delete first.resultSets;
  return first;
}
