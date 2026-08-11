/**
 * The run timeline the rail renders (#329 T10a).
 *
 * A ledger line is not a UI string, and the translation between them is where two
 * of this milestone's invariants become visible to a user:
 *
 *  - A policy denial is described as a denial, by its deny code, and never as
 *    something the engine said. T2 made that structural (the policy variant of
 *    `AgentToolRefusal` declares no readable message), so this test pins the
 *    resulting user-facing wording rather than the type.
 *  - Text that came from the database or the model is carried in a separate field
 *    from the wording the app itself chose, so the rail can quote it as untrusted
 *    content instead of splicing it into a sentence.
 */

import { describe, test, expect } from "bun:test";
import { foldLedgerEntries, parseLedgerLine } from "@/components/agent/timeline";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";

const OPENED: AgentLedgerEntry = {
  kind: "run-opened",
  atMs: 1_000,
  runId: "arun_1",
  mode: "agent",
  actor: { sessionId: "ada", role: "user" },
  connectionId: "seed:sales",
  objective: "why is checkout slow",
};

function event(event: AgentLedgerEntry & { kind: "event" }): AgentLedgerEntry {
  return event;
}

describe("parseLedgerLine", () => {
  test("reads a run-opened header", () => {
    expect(parseLedgerLine(JSON.stringify(OPENED))).toEqual(OPENED);
  });

  test("reads an event line", () => {
    const line = { kind: "event", event: { kind: "run-started", atMs: 2, mode: "planning" } };

    expect(parseLedgerLine(JSON.stringify(line))).toEqual(line as AgentLedgerEntry);
  });

  test("reads a cancellation record", () => {
    const line = { kind: "cancellation-requested", atMs: 3, bySessionId: "ada" };

    expect(parseLedgerLine(JSON.stringify(line))).toEqual(line as AgentLedgerEntry);
  });

  // The rail must survive a line it does not understand rather than tearing down
  // the timeline it has already shown: a newer server may write a kind this build
  // has never heard of, and a truncated final chunk is a line too.
  test("skips a line that is not JSON", () => {
    expect(parseLedgerLine('{"kind":"event"')).toBeNull();
  });

  test("skips a line whose kind is not a ledger kind", () => {
    expect(parseLedgerLine(JSON.stringify({ kind: "something-newer", atMs: 1 }))).toBeNull();
  });

  test("skips a line that is not an object at all", () => {
    expect(parseLedgerLine("42")).toBeNull();
    expect(parseLedgerLine("null")).toBeNull();
  });

  test("skips an event line carrying no event", () => {
    expect(parseLedgerLine(JSON.stringify({ kind: "event" }))).toBeNull();
  });
});

describe("foldLedgerEntries", () => {
  test("an empty ledger is a run with nothing to show yet", () => {
    const view = foldLedgerEntries([]);

    expect(view.items).toEqual([]);
    expect(view.status).toBe("queued");
  });

  test("the header names the mode and carries the user's own objective", () => {
    const view = foldLedgerEntries([OPENED]);

    expect(view.status).toBe("queued");
    expect(view.items).toHaveLength(1);
    expect(view.items[0].headline).toBe("Run opened in agent mode");
    expect(view.items[0].quoted).toBe("why is checkout slow");
    expect(view.items[0].atMs).toBe(1_000);
  });

  test("a started run is running, and a finished one carries its terminal status", () => {
    const opened: AgentLedgerEntry[] = [
      OPENED,
      event({ kind: "event", event: { kind: "run-started", atMs: 2, mode: "agent" } }),
    ];
    expect(foldLedgerEntries(opened).status).toBe("running");

    const finished = foldLedgerEntries([
      ...opened,
      event({ kind: "event", event: { kind: "run-finished", atMs: 9, status: "failed" } }),
    ]);
    expect(finished.status).toBe("failed");
    expect(finished.items.at(-1)?.headline).toBe("Run failed");
    expect(finished.items.at(-1)?.tone).toBe("refused");
  });

  test("a run that succeeded says so", () => {
    const view = foldLedgerEntries([
      event({ kind: "event", event: { kind: "run-finished", atMs: 9, status: "succeeded" } }),
    ]);

    expect(view.status).toBe("succeeded");
    expect(view.items[0].headline).toBe("Run succeeded");
    expect(view.items[0].tone).toBe("done");
  });

  test("a cancelled run says so", () => {
    const view = foldLedgerEntries([
      event({ kind: "event", event: { kind: "run-finished", atMs: 9, status: "cancelled" } }),
    ]);

    expect(view.status).toBe("cancelled");
    expect(view.items[0].headline).toBe("Run cancelled");
  });

  test("a planning run's header says planning", () => {
    const view = foldLedgerEntries([
      event({ kind: "event", event: { kind: "run-started", atMs: 2, mode: "planning" } }),
    ]);

    expect(view.items[0].headline).toBe("Run started in planning mode");
  });

  test("a captured schema reports what it covers, not the inventory", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: { kind: "context-captured", atMs: 3, fingerprint: "abcdef1234567890", tableCount: 12 },
      }),
    ]);

    expect(view.items[0].headline).toBe("Schema captured");
    expect(view.items[0].detail).toBe("12 tables, fingerprint abcdef12");
    expect(view.items[0].quoted).toBeUndefined();
  });

  test("a drafted statement quotes the statement and states the reason separately", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "statement-drafted",
          atMs: 4,
          stepId: "s1",
          sql: "SELECT 1",
          rationale: "count the orders",
        },
      }),
    ]);

    expect(view.items[0].headline).toBe("Statement drafted");
    expect(view.items[0].detail).toBe("count the orders");
    expect(view.items[0].quoted).toBe("SELECT 1");
  });

  test("an invocation names the tool, and the operation when it reaches the operation layer", () => {
    const view = foldLedgerEntries([
      event({ kind: "event", event: { kind: "tool-invoked", atMs: 5, stepId: "s1", tool: "compose_report" } }),
      event({
        kind: "event",
        event: { kind: "tool-invoked", atMs: 6, stepId: "s2", tool: "run_read_query", operationId: "sql.query.read" },
      }),
    ]);

    expect(view.items[0].detail).toBe("compose_report");
    expect(view.items[1].detail).toBe("run_read_query via sql.query.read");
  });

  test("a completed tool reports the shape of its result and its audit join key", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-completed",
          atMs: 7,
          stepId: "s1",
          artifact: {
            correlationId: "corr_9",
            runId: "arun_1",
            operationId: "sql.query.read",
            summary: { rowCount: 3, columnNames: ["id", "total"], elapsedMs: 12 },
          },
        },
      }),
    ]);

    expect(view.items[0].headline).toBe("Result stored");
    expect(view.items[0].detail).toBe("3 rows, 2 columns, 12 ms (corr_9)");
    expect(view.items[0].tone).toBe("progress");
  });

  /**
   * The point of the whole refusal split: a denial is reported as a denial by its
   * deny code, with no engine text anywhere in the item, because there is none to
   * read.
   */
  test("a policy denial is described as a denial, by its code, with nothing quoted", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 8,
          stepId: "s1",
          refusal: { class: "policy-denied", reasonCode: "TARGET_OUT_OF_SCOPE" },
        },
      }),
    ]);

    expect(view.items[0].headline).toBe("Refused by policy");
    expect(view.items[0].detail).toBe("TARGET_OUT_OF_SCOPE");
    expect(view.items[0].quoted).toBeUndefined();
    expect(view.items[0].tone).toBe("refused");
  });

  test("an approval requirement is its own outcome, naming the operation", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 9,
          stepId: "s1",
          refusal: { class: "approval-required", operationId: "sql.plan.analyze" },
        },
      }),
    ]);

    expect(view.items[0].headline).toBe("Approval required");
    expect(view.items[0].detail).toBe("sql.plan.analyze");
  });

  test("an engine error carries the engine's own text as quoted content", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 10,
          stepId: "s1",
          refusal: {
            class: "database-error",
            statementFingerprint: "fp1",
            message: 'relation "custmers" does not exist',
          },
        },
      }),
    ]);

    expect(view.items[0].headline).toBe("The database refused the statement");
    expect(view.items[0].quoted).toBe('relation "custmers" does not exist');
  });

  test("a composed report reports how many claims it carries", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "report-composed",
          atMs: 11,
          claims: [
            { claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_9" }] },
            { claim: "an index is missing", evidence: [{ source: "context-snapshot", fingerprint: "abc" }] },
          ],
        },
      }),
    ]);

    expect(view.items[0].headline).toBe("Report composed");
    expect(view.items[0].detail).toBe("2 claims, each citing evidence");
  });

  test("one claim is not pluralized", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "report-composed",
          atMs: 12,
          claims: [{ claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_9" }] }],
        },
      }),
    ]);

    expect(view.items[0].detail).toBe("1 claim, each citing evidence");
  });

  /**
   * A stop is a request, not an outcome: the run is still running until its own loop
   * reaches a checkpoint. The wording has to say that, or a user reads a cancelled
   * run that is still holding a statement open.
   */
  test("a stop request is reported as requested, and the run stays running", () => {
    const view = foldLedgerEntries([
      OPENED,
      event({ kind: "event", event: { kind: "run-started", atMs: 2, mode: "agent" } }),
      { kind: "cancellation-requested", atMs: 13, bySessionId: "ada" },
    ]);

    expect(view.status).toBe("running");
    expect(view.items.at(-1)?.headline).toBe("Stop requested");
    expect(view.items.at(-1)?.detail).toBe("the run ends at its next checkpoint");
  });

  test("items are keyed uniquely even when two entries share a timestamp", () => {
    const view = foldLedgerEntries([
      event({ kind: "event", event: { kind: "tool-invoked", atMs: 5, stepId: "s1", tool: "inspect_schema" } }),
      event({ kind: "event", event: { kind: "tool-invoked", atMs: 5, stepId: "s1", tool: "inspect_schema" } }),
    ]);

    expect(new Set(view.items.map((item) => item.id)).size).toBe(2);
  });
});
