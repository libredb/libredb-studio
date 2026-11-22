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
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider } from "@/lib/db/types";
import { secretForms } from "@/lib/db/utils/server-text";
import { logger } from "@/lib/logger";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import type { McpStatementInput } from "@/lib/mcp/tools/run-statement";
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
    const answer = await runReadQuery(
      RunReadQueryInputSchema.parse({ connection_id: "seed:fake", sql: "SELECT 1" }) as McpStatementInput,
      { context: context(answering(undefined, [{ message: `notice ${form}` }])), signal: new AbortController().signal },
    );
    // run_read_query's facet answers no notes; the warnings are scrubbed before the answer is built either way.
    expectNoForm("an answer", JSON.stringify(answer));
  });
});
