/**
 * Whether a failed call may have reached the database, read from a real provider's errors.
 *
 * The rule is core's (`connectPhase` in src/lib/db/errors.ts): a failure the connect raised answers `outcome`
 * `not-sent`, and a statement that fails after it was sent answers `unknown`, because it may have run. libSQL raises the
 * same `ConnectionError` for an unreachable server in both phases, so it is the provider that shows the two apart.
 * Its real provider and its real Hrana transport run here; only `globalThis.fetch` is replaced per test and restored
 * afterwards, as in tests/integration/db/libsql-provider.test.ts, never `mock.module()`, which is process-wide in bun.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connectPhase, ConnectionError } from "@/lib/db/errors";
import { errorRecord, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { LibSQLProvider } from "@/lib/db/providers/sql/libsql";
import { secretForms } from "@/lib/db/utils/server-text";
import type { DatabaseConnection } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS } from "../../helpers/egress-decisions";

const originalFetch = globalThis.fetch;

/** A scrub whose forms are generated and occur in no text a test here builds. */
const scrub: ProviderTextScrub = { type: "libsql", forms: secretForms([crypto.randomUUID()]) };

const connection: DatabaseConnection = {
  id: "libsql-outcome",
  name: "libSQL outcome",
  type: "libsql",
  host: "127.0.0.1",
  port: 18081,
  createdAt: new Date("2026-11-22T00:00:00.000Z"),
};

/** A server that answers every pipeline with one row per statement, and its version. */
function answeringFetch(): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/version")) return Promise.resolve(new Response("sqld 0.24.33", { status: 200 }));
    const requests = (JSON.parse(String(init?.body ?? "{}")) as { requests?: { type: string }[] }).requests ?? [];
    const results = requests
      .filter((request) => request.type === "execute")
      .map(() => ({
        type: "ok",
        response: {
          type: "execute",
          result: {
            cols: [{ name: "n", decltype: null }],
            rows: [[{ type: "integer", value: "1" }]],
            affected_row_count: 0,
            last_insert_rowid: null,
          },
        },
      }));
    return Promise.resolve(
      new Response(JSON.stringify({ baton: null, base_url: null, results: [...results, { type: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

const unreachable = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;

async function connected(): Promise<LibSQLProvider> {
  const provider = new LibSQLProvider(connection, {}, { egress: ALLOWS_PRIVATE_HOSTS });
  await connectPhase(() => provider.connect());
  return provider;
}

beforeEach(() => {
  globalThis.fetch = answeringFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the outcome of a failed call on a real provider", () => {
  test("a connect that cannot reach the server answers outcome not-sent", async () => {
    globalThis.fetch = unreachable;
    const provider = new LibSQLProvider(connection, {}, { egress: ALLOWS_PRIVATE_HOSTS });
    const error = await connectPhase(() => provider.connect()).catch((raised: unknown) => raised);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(errorRecord(scrub, error)).toEqual({ kind: "connection", code: "CONNECTION_ERROR", outcome: "not-sent" });
  });

  test("the same unreachable server during a statement answers outcome unknown", async () => {
    const provider = await connected();
    globalThis.fetch = unreachable;
    const error = await provider.query("SELECT 1").catch((raised: unknown) => raised);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(errorRecord(scrub, error)).toEqual({ kind: "connection", code: "CONNECTION_ERROR", outcome: "unknown" });
    await provider.disconnect();
  });

  test("a connection lost after the answer began answers outcome unknown", async () => {
    const provider = await connected();
    // What undici raises when the socket closes while a response body is read: a TypeError whose cause names it.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"baton":null,"results":['));
              controller.error(
                Object.assign(new TypeError("fetch failed"), {
                  cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
                }),
              );
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch;
    const error = await provider.query("SELECT 1").catch((raised: unknown) => raised);
    // Measured: libSQL lets the body's TypeError through as raised, so it is no database error class and answers the
    // kind of any other thrown value, with the code `createErrorResponse` answers it.
    expect(error).toBeInstanceOf(TypeError);
    expect(errorRecord(scrub, error)).toEqual({ kind: "internal", code: "INTERNAL_ERROR", outcome: "unknown" });
    await provider.disconnect();
  });
});
