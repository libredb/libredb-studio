/**
 * The query route's open wait against the real factory (docs/providers/CONTRACT.md, clause C-44): a request that leaves while its connection opens is answered at once, 499 not-sent, the
 * open goes on in the factory's open table, and its later failure, which no caller waits for any more, is logged by
 * the connection, the error's kind and its code, never its text. An open its connect budget ends (clause C-55) is
 * answered 504 not-sent, and the next request opens afresh rather than joining it.
 *
 * Unlike tests/api/db/query.test.ts, this file does not mock `@/lib/db`: the route, the factory, its open table and the
 * PostgreSQL provider are the real ones, and only the session is mocked, to answer as an admin. The connection is an
 * inline PostgreSQL record that dials a TCP listener this file runs on 127.0.0.1, which accepts and never answers, so
 * no database is needed. Every wait is on a promise an event resolves (the listener's dial, the logger's line), never
 * on a timer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { EngineRecord } from "@/lib/db/server-catalog";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseType } from "@/lib/types";
import { parseResponseJSON } from "../../helpers/mock-next";

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
  readSession: mock(async () => ({
    kind: "authenticated",
    session: { role: "admin", username: "admin" },
  })),
}));

/**
 * The real connect budgets, with `connectBudgetFor`, the factory's open deadline, and `packageConnectBudget`, the
 * route's wait for the open, which it reads from the engine's record, each answering `budgetOverride` while a case sets
 * one, so the case that needs an open's deadline to pass sets it to a few tens of milliseconds for itself.
 */
const realConnectBudget = await import("@/lib/db/connect-budget");
const realConnectBudgetFor = realConnectBudget.connectBudgetFor;
let budgetOverride: number | undefined;
mock.module("@/lib/db/connect-budget", () => ({
  openDeadlineSentence: realConnectBudget.openDeadlineSentence,
  connectBudgetFor: (type: DatabaseType) => budgetOverride ?? realConnectBudgetFor(type),
}));
const realOpenContext = { ...(await import("@/lib/provider-host/open-context")) };
const realPackageConnectBudget = realOpenContext.packageConnectBudget;
mock.module("@/lib/provider-host/open-context", () => ({
  ...realOpenContext,
  packageConnectBudget: (engine: EngineRecord) => budgetOverride ?? realPackageConnectBudget(engine),
}));

const { POST } = await import("@/app/api/db/query/route");
const { clearProviderCache, getProviderCacheStats } = await import("@/lib/db/factory");

/** A listener that accepts every dial and never answers, and the sockets it accepted. */
let listener: Server;
const accepted: Socket[] = [];
let dialed: () => void = () => {};

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  listener = createServer((socket) => {
    accepted.push(socket);
    dialed();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  budgetOverride = undefined;
  for (const socket of accepted.splice(0)) socket.destroy();
  await clearProviderCache();
});

afterAll(async () => {
  forgetHostCore();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

describe("the query route's open wait, with the real factory", () => {
  test("a request that leaves while its connection opens is answered at once, and the open's later failure is logged by connection, kind and code", async () => {
    clearRateLimitState();
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("The listener has no TCP address.");
    const connectionId = randomUUID();
    const connection = {
      id: connectionId,
      name: "never answers",
      type: "postgres",
      host: "127.0.0.1",
      port: address.port,
      user: "studio",
      password: randomUUID(),
      database: "studio",
    };
    const dial = new Promise<void>((resolve) => {
      dialed = resolve;
    });
    let logged: () => void = () => {};
    const unclaimedLogged = new Promise<void>((resolve) => {
      logged = resolve;
    });
    const warn = spyOn(logger, "warn").mockImplementation((message: string) => {
      if (message.startsWith("[DB] An open of")) logged();
    });
    try {
      const controller = new AbortController();
      const answer = POST(
        new Request("http://localhost:3000/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connection, sql: "SELECT 1", queryId: randomUUID() }),
          signal: controller.signal,
        }) as never,
      );
      await dial;
      controller.abort();

      const response = await answer;
      const body = await parseResponseJSON<Record<string, unknown>>(response);
      expect(response.status).toBe(499);
      expect(body).toMatchObject({ code: "QUERY_CANCELLED", kind: "cancelled", outcome: "not-sent" });

      // The open is still in flight, waited for by no caller: ending its dial fails it, and the factory logs it.
      for (const socket of accepted) socket.destroy();
      await unclaimedLogged;

      const unclaimed = warn.mock.calls.filter(([message]) => String(message).startsWith("[DB] An open of"));
      expect(unclaimed).toEqual([
        [
          `[DB] An open of ${connectionId} failed after every caller stopped waiting for it, so nothing was admitted.`,
          { connectionId, kind: "connection", code: "CONNECTION_ERROR" },
        ],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(connection.password);
      expect(getProviderCacheStats().size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("an open its connect budget ended answers 504 in Studio's sentence naming the open and its budget, not-sent", async () => {
    clearRateLimitState();
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("The listener has no TCP address.");
    // Trino bounds nothing of its own on a server that accepts and never answers, so only the open's deadline ends it.
    const connection = {
      id: randomUUID(),
      name: "never answers",
      type: "trino",
      host: "127.0.0.1",
      port: address.port,
      database: "studio",
    };
    budgetOverride = 40;
    // The open dials on its own schedule, which may be after the answer: the case waits for its dial, so the socket is
    // accepted, and ended, before the next case runs.
    const dial = new Promise<void>((resolve) => {
      dialed = resolve;
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const response = await POST(
        new Request("http://localhost:3000/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connection, sql: "SELECT 1", queryId: randomUUID() }),
        }) as never,
      );
      const body = await parseResponseJSON<Record<string, unknown>>(response);

      expect(response.status).toBe(504);
      expect(body).toEqual({
        error: "The connection did not open within 0.1 seconds, so Studio stopped waiting for it and sent nothing.",
        code: "TIMEOUT_ERROR",
        statusCode: 504,
        retryable: true,
        kind: "studio-timeout-refusal",
        outcome: "not-sent",
      });
      await dial;
    } finally {
      warn.mockRestore();
    }
  });

  test("a connection whose open never settles is opened afresh by the next request after its connect budget", async () => {
    clearRateLimitState();
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("The listener has no TCP address.");
    // Trino bounds nothing of its own on a server that accepts and never answers, so only the open's deadline ends it.
    const connection = {
      id: randomUUID(),
      name: "never answers",
      type: "trino",
      host: "127.0.0.1",
      port: address.port,
      database: "studio",
    };
    budgetOverride = 40;
    // Each open dials on its own schedule, which may be after its request was answered: the case waits for two dials.
    const twoDials = new Promise<void>((resolve) => {
      dialed = () => {
        if (accepted.length === 2) resolve();
      };
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const ask = async () => {
        const response = await POST(
          new Request("http://localhost:3000/api/db/query", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connection, sql: "SELECT 1", queryId: randomUUID() }),
          }) as never,
        );
        return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
      };

      const first = await ask();
      // The request's own wait starts before the open's and ends a few milliseconds earlier, so a request sent at once
      // could still join the first open. That open started before the first answer, so its deadline passed at most
      // one budget after it: the second request is sent after twice that, with a plain await.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      const second = await ask();

      for (const answer of [first, second]) {
        expect(answer.status).toBe(504);
        expect(answer.body).toMatchObject({
          code: "TIMEOUT_ERROR",
          kind: "studio-timeout-refusal",
          outcome: "not-sent",
        });
      }
      await twoDials;
      expect(accepted).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});
