/**
 * The server's confirmation of a run reads a claim that loosens the gate only where the engine's register row grants it
 * for the grammar that row reviewed, and asks about every statement of an engine whose grammar its row did not review,
 * on every route it serves: `POST /api/db/query`, `POST /api/db/multi-query` and `POST /api/db/transaction` with
 * `action: "query"`.
 *
 * The ungranted requests are planted, since no shipped declaration makes one: a decides-alone row is the stand-in
 * vocabulary row under Trino, and the two grammar claims are planted as a declaration states them, in the generated
 * SQL text the grammar is composed from: an exempt form is Trino's real entry with `DELETE FROM` added to its
 * `confirmExemptForms`, and a text-not-SQL claim is Druid's real entry with `readsSqlText: false`. SQLite's register
 * row is planted to review no grammar, through the register's reader (tests/helpers/planted-legacy-register.ts). Both
 * modules are mocked before anything that reaches the grammar registry or the grant reader is imported, because
 * `SQL_GRAMMAR` and the legacy grants are composed from them when they load, so this file imports only `bun:test`
 * statically. Only what answers before a provider is replaced:
 * the session, the connection resolution, the provider cache, the query route's open of the editor's session and the
 * query event insert.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const { BUNDLED_SQL_TEXT } = await import("@/lib/db/engine-catalog/sql-text.generated");
mock.module("@/lib/db/engine-catalog/sql-text.generated", () => ({
  BUNDLED_SQL_TEXT: {
    ...BUNDLED_SQL_TEXT,
    trino: {
      ...BUNDLED_SQL_TEXT.trino,
      grammar: { ...BUNDLED_SQL_TEXT.trino.grammar, confirmExemptForms: [["DELETE", "FROM"]] },
    },
    druid: { ...BUNDLED_SQL_TEXT.druid, readsSqlText: false },
  },
}));
const { plantedRegisterReader } = await import("../../helpers/planted-legacy-register");
const realRegister = { ...(await import("@libredb/grant-register")) };
mock.module("@libredb/grant-register", () => ({
  ...realRegister,
  readGrantRegister: plantedRegisterReader(realRegister, { sqlite: { grammarSha256: null } }),
}));
const { servedEngineRecord } = await import("@/lib/db/server-catalog");

const { createMockProvider } = await import("../../helpers/mock-provider");
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);
/** The query route's open of the editor's session of any record; a request the gate answers reaches no open. */
const mockGetOrCreateEditorSession = mock(async () => {
  throw new Error("A request the gate answers opens nothing.");
});
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
  resolveServedConnection: mock(async (body: { connection: { type: string } }) => ({
    connection: body.connection,
    engine: servedEngineRecord(body.connection.type),
  })),
}));

const realDb = await import("@/lib/db");
mock.module("@/lib/db", () => ({
  ...realDb,
  getOrCreateProvider: mockGetOrCreateProvider,
  readProviderDeclarations: mockReadProviderDeclarations,
}));

const realFactory = { ...(await import("@/lib/db/factory")) };
mock.module("@/lib/db/factory", () => ({ ...realFactory, getOrCreateEditorSession: mockGetOrCreateEditorSession }));

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
  mockGetOrCreateEditorSession.mockClear();
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
    expect(mockGetOrCreateEditorSession).not.toHaveBeenCalled();
    expect(mockReadProviderDeclarations).not.toHaveBeenCalled();
  }

  test("a decides-alone claim the record does not list is answered 428 when asked, before any provider", async () => {
    remove = installStandInVocabulary({});
    await expectAsked(await run(STAND_IN_TYPE, "DROP TABLE t", "ask"));
  });

  test("an exempt form the record does not list is answered 428 when asked, before any provider", async () => {
    await expectAsked(await run("trino", "DELETE FROM t", "ask"));
  });

  test("a text-not-sql claim the record does not list is answered 428 when asked, before any provider", async () => {
    await expectAsked(await run("druid", "SELECT 1; DROP TABLE t", "ask"));
  });

  test("an unreadable run under a text-not-sql plant says unreadable", async () => {
    await expectAsked(await run("druid", "SELECT '\\'; DELETE FROM t", "ask"), true);
  });

  test("a grammar no register row reviews is answered 428 when asked, a read included, before any provider", async () => {
    await expectAsked(await run("sqlite", "SELECT 1", "ask"));
    process.env.LIBREDB_RUN_CONFIRMATION = "required";
    await expectAsked(await run("sqlite", "SELECT 1"));
  });

  test("required mode answers 428 for each planted claim without the field", async () => {
    process.env.LIBREDB_RUN_CONFIRMATION = "required";
    await expectAsked(await run("trino", "DELETE FROM t"));
    await expectAsked(await run("druid", "SELECT 1; DROP TABLE t"));
    remove = installStandInVocabulary({});
    await expectAsked(await run(STAND_IN_TYPE, "DROP TABLE t"));
  });
});
