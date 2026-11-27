/**
 * `POST /api/db/query` on an engine an admitted provider package serves, through the real `resolveServedConnection`,
 * the provider factory's real editor cache, the real confirmation gate, the real run (`runEditorQuery` in
 * src/lib/api/editor-query.ts) and the real host core: the route opens, gates and runs a legacy and a package engine
 * through one open, one gate and one run; every statement of an engine whose grammar no register row reviews is asked
 * about, and the statement of one whose grammar its row reviewed is read under that grammar with the claims that loosen
 * the gate its row grants; the session opens once per key through the package; the run answers the
 * package's rows keyed by column name; a request field the package does not honour, and one the route does not serve
 * for such an engine, is refused before any call; a caller that leaves sends the package's cancel; a package's own
 * words reach the client only where its register row grants them, and then through core's scrub; and each run records one editor event naming its engine by its id, whose record decides
 * what the event keeps of its text.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. Only `@/lib/auth` is mocked;
 * the editor's open, the gate and the run are wrapped to record what each was handed, each calling the real function,
 * the query events sink's recording is replaced to capture what the route hands it, and the legacy provider's own
 * entry points reject by name.
 * Nothing awaits a timer: the cancel case waits on a promise the package's execute resolves when it starts, and on one
 * its cancel resolves.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type CallRefusal, callRefusalSentence } from "@libredb/provider-sdk/calls";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { consoleTextByteLimit } from "@/lib/db/destructive-commands";
import { type EngineRecord, forgetServerCatalog, installServerCatalog } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { buildQueryEvent } from "@/lib/query-events/build";
import type { QueryEventInput } from "@/lib/query-events/types";
import { parseResponseJSON } from "../../helpers/mock-next";
import {
  admitSessionPackages,
  declaredGrammarSha256,
  type SessionPackage,
  setHooks,
} from "../../helpers/package-session-fixture";
import { ACME_LANGUAGE_DATA, withStatementLanguageData } from "../../helpers/package-catalog";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin", iat: 1_700_000_000 })),
  readSession: mock(async () => ({
    kind: "authenticated",
    session: { role: "admin", username: "admin", iat: 1_700_000_000 },
  })),
}));

/*
 * What the route opens, gates and runs, recorded by name around the real functions: the editor's one open of any record,
 * the one gate, and the one run, by the form the open answered. Neither of the legacy provider's own entry points is
 * reached: each rejects by name.
 */
const opens: string[] = [];
const gates: string[] = [];
const runs: string[] = [];
const unreached = () => Promise.reject(new Error("the factory's getOrCreateProvider was reached"));
// Each real function is held before its module is mocked: a mocked module's namespace object answers the mock, so a
// delegate read through it would call itself.
const realFactory = { ...(await import("@/lib/db/factory")) };
const openEditorSession = realFactory.getOrCreateEditorSession;
mock.module("@/lib/db/factory", () => ({
  ...realFactory,
  getOrCreateProvider: unreached,
  getOrCreateEditorSession: (...args: Parameters<typeof openEditorSession>) => {
    opens.push(args[1].id);
    return openEditorSession(...args);
  },
}));
const realDb = { ...(await import("@/lib/db")) };
mock.module("@/lib/db", () => ({ ...realDb, getOrCreateProvider: unreached }));
const realGate = { ...(await import("@/lib/api/run-confirmation")) };
const gateRun = realGate.gateRun;
mock.module("@/lib/api/run-confirmation", () => ({
  ...realGate,
  gateRun: (request: Parameters<typeof gateRun>[0]) => {
    gates.push(request.engine.id);
    return gateRun(request);
  },
}));
const realRun = { ...(await import("@/lib/api/editor-query")) };
const runEditorQuery = realRun.runEditorQuery;
mock.module("@/lib/api/editor-query", () => ({
  ...realRun,
  runEditorQuery: (...args: Parameters<typeof runEditorQuery>) => {
    runs.push(args[0].form);
    return runEditorQuery(...args);
  },
}));

/*
 * The query events the route records, captured in place of the sink's recording. Governance is off in this file, where
 * the real recorder returns at once, so not handing the input on changes nothing a case reads.
 */
const recordedEvents: QueryEventInput[] = [];
const realSink = { ...(await import("@/lib/query-events/sink")) };
mock.module("@/lib/query-events/sink", () => ({
  ...realSink,
  recordQueryEvent: (input: QueryEventInput) => {
    recordedEvents.push(input);
  },
}));

const { POST } = await import("@/app/api/db/query/route");
const { clearProviderCache } = await import("@/lib/db/factory");

const MAIN = "acmeqmain";
const BARE = "acmeqbare";
const LOOSE = "acmeqloose";
const WORDS = "acmeqwords";
const REVIEWED = "acmeqreviewed";
const NOSQL = "acmeqnosql";
const DECIDES = "acmeqdecides";
const CHANGED = "acmeqchanged";
const providers = scratchDirectory("studio-query-package-");
let engines: Map<string, EngineRecord>;

/** A package whose register row reviews the grammar it declares and grants no claim that loosens the gate. */
const REVIEWED_PACKAGE: SessionPackage = { name: "acme-q-reviewed", engine: REVIEWED };
const EXEMPT_FORM = ["ALTER", "SESSION", "SET"];
/**
 * A package declaring two claims that would loosen the gate, both granted by its register row for its grammar, and the
 * statement language data the row reviews, without which no package row grants text-not-SQL.
 */
const LOOSE_PACKAGE: SessionPackage = {
  name: "acme-q-loose",
  engine: LOOSE,
  edit: (engine) => {
    withStatementLanguageData(engine);
    const sqlText = engine.sqlText as { readsSqlText: boolean; grammar: { confirmExemptForms: string[][] } };
    sqlText.readsSqlText = false;
    sqlText.grammar.confirmExemptForms = [EXEMPT_FORM];
  },
};

/**
 * A package whose engine states no SQL text, SQL writing or migration DDL, and the statement language data its row
 * reviews, without which no package row grants text-not-SQL or decides-alone.
 */
const NOSQL_PACKAGE: SessionPackage = {
  name: "acme-q-nosql",
  engine: NOSQL,
  edit: (engine) => {
    withStatementLanguageData(engine);
    const members = engine as Record<string, unknown>;
    members.sqlText = null;
    members.sqlWriting = null;
    members.migrationDdl = null;
  },
};

/**
 * A package declaring the statement language data its register row reviews, with its grammar, and whose row grants the
 * data's claim that its reader's answer is the gate's whole answer.
 */
const DECIDES_PACKAGE: SessionPackage = { name: "acme-q-decides", engine: DECIDES, edit: withStatementLanguageData };
/** The same declaration, whose register row reviewed data one byte different from the data it declares. */
const CHANGED_PACKAGE: SessionPackage = { name: "acme-q-changed", engine: CHANGED, edit: withStatementLanguageData };
/** `ACME_LANGUAGE_DATA` with one byte changed: its bound is 4097 rather than 4096. */
const CHANGED_LANGUAGE_DATA = {
  ...ACME_LANGUAGE_DATA,
  confirmation: { ...ACME_LANGUAGE_DATA.confirmation, maxTextBytes: 4097 },
};

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  engines = await admitSessionPackages(
    providers,
    [
      // No register row reviews the grammar of MAIN, BARE or WORDS.
      { name: "acme-q-main", engine: MAIN, offered: ["console.cancel"] },
      { name: "acme-q-bare", engine: BARE },
      LOOSE_PACKAGE,
      { name: "acme-q-words", engine: WORDS },
      REVIEWED_PACKAGE,
      NOSQL_PACKAGE,
      DECIDES_PACKAGE,
      CHANGED_PACKAGE,
    ],
    {
      [WORDS]: { ownWords: "scrubbed" },
      [REVIEWED]: { grammarSha256: declaredGrammarSha256(REVIEWED_PACKAGE) },
      [LOOSE]: {
        grammarSha256: declaredGrammarSha256(LOOSE_PACKAGE),
        languageSha256: languageDataSha256(ACME_LANGUAGE_DATA),
        readsSqlText: false,
        confirmExemptForms: [EXEMPT_FORM],
      },
      // A row granting SQL text claims for a grammar NOSQL does not have: it states none for a row to review.
      [NOSQL]: {
        grammarSha256: declaredGrammarSha256(REVIEWED_PACKAGE),
        languageSha256: languageDataSha256(ACME_LANGUAGE_DATA),
        redaction: { kind: "sql", nameQuote: '"' },
        readsSqlText: false,
        confirmExemptForms: [EXEMPT_FORM],
        decidesAlone: true,
      },
      [DECIDES]: {
        grammarSha256: declaredGrammarSha256(DECIDES_PACKAGE),
        languageSha256: languageDataSha256(ACME_LANGUAGE_DATA),
        decidesAlone: true,
      },
      [CHANGED]: {
        grammarSha256: declaredGrammarSha256(CHANGED_PACKAGE),
        languageSha256: languageDataSha256(CHANGED_LANGUAGE_DATA),
        decidesAlone: true,
      },
    },
  );
});
afterAll(async () => {
  await clearProviderCache();
  removeScratch(providers);
});

/** What one package's hooks saw, by call name, with each call's arguments. */
interface Seen {
  readonly calls: { name: string; args: unknown[] }[];
}

const COLUMNS = [{ name: "key" }, { name: "value", type: "text" }];

/** A result source answering `rows` under `COLUMNS`, in batches no larger than the pump asks for. */
function source(rows: unknown[][]) {
  let at = 0;
  return {
    columns: COLUMNS,
    next: (limit: { maxRows: number }) => {
      const batch = rows.slice(at, at + limit.maxRows);
      at += batch.length;
      return Promise.resolve({ rows: batch, done: at >= rows.length });
    },
    close: () => Promise.resolve(),
  };
}

/** Hooks for `engine`'s package that open, answer `rows` to every execute and close; `execute` replaces the answer. */
function hooksFor(
  engine: string,
  options: { execute?: (...args: unknown[]) => Promise<unknown>; cancel?: (...args: unknown[]) => unknown } = {},
): Seen {
  const seen: Seen = { calls: [] };
  const push =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      seen.calls.push({ name, args });
      return answer(...args);
    };
  setHooks(engine, {
    open: push("open", () => Promise.resolve({ handle: { session: randomUUID() } })),
    close: push("close", () => Promise.resolve()),
    health: push("health", () => Promise.resolve({})),
    execute: push(
      "execute",
      options.execute ??
        (() =>
          Promise.resolve({
            results: [
              source([
                ["alpha", 1],
                ["beta", "two"],
              ]),
            ],
            warnings: [],
            executionTimeMs: 3,
            pageApplied: false,
          })),
    ),
    cancel: push("cancel", options.cancel ?? (() => Promise.resolve({ cancelled: true }))),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** The message a malformed execute answer is answered with: the package's defect, each refusal at its pointer. */
function packageDefectSentence(...refusals: (string | [string, string])[]): string {
  const read = refusals.map(
    (refusal): CallRefusal =>
      typeof refusal === "string"
        ? { rule: "execute-answer-unreadable", pointer: refusal }
        : { rule: "execute-answer-unreadable", pointer: refusal[0], name: refusal[1] },
  );
  return `${PACKAGE_DEFECT_PREFIX} ${read.map(callRefusalSentence).join(" ")}`;
}

/** A connection of `engine` with its own id and a generated secret. */
function connectionOf(engine: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `conn-${randomUUID()}`,
    name: "Keys",
    type: engine,
    host: "kv.local",
    password: randomUUID(),
    ...fields,
  };
}

/** The route's status and body for `body`, under `signal` when given. */
async function post(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  clearRateLimitState();
  const response = await POST(
    new Request("http://localhost:3000/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
}

beforeEach(() => {
  delete process.env.LIBREDB_RUN_CONFIRMATION;
});

describe("POST /api/db/query on an engine a provider package serves", () => {
  test("a query on an admitted engine answers the package's rows through the host core", async () => {
    const seen = hooksFor(REVIEWED);
    const { status, body } = await post({ connection: connectionOf(REVIEWED), sql: "SELECT 1", options: { limit: 5 } });
    expect(status).toBe(200);
    expect(body).toEqual({
      rows: [
        { key: "alpha", value: 1 },
        { key: "beta", value: "two" },
      ],
      fields: ["key", "value"],
      columnTypes: { value: "text" },
      rowCount: 2,
      executionTime: 3,
      pagination: { limit: 5, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
    });
    expect(names(seen)).toEqual(["open", "execute"]);
    expect(seen.calls[1]?.args[1]).toEqual({ statement: "SELECT 1", page: { limit: 6, offset: 0 } });
  });

  test("the query route runs one gate and one run for a legacy and a package engine, told apart only by the record's offers", async () => {
    const seen = hooksFor(REVIEWED);
    for (const list of [opens, gates, runs]) list.length = 0;

    const legacy = await post({
      connection: { id: `conn-${randomUUID()}`, name: "Scratch", type: "sqlite", database: ":memory:" },
      sql: "SELECT 1 AS one",
    });
    const served = await post({ connection: connectionOf(REVIEWED), sql: "SELECT 1", options: { limit: 5 } });

    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ rows: [{ one: 1 }], fields: ["one"] });
    expect(served.status).toBe(200);
    expect(served.body).toEqual({
      rows: [
        { key: "alpha", value: 1 },
        { key: "beta", value: "two" },
      ],
      fields: ["key", "value"],
      columnTypes: { value: "text" },
      rowCount: 2,
      executionTime: 3,
      pagination: { limit: 5, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
    });
    expect(opens).toEqual(["sqlite", REVIEWED]);
    expect(gates).toEqual(["sqlite", REVIEWED]);
    expect(runs).toEqual(["provider", "session"]);
    expect(names(seen)).toEqual(["open", "execute"]);
  });

  test("a package engine no register row reviews asks about every statement, a read included", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    expect(engines.get(MAIN)?.grants.reviewedGrammar).toBe(false);
    const asked = await post({ connection, sql: "SELECT 1", confirmation: "ask" });
    expect(asked.status).toBe(428);
    expect(asked.body).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      confirmation: { unreadable: false, typedConfirmation: null },
    });
    expect(names(seen)).toEqual([]);
    // The advisory default runs a request that sends no confirmation field, and marks it unconfirmed.
    const unasked = await post({ connection, sql: "SELECT 1" });
    expect(unasked.status).toBe(200);
    expect(unasked.body).toMatchObject({
      rows: [
        { key: "alpha", value: 1 },
        { key: "beta", value: "two" },
      ],
    });
    expect(unasked.body.confirmation).toBe("unconfirmed");
    expect(names(seen)).toEqual(["open", "execute"]);
  });

  test("a package engine with no SQL text facts whose register row states a grammar digest is asked about every statement, and its query events keep no statement text", async () => {
    expect(engines.get(NOSQL)?.statementGrammar).toBeNull();
    expect(engines.get(NOSQL)?.grants.reviewedGrammar).toBe(false);
    const connection = connectionOf(NOSQL);
    const secret = connection.password as string;
    const seen = hooksFor(NOSQL);
    // A read, and the form the row grants as exempt for a grammar the engine does not state: each asks.
    for (const sql of ["SELECT 1", "ALTER SESSION SET x = 1"]) {
      const asked = await post({ connection, sql, confirmation: "ask" });
      expect([sql, asked.status]).toEqual([sql, 428]);
      expect(asked.body).toMatchObject({
        code: "CONFIRMATION_REQUIRED",
        confirmation: { unreadable: false, typedConfirmation: null },
      });
    }
    expect(names(seen)).toEqual([]);

    recordedEvents.length = 0;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      // The advisory default runs a request that sends no confirmation field, and marks it unconfirmed.
      const unasked = await post({ connection, sql: "SELECT 1" });
      expect(unasked.status).toBe(200);
      expect(unasked.body).toMatchObject({
        rows: [
          { key: "alpha", value: 1 },
          { key: "beta", value: "two" },
        ],
        confirmation: "unconfirmed",
      });
      expect(names(seen)).toEqual(["open", "execute"]);
      hooksFor(NOSQL, { execute: () => Promise.reject(new Error(`no such key, as ${secret} said`)) });
      const failed = await post({ connection, sql: "SELECT 1" });
      expect(failed.status).toBe(500);
    } finally {
      error.mockRestore();
      hooksFor(NOSQL);
    }

    expect(recordedEvents.map(({ connection: named, statement, status }) => [named.engine, statement, status])).toEqual(
      [
        [NOSQL, "SELECT 1", "success"],
        [NOSQL, "SELECT 1", "error"],
      ],
    );
    // Each input built into its row by the real builder in every capture mode, given the `seed:` id, access level and
    // subject only governance's resolve and session hand, as the events case above gives them.
    for (const statementCapture of ["full", "redacted", "none"] as const) {
      const rows = recordedEvents.map((input) =>
        buildQueryEvent(
          {
            ...input,
            principal: { ...input.principal, subject: "subject-1" },
            connection: { ...input.connection, id: "seed:keys", accessLevel: "read" },
          },
          { statementCapture, maxStatementBytes: 4096 },
          { studioInstance: "libredb-studio" },
        ),
      );
      expect([
        statementCapture,
        rows.map(({ statement, statement_fingerprint, error_message, statement_type }) => [
          statement,
          statement_fingerprint,
          error_message,
          statement_type,
        ]),
      ]).toEqual([
        statementCapture,
        [
          [null, null, null, "OTHER"],
          [null, null, null, "OTHER"],
        ],
      ]);
    }
  });

  test("the statement is read under the package's declared grammar its register row reviewed, and a write asks for a confirmation", async () => {
    const seen = hooksFor(REVIEWED);
    const connection = connectionOf(REVIEWED);
    expect(engines.get(REVIEWED)?.grants.reviewedGrammar).toBe(true);
    const asked = await post({ connection, sql: "DELETE FROM t", confirmation: "ask" });
    expect(asked.status).toBe(428);
    expect(asked.body).toMatchObject({ code: "CONFIRMATION_REQUIRED", confirmation: { typedConfirmation: null } });
    expect(names(seen)).toEqual([]);
    const token = (asked.body.confirmation as { token: string }).token;
    const confirmed = await post({ connection, sql: "DELETE FROM t", confirmation: { token } });
    expect(confirmed.status).toBe(200);
    expect(names(seen)).toEqual(["open", "execute"]);

    // The minimal manifest declares that EXPLAIN never executes; the gate reads the claim both ways, so an analyzed
    // write asks, and nothing is opened before the confirmation.
    const analyzed = await post({ connection, sql: "EXPLAIN ANALYZE DELETE FROM t", confirmation: "ask" });
    expect(analyzed.status).toBe(428);
    expect(names(seen)).toEqual(["open", "execute"]);

    // A declaration that claims its text is not SQL and exempts a form, both granted by its register row: the form
    // runs, and the text is not split, so a write after the first statement is not read; its own write still asks.
    const loose = hooksFor(LOOSE);
    const looseConnection = connectionOf(LOOSE);
    expect(engines.get(LOOSE)?.grants).toMatchObject({ readsSqlText: false, confirmExemptForms: [EXEMPT_FORM] });
    const answer = await post({ connection: looseConnection, sql: "DELETE FROM t", confirmation: "ask" });
    expect(answer.status).toBe(428);
    expect(names(loose)).toEqual([]);
    for (const sql of ["ALTER SESSION SET x = 1", "SELECT 1; DROP TABLE x", "SELECT 1"]) {
      const ran = await post({ connection: looseConnection, sql, confirmation: "ask" });
      expect([sql, ran.status]).toEqual([sql, 200]);
    }
    expect(names(loose)).toEqual(["open", "execute", "execute", "execute"]);
  });

  test("a package engine's declared language data, reviewed by its row with decidesAlone granted, runs a SQL write, answers 413 past its stated byte bound, and one changed byte reads the statement as SQL", async () => {
    // Its data names no operation and its reader names none, so with the decides-alone claim granted every statement
    // whose text reads runs, a SQL write included.
    const decides = hooksFor(DECIDES);
    const decidesConnection = connectionOf(DECIDES);
    expect(engines.get(DECIDES)?.grants).toMatchObject({ reviewedGrammar: true, decidesAlone: true });
    for (const sql of ["DELETE FROM t", "SELECT 1"]) {
      const ran = await post({ connection: decidesConnection, sql, confirmation: "ask" });
      expect([sql, ran.status]).toEqual([sql, 200]);
    }
    expect(names(decides)).toEqual(["open", "execute", "execute"]);
    // The bound its data states holds on the query route, before any open, reviewed or not; a text at it runs.
    const padded = (bytes: number) => `SELECT 1 -- ${"x".repeat(bytes - "SELECT 1 -- ".length)}`;
    const over = await post({ connection: decidesConnection, sql: padded(4097), confirmation: "ask" });
    expect(over).toEqual({
      status: 413,
      body: {
        error:
          "The statement is 4097 bytes in UTF-8, over the 4096-byte limit for this connection type. Shorten it to run it.",
      },
    });
    expect(names(decides)).toEqual(["open", "execute", "execute"]);
    expect((await post({ connection: decidesConnection, sql: padded(4096), confirmation: "ask" })).status).toBe(200);
    expect(names(decides)).toEqual(["open", "execute", "execute", "execute"]);

    // A row that reviewed data one byte different grants none of the data's claims: the statement is read as SQL under
    // the grammar the row reviewed, so a write asks and a read runs.
    const changed = hooksFor(CHANGED);
    const changedConnection = connectionOf(CHANGED);
    expect(engines.get(CHANGED)?.grants).toMatchObject({ reviewedGrammar: true, decidesAlone: false });
    const asked = await post({ connection: changedConnection, sql: "DELETE FROM t", confirmation: "ask" });
    expect(asked.status).toBe(428);
    expect(names(changed)).toEqual([]);
    expect((await post({ connection: changedConnection, sql: "SELECT 1", confirmation: "ask" })).status).toBe(200);
    expect(names(changed)).toEqual(["open", "execute"]);

    // A package that declares no data and whose grammar no row reviewed still asks about a read.
    hooksFor(MAIN);
    expect((await post({ connection: connectionOf(MAIN), sql: "SELECT 1", confirmation: "ask" })).status).toBe(428);
  });

  test("bound params and an offset the package does not honour are refused before the call, not-sent", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    const params = await post({ connection, sql: "SELECT 1", params: [1] });
    expect([params.status, params.body.code, params.body.outcome, params.body.error]).toEqual([
      400,
      "FACET_NOT_OFFERED",
      "not-sent",
      "This connection's provider package takes no bound parameters, so Studio sent nothing.",
    ]);
    const offset = await post({ connection, sql: "SELECT 1", options: { limit: 2, offset: 2 } });
    expect([offset.status, offset.body.outcome, offset.body.error]).toEqual([
      400,
      "not-sent",
      "This connection's provider package does not take an offset, so Studio asks for no page after the first.",
    ]);
    expect(names(seen)).toEqual(["open"]);
  });

  test("a query whose caller leaves sends the package's cancel through the host core", async () => {
    for (const engine of [MAIN, BARE]) {
      let started!: () => void;
      const executing = new Promise<void>((resolve) => {
        started = resolve;
      });
      let settle!: (error: unknown) => void;
      let cancelled!: () => void;
      const cancelSent = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const seen = hooksFor(engine, {
        execute: () => {
          started();
          return new Promise((_resolve, reject) => {
            settle = reject;
          });
        },
        cancel: () => {
          cancelled();
          return Promise.resolve({ cancelled: true });
        },
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const queryId = randomUUID();
        const controller = new AbortController();
        const answer = post(
          { connection: connectionOf(engine), sql: "SELECT pg_sleep(60)", queryId },
          controller.signal,
        );
        await executing;
        controller.abort();
        const { status, body } = await answer;
        expect([status, body.code]).toEqual([499, "QUERY_CANCELLED"]);
        if (engine === MAIN) {
          await cancelSent;
          expect(seen.calls.filter(({ name }) => name === "cancel").map(({ args }) => args[1])).toEqual([
            { runId: queryId },
          ]);
        }
        settle(new Error("the run was cancelled"));
        // A package without console.cancel is sent no cancel: the run is reported still running.
        if (engine === BARE) expect(names(seen)).toEqual(["open", "execute"]);
      } finally {
        warn.mockRestore();
      }
    }
  });

  test("explain, database, catalog and unlimited are refused by name before any open", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    for (const [fields, field] of [
      [{ explain: { mode: "estimate" } }, "explain"],
      [{ database: 2 }, "database"],
      [{ catalog: "other" }, "catalog"],
      [{ options: { unlimited: true } }, "options.unlimited"],
    ] as const) {
      const { status, body } = await post({ connection, sql: "SELECT 1", ...fields });
      expect([status, body.code, body.error]).toEqual([
        501,
        "PACKAGE_ENGINE_UNSUPPORTED",
        `This LibreDB Studio does not serve ${field} in a query on an engine of a provider package yet.`,
      ]);
    }
    // A malformed field keeps its 400.
    for (const fields of [
      { explain: { mode: "plan" } },
      { database: -1 },
      { catalog: "" },
      { options: { limit: -1 } },
    ]) {
      expect((await post({ connection, sql: "SELECT 1", ...fields })).status).toBe(400);
    }
    expect(names(seen)).toEqual([]);
  });

  test("a field the record does not offer is refused by name with today's 501, after the malformed-field 400s", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    const answer = async (fields: Record<string, unknown>, onto: Record<string, unknown> = connection) => {
      const { status, body } = await post({ connection: onto, sql: "SELECT 1", ...fields });
      return { status, body };
    };
    // The package's record offers none of the four, each refused by the name the answer gives it.
    for (const [fields, field] of [
      [{ explain: { mode: "estimate" } }, "explain"],
      [{ database: 2 }, "database"],
      [{ catalog: "other" }, "catalog"],
      [{ options: { unlimited: true } }, "options.unlimited"],
    ] as const) {
      const { status, body } = await answer(fields);
      expect([field, status, body.code, body.error]).toEqual([
        field,
        501,
        "PACKAGE_ENGINE_UNSUPPORTED",
        `This LibreDB Studio does not serve ${field} in a query on an engine of a provider package yet.`,
      ]);
    }
    // Each malformed field answers its own 400 before any 501, alone and beside a field the record does not offer.
    const explain400 = { error: 'explain must be { "mode": "estimate" } or { "mode": "analyze" }' };
    const database400 = { error: '"database" must be a non-negative integer' };
    const catalog400 = {
      error: '"catalog" must be a non-empty string naming a database',
      code: "CONFIG_ERROR",
      statusCode: 400,
      kind: "config",
      outcome: "unknown",
    };
    for (const [fields, body] of [
      [{ explain: { mode: "plan" } }, explain400],
      [{ explain: { mode: "plan" }, database: 2 }, explain400],
      [{ database: -1 }, database400],
      [{ explain: { mode: "estimate" }, database: -1 }, database400],
      [{ catalog: "" }, catalog400],
      [{ explain: { mode: "estimate" }, catalog: "" }, catalog400],
      [{ options: { limit: -1 } }, { error: "options.limit must be a non-negative integer" }],
    ] as const) {
      expect([fields, await answer(fields)]).toEqual([fields, { status: 400, body }]);
    }
    expect(names(seen)).toEqual([]);

    // The package declares no statement language data, so its record holds no row and states no console text bound: a
    // text over the smallest bound a shipped engine declares runs.
    const bounds = EXTERNAL_DATABASE_TYPES.map((type) => consoleTextByteLimit(type)).filter(
      (bound): bound is number => bound !== undefined,
    );
    const over = `SELECT 1 -- ${"x".repeat(Math.min(...bounds))}`;
    expect((await post({ connection, sql: over })).status).toBe(200);
    expect(names(seen)).toEqual(["open", "execute"]);

    // A legacy engine's record offers all four, so none is refused by name: each answers as the engine answers it.
    const sqlite = { id: `conn-${randomUUID()}`, name: "Local", type: "sqlite", database: ":memory:" };
    const legacy = async (fields: Record<string, unknown>) => answer(fields, sqlite);
    expect(await legacy({ options: { unlimited: true } })).toMatchObject({
      status: 200,
      body: { rows: [{ "1": 1 }], pagination: { limit: 100_000, hasMore: false } },
    });
    expect(await legacy({ database: 2 })).toEqual({
      status: 400,
      body: {
        error:
          'sqlite declares no key-space walk: "database" names the database a key was walked in, and only an engine that needs such a name accepts it',
      },
    });
    expect(await legacy({ catalog: "other" })).toEqual({
      status: 400,
      body: {
        error: 'This sqlite connection runs every request in its own database and cannot run one in "other"',
        code: "CONFIG_ERROR",
        statusCode: 400,
        kind: "config",
        outcome: "unknown",
      },
    });
    expect(await legacy({ explain: { mode: "estimate" } })).toMatchObject({
      status: 200,
      body: {
        rows: [{ id: 1, parent: 0, notused: 0, detail: "SCAN CONSTANT ROW" }],
        fields: ["id", "parent", "notused", "detail"],
        explainFormat: "sqlite-queryplan",
      },
    });
  });

  test("a package's error answers Studio's sentence naming its code, and its words go to the log only", async () => {
    const connection = connectionOf(MAIN);
    const secret = connection.password as string;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      hooksFor(MAIN, { execute: () => Promise.reject(new Error(`no such key, as ${secret} said`)) });
      const failed = await post({ connection, sql: "SELECT 1" });
      // A plain Error of Studio's: kind internal, outcome unknown, since the statement may have run.
      expect([failed.status, failed.body.code, failed.body.error]).toEqual([
        500,
        "INTERNAL_ERROR",
        "The provider package's execute failed (INTERNAL_ERROR); the server's log holds its words.",
      ]);

      // An open that fails is answered as a connection error, not-sent: nothing was sent.
      setHooks(MAIN, { open: () => Promise.reject(new Error(`refused ${secret}`)) });
      const refused = await post({ connection: connectionOf(MAIN, { password: secret }), sql: "SELECT 1" });
      expect([refused.status, refused.body.code, refused.body.outcome, refused.body.error]).toEqual([
        503,
        "CONNECTION_ERROR",
        "not-sent",
        "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words.",
      ]);
      expect(JSON.stringify([failed.body, refused.body])).not.toContain(secret);
      // Each logged once, through core's scrub of the connection: the secret is withheld there too.
      // Each package error logged once, through core's scrub of the connection, so the secret is withheld there too;
      // the route's own line of the answer carries Studio's sentence.
      const packageLines = error.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"));
      expect(packageLines.map(([message]) => message)).toEqual([
        "A provider package's execute failed",
        "A provider package's open failed",
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(error.mock.calls)).not.toContain("no such key");
    } finally {
      error.mockRestore();
      hooksFor(MAIN);
    }
  });

  test("a package engine whose register row grants its own words answers its error through core's scrub, and one without a row answers Studio's sentence naming its code", async () => {
    const connection = connectionOf(WORDS);
    const secret = connection.password as string;
    const words = `no such key ${randomUUID()}`;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect([engines.get(WORDS)?.grants.ownWords, engines.get(MAIN)?.grants.ownWords]).toEqual([
        "scrubbed",
        "code-only",
      ]);
      // Granted: the error's own words reach the client, through core's scrub of the connection.
      hooksFor(WORDS, { execute: () => Promise.reject(new Error(words)) });
      const own = await post({ connection, sql: "SELECT 1" });
      expect([own.status, own.body.code, own.body.error]).toEqual([500, "INTERNAL_ERROR", words]);
      // Words holding the connection's password are withheld whole.
      hooksFor(WORDS, { execute: () => Promise.reject(new Error(`${words}, as ${secret} said`)) });
      const withheld = await post({ connection, sql: "SELECT 1" });
      expect([withheld.status, withheld.body.code]).toEqual([500, "INTERNAL_ERROR"]);
      expect(JSON.stringify(withheld.body)).not.toContain(secret);
      expect(JSON.stringify(withheld.body)).not.toContain(words);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);

      // No row: Studio's sentence naming the code, the words in the log only.
      hooksFor(MAIN, { execute: () => Promise.reject(new Error(words)) });
      const coded = await post({ connection: connectionOf(MAIN), sql: "SELECT 1" });
      expect([coded.status, coded.body.code, coded.body.error]).toEqual([
        500,
        "INTERNAL_ERROR",
        "The provider package's execute failed (INTERNAL_ERROR); the server's log holds its words.",
      ]);
    } finally {
      error.mockRestore();
      hooksFor(WORDS);
      hooksFor(MAIN);
    }
  });

  test("a granted package's open failure answers a not-sent ConnectionError with its scrubbed words", async () => {
    const connection = connectionOf(WORDS);
    const secret = connection.password as string;
    const words = `refused ${randomUUID()}`;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      hooksFor(WORDS);
      setHooks(WORDS, { open: () => Promise.reject(new Error(words)) });
      const refused = await post({ connection, sql: "SELECT 1" });
      expect([refused.status, refused.body.code, refused.body.outcome, refused.body.error]).toEqual([
        503,
        "CONNECTION_ERROR",
        "not-sent",
        words,
      ]);
      // Words holding the connection's password are withheld whole, in the answer and in the log.
      setHooks(WORDS, { open: () => Promise.reject(new Error(`${words}, as ${secret} said`)) });
      const withheld = await post({ connection, sql: "SELECT 1" });
      expect([withheld.status, withheld.body.code, withheld.body.outcome]).toEqual([
        503,
        "CONNECTION_ERROR",
        "not-sent",
      ]);
      expect(JSON.stringify(withheld.body)).not.toContain(secret);
      // Each logged once as the package's, through core's scrub.
      const packageLines = error.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"));
      expect(packageLines.map(([message]) => message)).toEqual([
        "A provider package's open failed",
        "A provider package's open failed",
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
    } finally {
      error.mockRestore();
      hooksFor(WORDS);
    }
  });

  test("a package's open answering a refinement it cannot have is answered as a not-sent connection error on both grants, the refusal logged as the package's", async () => {
    const key = `k${randomUUID().replaceAll("-", "")}`;
    // The host core refuses the open's answer, and the one open function raises that refusal in its own sentence.
    const refusedWords = `The provider package's open was refused: ${callRefusalSentence({ rule: "refinement-key-unknown", pointer: `/${key}`, name: key })}`;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const [engine, answered] of [
        [WORDS, refusedWords],
        [MAIN, "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words."],
      ] as const) {
        const executed: string[] = [];
        setHooks(engine, {
          open: () => Promise.resolve({ handle: { session: randomUUID() }, refine: { [key]: true } }),
          execute: () => {
            executed.push(engine);
            return Promise.reject(new Error("execute was reached"));
          },
        });
        const refused = await post({ connection: connectionOf(engine), sql: "SELECT 1" });
        // An open sends no statement, so its refusal is answered as a connection error marked not-sent.
        expect([refused.status, refused.body.code, refused.body.outcome, refused.body.error]).toEqual([
          503,
          "CONNECTION_ERROR",
          "not-sent",
          answered,
        ]);
        expect(executed).toEqual([]);
      }
      // Logged once per engine as the package's, naming the rule and the pointer, beside the route's connection line.
      const packageLines = error.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"));
      expect(packageLines.map(([message, logged]) => [message, (logged as Error).message])).toEqual([
        ["A provider package's open failed", refusedWords],
        ["A provider package's open failed", refusedWords],
      ]);
      expect(error.mock.calls.map(([message]) => message)).not.toContain("Unhandled error");
    } finally {
      error.mockRestore();
      hooksFor(WORDS);
      hooksFor(MAIN);
    }
  });

  test("a HostDefectError of what a granted package answered is logged as the package's defect", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const engine of [WORDS, MAIN]) {
        hooksFor(engine, {
          execute: () =>
            Promise.resolve({
              results: [source([["alpha", 1]])],
              warnings: [],
              executionTimeMs: -1,
              pageApplied: false,
            }),
        });
        const refused = await post({ connection: connectionOf(engine), sql: "SELECT 1" });
        // A plain Error of Studio's: kind internal, outcome unknown, since the statement may have run.
        expect([refused.status, refused.body.code, refused.body.error]).toEqual([
          500,
          "INTERNAL_ERROR",
          packageDefectSentence("/executionTimeMs"),
        ]);
      }
      const packageLines = error.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"));
      expect(packageLines.map(([message, logged]) => [message, (logged as Error).message])).toEqual([
        ["A provider package's execute failed", packageDefectSentence("/executionTimeMs")],
        ["A provider package's execute failed", packageDefectSentence("/executionTimeMs")],
      ]);
      expect(JSON.stringify(error.mock.calls.map(([message, logged]) => [message, String(logged)]))).not.toContain(
        HOST_DEFECT_PREFIX,
      );
    } finally {
      error.mockRestore();
      hooksFor(WORDS);
      hooksFor(MAIN);
    }
  });

  test("a package engine whose register row grants its own words answers its warnings through core's scrub", async () => {
    const connection = connectionOf(WORDS);
    const secret = connection.password as string;
    const words = `words the package wrote ${randomUUID()}`;
    hooksFor(WORDS, {
      execute: () =>
        Promise.resolve({
          results: [source([["alpha", 1]])],
          warnings: [
            { message: `deprecated, as ${secret} said`, code: "W01", severity: "WARNING" },
            { message: words },
          ],
          executionTimeMs: 1,
          pageApplied: false,
        }),
    });
    try {
      const answered = await post({ connection, sql: "SELECT 1" });
      expect(answered.status).toBe(200);
      const warnings = answered.body.warnings as { message: string; code?: string; severity?: string }[];
      expect(warnings).toHaveLength(2);
      // The words as the package wrote them; the warning holding the password withheld by core's scrub.
      expect(warnings[1]).toEqual({ message: words });
      expect(warnings[0]?.code).toBe("W01");
      expect(JSON.stringify(answered.body)).not.toContain(secret);
    } finally {
      hooksFor(WORDS);
    }
  });

  test("a warning outside the contract's shape is refused at the core as the package's defect on both grants, its members never answered", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const engine of [WORDS, MAIN]) {
        const connection = connectionOf(engine);
        const secret = connection.password as string;
        for (const [warning, refusal] of [
          [{ message: "ok", detail: `driver said: ${secret}` }, ["/warnings/0/detail", "detail"]],
          [{ message: 7, code: secret }, "/warnings/0/message"],
          [{ message: "ok", code: true }, "/warnings/0/code"],
          [{ message: "ok", severity: 1 }, "/warnings/0/severity"],
          [Object.defineProperty({}, "message", { enumerable: true, get: () => secret }), "/warnings/0/message"],
          [null, "/warnings/0"],
        ] as const) {
          hooksFor(engine, {
            execute: () =>
              Promise.resolve({
                results: [source([["alpha", 1]])],
                warnings: [warning],
                executionTimeMs: 1,
                pageApplied: false,
              }),
          });
          const answered = await post({ connection, sql: "SELECT 1" });
          expect([answered.status, answered.body.code, answered.body.error]).toEqual([
            500,
            "INTERNAL_ERROR",
            packageDefectSentence(refusal as string | [string, string]),
          ]);
          expect(JSON.stringify(answered.body)).not.toContain(secret);
        }
        expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      }
    } finally {
      error.mockRestore();
      hooksFor(WORDS);
      hooksFor(MAIN);
    }
  });

  test("the query route records one editor event per run, naming the engine by its id and the text submitted, and the engine's record decides what the event keeps", async () => {
    const connection = connectionOf(MAIN);
    const secret = connection.password as string;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    recordedEvents.length = 0;
    try {
      hooksFor(MAIN);
      const legacy = await post({
        connection: { id: `conn-${randomUUID()}`, name: "Scratch", type: "sqlite", database: ":memory:" },
        sql: "SELECT 1 AS one",
      });
      const served = await post({ connection, sql: "SELECT 1" });
      hooksFor(MAIN, { execute: () => Promise.reject(new Error(`no such key, as ${secret} said`)) });
      const failed = await post({ connection, sql: "SELECT 1" });
      expect([legacy.status, served.status, failed.status]).toEqual([200, 200, 500]);
    } finally {
      error.mockRestore();
      hooksFor(MAIN);
    }

    expect(
      recordedEvents.map(({ source, connection: named, statement, status }) => [
        source,
        named.engine,
        statement,
        status,
      ]),
    ).toEqual([
      ["editor", "sqlite", "SELECT 1 AS one", "success"],
      ["editor", MAIN, "SELECT 1", "success"],
      ["editor", MAIN, "SELECT 1", "error"],
    ]);
    // The failure is Studio's plain Error naming the package's code in its sentence, which carries no code of its own,
    // so the event records its sentence and no code, as for any plain Error.
    expect(recordedEvents[2]).toMatchObject({
      errorCode: undefined,
      errorMessage: "The provider package's execute failed (INTERNAL_ERROR); the server's log holds its words.",
    });
    expect(JSON.stringify(recordedEvents)).not.toContain(secret);
    expect(JSON.stringify(recordedEvents)).not.toContain("no such key");

    // Each input built into its row by the real builder under full capture. A row needs a `seed:` id, an access level
    // and a subject, which only governance's resolve and session hand; this file's connections are inline and its
    // session has no subject, so the three are given here and nothing else of the input is changed.
    const rows = recordedEvents.map((input) =>
      buildQueryEvent(
        {
          ...input,
          principal: { ...input.principal, subject: "subject-1" },
          connection: { ...input.connection, id: "seed:keys", accessLevel: "read" },
        },
        { statementCapture: "full", maxStatementBytes: 4096 },
        { studioInstance: "libredb-studio" },
      ),
    );
    expect(
      rows.map(({ engine, statement, statement_type, error_message }) => [
        engine,
        statement,
        statement_type,
        error_message,
      ]),
    ).toEqual([
      ["sqlite", "SELECT 1 AS one", "SELECT", null],
      [MAIN, null, "OTHER", null],
      [MAIN, null, "OTHER", null],
    ]);
  });

  test("a package's warnings reach the client only as Studio's sentence with their count, each logged once through core's scrub", async () => {
    const connection = connectionOf(MAIN);
    const secret = connection.password as string;
    const words = `words the package wrote ${randomUUID()}`;
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      hooksFor(MAIN, {
        execute: () =>
          Promise.resolve({
            results: [source([["alpha", 1]])],
            warnings: [
              { message: `deprecated, as ${secret} said`, code: "W01", severity: "WARNING" },
              { message: words },
            ],
            executionTimeMs: 1,
            pageApplied: false,
          }),
      });
      const answered = await post({ connection, sql: "SELECT 1" });
      expect(answered.status).toBe(200);
      expect(answered.body.warnings).toEqual([
        { message: "The provider package returned 2 warnings; the server's log holds their words." },
      ]);
      expect(JSON.stringify(answered.body)).not.toContain(words);
      expect(JSON.stringify(answered.body)).not.toContain(secret);

      const lines = warn.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"));
      expect(lines.map(([message]) => message)).toEqual([
        "A provider package's execute returned a warning",
        "A provider package's execute returned a warning",
      ]);
      expect(JSON.stringify(lines)).toContain(words);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
      hooksFor(MAIN);
    }
  });

  test("a package's warnings of another shape than the contract's are refused at the core as the package's defect, each at its pointer, their members never read or logged", async () => {
    const connection = connectionOf(MAIN);
    const secret = connection.password as string;
    let getterRuns = 0;
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      hooksFor(MAIN, {
        execute: () =>
          Promise.resolve({
            results: [source([["alpha", 1]])],
            warnings: [
              { message: `deprecated, as ${secret} said`, code: "W01", severity: "WARNING" },
              { message: "ok", detail: `driver said: ${secret}` },
              { message: 7, code: secret },
              { message: "ok", code: true },
              { message: "ok", severity: 1 },
              Object.defineProperty({}, "message", {
                enumerable: true,
                get: () => {
                  getterRuns += 1;
                  return secret;
                },
              }),
              // A symbol key is no member the host reads, so it is neither refused nor read.
              { message: "ok", [Symbol("detail")]: secret },
              null,
            ],
            executionTimeMs: 1,
            pageApplied: false,
          }),
      });
      const answered = await post({ connection, sql: "SELECT 1" });
      expect([answered.status, answered.body.code, answered.body.error]).toEqual([
        500,
        "INTERNAL_ERROR",
        packageDefectSentence(
          ["/warnings/1/detail", "detail"],
          "/warnings/2/message",
          "/warnings/3/code",
          "/warnings/4/severity",
          "/warnings/5/message",
          "/warnings/7",
        ),
      ]);
      // No warning is logged as one: the answer was refused before any warning reached the route.
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"))).toEqual([]);
      expect(JSON.stringify([warn.mock.calls, error.mock.calls, answered.body])).not.toContain(secret);
      expect(getterRuns).toBe(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      hooksFor(MAIN);
    }
  });

  test("warnings that are not a list are refused at the core as the package's defect, and the warnings a client is told of are the ones Studio walked, on both paths", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const engine of [MAIN, WORDS]) {
        const connection = connectionOf(engine);
        const secret = connection.password as string;
        let walked = 0;
        // An iterable that is not an array, whose length is text.
        const iterable = {
          length: `pw ${secret}`,
          *[Symbol.iterator]() {
            walked += 1;
            yield { message: secret };
          },
        };
        // An array whose length trap answers text: Array.isArray holds for it.
        const proxied = new Proxy([], {
          get: (target, key) => (key === "length" ? `pw ${secret}` : Reflect.get(target, key)),
        });
        const answering = (warnings: unknown) =>
          hooksFor(engine, {
            execute: () =>
              Promise.resolve({ results: [source([["alpha", 1]])], warnings, executionTimeMs: 1, pageApplied: false }),
          });

        answering(iterable);
        const refused = await post({ connection, sql: "SELECT 1" });
        expect([refused.status, refused.body.code, refused.body.error]).toEqual([
          500,
          "INTERNAL_ERROR",
          packageDefectSentence("/warnings"),
        ]);
        expect(walked).toBe(0);
        expect(JSON.stringify(refused.body)).not.toContain(secret);

        answering(proxied);
        const answered = await post({ connection, sql: "SELECT 1" });
        expect(answered.status).toBe(200);
        // Studio walked no warning, so the client is told of none.
        expect(answered.body.warnings).toBeUndefined();
        expect(JSON.stringify(answered.body)).not.toContain(secret);
        expect(JSON.stringify([warn.mock.calls, error.mock.calls])).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
      hooksFor(MAIN);
      hooksFor(WORDS);
    }
  });

  test("an execution time or a row count outside the contract's types is refused at the core as the package's defect, on both paths", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const engine of [MAIN, WORDS]) {
        const connection = connectionOf(engine);
        const secret = connection.password as string;
        const answering = (executionTimeMs: unknown, rowCount?: unknown) =>
          hooksFor(engine, {
            execute: () =>
              Promise.resolve({
                results: [{ ...source([["alpha", 1]]), ...(rowCount === undefined ? {} : { rowCount }) }],
                warnings: [],
                executionTimeMs,
                pageApplied: false,
              }),
          });
        const refusedWith = async (pointer: string) => {
          const refused = await post({ connection, sql: "SELECT 1" });
          expect([refused.status, refused.body.code, refused.body.error]).toEqual([
            500,
            "INTERNAL_ERROR",
            packageDefectSentence(pointer),
          ]);
          expect(JSON.stringify(refused.body)).not.toContain(secret);
        };

        for (const executionTimeMs of [`pw ${secret}`, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
          answering(executionTimeMs);
          await refusedWith("/executionTimeMs");
        }
        for (const rowCount of [`pw ${secret}`, 1.5, -1, Number.NaN]) {
          answering(1, rowCount);
          await refusedWith("/results/0/rowCount");
        }
        // Vacuity: a zero execution time and a row count of the package's own are answered as they are.
        answering(0, 7);
        const answered = await post({ connection, sql: "SELECT 1" });
        expect([answered.status, answered.body.executionTime, answered.body.rowCount]).toEqual([200, 0, 7]);
        expect(JSON.stringify([warn.mock.calls, error.mock.calls])).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
      hooksFor(MAIN);
      hooksFor(WORDS);
    }
  });

  test("the session is opened once per key and reused by the next query", async () => {
    const seen = hooksFor(BARE);
    const connection = connectionOf(BARE);
    for (let run = 0; run < 3; run += 1) {
      expect((await post({ connection, sql: "SELECT 1" })).status).toBe(200);
    }
    expect(names(seen)).toEqual(["open", "execute", "execute", "execute"]);
  });

  test("a refused package's engine and an unknown type answer as the server catalog answers them", async () => {
    forgetServerCatalog();
    installServerCatalog({
      engines: new Map([...composeServerCatalog([], [], STUDIO_GRANT_REGISTER).engines, ...engines]),
      unavailable: new Map([["acmeqgone", Object.freeze(["PROVIDER_LOAD_FAILED"])]]),
    });
    const gone = await post({ connection: connectionOf("acmeqgone"), sql: "SELECT 1" });
    expect([gone.status, gone.body.code]).toEqual([503, "PROVIDER_UNAVAILABLE"]);
    expect(String(gone.body.error)).toContain("(PROVIDER_LOAD_FAILED)");
    const unknown = await post({ connection: connectionOf("acmeqnone"), sql: "SELECT 1" });
    expect([unknown.status, unknown.body.code]).toEqual([400, "PROVIDER_UNKNOWN"]);
  });
});
