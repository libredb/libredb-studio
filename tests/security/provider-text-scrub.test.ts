/**
 * A credential of the connection never crosses out of a provider's text on the agent and MCP paths.
 *
 * Core scrubs every error, warning and notice text a provider hands it with the calling connection's own secret-class
 * values and every form `secretForms` derives from them (src/lib/db/operations/provider-text.ts), and withholds a text
 * that holds one whole. This is the cross-path absence matrix: a provider whose engine error, pre-send refusal, profile
 * refusal and warnings each carry one form of the password, and no form anywhere a reader or a model could see it.
 * Each site's own shape (fence, notice, author, status) is held beside its code; the hand-over's is in
 * tests/api/agent/handover.test.ts.
 *
 * The password is generated at run time, so no source line holds one.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { foldLedgerEntries } from "@/components/agent/timeline";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import { createErrorResponse } from "@/lib/api/errors";
import {
  ConnectionError,
  ExecutionProfileError,
  ProviderTextWithheldError,
  QueryError,
  RefusedBeforeSendError,
} from "@/lib/db/errors";
import {
  errorRecord,
  PROVIDER_TEXT_WITHHELD,
  providerTextScrub,
  scrubKindCounts,
  scrubObjectDetail,
  scrubSourceDocument,
  withholdProviderError,
} from "@/lib/db/operations/provider-text";
import type { DatabaseProvider, ObjectSourceDocument } from "@/lib/db/types";
import { secretForms } from "@/lib/db/utils/server-text";
import { logger } from "@/lib/logger";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import { type McpStatementInput, runStatement } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { QueryResult } from "@/lib/types";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { answersProse, callsTool } from "../isolated/fixtures/agent-scripted-model";
import { RunReadQueryInputSchema, runReadQuery } from "../helpers/run-read-query";
import { fakeTextScrub, pinMcpTestEnvironment, resetMcpTestState } from "../helpers/mcp-fixtures";

pinMcpTestEnvironment();

const password = `${crypto.randomUUID()}/${crypto.randomUUID().slice(0, 8)}`;
const forms = secretForms([password]);

/** Every line written to the console or the logger while a case runs. */
let written: string[] = [];
const spies: { mockRestore(): void }[] = [];
const runs: EvalRun[] = [];

beforeEach(() => {
  written = [];
  const capture = (...args: unknown[]) => {
    written.push(
      args
        .map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message}\n${arg.stack}` : JSON.stringify(arg)))
        .join(" "),
    );
  };
  for (const method of ["debug", "info", "warn", "error"] as const) {
    spies.push(spyOn(logger, method).mockImplementation(capture));
  }
  for (const method of ["log", "warn", "error"] as const) {
    spies.push(spyOn(console, method).mockImplementation(capture));
  }
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
  await resetMcpTestState();
});

function expectNoForm(where: string, text: string): void {
  for (const form of forms) expect(text.includes(form), `${where} holds a form of the password`).toBe(false);
}

describe("on the agent path", () => {
  const scenarios: [string, (form: string) => (sql: string) => Promise<QueryResult>][] = [
    [
      "an engine error",
      (form) => async () => {
        throw new QueryError(`password authentication failed for ${form}`, "postgres");
      },
    ],
    [
      "a refusal before sending",
      (form) => async () => {
        throw new RefusedBeforeSendError(`refused for the login ${form}`, "postgres");
      },
    ],
    [
      "a result's warnings",
      (form) => async () => ({
        rows: [{ n: 1 }],
        fields: ["n"],
        rowCount: 1,
        executionTime: 1,
        warnings: [{ message: `notice from ${form}`, code: form, severity: "WARNING" }],
      }),
    ],
  ];

  test.each(scenarios.flatMap(([label, make]) => forms.map((form) => [label, form, make] as const)))(
    "%s holding %s reaches no prompt, ledger, timeline or log line",
    async (_label, form, make) => {
      const run = await openEvalRun({
        objective: "How many orders are there?",
        answer: make(form),
        connectionFields: { password },
      });
      runs.push(run);

      const drive = await run.drive([
        callsTool("run_read_query", { sql: "SELECT count(*) AS n FROM orders", rationale: "count" }),
        answersProse("Done."),
        answersProse("Done."),
      ]);
      const events = await run.events();
      const entries: AgentLedgerEntry[] = [
        {
          kind: "run-opened",
          atMs: 0,
          runId: run.runId,
          mode: "agent",
          actor: { sessionId: "eval", role: "user" },
          connectionId: run.engine.connection.id,
          objective: "How many orders are there?",
        },
        ...events.map((event) => ({ kind: "event" as const, event })),
      ];

      const prompts = drive.transcripts.join("\n");
      expectNoForm("a prompt", prompts);
      expectNoForm("the ledger", JSON.stringify(events));
      expectNoForm("the timeline", JSON.stringify(foldLedgerEntries(entries)));
      expectNoForm("a log line", written.join("\n"));
      expect(prompts).toContain(PROVIDER_TEXT_WITHHELD);
      if (_label !== "a result's warnings") expect(JSON.stringify(events)).toContain(PROVIDER_TEXT_WITHHELD);
    },
  );
});

describe("on MCP", () => {
  const connection = {
    id: "seed:fake",
    name: "fake",
    type: "postgres",
    seedId: "fake",
    managed: true,
    mcp: true,
    roles: ["admin"],
    password,
    createdAt: new Date(),
  } as ManagedConnection;

  /** A context over the credentialed connection whose open and provider do what `provider` and `open` say. */
  function context(
    provider: Partial<DatabaseProvider>,
    open?: (form: string) => Error,
    form = "",
  ): McpConnectionContext {
    return {
      caller: { username: "alice", role: "admin" },
      visibleConnections: async () => [connection],
      resolve: async () => connection,
      textScrub: fakeTextScrub,
      acquire: async () => {
        if (open !== undefined) throw open(form);
        return provider as DatabaseProvider;
      },
    } as unknown as McpConnectionContext;
  }

  const answering = (failure?: Error, warnings?: { message: string }[]): Partial<DatabaseProvider> => ({
    type: "postgres",
    getCapabilities: () => ({}) as never,
    prepareQuery: (query: string) => ({ query, wasLimited: true, limit: 101, offset: 0 }),
    queryReadOnly: async () => {
      if (failure !== undefined) throw failure;
      return { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1, ...(warnings ? { warnings } : {}) };
    },
  });

  const read = (mcpContext: McpConnectionContext) =>
    runReadQuery(RunReadQueryInputSchema.parse({ connection_id: "seed:fake", sql: "SELECT 1" }) as McpStatementInput, {
      context: mcpContext,
      signal: new AbortController().signal,
    });
  const inspect = (mcpContext: McpConnectionContext) =>
    inspectSchema(InspectSchemaInputSchema.parse({ connection_id: "seed:fake" }), {
      context: mcpContext,
      signal: new AbortController().signal,
    });

  const failures: [string, (form: string) => McpConnectionContext][] = [
    [
      "a profile refusal at the open",
      (form) =>
        context({}, (text) => new ExecutionProfileError(`refused ${text}`, "PROFILE_PRIVILEGES_TOO_BROAD"), form),
    ],
    ["an error at the open", (form) => context({}, (text) => new Error(`could not connect as ${text}`), form)],
    ["an engine error", (form) => context(answering(new QueryError(`failed for ${form}`, "postgres")))],
    [
      "a refusal before sending",
      (form) => context(answering(new RefusedBeforeSendError(`refused ${form}`, "postgres"))),
    ],
    [
      "a profile refusal by the statement call",
      (form) => context(answering(new ExecutionProfileError(`refused ${form}`, "PROFILE_PRIVILEGES_TOO_BROAD"))),
    ],
  ];

  test.each(failures.flatMap(([label, make]) => forms.map((form) => [label, form, make] as const)))(
    "%s holding %s reaches no answer of either tool and no log line",
    async (label, form, make) => {
      const answers = [await read(make(form))];
      // inspect_schema sends no statement, so it meets the provider's text at the open.
      if (label.endsWith("at the open")) answers.push(await inspect(make(form)));

      for (const answer of answers) {
        expect(answer.isError).toBe(true);
        expectNoForm("an answer", JSON.stringify(answer));
        expect(JSON.stringify(answer)).toContain(PROVIDER_TEXT_WITHHELD);
      }
      expectNoForm("a log line", written.join("\n"));
    },
  );

  test.each(forms.map((form) => [form]))("notes holding %s are withheld", async (form) => {
    // run_s3_read's facet answers the provider's warnings as notes; run_read_query's answers none.
    const store = {
      ...connection,
      type: "s3",
      host: "127.0.0.1",
      port: 9000,
      user: crypto.randomUUID(),
      agentUser: crypto.randomUUID(),
      agentPassword: password,
    } as ManagedConnection;
    const provider = {
      getCapabilities: () => ({}),
      queryReadOnly: async () => ({
        rows: [{ bucket: "sales" }],
        fields: ["bucket"],
        rowCount: 1,
        executionTime: 1,
        warnings: [{ message: `signed with ${form}` }, { message: "a note of its own" }],
      }),
    };
    const mcpContext = {
      caller: { username: "alice", role: "admin" },
      resolve: async () => store,
      textScrub: fakeTextScrub,
      acquire: async () => provider,
    } as unknown as McpConnectionContext;
    const arm = mcpStatementArm("run_s3_read");
    const answer = await runStatement(
      arm,
      arm.inputSchema.parse({ connection_id: store.id, statement: "aws s3api list-buckets" }) as McpStatementInput,
      { context: mcpContext, signal: new AbortController().signal },
    );

    expect(answer.structuredContent?.notes).toEqual([PROVIDER_TEXT_WITHHELD, "a note of its own"]);
    expectNoForm("an answer", JSON.stringify(answer));
    expectNoForm("a log line", written.join("\n"));
  });
});

describe("an error's SQLSTATE", () => {
  test("a credential in an error's SQLSTATE is withheld with the error", () => {
    // A five-character credential shaped as a SQLSTATE, generated at run time: upper-case hex with a digit.
    const shaped =
      `${Math.floor(Math.random() * 10)}${crypto.randomUUID().replace(/-/g, "").slice(0, 4)}`.toUpperCase();
    const scrub = providerTextScrub(
      { id: "c1", name: "Prod", type: "postgres", password: shaped, createdAt: new Date(0) },
      "any",
    );
    const error = new QueryError("relation does not exist", "postgres");
    error.sqlstate = shaped;

    const withheld = withholdProviderError(scrub, error);
    expect(withheld).toBeInstanceOf(ProviderTextWithheldError);
    const record = errorRecord(scrub, error);
    expect(record.sqlState).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(shaped);
    expect(JSON.stringify(withheld)).not.toContain(shaped);
  });
});

describe("on the editor routes and the connection test", () => {
  test("an error answer that holds the connection's credential in any form secretForms derives keeps its status, code, kind and outcome and holds none of the forms", async () => {
    const scrub = providerTextScrub(
      { id: "c1", name: "Prod", type: "postgres", host: "db.internal", password, createdAt: new Date(0) },
      "any",
    );
    const answers = forms.map((form) => ({
      queryFailure: createErrorResponse(new QueryError(`syntax error near ${form}`, "postgres"), {
        route: "api/db/query",
        scrub,
      }),
      connectFailure: createErrorResponse(new ConnectionError(`could not connect as ${form}`, "postgres"), {
        route: "api/db/test-connection",
        scrub,
      }),
    }));
    const bodies = await Promise.all(
      answers.map(async ({ queryFailure, connectFailure }) => ({
        queryBody: await queryFailure.json(),
        connectBody: await connectFailure.json(),
      })),
    );
    answers.forEach(({ queryFailure, connectFailure }, index) => {
      const { queryBody, connectBody } = bodies[index];
      expect(queryFailure.status).toBe(400);
      expect(queryBody).toMatchObject({ code: "QUERY_ERROR", kind: "query", outcome: "unknown" });
      expectNoForm("a query error answer", JSON.stringify(queryBody));

      expect(connectFailure.status).toBe(503);
      expect(connectBody).toMatchObject({ code: "CONNECTION_ERROR", kind: "connection", retryable: true });
      expectNoForm("a connection error answer", JSON.stringify(connectBody));
    });
    expectNoForm("a log line", written.join("\n"));
  });
});

describe("on every route that resolves the calling connection", () => {
  test("an object read's sentences that hold the connection's credential in any form secretForms derives are withheld", () => {
    const scrub = providerTextScrub(
      { id: "c1", name: "Prod", type: "postgres", host: "db.internal", password, createdAt: new Date(0) },
      "any",
    );
    for (const form of forms) {
      const counts = scrubKindCounts(scrub, {
        table: { unavailable: `refused for ${form}` },
        view: { count: 4, sampledFrom: `sampled as ${form}` },
      });
      expect(counts).toEqual({
        table: { unavailable: PROVIDER_TEXT_WITHHELD },
        view: { count: 4, sampledFrom: PROVIDER_TEXT_WITHHELD },
      });
      const detail = scrubObjectDetail(scrub, {
        path: ["orders"],
        columns: [],
        indexes: { unavailable: `index read refused for ${form}` },
        foreignKeys: [],
      });
      expect(detail.indexes).toEqual({ unavailable: PROVIDER_TEXT_WITHHELD });
      const document: ObjectSourceDocument = {
        path: ["report"],
        kind: "function",
        parts: [
          { id: "definition", label: "Definition", unavailable: `refused for ${form}` },
          {
            id: "body",
            label: "Body",
            text: "SELECT 1",
            language: "sql",
            form: "partial",
            origin: "stored",
            truncated: { limit: 8, reason: `cut for ${form}` },
            edit: { offered: false, reason: `owned by ${form}` },
          },
        ],
      };
      const source = scrubSourceDocument(scrub, document);
      expectNoForm("an object read's sentences", JSON.stringify([counts, detail, source]));
    }
  });
});
