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
import { AGENT_MAX_REPAIR_ATTEMPTS, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { PLAN_NO_STATEMENT_MARKER } from "@/lib/agent/plan-draft";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import { DEFAULT_AGENT_WORKFLOW_TYPE } from "@/lib/agent/types";

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
    // A header written before `workflowType` existed says exactly what it always
    // said, rather than being narrated as an investigation it never declared.
    expect(view.items[0].headline).toBe("Run opened in agent mode");
    expect(view.items[0].quoted).toBe("why is checkout slow");
    expect(view.items[0].atMs).toBe(1_000);
  });

  test("a header that declares what the run is FOR says so, in words rather than in identifiers", () => {
    const view = foldLedgerEntries([{ ...OPENED, workflowType: "query-optimization" }]);

    expect(view.items[0].headline).toBe("Run opened in agent mode for query optimization");
  });

  test("every workflow type has words a reader can read", () => {
    for (const [workflowType, words] of [
      ["investigation", "an investigation"],
      ["query-optimization", "query optimization"],
      ["database-assessment", "a database assessment"],
      ["operations", "an operations reading"],
      ["data-analysis", "a data analysis"],
    ] as const) {
      const view = foldLedgerEntries([{ ...OPENED, workflowType }]);
      expect(view.items[0].headline, workflowType).toBe(`Run opened in agent mode for ${words}`);
    }
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

  test("a run that failed before it could start carries why, in the entry's own words", () => {
    // The reason is the difference between a rail that says "failed" and one a user
    // can act on: an unconfigured model provider and a transient fault look
    // identical without it, and only one of them is worth fixing before retrying.
    const view = foldLedgerEntries([
      OPENED,
      event({ kind: "event", event: { kind: "run-finished", atMs: 9, status: "failed", reason: "model-unavailable" } }),
    ]);

    expect(view.status).toBe("failed");
    expect(view.failureReason).toBe("model-unavailable");
    expect(view.items.at(-1)?.detail).toBe("The model provider is not configured or could not be reached.");
  });

  /*
    The prose a run ends on used to be returned to the caller and dropped. These pin
    the two halves of showing it: the entry that carries the words, and the ending
    that says the run stopped without a cited report — which is the difference
    between "succeeded" and "answered".
  */
  test("the model's closing prose becomes an entry of its own", () => {
    const view = foldLedgerEntries([
      OPENED,
      event({
        kind: "event",
        event: { kind: "closing-statement", atMs: 8, text: "Start with the salary index." },
      }),
      event({
        kind: "event",
        event: { kind: "run-finished", atMs: 9, status: "succeeded", stopReason: "model-stopped" },
      }),
    ]);

    const closing = view.items.at(-2);
    expect(closing?.headline).toBe("Closing statement");
    // Carried as PROSE rather than as a detail: `detail` is the app's own words, and
    // this is the model's — a distinction the surface reads, because prose is what it
    // renders with the structure the model wrote (#373 review).
    expect(closing?.prose).toBe("Start with the salary index.");
    expect(closing?.detail).toBeUndefined();
    expect(closing?.tone).toBe("progress");
    expect(view.items.at(-1)?.detail).toBe("The model stopped without composing a cited report.");
  });

  /*
    A plan run's drafted statement, as the timeline reads it (item 5 of the plan-mode
    SQL-generator design of 2026-08-15). The statement CARD is item 7; what is pinned
    here is the honesty of the line the fold produces in the meantime, because every
    sentence in it is a claim about a statement the user may be about to run.
  */
  describe("a plan run's drafted statement", () => {
    const drafted = (entry: AgentLedgerEntry) => foldLedgerEntries([OPENED, entry]).items.at(-1);

    test("a read of known tables is reported without claiming it will run", () => {
      const item = drafted(
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 8,
            sql: "SELECT title FROM film",
            dialect: "postgres",
            readOnly: true,
            identifiers: { kind: "checked", unknownTables: [] },
          },
        }),
      );

      expect(item?.headline).toBe("Statement drafted");
      expect(item?.detail).toContain("had no objection, which is not a promise about what it does");
      // The limit item 6 of the design says must be stated wherever the claim is made:
      // an inventory records what exists, not what this user's role may select from.
      expect(item?.detail).toContain("not what your role is permitted to read");
      // No hand-off from this entry yet: the statement card that can mark a write as a
      // write is item 7, and an "Apply to editor" control here would run ahead of it.
      expect(item?.applySql).toBeUndefined();
    });

    test("a guard objection is marked in the headline, with the guard's own reason", () => {
      const item = drafted(
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 8,
            sql: "DELETE FROM film",
            dialect: "postgres",
            readOnly: false,
            guardViolation: "NON_READ_STATEMENT",
            identifiers: { kind: "checked", unknownTables: [] },
          },
        }),
      );

      expect(item?.headline).toBe("Statement drafted — not classified as a read");
      expect(item?.detail).toContain("NON_READ_STATEMENT");
      expect(item?.detail).toContain("marked, not blocked");
    });

    /*
      `readOnly` is `inspectAgentStatement(sql) === null` and nothing more, and four of
      that guard's six objections say only that it could not READ the text: unclosed
      spans, a run two dialects disagree about, a second statement, and no statement at
      all. Its own header records that it over-refuses legitimate reads on purpose —
      PostgreSQL's `#>`/`#>>` jsonb operators among them.

      So the headline states the CLASSIFICATION and never the effect. A pure jsonb read
      announced as "not a read" is the overstatement this repository is repeatedly
      caught in, and it would be made about the one statement on this surface a user is
      most likely to act on.
    */
    test("an objection the guard could not classify is not announced as a write", () => {
      const item = drafted(
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 8,
            sql: "SELECT payload #>> '{a,b}' FROM events",
            dialect: "postgres",
            readOnly: false,
            guardViolation: "DIALECT_AMBIGUOUS_TEXT",
            identifiers: { kind: "checked", unknownTables: [] },
          },
        }),
      );

      expect(item?.headline).toBe("Statement drafted — not classified as a read");
      expect(`${item?.headline} ${item?.detail}`).not.toContain("change or delete");
      expect(item?.detail).toContain("DIALECT_AMBIGUOUS_TEXT");
    });

    /*
      The names are COUNTED and not spoken: they are model and engine text, and the
      rule this whole fold follows is that untrusted content never enters a sentence
      the user reads as the application speaking.
    */
    test("names the inventory does not hold are counted, not quoted into the app's sentence", () => {
      const item = drafted(
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 8,
            sql: "SELECT * FROM payments",
            dialect: "postgres",
            readOnly: true,
            identifiers: { kind: "checked", unknownTables: ["payments"] },
          },
        }),
      );

      expect(item?.detail).toContain("1 name(s) it uses are not in the inventory this run read");
      expect(item?.detail).not.toContain("payments");
    });

    test("a run with no inventory says nothing was checked, rather than that nothing was wrong", () => {
      const item = drafted(
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 8,
            sql: "SELECT 1",
            dialect: "mongodb",
            readOnly: true,
            identifiers: { kind: "no-inventory" },
          },
        }),
      );

      expect(item?.detail).toContain("were not checked at all");
    });

    /*
      Item 7: the statement itself has to REACH the surface, or the card cannot show
      it. The fold carries the ledger's own record — the text, the guard's verdict and
      what the identifier check found — rather than a rendering of it, because the
      card decides how a write is marked and the fold decides nothing about pixels.
    */
    test("the ledger's own record is carried to the surface, verbatim", () => {
      const item = drafted(
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 8,
            sql: "DELETE FROM film WHERE id = 1",
            dialect: "postgres",
            readOnly: false,
            guardViolation: "NON_READ_STATEMENT",
            identifiers: { kind: "checked", unknownTables: ["payments"] },
          },
        }),
      );

      expect(item?.planStatement).toEqual({
        sql: "DELETE FROM film WHERE id = 1",
        readOnly: false,
        guardViolation: "NON_READ_STATEMENT",
        identifiers: { kind: "checked", unknownTables: ["payments"] },
      });
      // Still no `applySql`, and that stays deliberate: that field drives the rail's
      // shared hydration control, whose "Apply to editor" carries no mark at all. The
      // card offers this statement through its OWN control, whose accessible name says
      // what the statement is.
      expect(item?.applySql).toBeUndefined();
    });

    test("a read carries no guard reason, because there was no objection to carry", () => {
      const item = drafted(
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 8,
            sql: "SELECT title FROM film",
            dialect: "sqlite",
            readOnly: true,
            identifiers: { kind: "no-inventory" },
          },
        }),
      );

      expect(item?.planStatement?.readOnly).toBe(true);
      expect(item?.planStatement?.guardViolation).toBeUndefined();
      expect(item?.planStatement?.identifiers).toEqual({ kind: "no-inventory" });
    });
  });

  /*
    The OTHER legitimate ending of a plan run (item 7 of the plan-mode SQL-generator
    design of 2026-08-15): the run says the schema does not support the question, on a
    line beginning with the marker its rules gave it.

    The marker is a PROTOCOL token, not something the model was writing for a reader,
    so it is stripped here and the rail renders the rest as its own card. What is
    pinned below is mostly the reading's deference to the ledger: the browser is not
    allowed to decide that a run refused when the SERVER recorded a statement for it,
    because the server's reader is fence-aware and this one is not.
  */
  describe("a plan run's refusal", () => {
    const PLANNING_OPENED: AgentLedgerEntry = { ...OPENED, mode: "planning" };

    /** The closing entry itself, which is the second item of every ledger below. */
    const closing = (text: string, ...rest: readonly AgentLedgerEntry[]) =>
      foldLedgerEntries([
        PLANNING_OPENED,
        event({ kind: "event", event: { kind: "closing-statement", atMs: 8, text } }),
        ...rest,
      ]).items[1];

    test("the marker becomes a refusal entry, and never reaches the user as text", () => {
      const item = closing("NO STATEMENT: there is no table holding rentals.\n\nWhich table records them?");

      expect(item?.planRefusal).toBe(true);
      expect(item?.headline).toBe("No statement drafted");
      // The model's own words survive in full; only the token is gone.
      expect(item?.prose).toBe("there is no table holding rentals.\n\nWhich table records them?");
      expect(item?.prose).not.toContain("NO STATEMENT");
    });

    test("the marker is read the way the SERVER reads it, or the two would disagree about the same run", () => {
      // The characters themselves, from the module that defines them. A second
      // spelling in the browser is a spelling that drifts, and the drift would show
      // as a run whose ledger says "refused" while the rail shows a closing statement.
      const item = closing(`${PLAN_NO_STATEMENT_MARKER} nothing here has a price.`);

      expect(item?.planRefusal).toBe(true);
      expect(item?.prose).toBe("nothing here has a price.");
    });

    /*
      The marker INSIDE a fenced block is that block's text, not the run's refusal —
      the server's reader ignores everything between fences, so a run like this records
      no statement AND no refusal, and the verdict scores it `no-statement`. The browser
      used a fence-blind regex and called it a successful refusal, so the same run was
      reported two different ways by two different readers. It now asks the server's
      reader (#396 review).

      Note the block is tagged `text`: that is what makes this survive the ledger check
      above. A query-tagged block would have recorded a statement and never reached the
      refusal path at all, which is why the earlier "only consulted when no statement
      was recorded" argument did not close the hole.
    */
    test("a marker inside a fenced block is that block's text, not the run's refusal", () => {
      const item = closing(
        ["Here is the shape of a refusal:", "", "```text", "NO STATEMENT: example", "```"].join("\n"),
      );

      expect(item?.planRefusal).toBeUndefined();
      expect(item?.headline).not.toBe("No statement drafted");
    });

    test("a lower-cased marker still refuses, matching the server's own reading", () => {
      const item = closing("no statement: I cannot see a customers table.");

      expect(item?.planRefusal).toBe(true);
      expect(item?.prose).toBe("I cannot see a customers table.");
    });

    test("a closing statement with no marker is a closing statement", () => {
      const item = closing("Start with the salary index.");

      expect(item?.planRefusal).toBeUndefined();
      expect(item?.headline).toBe("Closing statement");
      expect(item?.prose).toBe("Start with the salary index.");
    });

    /*
      The case the naive reading would get wrong. The server's reader ignores
      everything inside a fence, so a statement quoting the marker is still a
      statement — and it RECORDED one. The browser defers to that rather than
      overruling it, and the prose keeps every character the model wrote.
    */
    test("a run whose ledger holds a statement is not re-read as a refusal", () => {
      const text = "```sql\nSELECT 'NO STATEMENT: not this one'\n```";
      const item = closing(
        text,
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 9,
            sql: "SELECT 'NO STATEMENT: not this one'",
            dialect: "postgres",
            readOnly: true,
            identifiers: { kind: "checked", unknownTables: [] },
          },
        }),
      );

      expect(item?.planRefusal).toBeUndefined();
      expect(item?.headline).toBe("Closing statement");
      expect(item?.prose).toBe(text);
    });

    /*
      The real ledger shape, and the one no test had: a plan run's closing prose HOLDS
      the fenced statement, and `recordPlanStatement` writes the drafted event from it
      immediately afterwards. So the same SQL reaches the rail twice — once as a fenced
      block inside the prose, where #389's per-block "Apply to editor" carries no mark
      at all, and once in the statement card that marks it.

      The unmarked control is the silent hand-off the design's item 4 exists to
      prevent, so the fold tells the surface which closing entry the run's deliverable
      was already offered from. The card is the marked hand-off; the prose keeps its
      copy controls and loses only the editor button it could not label honestly.
    */
    test("the closing prose a statement was read out of is flagged, so its blocks are not offered unmarked", () => {
      const item = closing(
        "```postgres\nDELETE FROM film WHERE rental_count = 0\n```\n\nIt removes the unrented titles.",
        event({
          kind: "event",
          event: {
            kind: "plan-statement-drafted",
            atMs: 9,
            sql: "DELETE FROM film WHERE rental_count = 0",
            dialect: "postgres",
            readOnly: false,
            guardViolation: "NON_READ_STATEMENT",
            identifiers: { kind: "checked", unknownTables: [] },
          },
        }),
      );

      expect(item?.planStatementRecorded).toBe(true);
    });

    test("a plan run that drafted nothing keeps the fence reading #389 gave it", () => {
      // The fallback is unchanged where there is no card to defer to: a run whose
      // ledger records no statement has nothing else offering its blocks.
      expect(closing("```postgres\nSELECT 1\n```")?.planStatementRecorded).toBeUndefined();
    });

    test("an agent run's closing statement is never read as a plan refusal", () => {
      // Only a PLAN run has this contract. An agent run's closing prose is the model
      // talking, and the marker is not a token it was given.
      const item = foldLedgerEntries([
        OPENED,
        event({ kind: "event", event: { kind: "closing-statement", atMs: 8, text: "NO STATEMENT: nothing to add." } }),
      ]).items.at(-1);

      expect(item?.planRefusal).toBeUndefined();
      expect(item?.prose).toBe("NO STATEMENT: nothing to add.");
    });
  });

  test("the app's own lines carry no prose, so nothing else is rendered as the model's", () => {
    const view = foldLedgerEntries([
      OPENED,
      event({
        kind: "event",
        event: { kind: "run-finished", atMs: 9, status: "succeeded", stopReason: "model-stopped" },
      }),
    ]);

    expect(view.items[0]?.prose).toBeUndefined();
    expect(view.items[1]?.prose).toBeUndefined();
  });

  test("a run that ran out of steps says so, and keeps what it gathered", () => {
    const view = foldLedgerEntries([
      OPENED,
      event({ kind: "event", event: { kind: "run-finished", atMs: 9, status: "failed", stopReason: "turn-limit" } }),
    ]);

    expect(view.items.at(-1)?.detail).toBe(
      "The run reached its step limit before it finished. What it had gathered is above.",
    );
  });

  test("a deadline and a cancellation each get their own account", () => {
    const ended = (stopReason: "deadline-exceeded" | "cancelled") =>
      foldLedgerEntries([
        OPENED,
        event({ kind: "event", event: { kind: "run-finished", atMs: 9, status: "failed", stopReason } }),
      ]).items.at(-1)?.detail;

    expect(ended("deadline-exceeded")).toBe("The run reached its time limit before it finished.");
    expect(ended("cancelled")).toBe("Stopped because it was cancelled.");
  });

  test("a run that composed a report does not also announce that it stopped", () => {
    // The report is already in the timeline above; a line saying a report exists
    // would be the entry repeating its neighbour.
    const view = foldLedgerEntries([
      OPENED,
      event({
        kind: "event",
        event: { kind: "run-finished", atMs: 9, status: "succeeded", stopReason: "report-composed" },
      }),
    ]);

    expect(view.items.at(-1)?.detail).toBeUndefined();
  });

  test("a drive that died outside the loop is described by that, not by the loop's exit", () => {
    // Both can be present on a ledger written by a drive that failed after the loop
    // had already recorded how it stopped. The drive failure is the more specific
    // account of what happened, so it is the one a user reads.
    const view = foldLedgerEntries([
      OPENED,
      event({
        kind: "event",
        event: {
          kind: "run-finished",
          atMs: 9,
          status: "failed",
          reason: "model-unavailable",
          stopReason: "model-stopped",
        },
      }),
    ]);

    expect(view.items.at(-1)?.detail).toBe("The model provider is not configured or could not be reached.");
  });

  test("an ending with no reason claims none", () => {
    // Most endings need none: succeeded, cancelled, and a loop that stopped on its
    // own terms are fully described by the status. A default sentence here would
    // invent a cause for runs that had one recorded nowhere.
    const view = foldLedgerEntries([
      OPENED,
      event({ kind: "event", event: { kind: "run-finished", atMs: 9, status: "failed" } }),
    ]);

    expect(view.failureReason).toBeNull();
    expect(view.items.at(-1)?.detail).toBeUndefined();
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

  test("an operational reading says it is a MOMENT, which an ordinary read does not", () => {
    // A curated reading settles as an ordinary `tool-completed`, so without this the
    // timeline would show a session list exactly as it shows a table read and a
    // reader would have no way to tell the rows describe an instant already past.
    // Attached on the operation id, the only thing on the event that identifies it.
    const reading = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-completed",
          atMs: 7,
          stepId: "s1",
          artifact: {
            correlationId: "corr_ops",
            runId: "arun_1",
            operationId: "db.operations.read",
            summary: { rowCount: 3, columnNames: ["pid", "state"], elapsedMs: 4 },
          },
        },
      }),
    ]);

    expect(reading.items[0].detail).toContain("3 rows, 2 columns, 4 ms (corr_ops)");
    expect(reading.items[0].detail).toContain("A moment, not a history");
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

  test("a refused reading is its own outcome, and quotes nothing, because no engine wrote it", () => {
    // The two reading refusals are the server's own decision about a curated reading
    // it will not deliver, so the item names what happened rather than fencing text.
    const unsupported = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 10,
          stepId: "s1",
          refusal: { class: "reading-refused", reasonCode: "KIND_UNSUPPORTED_BY_PROVIDER" },
        },
      }),
    ]);
    const oversized = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 10,
          stepId: "s1",
          refusal: { class: "reading-refused", reasonCode: "READING_OVER_BUDGET" },
        },
      }),
    ]);

    expect(unsupported.items[0].headline).toBe("This engine serves no reading of that kind");
    expect(unsupported.items[0].detail).toBe("KIND_UNSUPPORTED_BY_PROVIDER");
    expect(unsupported.items[0].quoted).toBeUndefined();
    expect(oversized.items[0].headline).toBe("The reading was larger than the run may carry");
    // The call WAS made and charged, so it counts against the statement budget — and
    // it is not a repair, because no rewording of the request would change it.
    expect(unsupported.budget.find((meter) => meter.id === "statements")?.used).toBe(1);
    expect(unsupported.budget.find((meter) => meter.id === "repairs")?.used).toBe(0);
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
    // #356: what the checkpoint IS, rather than that there is one. "Ends at its next
    // checkpoint" was read as a promise the run ends, and twice the run then composed
    // a report and answered — composing one reaches no database, and the checkpoint
    // is in the step that does.
    expect(view.items.at(-1)?.detail).toBe(
      "the run takes no further database step; work already in hand, such as a report, still finishes",
    );
  });

  test("items are keyed uniquely even when two entries share a timestamp", () => {
    const view = foldLedgerEntries([
      event({ kind: "event", event: { kind: "tool-invoked", atMs: 5, stepId: "s1", tool: "inspect_schema" } }),
      event({ kind: "event", event: { kind: "tool-invoked", atMs: 5, stepId: "s1", tool: "inspect_schema" } }),
    ]);

    expect(new Set(view.items.map((item) => item.id)).size).toBe(2);
  });
});

/**
 * The stop flag (#329 T10b). T10a deliberately did NOT fold one, because nothing
 * asked a run to stop and this repository's standing position is that a
 * declared-but-unread field is the state to avoid. T10b's stop control is its
 * reader, so the flag arrives with it.
 */
describe("foldLedgerEntries — a pending stop", () => {
  test("a run nobody has asked to stop reports none", () => {
    expect(foldLedgerEntries([OPENED]).stopRequested).toBe(false);
  });

  test("a stop request is visible to the controls, not only in the timeline", () => {
    const view = foldLedgerEntries([
      OPENED,
      event({ kind: "event", event: { kind: "run-started", atMs: 2, mode: "agent" } }),
      { kind: "cancellation-requested", atMs: 13, bySessionId: "ada" },
    ]);

    expect(view.stopRequested).toBe(true);
    // Still running: the request is an ask, and the run's own loop is what ends it.
    expect(view.status).toBe("running");
  });
});

/**
 * The budget meter (#329 T10b).
 *
 * Every figure here is one the SERVER enforces, and every consumption is read off
 * the run's own durable ledger rather than estimated in the browser:
 *
 *  - A statement is charged once per execution the pipeline ALLOWED and invoked
 *    (`execution.ts` charges `statements: 1` on the success and the failure path
 *    alike), so a completed read and an engine error each cost one.
 *  - A policy denial and an approval requirement cost NOTHING: `execution.ts`
 *    returns before `tracker.beginExecution` on any non-allow, and
 *    `AgentRepairLedger.recordFailure` consumes an attempt only for a
 *    `database-error`. A meter that charged them would be describing a bound
 *    nobody enforces.
 */
describe("foldLedgerEntries — the budget meter", () => {
  const gauge = (view: ReturnType<typeof foldLedgerEntries>, id: string) => {
    const found = view.budget.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no gauge "${id}"`);
    return found;
  };

  const completed = (stepId: string, correlationId: string, elapsedMs: number): AgentLedgerEntry =>
    event({
      kind: "event",
      event: {
        kind: "tool-completed",
        atMs: 7,
        stepId,
        artifact: {
          correlationId,
          runId: "arun_1",
          operationId: "sql.query.read",
          summary: { rowCount: 3, columnNames: ["id"], elapsedMs },
        },
      },
    });

  /**
   * The ceilings differ per workflow, so a meter that read one row would state a
   * number the server is not enforcing for four runs out of five. The workflow is
   * taken off the run's own header — the only entry that carries it.
   */
  test.each(["investigation", "query-optimization", "database-assessment", "operations", "data-analysis"] as const)(
    "a %s run's gauges are that workflow's own ceilings",
    (workflowType) => {
      const view = foldLedgerEntries([{ ...OPENED, workflowType }]);
      const budgets = AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets;

      expect(view.workflowType).toBe(workflowType);
      expect(gauge(view, "statements").limit).toBe(budgets.maxStatementsPerRun);
      expect(gauge(view, "database-time").limit).toBe(budgets.maxTotalRunMs);
      expect(gauge(view, "repairs").limit).toBe(AGENT_MAX_REPAIR_ATTEMPTS);
    },
  );

  /**
   * Two ledgers fold to the default, and for the same reason `run-store.ts` reads one
   * that way: a header written before the field can only have been an investigation,
   * and a stream joined after its header has gone past has nothing else to read.
   */
  test("a header with no workflow, and a ledger with no header, both fold to the default", () => {
    const budgets = AGENT_WORKFLOW_BUDGETS[DEFAULT_AGENT_WORKFLOW_TYPE].policy.budgets;

    for (const entries of [[OPENED], []]) {
      const view = foldLedgerEntries(entries);
      expect(view.workflowType).toBe(DEFAULT_AGENT_WORKFLOW_TYPE);
      expect(gauge(view, "statements").limit).toBe(budgets.maxStatementsPerRun);
      expect(gauge(view, "database-time").limit).toBe(budgets.maxTotalRunMs);
    }
  });

  test("a run that has done nothing has consumed nothing", () => {
    const view = foldLedgerEntries([OPENED]);

    expect(view.budget.map((entry) => entry.used)).toEqual([0, 0, 0]);
  });

  test("a completed read costs one statement and the database time it reported", () => {
    const view = foldLedgerEntries([completed("s1", "corr_1", 12), completed("s2", "corr_2", 30)]);

    expect(gauge(view, "statements").used).toBe(2);
    expect(gauge(view, "database-time").used).toBe(42);
    expect(gauge(view, "repairs").used).toBe(0);
  });

  test("a statement that failed at the database costs a statement and a repair attempt", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 8,
          stepId: "s1",
          refusal: { class: "database-error", statementFingerprint: "fp1", message: 'relation "custmers"' },
        },
      }),
    ]);

    expect(gauge(view, "statements").used).toBe(1);
    expect(gauge(view, "repairs").used).toBe(1);
    // The ledger records no duration for a statement that failed, so the meter
    // does not invent one — the caveat beside it is what says so.
    expect(gauge(view, "database-time").used).toBe(0);
  });

  test("a policy denial and an approval requirement cost nothing, because nothing ran", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 8,
          stepId: "s1",
          refusal: { class: "policy-denied", reasonCode: "ROLE_FORBIDDEN" },
        },
      }),
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 9,
          stepId: "s2",
          refusal: { class: "approval-required", operationId: "sql.plan.execute" },
        },
      }),
    ]);

    expect(view.budget.map((entry) => entry.used)).toEqual([0, 0, 0]);
  });

  /**
   * An invocation is written BEFORE its effect (T7a), so a step with no outcome is
   * a run interrupted between the two — or a call that failed while acquiring its
   * provider, which `tools.ts` accounts as a spent statement even though nothing
   * ran. The fold charges neither, because the ledger cannot tell them apart and a
   * meter that guessed would be the one figure here that is not an enforced value.
   * The second case is a known under-count, recorded as `docs/BACKLOG.md` B13.
   */
  /**
   * A ceiling is per drive (`docs/BACKLOG.md` B6) while the ledger spans every
   * drive, so a resumed run legitimately folds to more than one drive's allowance.
   * The fold does NOT clamp it: clamping would hide that a run has cost more than
   * its ceiling suggests, which is the direction that misleads. The rail's caveat
   * is what says so, and this pins the behaviour that caveat describes.
   */
  test("a run resumed past a per-drive ceiling folds to what it actually spent", () => {
    const failed = (stepId: string): AgentLedgerEntry =>
      event({
        kind: "event",
        event: {
          kind: "tool-refused",
          atMs: 8,
          stepId,
          refusal: { class: "database-error", statementFingerprint: stepId, message: "boom" },
        },
      });
    const view = foldLedgerEntries([failed("s1"), failed("s2"), failed("s3"), failed("s4")]);

    expect(gauge(view, "repairs").used).toBeGreaterThan(AGENT_MAX_REPAIR_ATTEMPTS);
  });

  test("an invocation with no recorded outcome is charged to nothing", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: { kind: "tool-invoked", atMs: 6, stepId: "s1", tool: "run_read_query", operationId: "sql.query.read" },
      }),
    ]);

    expect(view.budget.map((entry) => entry.used)).toEqual([0, 0, 0]);
  });
});

/**
 * Evidence citations (#329 T10b).
 *
 * `composeReportTool` already refuses a claim whose evidence does not match
 * something the run produced, so what the rail adds is the other half: showing the
 * user WHAT each claim rests on, resolved out of the same ledger. The claim itself
 * is the model's prose and is carried as quoted content, never as the app speaking.
 */
describe("foldLedgerEntries — the report and its citations", () => {
  const CAPTURED: AgentLedgerEntry = event({
    kind: "event",
    event: { kind: "context-captured", atMs: 3, fingerprint: "fingerprint_9", tableCount: 8 },
  });

  const COMPLETED: AgentLedgerEntry = event({
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
  });

  const DRAFTED: AgentLedgerEntry = event({
    kind: "event",
    event: { kind: "statement-drafted", atMs: 6, stepId: "s1", sql: "SELECT 1", rationale: "count the orders" },
  });

  const reportOf = (claims: readonly { claim: string; evidence: readonly unknown[] }[]): AgentLedgerEntry =>
    event({
      kind: "event",
      event: { kind: "report-composed", atMs: 11, claims: claims as never },
    });

  test("a run that composed no report has none", () => {
    expect(foldLedgerEntries([OPENED, COMPLETED]).report).toBeNull();
  });

  test("a claim is carried as the model's own words, quoted rather than narrated", () => {
    const view = foldLedgerEntries([
      COMPLETED,
      reportOf([{ claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_9" }] }]),
    ]);

    expect(view.report?.claims).toHaveLength(1);
    expect(view.report?.claims[0].quoted).toBe("checkout is slow");
  });

  test("an artifact citation resolves to the read that produced it, and to its statement", () => {
    const view = foldLedgerEntries([
      DRAFTED,
      COMPLETED,
      reportOf([{ claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_9" }] }]),
    ]);

    const [citation] = view.report?.claims[0].citations ?? [];
    expect(citation.resolved).toBe(true);
    expect(citation.label).toBe("Artifact corr_9");
    expect(citation.detail).toBe("3 rows via sql.query.read");
    expect(citation.quoted).toBe("SELECT 1");
  });

  test("an artifact read without a drafted statement cites the read alone", () => {
    const view = foldLedgerEntries([
      COMPLETED,
      reportOf([{ claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_9" }] }]),
    ]);

    const [citation] = view.report?.claims[0].citations ?? [];
    expect(citation.resolved).toBe(true);
    expect(citation.quoted).toBeUndefined();
  });

  test("a schema citation resolves to the capture it names", () => {
    const view = foldLedgerEntries([
      CAPTURED,
      reportOf([
        {
          claim: "orders has no index on placed_at",
          evidence: [{ source: "context-snapshot", fingerprint: "fingerprint_9" }],
        },
      ]),
    ]);

    const [citation] = view.report?.claims[0].citations ?? [];
    expect(citation.resolved).toBe(true);
    expect(citation.label).toBe("Schema snapshot fingerpr");
    expect(citation.detail).toBe("8 tables");
  });

  test("one row and one table are not pluralized", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: { kind: "context-captured", atMs: 3, fingerprint: "solo", tableCount: 1 },
      }),
      event({
        kind: "event",
        event: {
          kind: "tool-completed",
          atMs: 7,
          stepId: "s2",
          artifact: {
            correlationId: "corr_1",
            runId: "arun_1",
            operationId: "sql.query.read",
            summary: { rowCount: 1, columnNames: ["id"], elapsedMs: 4 },
          },
        },
      }),
      reportOf([
        {
          claim: "one of each",
          evidence: [
            { source: "artifact", correlationId: "corr_1" },
            { source: "context-snapshot", fingerprint: "solo" },
          ],
        },
      ]),
    ]);

    const citations = view.report?.claims[0].citations ?? [];
    expect(citations[0].detail).toBe("1 row via sql.query.read");
    expect(citations[1].detail).toBe("1 table");
  });

  // The server verified every reference against the run's log before recording the
  // report, so an unresolved citation means this TIMELINE is missing the entry —
  // a line the reader skipped, or a stream joined late. Saying so beats rendering a
  // reference as if the rail had checked it.
  test("a citation this timeline cannot resolve says so rather than inventing a source", () => {
    const view = foldLedgerEntries([
      reportOf([{ claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_absent" }] }]),
      reportOf([{ claim: "still slow", evidence: [{ source: "context-snapshot", fingerprint: "absent" }] }]),
    ]);

    const first = view.report?.claims[0].citations[0];
    expect(first?.resolved).toBe(false);
    expect(first?.detail).toBe("not in the part of this run's timeline the rail has read");
    expect(first?.quoted).toBeUndefined();
  });

  test("a locator the model supplied is carried through as its own untrusted text", () => {
    const view = foldLedgerEntries([
      COMPLETED,
      reportOf([
        {
          claim: "checkout is slow",
          evidence: [{ source: "artifact", correlationId: "corr_9", locator: "row 2, total" }],
        },
      ]),
    ]);

    expect(view.report?.claims[0].citations[0].locator).toBe("row 2, total");
  });

  test("every claim and citation is keyed uniquely, even when two claims are identical", () => {
    const evidence = [{ source: "artifact", correlationId: "corr_9" }];
    const view = foldLedgerEntries([
      COMPLETED,
      reportOf([
        { claim: "checkout is slow", evidence },
        { claim: "checkout is slow", evidence },
      ]),
    ]);

    const claims = view.report?.claims ?? [];
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(2);
    expect(new Set(claims.flatMap((claim) => claim.citations.map((citation) => citation.id))).size).toBe(2);
  });

  // A run that composed twice (a resumed run may — `composeReport` says so) shows
  // the LAST report: it is the one the run ended on.
  test("a second report replaces the first", () => {
    const view = foldLedgerEntries([
      COMPLETED,
      reportOf([{ claim: "first", evidence: [{ source: "artifact", correlationId: "corr_9" }] }]),
      reportOf([{ claim: "second", evidence: [{ source: "artifact", correlationId: "corr_9" }] }]),
    ]);

    expect(view.report?.claims).toHaveLength(1);
    expect(view.report?.claims[0].quoted).toBe("second");
  });

  /*
   * The hydration affordances (#329 T11). What a citation may OFFER is decided here,
   * from the ledger, so the rail renders a control only where the run recorded
   * something to hydrate from — never a button that would ask for an artifact this
   * timeline never saw.
   */
  test("a resolved artifact citation names the artifact a result can be fetched by", () => {
    const view = foldLedgerEntries([
      DRAFTED,
      COMPLETED,
      reportOf([{ claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_9" }] }]),
    ]);

    const [citation] = view.report?.claims[0].citations ?? [];
    expect(citation.artifactId).toBe("corr_9");
  });

  test("a citation this timeline cannot resolve offers nothing to fetch", () => {
    const view = foldLedgerEntries([
      reportOf([{ claim: "checkout is slow", evidence: [{ source: "artifact", correlationId: "corr_missing" }] }]),
    ]);

    const [citation] = view.report?.claims[0].citations ?? [];
    expect(citation.resolved).toBe(false);
    expect(citation.artifactId).toBeUndefined();
  });

  test("a schema citation offers nothing to fetch: a snapshot is not an artifact", () => {
    const view = foldLedgerEntries([
      CAPTURED,
      reportOf([{ claim: "orders is wide", evidence: [{ source: "context-snapshot", fingerprint: "fingerprint_9" }] }]),
    ]);

    const [citation] = view.report?.claims[0].citations ?? [];
    expect(citation.resolved).toBe(true);
    expect(citation.artifactId).toBeUndefined();
  });
});

describe("foldLedgerEntries — what a timeline item offers to hydrate", () => {
  test("a completed tool names its artifact, so its rows can be asked for", () => {
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
            summary: { rowCount: 3, columnNames: ["id"], elapsedMs: 12 },
          },
        },
      }),
    ]);

    expect(view.items[0].artifactId).toBe("corr_9");
    expect(view.items[0].applySql).toBeUndefined();
  });

  test("a drafted statement offers the statement itself, which is what the editor takes", () => {
    const view = foldLedgerEntries([
      event({
        kind: "event",
        event: { kind: "statement-drafted", atMs: 6, stepId: "s1", sql: "SELECT 1", rationale: "why" },
      }),
    ]);

    expect(view.items[0].applySql).toBe("SELECT 1");
    expect(view.items[0].artifactId).toBeUndefined();
  });

  test("an entry that produced neither offers neither", () => {
    const view = foldLedgerEntries([OPENED]);

    expect(view.items[0].applySql).toBeUndefined();
    expect(view.items[0].artifactId).toBeUndefined();
  });
});

// ─── the query-optimization template's entries (#330 T3) ────────────────────

describe("a plan comparison reads as a comparison, and says what those plans are", () => {
  const comparison = (
    before: { access: string; estimatedRows?: number; estimatedCost?: number; uninterpretedStep?: boolean },
    after: { access: string; estimatedRows?: number; estimatedCost?: number; uninterpretedStep?: boolean },
  ): AgentLedgerEntry =>
    event({
      kind: "event",
      event: {
        kind: "plan-comparison",
        atMs: 5,
        before: { correlationId: "corr-1", sql: "SELECT * FROM orders", summary: before },
        after: { correlationId: "corr-2", sql: "SELECT id FROM orders", summary: after },
      },
    } as AgentLedgerEntry & { kind: "event" });

  test("names both access paths and carries the engine's estimates when it reported them", () => {
    const view = foldLedgerEntries([
      OPENED,
      comparison(
        { access: "full-scan", estimatedRows: 1000, estimatedCost: 210.5 },
        { access: "index", estimatedRows: 3, estimatedCost: 8.3 },
      ),
    ]);

    const item = view.items[1];
    expect(item?.headline).toBe("Plans compared");
    expect(item?.detail).toContain("a full scan (1000 row(s), cost 210.5)");
    expect(item?.detail).toContain("an index (3 row(s), cost 8.3)");
  });

  test("states that the plans were estimated and never executed, in the app's own words", () => {
    // The honesty #330 asks for, said by the app rather than left to the model to
    // remember: the executing form of EXPLAIN is policy-denied precisely because it
    // would have run the statement.
    const view = foldLedgerEntries([OPENED, comparison({ access: "full-scan" }, { access: "index" })]);

    expect(view.items[1]?.detail).toContain("Estimates only");
    expect(view.items[1]?.detail).toContain("EXPLAIN ANALYZE is policy-denied");
  });

  test("a partly-read plan is described exactly as a fully-read one of the same access", () => {
    // `uninterpretedStep` was added for the auto-execute gate (#373) and this is the
    // constraint that came with it: a comparison is about how two statements differ in
    // the access they were read to have, and whether one of them also sorted is not a
    // difference this reading measured. So the sentence is the one it was before the
    // field existed, and the field is read by the gate alone.
    const flagged = foldLedgerEntries([
      OPENED,
      comparison({ access: "full-scan", uninterpretedStep: true }, { access: "index", uninterpretedStep: true }),
    ]);
    const plain = foldLedgerEntries([OPENED, comparison({ access: "full-scan" }, { access: "index" })]);

    expect(flagged.items[1]?.detail).toBe(plain.items[1]?.detail ?? "");
  });

  test("an engine that reports no estimates gets no parenthetical, rather than a zero", () => {
    const view = foldLedgerEntries([OPENED, comparison({ access: "full-scan" }, { access: "index" })]);

    expect(view.items[1]?.detail).toContain("a full scan to an index");
    expect(view.items[1]?.detail).not.toContain("(");
  });

  test("offers the improved statement to the editor, and quotes it rather than narrating it", () => {
    const view = foldLedgerEntries([OPENED, comparison({ access: "full-scan" }, { access: "index" })]);

    expect(view.items[1]?.applySql).toBe("SELECT id FROM orders");
    expect(view.items[1]?.quoted).toBe("SELECT id FROM orders");
  });

  test("every access path has words, so none renders blank", () => {
    for (const [access, words] of [
      ["full-scan", "a full scan"],
      ["index", "an index"],
      ["mixed", "a mix of index and full scan"],
      ["unknown", "an access path this reading could not interpret"],
    ] as const) {
      const view = foldLedgerEntries([OPENED, comparison({ access }, { access })]);
      expect(view.items[1]?.detail, access).toContain(words);
    }
  });

  test("a row estimate without a cost reports only what the engine gave", () => {
    const view = foldLedgerEntries([OPENED, comparison({ access: "index", estimatedRows: 4 }, { access: "index" })]);

    expect(view.items[1]?.detail).toContain("an index (4 row(s))");
  });
});

describe("a recommendation reads as a proposal, never as something that happened", () => {
  const recommendation = (change: "index" | "rewrite", statement: string): AgentLedgerEntry =>
    event({
      kind: "event",
      event: {
        kind: "recommendation",
        atMs: 6,
        change,
        statement,
        rationale: "The filtered column has no index.",
        evidence: [{ source: "artifact", correlationId: "corr-1" }],
      },
    } as AgentLedgerEntry & { kind: "event" });

  test("an index recommendation is named as one, and says it was not applied", () => {
    const view = foldLedgerEntries([OPENED, recommendation("index", "CREATE INDEX ix ON orders (customer_id)")]);

    expect(view.items[1]?.headline).toBe("Index recommended");
    expect(view.items[1]?.detail).toContain("Not applied");
  });

  test("a rewrite recommendation is named as one", () => {
    const view = foldLedgerEntries([OPENED, recommendation("rewrite", "SELECT id FROM orders")]);

    expect(view.items[1]?.headline).toBe("Rewrite recommended");
  });

  test("the statement is offered to the editor and quoted, which is the whole affordance", () => {
    const ddl = "CREATE INDEX ix ON orders (customer_id)";
    const view = foldLedgerEntries([OPENED, recommendation("index", ddl)]);

    expect(view.items[1]?.applySql).toBe(ddl);
    expect(view.items[1]?.quoted).toBe(ddl);
  });
});

describe("a table profile reads as counts and findings, never as values", () => {
  const profiled = (findings: readonly { code: string; column: string; detail: string }[]): AgentLedgerEntry =>
    event({
      kind: "event",
      event: {
        kind: "table-profiled",
        atMs: 7,
        artifact: {
          correlationId: "corr-1",
          runId: "run-1",
          operationId: "sql.table.profile",
          summary: { rowCount: 1, columnNames: ["row_count"], elapsedMs: 9 },
        },
        profile: {
          table: "public.customers",
          depth: "pattern",
          rowCount: 4120,
          columns: [{ column: "email", present: 4118, distinct: 4100, shaped: 4090 }],
          findings,
        },
      },
    } as AgentLedgerEntry & { kind: "event" });

  test("names the table, the depth and every finding", () => {
    const view = foldLedgerEntries([
      OPENED,
      profiled([{ code: "suspected_pii", column: "email", detail: "99% look like an email address." }]),
    ]);

    expect(view.items[1]?.headline).toBe("Profiled public.customers");
    expect(view.items[1]?.detail).toContain("4120 row(s) at pattern depth");
    expect(view.items[1]?.detail).toContain("email: suspected_pii");
  });

  test("a profile that crossed no threshold says so rather than listing nothing", () => {
    const view = foldLedgerEntries([OPENED, profiled([])]);

    expect(view.items[1]?.detail).toContain("Nothing stood out");
    expect(view.items[1]?.detail).toContain("1 column(s)");
  });
});

describe("an ending says whether the run ANSWERED, not only how it stopped (B24)", () => {
  const finished = (
    status: "succeeded" | "failed" | "cancelled",
    goalVerdict?: { outcome: "answered" | "unanswered"; verifier: string; unmet?: string[] },
    stopReason?: string,
  ): AgentLedgerEntry =>
    event({
      kind: "event",
      event: { kind: "run-finished", atMs: 9, status, stopReason, goalVerdict },
    } as AgentLedgerEntry & { kind: "event" });

  test("a run that answered says so, whatever word its status carries", () => {
    const view = foldLedgerEntries([
      OPENED,
      finished("succeeded", { outcome: "answered", verifier: "agent-investigation.1" }, "report-composed"),
    ]);

    expect(view.items[1]?.headline).toBe("Run answered");
  });

  test("the two live shapes that made this necessary read the same way", () => {
    // Observed on 2026-08-13: one run ended `succeeded` (the model stopped) and one
    // ended `failed` (the turn ceiling), and both answered nothing. The status word
    // told them apart; nothing told them apart from a run that answered.
    const stopped = foldLedgerEntries([
      OPENED,
      finished(
        "succeeded",
        { outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] },
        "model-stopped",
      ),
    ]);
    const exhausted = foldLedgerEntries([
      OPENED,
      finished(
        "failed",
        { outcome: "unanswered", verifier: "agent-query-optimization.1", unmet: ["no-report"] },
        "turn-limit",
      ),
    ]);

    expect(stopped.items[1]?.headline).toBe("Run did not answer");
    expect(exhausted.items[1]?.headline).toBe("Run did not answer");
    // And the STATUS is still its own fact, unchanged.
    expect(stopped.status).toBe("succeeded");
    expect(exhausted.status).toBe("failed");
  });

  test("what was missing is said in the app's own words, more specific than the stop reason", () => {
    const view = foldLedgerEntries([
      OPENED,
      finished(
        "succeeded",
        { outcome: "unanswered", verifier: "agent-query-optimization.1", unmet: ["no-plan-comparison"] },
        "report-composed",
      ),
    ]);

    expect(view.items[1]?.detail).toContain("before-and-after plan comparison");
  });

  test("every shortfall has words, so none reaches a user as a raw code", () => {
    for (const code of [
      "no-report",
      "empty-evidence",
      "no-plan",
      "no-statement",
      "no-plan-comparison",
      "no-plan-evidence",
      "no-table-profile",
      "no-answer",
      "cancelled",
    ]) {
      const view = foldLedgerEntries([
        OPENED,
        finished("failed", { outcome: "unanswered", verifier: "agent-investigation.1", unmet: [code] }),
      ]);
      expect(view.items[1]?.detail, code).toBeTruthy();
      expect(view.items[1]?.detail, code).not.toContain(code);
    }
  });

  test("a drive that died outside the loop still reports its reason, which is more specific", () => {
    const view = foldLedgerEntries([
      OPENED,
      event({
        kind: "event",
        event: {
          kind: "run-finished",
          atMs: 9,
          status: "failed",
          reason: "model-rate-limited",
          goalVerdict: { outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] },
        },
      } as AgentLedgerEntry & { kind: "event" }),
    ]);

    expect(view.items[1]?.detail).toContain("limiting this key's requests");
  });

  test("an older ending, with no verdict, reads exactly as it always did", () => {
    const view = foldLedgerEntries([OPENED, finished("succeeded", undefined, "model-stopped")]);

    expect(view.items[1]?.headline).toBe("Run succeeded");
    expect(view.items[1]?.detail).toContain("stopped without composing a cited report");
  });

  /**
   * #356 finding 2, observed twice on 2026-08-12: Stop was pressed, the request was
   * recorded, and the run composed its report 2.4s later and ended
   * `succeeded / answered`. Correct by contract, and the rail said "Run answered"
   * and never mentioned the stop again.
   */
  describe("a run that was asked to stop and finished anyway says so", () => {
    const stop: AgentLedgerEntry = { kind: "cancellation-requested", atMs: 13, bySessionId: "ada" };

    test("the ending accounts for the stop it outran", () => {
      const view = foldLedgerEntries([
        OPENED,
        stop,
        finished("succeeded", { outcome: "answered", verifier: "agent-investigation.1" }, "report-composed"),
      ]);

      // The verdict is unchanged: the run answered, and who asked for what is a
      // different fact from what the run produced.
      expect(view.items.at(-1)?.headline).toBe("Run answered");
      expect(view.items.at(-1)?.detail).toBe(
        "A stop was requested before this ending: the run took no further database step, and finished what it already had in hand.",
      );
    });

    test("a shortfall still leads, and the stop is added after it", () => {
      const view = foldLedgerEntries([
        OPENED,
        stop,
        finished(
          "failed",
          { outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] },
          "turn-limit",
        ),
      ]);

      expect(view.items.at(-1)?.detail).toContain("without composing a cited report");
      expect(view.items.at(-1)?.detail).toContain("A stop was requested before this ending");
    });

    test("a run that ended cancelled is not told about its own cancellation twice", () => {
      const view = foldLedgerEntries([
        OPENED,
        stop,
        finished(
          "cancelled",
          { outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["cancelled"] },
          "cancelled",
        ),
      ]);

      expect(view.items.at(-1)?.detail).toBe("The run was stopped before it could finish.");
    });

    test("an ending nobody asked for says nothing about a stop", () => {
      const view = foldLedgerEntries([
        OPENED,
        finished("succeeded", { outcome: "answered", verifier: "agent-investigation.1" }, "report-composed"),
      ]);

      expect(view.items.at(-1)?.detail).toBeUndefined();
    });
  });
});

/*
  #350's second finding, and the reason it survived every existing assertion: the
  headline and the sentence under it were each pinned alone, and the defect is only
  visible in the PAIR. A planning run that ended exactly as planning runs are meant
  to ended `model-stopped`, and the rail rendered "Run answered" with "The model
  stopped without composing a cited report." directly beneath it — a verdict and a
  shortfall about the same run, in the same breath, one of them false.

  Every test here therefore reads BOTH fields of one ending. Asserting either half
  on its own is what let the contradiction through the first time.
*/
describe("the verdict and the sentence beneath it are read as one pair (#350)", () => {
  const openedIn = (mode: "agent" | "planning"): AgentLedgerEntry => ({ ...OPENED, mode });

  const stoppedAnswering = (verifier: string): AgentLedgerEntry =>
    event({
      kind: "event",
      event: {
        kind: "run-finished",
        atMs: 9,
        status: "succeeded",
        stopReason: "model-stopped",
        goalVerdict: { outcome: "answered", verifier },
      },
    } as AgentLedgerEntry & { kind: "event" });

  test("a planning run that answered is not also told it composed no report", () => {
    // Planning is TOOLLESS by contract: `compose_report` does not exist in that
    // mode, so stopping without one is how a good planning run ends.
    const view = foldLedgerEntries([openedIn("planning"), stoppedAnswering("agent-planning.1")]);
    const ending = view.items[1];

    expect(ending?.headline).toBe("Run answered");
    expect(ending?.detail ?? "").not.toContain("without composing a cited report");
    // And it is not merely silent: the pair still says what happened.
    expect(ending?.detail).toContain("plan");
  });

  test("an agent run that answered nothing still reads as the shortfall it is", () => {
    const view = foldLedgerEntries([
      openedIn("agent"),
      event({
        kind: "event",
        event: {
          kind: "run-finished",
          atMs: 9,
          status: "succeeded",
          stopReason: "model-stopped",
          goalVerdict: { outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] },
        },
      } as AgentLedgerEntry & { kind: "event" }),
    ]);
    const ending = view.items[1];

    expect(ending?.headline).toBe("Run did not answer");
    expect(ending?.detail).toContain("without composing a cited report");
  });

  test("a planning run that fell short says what it lacked, not how the loop exited", () => {
    const view = foldLedgerEntries([
      openedIn("planning"),
      event({
        kind: "event",
        event: {
          kind: "run-finished",
          atMs: 9,
          status: "succeeded",
          stopReason: "model-stopped",
          goalVerdict: { outcome: "unanswered", verifier: "agent-planning.1", unmet: ["no-plan"] },
        },
      } as AgentLedgerEntry & { kind: "event" }),
    ]);
    const ending = view.items[1];

    expect(ending?.headline).toBe("Run did not answer");
    expect(ending?.detail).toContain("no plan at all");
  });

  test("a planning run's other endings are still the failures they were", () => {
    const view = foldLedgerEntries([
      openedIn("planning"),
      event({
        kind: "event",
        event: { kind: "run-finished", atMs: 9, status: "failed", stopReason: "deadline-exceeded" },
      } as AgentLedgerEntry & { kind: "event" }),
    ]);

    expect(view.items[1]?.detail).toContain("time limit");
  });

  test("a ledger whose header the rail never read keeps the agent-mode reading", () => {
    // A stream joined after the header — the fold has no mode to go on, and the
    // agent wording is what this component has always shown.
    const view = foldLedgerEntries([stoppedAnswering("agent-investigation.1")]);

    expect(view.items[0]?.detail).toContain("without composing a cited report");
  });

  test("the mode is taken from a run-started event when that is all there is", () => {
    const view = foldLedgerEntries([
      event({ kind: "event", event: { kind: "run-started", atMs: 2, mode: "planning" } } as AgentLedgerEntry & {
        kind: "event";
      }),
      stoppedAnswering("agent-planning.1"),
    ]);

    expect(view.items[1]?.detail ?? "").not.toContain("without composing a cited report");
  });

  /*
    Keying the sentence on the mode made a two-level lookup out of a one-level one,
    and the second index is the one that throws. `parseLedgerLine` validates the
    entry KIND and deliberately nothing else — its own docblock says a newer server
    may write things this bundle has never heard of, and that is not a reason to
    tear down a timeline a user is already reading. A mode is exactly such a thing:
    it arrives off parsed JSON, so `AgentRunMode` describes what this bundle knows,
    not what the line contains.

    The rail must therefore degrade for an unknown mode the way it already degrades
    for an unknown stop reason — no sentence, everything else intact — rather than
    blanking the run.
  */
  test("a mode this bundle has never heard of does not tear down the timeline", () => {
    const line = JSON.stringify({ ...OPENED, mode: "supervised" });
    const parsed = parseLedgerLine(line);
    if (parsed === null) throw new Error("the header itself must still parse: its kind is one this bundle knows");

    const view = foldLedgerEntries([parsed, stoppedAnswering("agent-supervised.1")]);

    // The run is still readable, and the ending still carries its verdict.
    expect(view.items).toHaveLength(2);
    expect(view.items[1]?.headline).toBe("Run answered");
    // No invented sentence: unknown mode degrades exactly like an unknown stop
    // reason, which yields no detail rather than another mode's wording.
    expect(view.items[1]?.detail).toBeUndefined();
  });

  test("an unknown stop reason still degrades to no sentence, in a mode this bundle knows", () => {
    const view = foldLedgerEntries([
      openedIn("agent"),
      event({
        kind: "event",
        event: { kind: "run-finished", atMs: 9, status: "succeeded", stopReason: "abandoned-by-operator" },
      } as unknown as AgentLedgerEntry & { kind: "event" }),
    ]);

    expect(view.items[1]?.detail).toBeUndefined();
  });
});

describe("an answer reads as the app's decision, with the model's caption quoted", () => {
  const ANSWER_SQL = "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region";

  const answer = (presentation: unknown): AgentLedgerEntry =>
    event({
      kind: "event",
      event: {
        kind: "answer-composed",
        atMs: 9,
        sql: ANSWER_SQL,
        artifact: {
          correlationId: "corr-answer",
          runId: "run-1",
          operationId: "sql.query.read",
          summary: { rowCount: 4, columnNames: ["region", "net_total"], elapsedMs: 11 },
        },
        presentation,
        handover: "none",
      },
    } as AgentLedgerEntry & { kind: "event" });

  /** The same answer, with the handover the gate decided. */
  const handedOver = (handover: string, handoverWarning?: string): AgentLedgerEntry =>
    event({
      kind: "event",
      event: {
        kind: "answer-composed",
        atMs: 9,
        sql: ANSWER_SQL,
        artifact: {
          correlationId: "corr-answer",
          runId: "run-1",
          operationId: "sql.query.read",
          summary: { rowCount: 4, columnNames: ["region", "net_total"], elapsedMs: 11 },
        },
        presentation: { kind: "table" },
        handover,
        ...(handoverWarning === undefined ? {} : { handoverWarning }),
      },
    } as AgentLedgerEntry & { kind: "event" });

  test("a chart answer names the type in the app's own words and quotes the caption", () => {
    const view = foldLedgerEntries([
      OPENED,
      answer({
        kind: "chart",
        spec: { type: "bar", x: "region", y: ["net_total"], caption: "Net total by region, largest first." },
      }),
    ]);

    expect(view.items[1]?.headline).toBe("Answer composed");
    expect(view.items[1]?.detail).toContain("bar chart");
    // The caption is the model's own prose and is rendered as quoted content, never
    // spliced into a sentence a user would read as the app speaking.
    expect(view.items[1]?.quoted).toBe("Net total by region, largest first.");
  });

  test("a table answer is stated as an answer, not as a fallback", () => {
    const view = foldLedgerEntries([OPENED, answer({ kind: "table" })]);

    expect(view.items[1]?.headline).toBe("Answer composed");
    expect(view.items[1]?.detail).toContain("table");
    // There is no caption on a table answer, so there is nothing to quote.
    expect(view.items[1]?.quoted).toBeUndefined();
  });

  test("the result is offered by id, and the statement is offered to the editor", () => {
    const view = foldLedgerEntries([OPENED, answer({ kind: "table" })]);

    expect(view.items[1]?.artifactId).toBe("corr-answer");
    expect(view.items[1]?.applySql).toBe(ANSWER_SQL);
  });

  test("the answer entry says it IS the answer, and no other entry does", () => {
    // The rail shows an answer as it arrives (#373 review) and shows no other stored result
    // on its own, so which entry that is has to be a fact the fold states. Inferring
    // it from the fields beside it does not work: a table answer with no hand-over
    // carries what a drafted statement and a stored result carry between them.
    const view = foldLedgerEntries([
      OPENED,
      event({
        kind: "event",
        event: {
          kind: "tool-completed",
          atMs: 8,
          stepId: "s1",
          artifact: {
            correlationId: "corr-read",
            runId: "run-1",
            operationId: "sql.query.read",
            summary: { rowCount: 2, columnNames: ["id"], elapsedMs: 3 },
          },
        },
      } as AgentLedgerEntry & { kind: "event" }),
      answer({ kind: "table" }),
    ]);

    expect(view.items[2]?.isAnswer).toBe(true);
    expect(view.items[1]?.isAnswer).toBeUndefined();
    expect(view.items[0]?.isAnswer).toBeUndefined();
  });

  test("a chart answer carries its spec, so the surface is chosen from the record", () => {
    // The spec travels with the entry rather than being asked of the rows later:
    // this is what makes the app's chart the one the RUN composed, and it is the
    // same rule the explain surface follows.
    const spec = { type: "bar", x: "region", y: ["net_total"], caption: "Net total by region." } as const;
    const view = foldLedgerEntries([OPENED, answer({ kind: "chart", spec })]);

    expect(view.items[1]?.chartSpec).toEqual(spec);
  });

  test("a table answer carries no spec, and neither does any other entry", () => {
    const view = foldLedgerEntries([OPENED, answer({ kind: "table" })]);

    expect(view.items[1]?.chartSpec).toBeUndefined();
    expect(view.items[0]?.chartSpec).toBeUndefined();
  });

  test("the entry says what did NOT happen: nothing was sent anywhere to be run", () => {
    // `handover` records the outcome. The sentence is keyed on it as a total record,
    // so the wording cannot outlive its truth.
    const view = foldLedgerEntries([OPENED, answer({ kind: "table" })]);

    expect(view.items[1]?.detail).toContain("Nothing was sent to the editor");
  });

  test("a handed-over statement is stated as a handover, and what the editor did is the editor's own", () => {
    // §2.3: the editor's re-run produces no ledger event and cannot — it happens in
    // the browser, against a route this runtime does not own. So the entry records
    // that the run HANDED OVER, and says the rest is visible in the editor rather
    // than claiming a result it never saw.
    const view = foldLedgerEntries([OPENED, handedOver("auto-executed")]);

    expect(view.items[1]?.detail).toContain("handed the statement to your editor to run");
    expect(view.items[1]?.detail).toContain("what it did with it is visible there");
  });

  test("a gate that declined says so, in the run's own words, and never silently", () => {
    const view = foldLedgerEntries([
      OPENED,
      handedOver("applied", "Not run for you: the plan reads as a full table read, so this one is yours to run."),
    ]);

    expect(view.items[1]?.detail).toContain("The statement is in your editor and was not run");
    expect(view.items[1]?.detail).toContain("Not run for you: the plan reads as a full table read");
  });

  test("an applied answer with no recorded warning still reads as a refusal, not as a run", () => {
    // A ledger is read long after it is written, and an entry missing a field must
    // not fall through to the sentence describing the outcome that DID run.
    const view = foldLedgerEntries([OPENED, handedOver("applied")]);

    expect(view.items[1]?.detail).toContain("The statement is in your editor and was not run");
    expect(view.items[1]?.detail).not.toContain("handed the statement");
  });

  test("the columns the chart names never reach the app's own sentence", () => {
    // Column names are engine-supplied text. They belong in the quoted field or in
    // the result itself, never in a line the user reads as the app speaking.
    const view = foldLedgerEntries([
      OPENED,
      answer({
        kind: "chart",
        spec: { type: "pie", x: "region", y: ["net_total"], caption: "share by region" },
      }),
    ]);

    expect(view.items[1]?.detail).not.toContain("net_total");
    expect(view.items[1]?.detail).not.toContain("region");
  });
});
