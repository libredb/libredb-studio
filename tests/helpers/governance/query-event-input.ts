/**
 * Query event inputs for the tests of the query event sink: one editor statement that ran on a granted PostgreSQL
 * connection, as a route describes it to `recordQueryEvent()`, which a test varies through its overrides.
 */
import { queryEventStart } from "@/lib/query-events/build";
import type { QueryEventInput } from "@/lib/query-events/types";

/** The subject the inputs name, as an identity provider's `sub`. */
export const QUERY_EVENT_SUBJECT = "8d0f6a4e-2b1c-4f3a-9e7d-5c6b4a3f2e1d";

export function queryEventInput(overrides: Partial<QueryEventInput> = {}): QueryEventInput {
  return {
    source: "editor",
    principal: { subject: QUERY_EVENT_SUBJECT, username: "alice@example.com", role: "user" },
    connection: { id: "seed:orders", name: "Orders", engine: "postgres", accessLevel: "read" },
    statement: "SELECT id, total FROM orders WHERE customer_id = 42",
    status: "success",
    started: queryEventStart(),
    rowCount: 1,
    ...overrides,
  };
}

/** A start ten minutes ahead of the wall clock: the governance source refuses an event more than 5 minutes ahead. */
export function startInTheFuture(aheadMs = 10 * 60_000): QueryEventInput["started"] {
  return { wallClockMs: Date.now() + aheadMs, monotonicMs: performance.now() };
}
