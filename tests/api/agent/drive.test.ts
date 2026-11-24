/**
 * The durable transport's drive callback (#329 T9).
 *
 * This is the one path a caller reaches without a user session, so what it refuses
 * matters more than what it does. It authenticates with its own single-purpose
 * credential; a user session is not one, and the run it drives is named by the
 * credential rather than by the request body.
 *
 * `installMocks` is re-applied in `beforeEach` rather than only at import time, and
 * that is not belt-and-braces: `mock.module` replaces a module process-wide, and
 * `tests/api/agent/runs.test.ts` mocks the same runtime module in the same process
 * under `bun run test`. Re-registering makes the file that is currently running own
 * the module, whatever order the runner loaded them in.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { SignJWT } from "jose";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { mintTestToken, useMcpChannel } from "../../helpers/mcp-token";
import { AGENT_DRIVE_HEADER, mintAgentDriveToken } from "@/lib/agent/drive-token";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AgentRunServiceError } from "@/lib/agent/run-service";
import type { AgentDriveOutcome } from "@/lib/agent/runtime";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { createErrorResponse } from "@/lib/api/errors";
import { AuthenticationError, ConnectionError, QueryError, RowBudgetRefusal } from "@/lib/db/errors";
import { providerTextScrub, withheldErrorMessage, withholdProviderError } from "@/lib/db/operations/provider-text";
import { secretForms } from "@/lib/db/utils/server-text";
import { LLMRateLimitError } from "@/lib/llm/types";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";

const mockDriveAgentRunOutcome = mock(
  async (runId: string): Promise<AgentDriveOutcome> => ({
    kind: "finished",
    result: { runId, status: "succeeded", stopReason: "report-composed", turns: 3, text: "done" } as never,
  }),
);

/** The runtime's wrapper over the outcome, as it answers: the result, or the failure withheld with the run's scrub. */
async function driveAgentRunOverOutcome(runId: string) {
  const outcome = await mockDriveAgentRunOutcome(runId);
  if (outcome.kind === "finished") return outcome.result;
  throw withholdProviderError(outcome.scrub, outcome.error);
}

function installMocks(): void {
  mock.module("@/lib/agent/runtime", () => ({
    driveAgentRunOutcome: mockDriveAgentRunOutcome,
    driveAgentRun: driveAgentRunOverOutcome,
    getAgentRunService: mock(async () => ({})),
    // Unused here, and listed anyway: `mock.module` replaces the module for the whole
    // process, so an export this file forgets is an export the NEXT file's route
    // cannot import (`tests/api/agent/artifacts.test.ts` reaches for exactly this one).
    readAgentArtifact: mock(() => undefined),
  }));
}

installMocks();

const { POST } = await import("@/app/api/agent/drive/route");

const RUN_ID = "arun_0123456789abcdef";

const password = `${crypto.randomUUID()}/${crypto.randomUUID().slice(0, 8)}`;
const connection = { id: "conn-drive", name: "drive", type: "postgres", password } as DatabaseConnection;
const scrub = providerTextScrub(connection, "any");

/** A drive that failed after the run's connection resolved, as the runtime answers it: the failure and its scrub. */
function failed(error: unknown): AgentDriveOutcome {
  return { kind: "failed", error, scrub };
}

function driveRequest(options: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers[AGENT_DRIVE_HEADER] = options.token;
  return createMockRequest("/api/agent/drive", { method: "POST", headers, body: options.body ?? {} });
}

beforeEach(() => {
  installMocks();
  clearRateLimitState();
  mockDriveAgentRunOutcome.mockClear();
  // A configured model is what makes the surface exist since #331 T5; the flag is
  // only the off-switch, so the absence test below sets it to a negative value.
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
});

afterEach(() => {
  restoreAgentModel();
});

describe("POST /api/agent/drive", () => {
  test("an MCP token is not a drive credential (#246)", async () => {
    const restoreChannel = useMcpChannel();
    try {
      const res = await POST(driveRequest({ token: await mintTestToken() }));
      expect(res.status).toBe(401);
      expect(mockDriveAgentRunOutcome).not.toHaveBeenCalled();
    } finally {
      restoreChannel();
    }
  });

  test("a valid credential drives the run it names", async () => {
    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));
    const body = await parseResponseJSON<{ runId: string; status: string }>(res);

    expect(res.status).toBe(200);
    expect(body.runId).toBe(RUN_ID);
    expect(body.status).toBe("succeeded");
    expect(mockDriveAgentRunOutcome).toHaveBeenCalledWith(RUN_ID);
  });

  test("the run driven is the credential's, never the body's", async () => {
    await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID), body: { runId: "arun_someoneelse" } }));

    expect(mockDriveAgentRunOutcome).toHaveBeenCalledWith(RUN_ID);
  });

  test("no credential drives nothing", async () => {
    const res = await POST(driveRequest());

    expect(res.status).toBe(401);
    expect(mockDriveAgentRunOutcome).not.toHaveBeenCalled();
  });

  test("a token signed with the session secret is not a drive credential", async () => {
    // It carries a well-formed `runId` as well as session claims, so the only thing
    // that can refuse it is the key separation — a probe missing the runId would
    // still be rejected on shape if the two keys were ever collapsed into one.
    const session = await new SignJWT({ runId: RUN_ID, role: "admin", username: "root" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET as string));

    const res = await POST(driveRequest({ token: session }));

    expect(res.status).toBe(401);
    expect(mockDriveAgentRunOutcome).not.toHaveBeenCalled();
  });

  test("a broken audit sink still refuses the caller", async () => {
    // The emit is isolated in its own try/catch: the 401 is already decided, and a
    // failing audit sink must not turn a refusal into an unrelated 500.
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const res = await POST(driveRequest());

      expect(res.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  test("an expired credential drives nothing", async () => {
    const stale = await mintAgentDriveToken(RUN_ID, () => Date.now() - 120_000);

    const res = await POST(driveRequest({ token: stale }));

    expect(res.status).toBe(401);
    expect(mockDriveAgentRunOutcome).not.toHaveBeenCalled();
  });

  test("the callback does not exist once the operator switches the agent off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBe(404);
    expect(mockDriveAgentRunOutcome).not.toHaveBeenCalled();
  });

  test("a run that does not exist is a 404", async () => {
    mockDriveAgentRunOutcome.mockRejectedValueOnce(new AgentRunServiceError("RUN_NOT_FOUND", "gone"));

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBe(404);
  });

  test("a run that has already ended is a conflict, not a failure", async () => {
    mockDriveAgentRunOutcome.mockResolvedValueOnce(
      failed(new AgentRunServiceError("RUN_NOT_RESUMABLE", "already succeeded")),
    );

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBe(409);
  });

  test("a delivery for a run another drive is already carrying is a conflict, not a failure", async () => {
    // The duplicate-delivery case, and the one place the distinction matters: the run
    // is HEALTHY and in flight, so this must not read as a server fault the queue
    // retries forever against a run someone else owns. 409 tells it to drop the
    // delivery; the drive that holds the claim finishes the run.
    mockDriveAgentRunOutcome.mockResolvedValueOnce(
      failed(new AgentRunServiceError("RUN_ALREADY_DRIVEN", "already being driven in this process")),
    );

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBe(409);
  });

  test("a drive that fails for any other reason reports a failure", async () => {
    mockDriveAgentRunOutcome.mockRejectedValueOnce(new Error("model unreachable"));

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("deliveries for one run are rate limited like every other model-reaching route", async () => {
    const token = await mintAgentDriveToken(RUN_ID);
    let last = 0;
    for (let attempt = 0; attempt < 21; attempt++) {
      last = (await POST(driveRequest({ token }))).status;
    }

    expect(last).toBe(429);
  });
});

describe("POST /api/agent/drive, a failure after the run's connection resolved", () => {
  const forms = secretForms([password]);
  const failures: [string, (text: string) => unknown][] = [
    ["a ConnectionError", (text) => new ConnectionError(text, "postgres")],
    ["a QueryError's detail", (text) => new QueryError("failed", "postgres", undefined, undefined, text)],
    ["a provider's RowBudgetRefusal", (text) => new RowBudgetRefusal(text, "postgres")],
    [
      "an AuthenticationError's fixStatement",
      (text) => new AuthenticationError("denied", "postgres", { fixStatement: text }),
    ],
    ["a thrown string", (text) => text],
  ];

  type AnswerBody = { error: string; details?: unknown; fixStatement?: unknown } & Record<string, unknown>;

  /** Every field of an answer but its texts, beside its status: what a client branches on. */
  function closedFields(status: number, body: AnswerBody) {
    const texts = new Set(["error", "details", "fixStatement"]);
    return { status, ...Object.fromEntries(Object.entries(body).filter(([field]) => !texts.has(field))) };
  }

  test.each(failures.flatMap(([label, make]) => forms.map((form) => [label, form, make] as const)))(
    "%s holding %s answers what its clean twin answers with the run's scrub, and neither the body nor the log holds it",
    async (_label, form, make) => {
      const logged = [spyOn(logger, "error"), spyOn(logger, "warn")].map((spy) => spy.mockImplementation(() => {}));
      try {
        const clean = make("could not run as the reader");
        const expected = createErrorResponse(clean, { route: "api/agent/drive", scrub });
        const expectedBody = await parseResponseJSON<AnswerBody>(expected);
        for (const spy of logged) spy.mockClear();
        const failure = make(`could not run as ${form}`);
        mockDriveAgentRunOutcome.mockResolvedValueOnce(failed(failure));

        const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));
        const body = await parseResponseJSON<AnswerBody>(res);

        expect(closedFields(res.status, body)).toEqual(closedFields(expected.status, expectedBody));
        expect(body.error).toBe(withheldErrorMessage(failure instanceof Error ? failure.name : "thrown string"));
        const calls = JSON.stringify(
          logged.flatMap((spy) => spy.mock.calls),
          (_key, value: unknown) => (value instanceof Error ? { message: value.message, stack: value.stack } : value),
        );
        for (const each of forms) {
          expect(JSON.stringify(body)).not.toContain(each);
          expect(calls).not.toContain(each);
        }
      } finally {
        for (const spy of logged) spy.mockRestore();
      }
    },
  );

  test("a database error with a SQLSTATE answers it beside its kind", async () => {
    const failure = new QueryError('relation "orders" does not exist', "postgres");
    failure.sqlstate = "42P01";
    mockDriveAgentRunOutcome.mockResolvedValueOnce(failed(failure));
    const quiet = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));
      const body = await parseResponseJSON<{ kind?: string; sqlState?: string }>(res);

      expect(res.status).toBe(400);
      expect(body.kind).toBe("query");
      expect(body.sqlState).toBe("42P01");
    } finally {
      quiet.mockRestore();
    }
  });

  test("a model's rate limit answers as the agent runs route answers it", async () => {
    mockDriveAgentRunOutcome.mockResolvedValueOnce(failed(new LLMRateLimitError("slow down", "openai")));
    const quiet = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));
      const body = await parseResponseJSON<{ code?: string; retryable?: boolean }>(res);

      expect(res.status).toBe(429);
      expect(body.code).toBe("LLM_RATE_LIMIT");
      expect(body.retryable).toBe(true);
    } finally {
      quiet.mockRestore();
    }
  });
});
