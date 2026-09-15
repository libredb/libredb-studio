import "../../setup-dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentHistory, reportOf } from "@/components/agent/AgentHistory";
import type { AgentRunRecord } from "@/lib/agent/types";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";

/**
 * The run history panel (#830): the finished conversations this session can
 * reopen, and the report of any one step read back on demand.
 */

const conversationPayload = {
  conversations: [
    {
      threadId: "t_1",
      steps: [
        {
          runId: "arun_t_1",
          objective: "Why is checkout slow?",
          workflowType: "investigation",
          mode: "agent",
          status: "succeeded",
          answered: true,
          connectionId: "seed:sales",
          createdAtMs: 1_699_999_000_000,
          updatedAtMs: 1_700_000_000_000,
        },
      ],
    },
  ],
  nextCursor: null,
};

function recordWith(events: unknown[]): AgentRunRecord {
  return {
    runId: "arun_t_1",
    mode: "agent",
    workflowType: "investigation",
    workflowSource: "chosen",
    workflowReading: "unrecorded",
    autoExecute: false,
    status: "succeeded",
    actor: { sessionId: "ada", role: "user" },
    connectionId: "seed:sales",
    objective: "Why is checkout slow?",
    createdAtMs: 1_699_999_000_000,
    updatedAtMs: 1_700_000_000_000,
    thread: { threadId: "arun_t_1", steps: [], text: "" },
    events: events as AgentRunRecord["events"],
  };
}

function reportRecord(): AgentRunRecord {
  return recordWith([
    {
      kind: "report-composed",
      atMs: 1_700_000_000_000,
      claims: [
        {
          claim: "The checkout query scans the whole orders table.",
          evidence: [{ source: "artifact", correlationId: "corr_1" }],
        },
      ],
    },
    {
      kind: "answer-composed",
      atMs: 1_700_000_000_001,
      sql: "SELECT * FROM orders;",
      artifact: {
        correlationId: "corr_2",
        runId: "arun_t_1",
        operationId: "sql.query.read",
        summary: { rowCount: 1, columnNames: ["id"], elapsedMs: 5 },
      },
      presentation: { kind: "table" },
      handover: "none",
    },
    { kind: "closing-statement", atMs: 1_700_000_000_002, text: "Checkout reads too many rows." },
  ]);
}

function json(body: unknown, status = 200): MockFetchResponse {
  return { ok: status < 400, status, json: body };
}

beforeEach(() => {
  // The report route is listed first: `mockGlobalFetch` matches on `pathname.includes`,
  // and `/api/agent/runs` is a prefix of `/api/agent/runs/arun_t_1`, so the list
  // pattern would capture the report request if it came first.
  mockGlobalFetch({
    "/api/agent/runs/arun_t_1": json({ record: reportRecord(), cancellationRequested: false }),
    "/api/agent/runs": json(conversationPayload),
  });
});

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
});

describe("reportOf", () => {
  test("extracts claims, the answer statement and the closing words", () => {
    expect(reportOf(reportRecord())).toEqual({
      claims: ["The checkout query scans the whole orders table."],
      closing: ["Checkout reads too many rows."],
      answerSql: ["SELECT * FROM orders;"],
      planSql: [],
    });
  });

  test("extracts the drafted statement of a plan run", () => {
    const plan = recordWith([
      {
        kind: "plan-statement-drafted",
        atMs: 1,
        sql: "SELECT id FROM orders;",
        dialect: "postgres",
        readOnly: true,
        identifiers: { tables: [], columns: [], unknown: false },
      },
    ]);

    expect(reportOf(plan).planSql).toEqual(["SELECT id FROM orders;"]);
  });
});

describe("AgentHistory", () => {
  test("lists a finished conversation with its objective and status", async () => {
    render(<AgentHistory />);

    expect(await screen.findByText("Why is checkout slow?")).toBeDefined();
    expect(screen.getByText("Succeeded")).toBeDefined();
    expect(screen.getByText("answered")).toBeDefined();
  });

  test("skips a conversation the wire shaped badly rather than trusting it", async () => {
    mockGlobalFetch({
      "/api/agent/runs": json({
        conversations: [{ threadId: 42, steps: "nope" }, conversationPayload.conversations[0]],
        nextCursor: null,
      }),
    });
    render(<AgentHistory />);

    expect(await screen.findByText("Why is checkout slow?")).toBeDefined();
    expect(screen.queryByText("Succeeded")).toBeDefined();
  });

  test("renders the failed and cancelled statuses in their own words", async () => {
    mockGlobalFetch({
      "/api/agent/runs": json({
        conversations: [
          {
            threadId: "t_fail",
            steps: [
              {
                runId: "arun_fail",
                objective: "Why did it fail?",
                workflowType: "investigation",
                mode: "agent",
                status: "failed",
                answered: false,
                connectionId: "seed:sales",
                createdAtMs: 1,
                updatedAtMs: 2,
              },
            ],
          },
          {
            threadId: "t_cancel",
            steps: [
              {
                runId: "arun_cancel",
                objective: "Why did it stop?",
                workflowType: "investigation",
                mode: "agent",
                status: "cancelled",
                answered: null,
                connectionId: "seed:sales",
                createdAtMs: 1,
                updatedAtMs: 2,
              },
            ],
          },
        ],
        nextCursor: null,
      }),
    });
    render(<AgentHistory />);

    expect(await screen.findByText("Failed")).toBeDefined();
    expect(screen.getByText("Cancelled")).toBeDefined();
  });

  test("expands a conversation and reads its report back", async () => {
    render(<AgentHistory />);

    fireEvent.click(await screen.findByText("Why is checkout slow?"));

    expect(await screen.findByText(/scans the whole orders table/)).toBeDefined();
    expect(screen.getByText(/Checkout reads too many rows/)).toBeDefined();
  });

  test("collapsing a conversation puts its report away", async () => {
    render(<AgentHistory />);

    const objective = await screen.findByText("Why is checkout slow?");
    fireEvent.click(objective);
    await screen.findByText(/scans the whole orders table/);

    fireEvent.click(objective);
    await waitFor(() => {
      expect(screen.queryByText(/scans the whole orders table/)).toBeNull();
    });
  });

  test("a report that cannot be reopened says so", async () => {
    mockGlobalFetch({
      "/api/agent/runs/arun_t_1": { ok: false, status: 404, json: { error: "No such agent run" } },
      "/api/agent/runs": json(conversationPayload),
    });
    render(<AgentHistory />);

    fireEvent.click(await screen.findByText("Why is checkout slow?"));
    expect(await screen.findByText("That run could not be reopened.")).toBeDefined();
  });

  test("a successful reopen clears the failure sentence of the report before it", async () => {
    let fail = true;
    mockGlobalFetch({
      "/api/agent/runs/arun_t_1": async () => {
        if (fail) {
          fail = false;
          return { ok: false, status: 404, json: { error: "No such agent run" } };
        }
        return json({ record: reportRecord(), cancellationRequested: false });
      },
      "/api/agent/runs": json(conversationPayload),
    });
    render(<AgentHistory />);

    const item = await screen.findByText("Why is checkout slow?");
    fireEvent.click(item);
    expect(await screen.findByText("That run could not be reopened.")).toBeDefined();

    // Collapse, then reopen the same step: the second read succeeds and must
    // clear the sentence the first one left, not leave it over a healthy report.
    fireEvent.click(item);
    fireEvent.click(item);
    expect(await screen.findByText(/scans the whole orders table/)).toBeDefined();
    expect(screen.queryByText("That run could not be reopened.")).toBeNull();
  });

  test("a report payload without a record says so rather than reading one", async () => {
    mockGlobalFetch({
      "/api/agent/runs/arun_t_1": json({ cancellationRequested: false }),
      "/api/agent/runs": json(conversationPayload),
    });
    render(<AgentHistory />);

    fireEvent.click(await screen.findByText("Why is checkout slow?"));
    expect(await screen.findByText("That run could not be reopened.")).toBeDefined();
  });

  test("a record whose events are not an array says so rather than reading them", async () => {
    mockGlobalFetch({
      "/api/agent/runs/arun_t_1": json({ record: { events: "not-an-array" }, cancellationRequested: false }),
      "/api/agent/runs": json(conversationPayload),
    });
    render(<AgentHistory />);

    fireEvent.click(await screen.findByText("Why is checkout slow?"));
    expect(await screen.findByText("That run could not be reopened.")).toBeDefined();
  });

  test("a report request that throws reports the failure", async () => {
    mockGlobalFetch({
      "/api/agent/runs/arun_t_1": () => {
        throw new Error("network down");
      },
      "/api/agent/runs": json(conversationPayload),
    });
    render(<AgentHistory />);

    fireEvent.click(await screen.findByText("Why is checkout slow?"));
    expect(await screen.findByText("That run could not be reopened.")).toBeDefined();
  });

  test("shows an empty state when there are no finished runs", async () => {
    mockGlobalFetch({ "/api/agent/runs": json({ conversations: [], nextCursor: null }) });
    render(<AgentHistory />);

    expect(await screen.findByText(/No finished runs yet/)).toBeDefined();
  });

  test("shows the server's sentence when the list cannot be read", async () => {
    mockGlobalFetch({
      "/api/agent/runs": { ok: false, status: 404, json: { error: "The agent runtime is not enabled on this server" } },
    });
    render(<AgentHistory />);

    expect(await screen.findByText("The agent runtime is not enabled on this server")).toBeDefined();
  });

  test("a list request that throws reports the fallback sentence", async () => {
    mockGlobalFetch({
      "/api/agent/runs": () => {
        throw new Error("network down");
      },
    });
    render(<AgentHistory />);

    expect(await screen.findByText("The run history could not be read.")).toBeDefined();
  });

  test("offers Load more when the server returns a next cursor, and appends the next page", async () => {
    const secondPage = {
      conversations: [
        {
          threadId: "t_2",
          steps: [
            {
              runId: "arun_t_2",
              objective: "Chart those.",
              workflowType: "data-analysis",
              mode: "agent",
              status: "succeeded",
              answered: true,
              connectionId: "seed:sales",
              createdAtMs: 1,
              updatedAtMs: 1,
            },
          ],
        },
      ],
      nextCursor: null,
    };
    let calls = 0;
    mockGlobalFetch({
      "/api/agent/runs": () => {
        calls += 1;
        return calls === 1 ? json({ ...conversationPayload, nextCursor: "1700000000000.t_1" }) : json(secondPage);
      },
    });
    render(<AgentHistory />);

    fireEvent.click(await screen.findByText("Load more"));
    expect(await screen.findByText("Chart those.")).toBeDefined();
    // Append, not replace: the first page's conversation stays listed under the
    // one the second page added.
    expect(screen.getByText("Why is checkout slow?")).toBeDefined();
  });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const stepFixture = (runId: string, objective: string) => ({
  runId,
  objective,
  workflowType: "investigation",
  mode: "agent",
  status: "succeeded",
  answered: true,
  connectionId: "seed:sales",
  createdAtMs: 1,
  updatedAtMs: 1,
});

function reportRecordWithClaim(claim: string): AgentRunRecord {
  return recordWith([
    {
      kind: "report-composed",
      atMs: 1,
      claims: [{ claim, evidence: [{ source: "artifact", correlationId: "corr_1" }] }],
    },
  ]);
}

describe("AgentHistory hardening", () => {
  test("a slow report cannot overwrite the one asked for after it (P1#15)", async () => {
    mockGlobalFetch({
      "/api/agent/runs/arun_a": async () => {
        await delay(60);
        return json({ record: reportRecordWithClaim("claim A"), cancellationRequested: false });
      },
      "/api/agent/runs/arun_b": async () => {
        await delay(5);
        return json({ record: reportRecordWithClaim("claim B"), cancellationRequested: false });
      },
      "/api/agent/runs": json({
        conversations: [{ threadId: "t_1", steps: [stepFixture("arun_a", "Step A"), stepFixture("arun_b", "Step B")] }],
        nextCursor: null,
      }),
    });
    render(<AgentHistory />);

    // `findBy*` must stay OUTSIDE `act`: its waitFor runs with the act
    // environment deliberately switched off, so nesting it inside `act`
    // deadlocks the flush. Each report's async resolution is awaited inside
    // its own act scope instead, so no state update leaks past the test.
    const item = await screen.findByTestId("agent-history-item-t_1");

    // Expand the conversation: the header opens the latest step's report.
    fireEvent.click(item);
    await act(async () => {
      await delay(30);
    });
    expect(screen.getByText("claim B")).toBeDefined();

    // Now ask for the slow step, then immediately the fast one.
    fireEvent.click(screen.getByTestId("agent-history-step-arun_a"));
    fireEvent.click(screen.getByTestId("agent-history-step-arun_b"));
    await act(async () => {
      await delay(30);
    });
    expect(screen.getByText("claim B")).toBeDefined();

    // Let the stale reply land, if it ever would; it is discarded, so it
    // settles nothing and the fast report stays on screen.
    await act(async () => {
      await delay(100);
    });
    expect(screen.queryByText("claim A")).toBeNull();
  });

  test("double-clicking Load more fetches the next page once (P1#16)", async () => {
    let calls = 0;
    mockGlobalFetch({
      "/api/agent/runs": async () => {
        calls += 1;
        await delay(20);
        return calls === 1
          ? json({ ...conversationPayload, nextCursor: "1700000000000.t_1" })
          : json({ conversations: [], nextCursor: null });
      },
    });
    render(<AgentHistory />);

    const more = await screen.findByText("Load more");
    fireEvent.click(more);
    fireEvent.click(more);

    await act(async () => {
      await delay(80);
    });
    expect(calls).toBe(2);
  });

  test("renders a very long objective without crashing (P1#17)", async () => {
    const long = "x".repeat(2000);
    mockGlobalFetch({
      "/api/agent/runs": json({
        conversations: [{ threadId: "t_long", steps: [stepFixture("arun_long", long)] }],
        nextCursor: null,
      }),
    });
    render(<AgentHistory />);

    expect(await screen.findByText(long)).toBeDefined();
  });

  test("renders Unicode objectives verbatim (P2#25)", async () => {
    const unicode = "Hangi departmanda çalışan var? 👥";
    mockGlobalFetch({
      "/api/agent/runs": json({
        conversations: [{ threadId: "t_uni", steps: [stepFixture("arun_uni", unicode)] }],
        nextCursor: null,
      }),
    });
    render(<AgentHistory />);

    expect(await screen.findByText(unicode)).toBeDefined();
  });

  test("the list item reports its expanded state for assistive tech (P2#23)", async () => {
    render(<AgentHistory />);

    const item = await screen.findByTestId("agent-history-item-t_1");
    expect(item.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(item);
    expect(await screen.findByText(/scans the whole orders table/)).toBeDefined();
    expect(item.getAttribute("aria-expanded")).toBe("true");
  });
});
