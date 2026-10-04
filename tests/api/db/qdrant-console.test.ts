/**
 * A Qdrant console request through the real routes (vector-family spec 6.5, 6.6, 3.9, QE4, QE15): the route
 * overwrites `pagination`, so a scroll's next page is shown here as well as in the provider; the console text bound
 * and the one-statement rule of the registered type; an echoed key kept out of the error body and the log; and a
 * cancel through `POST /api/db/cancel` stopping a running request.
 *
 * The provider is the real QdrantProvider, connected over a client whose answers this file writes, from the
 * captures of the seeded server (tests/helpers/qdrant-surface-fixtures.ts) unless a test replaces one. Only the
 * session and the provider cache are replaced. The credential is the stand-in TEST_PASSWORD.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { getServerAuditBuffer } from "@/lib/audit";
import * as actualDb from "@/lib/db";
import type { QdrantAnswer, QdrantRequest } from "@/lib/db/providers/vector/qdrant/client";
import { QDRANT_DEFAULT_PORT } from "@/lib/db/providers/vector/qdrant/connection-options";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { secretForms } from "@/lib/db/utils/server-text";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { recordedAnswer } from "../../helpers/qdrant-surface-fixtures";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";

const CONNECTION: DatabaseConnection = {
  id: "qdrant-route",
  name: "Qdrant",
  type: "qdrant",
  host: "127.0.0.1",
  port: QDRANT_DEFAULT_PORT,
  createdAt: new Date(0),
};

type Answer = (request: QdrantRequest, signal: AbortSignal) => QdrantAnswer | Promise<QdrantAnswer>;

let current: QdrantProvider | undefined;

/** A connected QdrantProvider whose client answers through `answer`, with the signal the provider passes. */
async function connectedProvider(answer: Answer, connection: Partial<DatabaseConnection> = {}) {
  const provider = new QdrantProvider({ ...CONNECTION, ...connection }, {}, {}, () => ({
    send: async (request, signal) => answer(request, signal),
    close() {},
  }));
  await provider.connect();
  current = provider;
  return provider;
}

const mockGetOrCreateProvider = mock(async () => {
  if (current === undefined) throw new Error("no provider was connected for this test");
  return current;
});

// The spread form, not a hand-written five-key stub: `src/lib/auth.ts` exports more
// names than such a stub carries, and only one of them is being replaced here (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
}));

mock.module("@/lib/db", () => ({
  ...actualDb,
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => {
    if (current === undefined) throw new Error("no provider was connected for this test");
    return current;
  }),
}));

const { POST: query } = await import("@/app/api/db/query/route");
const { POST: multiQuery } = await import("@/app/api/db/multi-query/route");
const { POST: cancel } = await import("@/app/api/db/cancel/route");

beforeEach(() => {
  clearRateLimitState();
  mockGetOrCreateProvider.mockClear();
});

afterEach(async () => {
  await current?.disconnect();
  current = undefined;
});

interface Answered {
  readonly status: number;
  readonly data: Record<string, unknown>;
}

async function post(
  route: typeof query,
  path: string,
  body: Record<string, unknown>,
  connection: Partial<DatabaseConnection> = {},
): Promise<Answered> {
  const res = await route(
    createMockRequest(path, {
      method: "POST",
      body: { connection: { ...CONNECTION, ...connection }, ...body },
    }) as never,
  );
  return { status: res.status, data: await parseResponseJSON<Record<string, unknown>>(res) };
}

const envelope = (result: string) => `{"result":${result},"status":"ok","time":0.001}`;
const ok = (text: string): QdrantAnswer => ({ status: 200, contentType: "application/json", retryAfter: null, text });

describe("a scroll's next page through POST /api/db/query (spec 6.5)", () => {
  test.each([
    ["18446744073709551615", "18446744073709551615"],
    ["9007199254740993", "9007199254740993"],
    ['"8d8f5313-0a2e-4c3b-9f1e-2b7c1d0e5a44"', '"8d8f5313-0a2e-4c3b-9f1e-2b7c1d0e5a44"'],
  ])(
    "next_page_offset %s: no page two in pagination, and a warning with exactly that offset",
    async (offset, written) => {
      await connectedProvider((request) =>
        request.op === "scroll_points"
          ? ok(envelope(`{"points":[{"id":1}],"next_page_offset":${offset}}`))
          : recordedAnswer(request),
      );
      const { status, data } = await post(query, "/api/db/query", { sql: "POST /collections/docs/points/scroll" });
      expect(status).toBe(200);
      expect(data.pagination).toMatchObject({ hasMore: false, offset: 0, totalReturned: 1 });
      expect(data.warnings).toEqual([
        {
          code: "next_page_offset",
          message: `The scroll has more points. Its next_page_offset is ${written}: repeat the request with "offset": ${written} in the body to read the next page.`,
        },
      ]);
      expect(data.rows).toEqual([{ id: "1" }]);
    },
  );
});

describe("the console text bound and the one-statement rule of the registered type (3.9)", () => {
  test("a text one byte over Qdrant's 1 MiB bound answers 413 before any provider, never repeating the text", async () => {
    const head = 'POST /collections/docs/points/scroll\n{"filter": "';
    const sql = `${head}${"x".repeat(1_048_576 + 1 - head.length - 2)}"}`;
    const { status, data } = await post(query, "/api/db/query", { sql });
    expect(status).toBe(413);
    expect(data.error).toBe(
      "The statement is 1048577 bytes in UTF-8, over the 1048576-byte limit for this connection type. Shorten it to run it.",
    );
    expect(JSON.stringify(data)).not.toContain("xxxx");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("POST /api/db/multi-query sends a Qdrant text to the single-statement route, splitting nothing", async () => {
    const { status, data } = await post(multiQuery, "/api/db/multi-query", {
      sql: "GET /collections; GET /collections",
    });
    expect(status).toBe(400);
    expect(data.error).toBe(
      "This connection type runs one statement per request: send it to POST /api/db/query, because this route would split its text into several requests.",
    );
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });
});

describe("an echoed key never reaches the error body, the log or the audit trail (QE4, VF9)", () => {
  const forms = secretForms([TEST_PASSWORD]);

  test.each([
    [401, "text/plain", `Invalid API key or JWT: ${TEST_PASSWORD}`],
    [403, "application/json", JSON.stringify({ status: { error: `Forbidden: key ${TEST_PASSWORD}` }, time: 0 })],
    [400, "application/json", JSON.stringify({ status: { error: `Bad request: ${TEST_PASSWORD}` }, time: 0 })],
    [500, "application/json", JSON.stringify({ status: { error: `Service internal error: ${forms[1]}` }, time: 0 })],
    [503, "text/plain", `unavailable ${encodeURIComponent(TEST_PASSWORD)}`],
  ])("HTTP %d echoing the key", async (code, contentType, text) => {
    await connectedProvider(
      (request) =>
        request.op === "scroll_points"
          ? { status: code, contentType, retryAfter: null, text }
          : recordedAnswer(request),
      { password: TEST_PASSWORD },
    );
    const logged: unknown[] = [];
    const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
    try {
      const { status, data } = await post(
        query,
        "/api/db/query",
        { sql: "POST /collections/docs/points/scroll" },
        { password: TEST_PASSWORD },
      );
      expect(status).toBeGreaterThanOrEqual(400);
      expect(String(data.error)).toContain("withheld because it contained the configured credential");
      const seen = JSON.stringify([data, logged, getServerAuditBuffer().getAll()]);
      for (const form of forms) expect(seen).not.toContain(form);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("a cancel through POST /api/db/cancel (QE15)", () => {
  test("stops the running request, which answers as cancelled; an unknown id answers false", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let sawAbort = false;
    await connectedProvider((request, signal) => {
      if (request.op !== "scroll_points") return recordedAnswer(request);
      started();
      return new Promise<QdrantAnswer>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted"));
        });
      });
    });
    const pending = post(query, "/api/db/query", { sql: "POST /collections/docs/points/scroll", queryId: "q-1" });
    await running;
    const cancelled = await post(cancel, "/api/db/cancel", { queryId: "q-1" });
    expect(cancelled).toEqual({ status: 200, data: { cancelled: true } });
    const { status, data } = await pending;
    expect(sawAbort).toBe(true);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(String(data.error)).toContain("cancel");
    expect(await post(cancel, "/api/db/cancel", { queryId: "q-unknown" })).toEqual({
      status: 200,
      data: { cancelled: false },
    });
  });
});
