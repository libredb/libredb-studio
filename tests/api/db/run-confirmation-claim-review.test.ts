/**
 * The server's confirmation of a run reads a row's loosening claim only where Studio's review record lists it
 * (`CONFIRMATION_CLAIM_REVIEW`), on every route it serves: `POST /api/db/query`, `POST /api/db/multi-query` and
 * `POST /api/db/transaction` with `action: "query"`.
 *
 * The claims are planted, since no shipped row makes an unlisted one: a decides-alone row is the stand-in vocabulary
 * row under Trino, and an exempt form is Trino's real grammar row with `DELETE FROM` added. A grammar row is mocked
 * before anything that reaches the grammar registry is imported, because `SQL_GRAMMAR` is built from the row objects
 * when it loads, so this file imports only `bun:test` statically. Only what answers before a provider is replaced:
 * the session, the connection resolution, the provider cache and the query event insert.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realTrino = await import("@/lib/db/providers/sql/trino/sql-grammar");
mock.module("@/lib/db/providers/sql/trino/sql-grammar", () => ({
  ...realTrino,
  TRINO_SQL_GRAMMAR: {
    ...realTrino.TRINO_SQL_GRAMMAR,
    grammar: { ...realTrino.TRINO_SQL_GRAMMAR.grammar, confirmExemptForms: [["DELETE", "FROM"]] },
  },
}));

const { createMockProvider } = await import("../../helpers/mock-provider");
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);
const mockReadProviderDeclarations = mock(async () => ({
  capabilities: mockProvider.getCapabilities(),
  labels: mockProvider.getLabels(),
  supportsQueryCancel: false,
}));

/** A run confirmation is bound to the session's issue time, so the session carries one. */
const session = { role: "user", username: "alice", iat: 1_700_000_000 };
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => session),
  readSession: mock(async () => ({ kind: "authenticated", session })),
}));

const realResolveConnection = await import("@/lib/seed/resolve-connection");
mock.module("@/lib/seed/resolve-connection", () => ({
  ...realResolveConnection,
  resolveConnection: mock(async (body: Record<string, unknown>) => body.connection),
}));

const realDb = await import("@/lib/db");
mock.module("@/lib/db", () => ({
  ...realDb,
  getOrCreateProvider: mockGetOrCreateProvider,
  readProviderDeclarations: mockReadProviderDeclarations,
}));

const realPostgresSink = await import("@/lib/query-events/postgres-sink");
mock.module("@/lib/query-events/postgres-sink", () => ({
  ...realPostgresSink,
  writeQueryEventBatch: mock(async (rows: readonly unknown[]) => ({
    settled: rows.length,
    rejections: [],
    failure: null,
  })),
}));

const { createMockRequest, parseResponseJSON } = await import("../../helpers/mock-next");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { forgetUsedRunConfirmations } = await import("@/lib/api/run-confirmation-token");
const { installStandInVocabulary, STAND_IN_TYPE } = await import("../../helpers/stand-in-vocabulary");
const query = await import("@/app/api/db/query/route");
const multiQuery = await import("@/app/api/db/multi-query/route");
const transaction = await import("@/app/api/db/transaction/route");

type Post = (request: never) => Promise<Response>;

const ROUTES: readonly (readonly [string, Post, Record<string, unknown>])[] = [
  ["/api/db/query", query.POST as Post, {}],
  ["/api/db/multi-query", multiQuery.POST as Post, {}],
  ["/api/db/transaction", transaction.POST as Post, { action: "query" }],
];

const original = process.env.LIBREDB_RUN_CONFIRMATION;
let remove: (() => void) | undefined;

beforeEach(() => {
  delete process.env.LIBREDB_RUN_CONFIRMATION;
  clearRateLimitState();
  forgetUsedRunConfirmations();
  mockGetOrCreateProvider.mockClear();
  mockReadProviderDeclarations.mockClear();
});

afterEach(() => {
  remove?.();
  remove = undefined;
  if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
  else process.env.LIBREDB_RUN_CONFIRMATION = original;
});

describe.each(ROUTES)("POST %s", (path, post, extra) => {
  function run(type: string, sql: string, confirmation?: unknown) {
    const connection = { id: "claims-1", name: "Claims", type, host: "localhost", port: 8080 };
    const body = { connection, sql, ...extra, ...(confirmation === undefined ? {} : { confirmation }) };
    return post(createMockRequest(path, { method: "POST", body }) as never);
  }

  async function expectAsked(res: Response, unreadable = false): Promise<void> {
    expect(res.status).toBe(428);
    expect(await parseResponseJSON(res)).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      confirmation: { unreadable, typedConfirmation: null, classificationFailed: false },
    });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockReadProviderDeclarations).not.toHaveBeenCalled();
  }

  test("a decides-alone claim the record does not list is answered 428 when asked, before any provider", async () => {
    remove = installStandInVocabulary({});
    await expectAsked(await run(STAND_IN_TYPE, "DROP TABLE t", "ask"));
  });

  test("an exempt form the record does not list is answered 428 when asked, before any provider", async () => {
    await expectAsked(await run("trino", "DELETE FROM t", "ask"));
  });

  test("required mode answers 428 for each planted claim without the field", async () => {
    process.env.LIBREDB_RUN_CONFIRMATION = "required";
    await expectAsked(await run("trino", "DELETE FROM t"));
    remove = installStandInVocabulary({});
    await expectAsked(await run(STAND_IN_TYPE, "DROP TABLE t"));
  });
});
