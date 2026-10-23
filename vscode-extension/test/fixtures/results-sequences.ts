// The host's message sequences for the criteria the dropped _electron e2e held (part 4 "Tests", the controller's
// ruling): written from part 4's tables and the query route's page shape, rendered by test/browser/results-view.spec.ts.
// Part H's presenter test (test/unit/results/results-presenter.test.ts) must assert that the presenter posts exactly
// these for the same runs, so the browser leg renders what the host really sends.
import type { QueryPage } from "../../src/protocol";
import type { GridContext, HostToWebview } from "../../src/results-protocol";

export const RUN_A = "6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4";
export const RUN_B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** A fixed start, so a sequence is the same bytes on every run; the presenter test's clock answers it. */
export const STARTED_AT = 1_760_000_000_000;

export const POSTGRES_GRID: GridContext = {
  databaseType: "postgres",
  supportsResultPagination: true,
  commitKeyword: "COMMIT",
};

const MONGODB_GRID: GridContext = {
  databaseType: "mongodb",
  supportsResultPagination: false,
  commitKeyword: "COMMIT",
};

const page = (
  rows: Record<string, unknown>[],
  pagination: QueryPage["pagination"],
  extra: Partial<QueryPage> = {},
): QueryPage => ({
  rows,
  fields: rows.length > 0 ? Object.keys(rows[0]) : [],
  rowCount: rows.length,
  executionTime: 12,
  pagination,
  ...extra,
});

const started = (runId: string, statement: string): HostToWebview => ({
  v: 1,
  type: "runStarted",
  runId,
  statement,
  startedAt: STARTED_AT,
});

const SELECT_PEOPLE = 'SELECT * FROM "public"."people"';

/** What PostgreSQL 18 declares for `people (id int, name text, email text)`, as a live run of SELECT_PEOPLE answers. */
const PEOPLE_TYPES = { columnTypes: { id: "integer", name: "text", email: "text" } };

const PEOPLE_FIRST_PAGE = page(
  [
    { id: 1, name: "Ada", email: "ada@example.com" },
    { id: 2, name: "Lin", email: "lin@example.com" },
  ],
  { limit: 2, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
  PEOPLE_TYPES,
);

/**
 * Criterion 8: Select Rows on PostgreSQL with libredb.query.rowLimit 2 over a 4-row table, then Load More once.
 * The route probes one row past its own bound, so the first page has hasMore and the second, at offset 2, does not.
 * Part H's presenter test: "Load More appends the next page at offset 2" posts exactly this.
 */
export const LOAD_MORE_ON_POSTGRES: HostToWebview[] = [
  started(RUN_A, SELECT_PEOPLE),
  { v: 1, type: "runSucceeded", runId: RUN_A, page: PEOPLE_FIRST_PAGE, grid: POSTGRES_GRID },
  { v: 1, type: "pageStarted", runId: RUN_A },
  {
    v: 1,
    type: "pageAppended",
    runId: RUN_A,
    page: page(
      [
        { id: 3, name: "Grace", email: "grace@example.com" },
        { id: 4, name: "Edsger", email: "edsger@example.com" },
      ],
      { limit: 2, offset: 2, hasMore: false, totalReturned: 2, wasLimited: true },
      PEOPLE_TYPES,
    ),
  },
];

/**
 * Criterion 9, one sequence per row of part 4's error table and the failed page.
 * Part H's presenter test: each failure kind through toRunFailure posts exactly the matching sequence.
 */
export const FAILURES: Record<"pageFailed" | "runFailed" | "cancelled" | "backendExited", HostToWebview[]> = {
  pageFailed: [
    started(RUN_A, SELECT_PEOPLE),
    { v: 1, type: "runSucceeded", runId: RUN_A, page: PEOPLE_FIRST_PAGE, grid: POSTGRES_GRID },
    { v: 1, type: "pageStarted", runId: RUN_A },
    {
      v: 1,
      type: "pageFailed",
      runId: RUN_A,
      failure: { kind: "error", message: "canceling statement due to statement timeout" },
    },
  ],
  runFailed: [
    started(RUN_B, "select * from it_missing"),
    {
      v: 1,
      type: "runFailed",
      runId: RUN_B,
      failure: { kind: "error", message: 'relation "it_missing" does not exist' },
    },
  ],
  cancelled: [
    started(RUN_A, "select pg_sleep(60)"),
    { v: 1, type: "runFailed", runId: RUN_A, failure: { kind: "cancelled" } },
  ],
  backendExited: [
    started(RUN_B, "select pg_sleep(60)"),
    { v: 1, type: "runFailed", runId: RUN_B, failure: { kind: "backendExited", exitCode: null, signal: "SIGKILL" } },
  ],
};

/**
 * SYNTHETIC, not recorded: a failure that carries the driver's detail, for the cases that check how the webview shows
 * one. No live run on the four v0 engines answers a detail today, because mapDatabaseError in src/lib/db/errors.ts
 * builds QueryError without it (docs/BACKLOG.md D389), so this sequence is left out of the integration leg's
 * comparison with live runs by name. The message and detail are what PostgreSQL itself raises for a unique violation.
 * Part H's presenter test and the browser leg's criterion 9 read it; D389 replaces it with a recorded live sequence.
 */
export const SYNTHETIC_RUN_FAILED_WITH_DETAIL: HostToWebview[] = [
  started(RUN_A, "insert into it_unique (id) values (1)"),
  {
    v: 1,
    type: "runFailed",
    runId: RUN_A,
    failure: {
      kind: "error",
      message: 'duplicate key value violates unique constraint "it_unique_pkey"',
      detail: "Key (id)=(1) already exists.",
    },
  },
];

/**
 * Criterion 10: an UPDATE of 3 rows, a lone BEGIN on PostgreSQL (the route rolls back the transaction it left open),
 * and `select 1; select 2` (the first set, with resultSetCount 2).
 * Part H's presenter test: the three runs post exactly these.
 */
export const EMPTY_AND_NOTICES: Record<"update3" | "loneBegin" | "twoResultSets", HostToWebview[]> = {
  update3: [
    started(RUN_A, "update people set name = upper(name) where id <= 3"),
    {
      v: 1,
      type: "runSucceeded",
      runId: RUN_A,
      page: page([], { limit: 2, offset: 0, hasMore: false, totalReturned: 0, wasLimited: false }, { rowCount: 3 }),
      grid: POSTGRES_GRID,
    },
  ],
  loneBegin: [
    started(RUN_B, "BEGIN"),
    {
      v: 1,
      type: "runSucceeded",
      runId: RUN_B,
      page: page(
        [],
        { limit: 2, offset: 0, hasMore: false, totalReturned: 0, wasLimited: false },
        { openTransaction: "rolled-back" },
      ),
      grid: POSTGRES_GRID,
    },
  ],
  twoResultSets: [
    started(RUN_A, "select 1; select 2"),
    {
      v: 1,
      type: "runSucceeded",
      runId: RUN_A,
      page: page(
        [{ "?column?": 1 }],
        { limit: 2, offset: 0, hasMore: false, totalReturned: 1, wasLimited: false },
        { columnTypes: { "?column?": "integer" }, resultSetCount: 2 },
      ),
      grid: POSTGRES_GRID,
    },
  ],
};

/**
 * Criterion 11: a find over documents with different keys, as the MongoDB provider shapes them: ObjectIds as hex,
 * the union of the top-level keys as fields, first seen first; MongoDB declares no result pagination.
 * Part H's presenter test: the MongoDB run posts exactly this.
 */
export const MONGODB_DOCUMENTS: HostToWebview[] = [
  started(RUN_B, '{ "collection": "people", "operation": "find" }'),
  {
    v: 1,
    type: "runSucceeded",
    runId: RUN_B,
    page: page(
      [
        { _id: "65f1c0ffee0000000000abcd", name: "Ada", address: { city: "Izmir", zip: "35000" }, tags: ["a"] },
        { _id: "65f1c0ffee0000000000abce", name: "Lin", address: { city: "Ankara", zip: "06000" } },
      ],
      { limit: 2, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
      { fields: ["_id", "name", "address", "tags"] },
    ),
    grid: MONGODB_GRID,
  },
];
