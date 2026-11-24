/**
 * `POST /api/db/test-connection`, which the connection dialog's Test Connection and Save both post to, held to the
 * dialog over every engine's field rules (docs/providers/CONTRACT.md, clause M-33): for every connection of the corpus
 * (tests/helpers/field-rule-corpus.ts), the dialog's answer, `connectionFieldRefusal` on the engine's
 * `getDBConfig` entry through src/lib/db-ui-config.ts as the hook calls it, and the route's answer to the same JSON
 * body agree. Where the dialog refuses, the route answers the dialog's sentence as a configuration error whose
 * statement was not sent, and neither the tunnel nor the build is reached; where the dialog passes, the route reaches
 * the tunnel and the build once with that connection.
 *
 * The session and seed resolution are stood in for (a pass-through), and so is the factory: its tunnel scope and its
 * build count their calls and answer a mock provider, so nothing is dialled. The rules, the form table and the route
 * are real.
 *
 * The route passes core's scrub of the connection (`providerTextScrub(connection, "any")`), which withholds any text
 * holding a form of the connection's own secret, a refusal sentence included; the dialog never sends such a payload,
 * and the expected answer here is the dialog's sentence passed through the same scrub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { connectionFieldRefusal, getDBConfig, RABBITMQ_FIELD_RULES } from "@/lib/db-ui-config";
import { DatabaseConfigError } from "@/lib/db/errors";
import { providerTextScrub, withheldProviderError } from "@/lib/db/operations/provider-text";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { fieldRuleBase, fieldRuleCorpus } from "../../helpers/field-rule-corpus";
import { createMockProvider } from "../../helpers/mock-provider";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

// The spread form, not a hand-written stub: only the session readers are replaced (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => ({ kind: "authenticated", session: await mockGetSession() })),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => body.connection),
    SeedConnectionError,
  };
});

/** The connections the tunnel scope was entered with, one per call. */
let tunnelled: unknown[] = [];
/** The connections a provider was built from, one per call. */
let built: unknown[] = [];
const provider = createMockProvider();

mock.module("@/lib/db/factory", () => ({
  withOneShotTunnel: async (
    connection: DatabaseConnection,
    run: (effective: DatabaseConnection) => Promise<unknown>,
  ) => {
    tunnelled.push(connection);
    return await run(connection);
  },
  createDatabaseProvider: async (connection: DatabaseConnection) => {
    built.push(connection);
    return provider;
  },
  findOpenSingleWriterProvider: () => null,
  isSingleWriterFileOpen: () => false,
  getOrCreateProvider: mock(async () => provider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
}));

const { POST } = await import("@/app/api/db/test-connection/route");

// Test Connection reads health through the process's host core (src/lib/provider-host/instance.ts), so this file
// composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

/** The route's status and body for `connection`, posted as the dialog posts it. */
async function routeAnswer(connection: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  clearRateLimitState();
  const request = createMockRequest("/api/db/test-connection", { method: "POST", body: { connection } });
  const response = await POST(request as never);
  return { status: response.status, body: (await parseResponseJSON(response)) as Record<string, unknown> };
}

/** The dialog's sentence as the route's scrub of `connection` answers it: itself, unless it holds the connection's secret. */
function scrubbed(connection: DatabaseConnection, sentence: string): string {
  const error = new DatabaseConfigError(sentence, connection.type);
  return withheldProviderError(providerTextScrub(connection, "any"), error)?.message ?? sentence;
}

/** The connection the route receives: the same body after its JSON round trip, which the dialog's answer reads too. */
const roundTripped = (connection: DatabaseConnection): DatabaseConnection =>
  JSON.parse(JSON.stringify(connection)) as DatabaseConnection;

beforeEach(() => {
  tunnelled = [];
  built = [];
});

describe("POST /api/db/test-connection and the connection dialog's field rules", () => {
  test("Test Connection's route refuses exactly the connections the dialog refuses, with the dialog's sentence, over every engine's field rules", async () => {
    const disagreements: unknown[] = [];
    let refused = 0;
    for (const entry of fieldRuleCorpus()) {
      const connection = roundTripped(entry.connection);
      const dialog = connectionFieldRefusal(getDBConfig(entry.type), connection);
      if (dialog === undefined) continue;
      refused += 1;
      tunnelled = [];
      built = [];
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so the counts are this connection's.
      const { status, body } = await routeAnswer(connection);
      const answer = { status, error: body.error, code: body.code, outcome: body.outcome, tunnels: tunnelled.length };
      const expected = {
        status: 400,
        error: scrubbed(connection, dialog),
        code: "CONFIG_ERROR",
        outcome: "not-sent",
        tunnels: 0,
      };
      if (JSON.stringify(answer) !== JSON.stringify(expected) || built.length !== 0) {
        disagreements.push({ label: entry.label, answer, expected, builds: built.length });
      }
    }
    expect(disagreements).toEqual([]);
    // The control that the corpus holds refusals at all, and of every engine.
    expect(refused).toBeGreaterThan(500);
  });

  test("every connection the dialog lets through reaches the tunnel and the build on Test Connection's route", async () => {
    const disagreements: unknown[] = [];
    const passedTypes = new Set<DatabaseType>();
    for (const entry of fieldRuleCorpus()) {
      const connection = roundTripped(entry.connection);
      if (connectionFieldRefusal(getDBConfig(entry.type), connection) !== undefined) continue;
      passedTypes.add(entry.type);
      tunnelled = [];
      built = [];
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const { status, body } = await routeAnswer(connection);
      const reached = status === 200 && body.success === true && tunnelled.length === 1 && built.length === 1;
      if (!reached || JSON.stringify(tunnelled[0]) !== JSON.stringify(connection)) {
        disagreements.push({ label: entry.label, status, body, tunnels: tunnelled.length, builds: built.length });
      }
    }
    expect(disagreements).toEqual([]);
    expect([...passedTypes]).toEqual(["databend", "kubernetes", "rabbitmq", "s3", "snowflake", "spark"]);
  });

  test("a Path prefix the RabbitMQ provider refuses by its exact shape is answered with the dialog's sentence on Test Connection", async () => {
    const sentence = RABBITMQ_FIELD_RULES.apiPath?.format?.sentence;
    expect(sentence).toBeString();
    const paths = [
      "a b",
      "UPPER_case!",
      "../x",
      "/api",
      "%41",
      "-x-",
      "0",
      "70000",
      "a".repeat(300),
      "x\u0001y",
      "a.b",
      "é",
      "`",
      "  ",
      "x,,y",
      "a/b/",
    ];
    const answers: unknown[] = [];
    for (const apiPath of paths) {
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const { status, body } = await routeAnswer(roundTripped({ ...fieldRuleBase("rabbitmq"), apiPath }));
      answers.push({ apiPath, status, error: body.error, outcome: body.outcome });
    }
    expect(answers).toEqual(paths.map((apiPath) => ({ apiPath, status: 400, error: sentence, outcome: "not-sent" })));
    expect(tunnelled).toEqual([]);
    expect(built).toEqual([]);
  });
});
