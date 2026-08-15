import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor, act } from "@testing-library/react";
import { AgentRail } from "@/components/agent/AgentRail";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import type { AgentRunWorkflowType } from "@/lib/agent/types";

/**
 * The standalone agent rail (#329 T10a): the gated surface, its two modes and the
 * run timeline.
 *
 * What these tests pin beyond rendering:
 *
 *  - **Planning is the mode a run opens in**, and switching is free. The server
 *    decides what a mode may do (T6 selects the tool set from the run's persisted
 *    mode); this surface only decides what it ASKS for, and it asks for the
 *    toolless one unless the user says otherwise.
 *  - **A connection the server cannot resolve is refused here, with a reason.** T9
 *    pinned that a run needs a `seed:` connection because a resumed drive re-resolves
 *    it server-side, so the rail says so instead of posting a request that can only
 *    400.
 *  - **The timeline survives a stream that does not arrive in whole lines**, which is
 *    the normal case for NDJSON over a real connection.
 */

const encoder = new TextEncoder();

function ndjsonResponse(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OPENED_LINE = `${JSON.stringify({
  kind: "run-opened",
  atMs: 1_000,
  runId: "arun_1",
  mode: "planning",
  actor: { sessionId: "ada", role: "user" },
  connectionId: "seed:sales",
  objective: "why is checkout slow",
})}\n`;

/** A header for a run opened FOR a named workflow, which is where the meter reads it. */
const openedFor = (workflowType: AgentRunWorkflowType): string =>
  `${JSON.stringify({
    kind: "run-opened",
    atMs: 1_000,
    runId: "arun_1",
    mode: "agent",
    workflowType,
    actor: { sessionId: "ada", role: "user" },
    connectionId: "seed:sales",
    objective: "why is checkout slow",
  })}\n`;

const STARTED_LINE = `${JSON.stringify({ kind: "event", event: { kind: "run-started", atMs: 1_001, mode: "planning" } })}\n`;

const COMPLETED_LINE = `${JSON.stringify({
  kind: "event",
  event: {
    kind: "tool-completed",
    atMs: 1_002,
    stepId: "s1",
    artifact: {
      correlationId: "corr_9",
      runId: "arun_1",
      operationId: "sql.query.read",
      summary: { rowCount: 3, columnNames: ["id", "total"], elapsedMs: 1_500 },
    },
  },
})}\n`;

/** A drive whose database time already exceeds the per-drive ceiling (`docs/BACKLOG.md` B6). */
const OVERSPENT_LINE = `${JSON.stringify({
  kind: "event",
  event: {
    kind: "tool-completed",
    atMs: 1_002,
    stepId: "s9",
    artifact: {
      correlationId: "corr_over",
      runId: "arun_1",
      operationId: "sql.query.read",
      summary: { rowCount: 1, columnNames: ["id"], elapsedMs: 90_000 },
    },
  },
})}\n`;

const DRAFTED_LINE = `${JSON.stringify({
  kind: "event",
  event: {
    kind: "statement-drafted",
    atMs: 1_002,
    stepId: "s1",
    sql: "SELECT count(*) FROM orders",
    rationale: "count the orders",
  },
})}\n`;

const REPORT_LINE = `${JSON.stringify({
  kind: "event",
  event: {
    kind: "report-composed",
    atMs: 1_003,
    claims: [
      {
        claim: "checkout is slow because orders is scanned",
        evidence: [{ source: "artifact", correlationId: "corr_9", locator: "row 2, total" }],
      },
    ],
  },
})}\n`;

const CANCELLED_LINE = `${JSON.stringify({ kind: "cancellation-requested", atMs: 1_004, bySessionId: "ada" })}\n`;

const FINISHED_LINE = `${JSON.stringify({
  kind: "event",
  event: { kind: "run-finished", atMs: 1_005, status: "succeeded" },
})}\n`;

const DEFAULT_PROPS = {
  connectionId: "seed:sales",
  connectionName: "Sales",
};

/** POST /api/agent/runs accepted, then a stream of whatever lines are given. */
function mockAgentFetch(
  lines: readonly string[],
  startBody: unknown = { runId: "arun_1", status: "queued", mode: "planning" },
) {
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/stream")) return ndjsonResponse(lines);
    return jsonResponse(startBody, 202);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/**
 * `useIsMobile` reads `window.matchMedia`, so the breakpoint is driven here rather
 * than by mocking the hook: `mock.module` is process-wide, and this file shares its
 * process with other component suites that use the real hook.
 */
function installMatchMedia() {
  const listeners = new Set<() => void>();
  let matches = false;
  const mql = {
    get matches() {
      return matches;
    },
    addEventListener: (_type: string, fn: () => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: () => void) => {
      listeners.delete(fn);
    },
  };
  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia;
  return {
    setMatches(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
  };
}

describe("AgentRail", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalMatchMedia: typeof window.matchMedia;
  let media: ReturnType<typeof installMatchMedia>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalMatchMedia = window.matchMedia;
    media = installMatchMedia();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
    cleanup();
  });

  test("opens in planning mode with agent mode one click away", () => {
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    expect(getByTestId("agent-mode-planning").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("agent-mode-agent").getAttribute("aria-pressed")).toBe("false");
  });

  test("switching to agent mode and back is free", () => {
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    expect(getByTestId("agent-mode-agent").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("agent-mode-planning").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(getByTestId("agent-mode-planning"));
    expect(getByTestId("agent-mode-planning").getAttribute("aria-pressed")).toBe("true");
  });

  test("the timeline is empty until a run has happened", () => {
    const { getByTestId, queryAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    expect(queryAllByTestId("agent-timeline-item")).toHaveLength(0);
    expect(getByTestId("agent-timeline-empty")).toBeTruthy();
  });

  test("a run cannot start without an objective", () => {
    const fetchMock = mock(async () => jsonResponse({}, 202));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    expect((getByTestId("agent-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByTestId("agent-start"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("starting a run asks for the selected mode against the resolvable connection, then follows its ledger", async () => {
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const { getByTestId, findAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    const items = await findAllByTestId("agent-timeline-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Run opened in planning mode");
    expect(items[1].textContent).toContain("Run started in planning mode");

    const [startUrl, startInit] = fetchMock.mock.calls[0];
    expect(startUrl).toBe("/api/agent/runs");
    expect(JSON.parse(String(startInit?.body))).toEqual({
      mode: "agent",
      workflowType: "investigation",
      autoExecute: false,
      objective: "why is checkout slow",
      connectionId: "seed:sales",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/agent/runs/arun_1/stream");
  });

  test("the workflow control is offered in BOTH modes, because the axes are independent", () => {
    // Found by review on #344: an agent-only control made the rail unable to open a
    // planning run of a query optimization, which the epic's independent axes exist
    // to allow.
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    expect(getByTestId("agent-workflow-investigation").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("agent-workflow-query-optimization").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(getByTestId("agent-mode-agent"));
    expect(getByTestId("agent-workflow-database-assessment").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(getByTestId("agent-mode-planning"));
    expect(getByTestId("agent-workflow-investigation").getAttribute("aria-pressed")).toBe("true");
  });

  test("the Operate workflow is offered, and starting it asks the server for it", async () => {
    // The rail's button row is generated from the label record, so this is the
    // assertion that the new workflow is actually reachable by a user rather than
    // merely present in a type.
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    const operate = getByTestId("agent-workflow-operations");
    expect(operate.getAttribute("aria-pressed")).toBe("false");
    expect(operate.textContent).toBe("Operate");

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.click(operate);
    expect(getByTestId("agent-workflow-operations").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("agent-workflow-investigation").getAttribute("aria-pressed")).toBe("false");

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "what is blocked right now" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      mode: "agent",
      workflowType: "operations",
      autoExecute: false,
      objective: "what is blocked right now",
      connectionId: "seed:sales",
    });
  });

  test("the Analyze workflow is offered, and starting it asks the server for it", async () => {
    // Same assertion as Operate's, for the same reason: the button row is generated
    // from the label record, so this is what makes the workflow reachable by a user
    // rather than merely present in a type.
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    const analyze = getByTestId("agent-workflow-data-analysis");
    expect(analyze.getAttribute("aria-pressed")).toBe("false");
    expect(analyze.textContent).toBe("Analyze");

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.click(analyze);
    expect(getByTestId("agent-workflow-data-analysis").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("agent-workflow-investigation").getAttribute("aria-pressed")).toBe("false");

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "sales by region today" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      mode: "agent",
      workflowType: "data-analysis",
      autoExecute: false,
      objective: "sales by region today",
      connectionId: "seed:sales",
    });
  });

  test("a workflow chosen in one mode survives the switch to the other", () => {
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-workflow-query-optimization"));
    fireEvent.click(getByTestId("agent-mode-agent"));

    expect(getByTestId("agent-workflow-query-optimization").getAttribute("aria-pressed")).toBe("true");
  });

  test("the chosen workflow is what the start request asks for", async () => {
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.click(getByTestId("agent-workflow-query-optimization"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      mode: "agent",
      workflowType: "query-optimization",
      autoExecute: false,
      objective: "why is checkout slow",
      connectionId: "seed:sales",
    });
  });

  test("a planning run carries its workflow too — a plan FOR an optimization is still about one", async () => {
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-workflow-query-optimization"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      mode: "planning",
      workflowType: "query-optimization",
      autoExecute: false,
      objective: "why is checkout slow",
      connectionId: "seed:sales",
    });
  });

  /**
   * The box is emptied for the next question (#373 review).
   *
   * Measured: after a run completed, `agent-objective` still held the previous
   * question, so asking a second one meant selecting the old text and deleting it.
   *
   * Cleared when the SERVER HAS OPENED the run rather than on the click, which is the
   * half the second test pins: a start that was refused must not eat what the user
   * typed, or retrying means typing it again.
   */
  describe("the objective", () => {
    test("is cleared once the run has opened, and is still readable in the timeline", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, FINISHED_LINE]);
      const { getByTestId, findAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      await waitFor(() => {
        expect((getByTestId("agent-objective") as HTMLTextAreaElement).value).toBe("");
      });
      // Not lost, only moved: the question is on the run's own header, quoted under
      // the first entry, beside the run that is answering it.
      const items = await findAllByTestId("agent-timeline-item");
      expect(items[0].textContent).toContain("why is checkout slow");
    });

    test("survives a start the server refused, so retrying needs no retyping", async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({ error: "connection seed:sales no longer resolves" }, 400),
      ) as unknown as typeof fetch;
      const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      expect((await findByTestId("agent-error")).textContent).toContain("no longer resolves");
      expect((getByTestId("agent-objective") as HTMLTextAreaElement).value).toBe("why is checkout slow");
    });
  });

  test("a connection the server cannot resolve is refused here, with the reason", () => {
    const fetchMock = mock(async () => jsonResponse({}, 202));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId } = render(<AgentRail connectionId={null} connectionName="Local scratch" />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });

    expect((getByTestId("agent-start") as HTMLButtonElement).disabled).toBe(true);
    const caveat = getByTestId("agent-unresolvable-connection").textContent ?? "";
    expect(caveat).toContain("Local scratch");
    // The reason has to hold for an EDITED copy of a seed too, not only for a
    // connection the server has never heard of: the seed exists on the server, it is
    // the local settings that do not. So the caveat may not
    // claim the agent reaches managed connections only — it does not.
    expect(caveat).toContain("this browser");
    expect(caveat).not.toContain("managed connections only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a refused start reports what the server said and follows nothing", async () => {
    const fetchMock = mock(async () => jsonResponse({ error: "The agent runtime is not enabled on this server" }, 404));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-error")).textContent).toContain(
      "The agent runtime is not enabled on this server",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a start that never reaches the server reports that, not a run", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-error")).textContent).toContain("network down");
  });

  test("a refusal with no message of its own still says something true", async () => {
    globalThis.fetch = mock(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-error")).textContent).toContain("500");
    expect(queryByTestId("agent-model-refusal")).toBeNull();
  });

  /**
   * The refused model (#331 T4).
   *
   * A `422` is the one start failure that is a verdict about the MODEL: the capability
   * gate refuses only what the probe positively established, so everything that merely
   * went wrong — a bad key, a quota, a 5xx — starts a run and is reported by the drive
   * instead. The body below is the one a real refusal produced on 2026-08-13, from an
   * Ollama endpoint serving `gemma3:270m`.
   *
   * #325 ratified that a model failing the probe falls back to chat/NL2SQL. T2 and T3
   * deleted both surfaces — but the toolless surface that SURVIVED is in this rail:
   * `admitAgentModel` returns `allowed` for planning mode without probing at all, so
   * the mode one click away works with exactly the model that was just refused. The
   * rail therefore may not claim there is nothing toolless left; what it owes the user
   * is which capability is missing, that an AGENT run is what this model cannot drive,
   * that plan mode still works, and that another model is what reads the database.
   */
  test("a model established as unable to drive a run is refused, and the shortfall is named", async () => {
    const fetchMock = mock(async () =>
      jsonResponse(
        {
          error:
            'The model "gemma3:270m" (ollama) cannot drive an agent run: the capability probe could not establish tool calling, schema-valid tool arguments, streaming. The endpoint refused the tool request with HTTP 400: registry.ollama.ai/library/gemma3:270m does not support tools. Configure a different model and start the run again.',
          missing: ["toolCalling", "structuredOutput", "streaming"],
        },
        422,
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-model-refusal")).textContent).toContain("cannot drive an agent run");

    const missing = getByTestId("agent-model-refusal-missing").textContent ?? "";
    expect(missing).toContain("tool calling");
    expect(missing).toContain("schema-valid tool arguments");
    expect(missing).toContain("streaming");
    // Our field names are not the user's vocabulary, and the probe's own message rule
    // says so; a rail rendering `missing` raw would reintroduce exactly that leak.
    expect(missing).not.toContain("toolCalling");
    expect(missing).not.toContain("structuredOutput");

    // The endpoint's own words survive the trip: they name the true cause, and nothing
    // this browser composes could have known them.
    expect(getByTestId("agent-model-refusal-report").textContent).toContain("does not support tools");
    expect(getByTestId("agent-model-refusal-action").textContent).toContain("model");

    // Not the generic red line, and nothing was followed.
    expect(queryByTestId("agent-error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The false statement this state used to make. It read "There is nothing toolless to
   * fall back to", which the capability gate contradicts on its second line: planning
   * mode is never probed and never refused, so the same model drives a plan today.
   *
   * The offer is an invitation rather than a promise, and that is not hedging: the
   * probe always sends tools, so a refusal that establishes nothing about a TOOLLESS
   * request cannot establish that one would work either. What it can do is not
   * contradict it — see the two tests below for the case where it does.
   */
  test("the refusal offers plan mode where nothing the probe saw rules it out", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: "no", missing: ["toolCalling"], disproved: ["toolCalling"] }, 422),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(await findByTestId("agent-model-refusal-use-planning")).toBeTruthy();
    const action = getByTestId("agent-model-refusal-action").textContent ?? "";
    expect(action).toContain("Plan mode");
    expect(action).toContain("no tools");
    // Offered, not guaranteed: the probe never sent a toolless request.
    expect(action).toMatch(/\btry\b|\bmay\b/i);
    // The claim that was false. It cannot come back in any of its wordings.
    expect(action).not.toContain("nothing toolless");
    expect(action).not.toContain("nothing to fall back to");
    // And a different model is still what buys a run that reads the database.
    expect(action).toContain("different model");
  });

  /**
   * The distinction this state turns on (#331 T4 review).
   *
   * `missing` names what the probe could not ESTABLISH, and "streaming" lands there for
   * two opposite reasons. Here the endpoint refused the tool request outright — the
   * live `gemma3:270m` case of 2026-08-13 — so no stream ever existed to observe, and
   * the same model then drove a planning run to `succeeded`. Nothing was disproved, so
   * the offer stands even though `missing` names streaming.
   */
  test("streaming merely unobserved does not withdraw the offer", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: "no", missing: ["toolCalling", "structuredOutput", "streaming"], disproved: [] }, 422),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-model-refusal-missing")).textContent).toContain("streaming");
    expect(getByTestId("agent-model-refusal-use-planning")).toBeTruthy();
  });

  /**
   * The other reason, and the one that made the old copy a false promise. An endpoint
   * that answered the probe with one buffered body was WATCHED failing to stream, and
   * plan mode consumes the same `streamText().fullStream` an agent run does
   * (`investigation.ts`). Driven through the real run loop on 2026-08-13: a planning
   * run over such an endpoint ends `succeeded` with empty text and writes no closing
   * statement — the user gets a run that claims to have worked and says nothing.
   *
   * So the rail does not offer it. Pinned on the DISPROOF rather than on `missing`,
   * which is identical in this case and in the one above.
   */
  test("an endpoint watched failing to stream is not offered a mode that reads the same stream", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(
        { error: "no", missing: ["toolCalling", "structuredOutput", "streaming"], disproved: ["streaming"] },
        422,
      ),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(await findByTestId("agent-model-refusal")).toBeTruthy();
    expect(queryByTestId("agent-model-refusal-use-planning")).toBeNull();

    const action = getByTestId("agent-model-refusal-action").textContent ?? "";
    // The promise that cannot be kept here, in any of its wordings.
    expect(action).not.toContain("still work");
    expect(action).not.toContain("Try");
    // What is true instead: the endpoint did not stream, and that is what plan mode
    // would read too.
    expect(action).toContain("streaming");
    expect(action).toContain("different model");
  });

  /**
   * Small print is print (#100). `text-zinc-500` on this rail's `#0a0a0a`, under the
   * alert's own `bg-red-500/5`, computes to 3.98:1 against WCAG AA's 4.5:1 — measured
   * from the installed Tailwind 4 palette, not estimated — and this text is 10px, so
   * the large-text allowance does not apply. `text-zinc-400` is 7.33:1.
   */
  test("the refusal's small print is not written in a colour that fails AA", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: "no", missing: ["toolCalling"], disproved: ["toolCalling"] }, 422),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    const missing = await findByTestId("agent-model-refusal-missing");
    expect(missing.querySelector("span")?.className).not.toContain("text-zinc-500");
    expect(getByTestId("agent-model-refusal-action").className).not.toContain("text-zinc-500");
  });

  /**
   * Offering is honest, deciding is not — and a shortcut that spent model budget is the
   * thing #331 T1 already refused to build. So the control SELECTS the mode and does
   * nothing else: no second request leaves the browser.
   */
  test("the refusal's control selects plan mode and starts nothing", async () => {
    const fetchMock = mock(async () =>
      jsonResponse({ error: "no", missing: ["toolCalling"] }, 422),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    await act(async () => {
      fireEvent.click(await findByTestId("agent-model-refusal-use-planning"));
    });

    expect(getByTestId("agent-mode-planning").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("agent-mode-agent").getAttribute("aria-pressed")).toBe("false");
    // The refused start, and nothing after it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryByTestId("agent-run-id")?.textContent).toBe("");
    // The objective is the user's and the offer did not touch it.
    expect((getByTestId("agent-objective") as HTMLTextAreaElement).value).toBe("why is checkout slow");
  });

  /**
   * A verdict is about the mode it was raised for. Once the copy points at plan mode,
   * a refusal still standing above the mode the user just took would name a way
   * forward and then deny the user took it.
   */
  test("a refusal raised for an agent run does not stand over plan mode", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: "no", missing: ["toolCalling"] }, 422),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });
    expect(await findByTestId("agent-model-refusal")).toBeTruthy();

    fireEvent.click(getByTestId("agent-mode-planning"));
    expect(queryByTestId("agent-model-refusal")).toBeNull();

    // Still true of the mode it was about, and nothing was re-asked to learn that.
    fireEvent.click(getByTestId("agent-mode-agent"));
    expect(getByTestId("agent-model-refusal")).toBeTruthy();
  });

  /**
   * The gate admits planning without probing, so only a server that probes it could
   * refuse one. Should that ever arrive, the state still explains itself — but it does
   * not offer the mode the user is already in, because an offer that changes nothing
   * is an offer saying nothing.
   */
  test("a verdict raised for plan mode explains itself and offers no switch to plan mode", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: "no", missing: ["streaming"] }, 422),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-model-refusal-missing")).textContent).toContain("streaming");
    expect(queryByTestId("agent-model-refusal-use-planning")).toBeNull();
  });

  test("a verdict whose body carries nothing else is still a verdict rather than a generic failure", async () => {
    globalThis.fetch = mock(async () => jsonResponse({}, 422)) as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-model-refusal")).textContent).toContain("422");
    // Nothing is claimed about which capability is absent, because nothing was said.
    expect(queryByTestId("agent-model-refusal-missing")).toBeNull();
    expect(queryByTestId("agent-error")).toBeNull();
  });

  // A newer server may probe a capability this build has never heard of. Rendering the
  // identifier raw is the one thing the labels exist to prevent, so it is dropped.
  test("a capability this build has no words for is not read back at the user", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: "no", missing: ["toolCalling", "telepathy"] }, 422),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    const missing = (await findByTestId("agent-model-refusal-missing")).textContent ?? "";
    expect(missing).toContain("tool calling");
    expect(missing).not.toContain("telepathy");
  });

  // An operator fixes the configuration and starts again: the verdict was about the
  // model that was configured then, so it cannot outlive the next attempt.
  test("a refusal does not survive the next start", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: "no", missing: ["toolCalling"] }, 422),
    ) as unknown as typeof fetch;
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });
    expect(await findByTestId("agent-model-refusal")).toBeTruthy();

    mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-run-id")).textContent).toBe("arun_1");
    expect(queryByTestId("agent-model-refusal")).toBeNull();
  });

  // An accepted start whose body names no run leaves nothing to follow: the stream
  // URL would be built from `undefined`, and the rail would report a run it cannot
  // read as if it were running.
  test("an accepted start that names no run is not followed", async () => {
    const fetchMock = mockAgentFetch([OPENED_LINE], { status: "queued", mode: "planning" });
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-error")).textContent).toContain("without naming it");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // NDJSON over a real connection does not arrive in whole lines. A reader that
  // assumed it did would drop the entry split across the boundary.
  test("an entry split across two chunks still renders once", async () => {
    const half = Math.floor(OPENED_LINE.length / 2);
    mockAgentFetch([OPENED_LINE.slice(0, half), OPENED_LINE.slice(half), STARTED_LINE.trimEnd()]);
    const { getByTestId, findAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    const items = await findAllByTestId("agent-timeline-item");
    expect(items).toHaveLength(2);
  });

  test("a line this build cannot read is skipped, and the rest of the timeline survives", async () => {
    mockAgentFetch(['{"kind":"something-newer"}\n', OPENED_LINE, "\n"]);
    const { getByTestId, findAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    const items = await findAllByTestId("agent-timeline-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("Run opened");
  });

  test("a stream that is refused reports it without losing the run", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/stream")) return jsonResponse({ error: "No such agent run" }, 404);
      return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-error")).textContent).toContain("No such agent run");
    expect(getByTestId("agent-run-id").textContent).toContain("arun_1");
  });

  test("a stream carrying no body at all leaves the run visible and reports nothing false", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/stream")) return new Response(null, { status: 200 });
      return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-run-id")).textContent).toContain("arun_1");
  });

  test("a stream that dies mid-flight reports the failure and keeps what it had", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/stream")) {
        // Pull-based, so the first read delivers the entry and the SECOND one fails.
        // A stream that errors in start() discards what it enqueued, which would
        // prove the opposite of what this test is about.
        let delivered = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (!delivered) {
                delivered = true;
                controller.enqueue(encoder.encode(OPENED_LINE));
                return;
              }
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        );
      }
      return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId, findByTestId, findAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-error")).textContent).toContain("connection reset");
    expect(await findAllByTestId("agent-timeline-item")).toHaveLength(1);
  });

  test("the rail stops following when it goes away", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/stream")) {
        capturedSignal = init?.signal ?? undefined;
        // Never closes: the only thing that ends this stream is the abort.
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId, unmount } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });
    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  test("a second run cannot be started while one is being followed", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200 });
      return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    await waitFor(() => {
      expect((getByTestId("agent-start") as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.click(getByTestId("agent-start"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The case a user actually hits: an operator enables the runtime and starts a run
   * before configuring a model. The drive dies before the loop, and what the rail
   * used to show was a run sitting at `queued` forever with the reason visible only
   * in the server log (`docs/BACKLOG.md` B9 means nothing comes back to it either).
   */
  test("a run that failed before it started says why, in the app's own words", async () => {
    const failedLine = `${JSON.stringify({
      kind: "event",
      event: { kind: "run-finished", atMs: 1_002, status: "failed", reason: "model-unavailable" },
    })}\n`;
    mockAgentFetch([OPENED_LINE, failedLine]);
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-run-status")).textContent).toBe("failed");
    expect((await findByTestId("agent-failure-reason")).textContent).toBe(
      "The model provider is not configured or could not be reached.",
    );
  });

  /**
   * The failure this state must NOT swallow (#331 T4). A quota is not a verdict about
   * what the model can do: the run opened, the drive classified it, and the ledger says
   * so in the words `describeFailureReason` owns. Reporting it as an incapable model
   * would send an operator to change a model that is fine.
   */
  test("a drive that ran out of quota keeps the quota's own words, not the incapable-model state", async () => {
    const failedLine = `${JSON.stringify({
      kind: "event",
      event: { kind: "run-finished", atMs: 1_002, status: "failed", reason: "model-rate-limited" },
    })}\n`;
    mockAgentFetch([OPENED_LINE, failedLine]);
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-failure-reason")).textContent).toBe(
      "The model provider is limiting this key's requests. Waiting a minute usually clears it.",
    );
    expect(queryByTestId("agent-model-refusal")).toBeNull();
  });

  test("an ending the server gave no reason for claims none", async () => {
    const failedLine = `${JSON.stringify({
      kind: "event",
      event: { kind: "run-finished", atMs: 1_002, status: "failed" },
    })}\n`;
    mockAgentFetch([OPENED_LINE, failedLine]);
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-run-status")).textContent).toBe("failed");
    expect(queryByTestId("agent-failure-reason")).toBeNull();
  });

  test("a run reports the status its ledger folds to", async () => {
    mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    expect(getByTestId("agent-run-id").textContent).toBe("");
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-run-status")).textContent).toBe("running");
  });

  // Below md the rail's own panel is display:none, so the sheet is how it is
  // reached. The breakpoint is READ rather than expressed as a class, because Radix
  // renders the sheet's overlay beside its content and that overlay takes no
  // responsive class of ours.
  test("below md the rail opens as a sheet, and above md it is the panel", async () => {
    const onSheetOpenChange = mock(() => {});
    const desktop = render(<AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} />);

    // Above md the sheet is not merely hidden, it is not rendered — so neither is
    // the overlay that would otherwise cover the app.
    expect(desktop.queryByTestId("agent-rail-sheet")).toBeNull();
    expect(desktop.getByTestId("agent-rail-panel").className).toContain("md:flex");
    // And the caller's flag is left alone: `useIsMobile` reports false on its first
    // render before resolving in an effect, so a reconciliation that fired on "not
    // mobile" rather than on a CROSSING would close the sheet on a mobile mount.
    expect(onSheetOpenChange).not.toHaveBeenCalled();

    cleanup();
    media.setMatches(true);
    const mobile = render(<AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} />);

    const sheet = await mobile.findByTestId("agent-rail-sheet");
    // One instance, one content: the sheet HOSTS the rail rather than duplicating
    // it, so the objective being typed and the run being followed survive the move.
    expect(sheet.querySelector('[data-testid="agent-objective"]')).toBeTruthy();
    expect(mobile.queryByTestId("agent-rail-panel")).toBeNull();
  });

  /**
   * The window widening past `md` while the sheet is open is the case a CSS-only
   * split gets wrong: `SheetContent` can be told `md:hidden`, but Radix's overlay
   * cannot, and it also sets `pointer-events: none` on the body. The rail would be
   * gone and the app would be behind a scrim.
   */
  test("crossing to a desktop width takes the sheet down and tells the caller", async () => {
    const onSheetOpenChange = mock(() => {});
    media.setMatches(true);
    const { findByTestId, queryByTestId, rerender } = render(
      <AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} />,
    );
    await findByTestId("agent-rail-sheet");

    await act(async () => {
      media.setMatches(false);
    });

    expect(onSheetOpenChange).toHaveBeenCalledWith(false);
    expect(queryByTestId("agent-rail-sheet")).toBeNull();
    rerender(<AgentRail {...DEFAULT_PROPS} sheetOpen={false} onSheetOpenChange={onSheetOpenChange} />);
    expect(queryByTestId("agent-rail-panel")).toBeTruthy();
  });

  /**
   * The prefill seam (#331 T1) — the contract every shortcut T2, T3 and T4 wire goes
   * through, which is why it is pinned here rather than at each caller.
   *
   * What these tests hold to, in the order the seam's decisions were made:
   *
   *  - **An ask carries a workflow and an objective, and nothing about the MODE.** The
   *    epic's three axes are independent: a shortcut says what a run is FOR, and how it
   *    executes stays whatever the user chose.
   *  - **An ask starts nothing.** Every test here asserts the network was never
   *    touched. One click that spent model tokens and read a database would be a
   *    different feature from one that filled in a question.
   *  - **An objective the user typed is never discarded.** Not overwritten, and not
   *    dropped either — the ask waits on a line they can accept, because a shortcut
   *    that appeared to do nothing would read as broken.
   *  - **Both presentations, one instance.** The panel above `md` and the sheet below
   *    it are branches of the same component, so an ask has to land in whichever one is
   *    rendering; a seam wired into a single branch is the failure this task exists to
   *    prevent. Including the branch `useIsMobile` has not resolved into yet: the T1
   *    adversarial review found that an ask present in the first committed render on a
   *    narrow viewport reached the invisible one, and the recheck then found the
   *    workaround for that leaving a debt a later narrowing paid on a desktop. The
   *    three tests at the end of this block hold the reading that removed both.
   */
  describe("prefill", () => {
    const ASK = { id: 1, workflowType: "query-optimization", objective: "why is checkout slow" } as const;
    const SECOND_ASK = { id: 2, workflowType: "database-assessment", objective: "what is worth fixing here" } as const;

    /** A prefill fills the rail; it never runs it, so nothing here may reach the network. */
    function refuseEveryRequest() {
      const fetchMock = mock(async () => jsonResponse({}, 202));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    const objectiveValue = (element: Element | null): string => (element as HTMLTextAreaElement).value;

    test("an ask selects the workflow, fills the objective and starts nothing", () => {
      const fetchMock = refuseEveryRequest();
      const { getByTestId, rerender } = render(<AgentRail {...DEFAULT_PROPS} />);

      fireEvent.click(getByTestId("agent-mode-agent"));
      rerender(<AgentRail {...DEFAULT_PROPS} prefill={ASK} />);

      expect(getByTestId("agent-workflow-query-optimization").getAttribute("aria-pressed")).toBe("true");
      expect(getByTestId("agent-workflow-investigation").getAttribute("aria-pressed")).toBe("false");
      expect(objectiveValue(getByTestId("agent-objective"))).toBe(ASK.objective);
      // The mode is the user's, and an ask carries none: merging that axis into the
      // shortcut is what the epic's three independent axes exist to prevent.
      expect(getByTestId("agent-mode-agent").getAttribute("aria-pressed")).toBe("true");
      expect(getByTestId("agent-rail-panel")).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("a second ask replaces an objective the user has not touched", () => {
      const fetchMock = refuseEveryRequest();
      const { getByTestId, queryByTestId, rerender } = render(<AgentRail {...DEFAULT_PROPS} prefill={ASK} />);

      rerender(<AgentRail {...DEFAULT_PROPS} prefill={SECOND_ASK} />);

      expect(objectiveValue(getByTestId("agent-objective"))).toBe(SECOND_ASK.objective);
      expect(getByTestId("agent-workflow-database-assessment").getAttribute("aria-pressed")).toBe("true");
      // Nothing of the user's was in the box, so there is nothing to offer.
      expect(queryByTestId("agent-prefill-offer")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("the same ask twice takes effect twice", () => {
      const fetchMock = refuseEveryRequest();
      const { getByTestId, rerender } = render(<AgentRail {...DEFAULT_PROPS} prefill={ASK} />);

      // The user emptied the box and clicked the same shortcut again. The second ask
      // is identical in every field but its id, which is the whole reason it carries
      // one: a request compared by value would make that click do nothing.
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "" } });
      expect(objectiveValue(getByTestId("agent-objective"))).toBe("");

      rerender(<AgentRail {...DEFAULT_PROPS} prefill={{ ...ASK, id: 2 }} />);

      expect(objectiveValue(getByTestId("agent-objective"))).toBe(ASK.objective);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("a box holding only whitespace is not something the user typed", () => {
      const fetchMock = refuseEveryRequest();
      const { getByTestId, queryByTestId, rerender } = render(<AgentRail {...DEFAULT_PROPS} />);

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "   \n " } });
      rerender(<AgentRail {...DEFAULT_PROPS} prefill={ASK} />);

      expect(objectiveValue(getByTestId("agent-objective"))).toBe(ASK.objective);
      expect(queryByTestId("agent-prefill-offer")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("an objective the user typed survives an ask, which waits on a line they can accept", () => {
      const fetchMock = refuseEveryRequest();
      const { getByTestId, queryByTestId, rerender } = render(<AgentRail {...DEFAULT_PROPS} />);

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "which index is missing on orders" } });
      rerender(<AgentRail {...DEFAULT_PROPS} prefill={ASK} />);

      expect(objectiveValue(getByTestId("agent-objective"))).toBe("which index is missing on orders");
      // The workflow is applied either way — it is a visible control holding nothing
      // the user wrote, and one they can change back in a click.
      expect(getByTestId("agent-workflow-query-optimization").getAttribute("aria-pressed")).toBe("true");
      // And the ask is not dropped on the floor, which is what would make the
      // shortcut look broken.
      expect(getByTestId("agent-prefill-offer").textContent).toContain(ASK.objective);

      fireEvent.click(getByTestId("agent-prefill-offer-apply"));

      expect(objectiveValue(getByTestId("agent-objective"))).toBe(ASK.objective);
      expect(queryByTestId("agent-prefill-offer")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("an objective replaced on the user's say-so is no longer theirs to protect", () => {
      const fetchMock = refuseEveryRequest();
      const { getByTestId, queryByTestId, rerender } = render(<AgentRail {...DEFAULT_PROPS} />);

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "which index is missing on orders" } });
      rerender(<AgentRail {...DEFAULT_PROPS} prefill={ASK} />);
      fireEvent.click(getByTestId("agent-prefill-offer-apply"));

      rerender(<AgentRail {...DEFAULT_PROPS} prefill={SECOND_ASK} />);

      // The box now holds exactly what the last ask put there, so the next one takes
      // it without asking again.
      expect(objectiveValue(getByTestId("agent-objective"))).toBe(SECOND_ASK.objective);
      expect(queryByTestId("agent-prefill-offer")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * An offer outlives the box it was made about unless the applied branch retracts
     * it, and the T1 adversarial review found nothing holding that: the retraction was
     * covered only incidentally, so deleting it left every test green.
     *
     * The state it exists for is the one where the user answers the offer their own
     * way — they clear the box instead of taking the suggestion. The next ask then has
     * nothing of theirs to protect and lands in the box itself, and an offer still
     * standing would read "Suggested: A" under an objective that already says B.
     */
    test("an ask taken into an emptied box retracts the offer the last one left", () => {
      const fetchMock = refuseEveryRequest();
      const { getByTestId, queryByTestId, rerender } = render(<AgentRail {...DEFAULT_PROPS} />);

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "which index is missing on orders" } });
      rerender(<AgentRail {...DEFAULT_PROPS} prefill={ASK} />);
      expect(getByTestId("agent-prefill-offer").textContent).toContain(ASK.objective);

      // Their own answer to the offer: the box is emptied rather than replaced.
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "" } });
      rerender(<AgentRail {...DEFAULT_PROPS} prefill={SECOND_ASK} />);

      expect(objectiveValue(getByTestId("agent-objective"))).toBe(SECOND_ASK.objective);
      expect(queryByTestId("agent-prefill-offer")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("below md an ask opens the sheet and fills the rail inside it", async () => {
      const fetchMock = refuseEveryRequest();
      const onSheetOpenChange = mock(() => {});
      const view = render(<AgentRail {...DEFAULT_PROPS} onSheetOpenChange={onSheetOpenChange} />);

      // The breakpoint is crossed explicitly: `useIsMobile` reports false on its first
      // render and resolves in an effect, so an ask applied in the mount commit could
      // not yet know the panel it filled is display:none.
      await act(async () => {
        media.setMatches(true);
      });
      view.rerender(<AgentRail {...DEFAULT_PROPS} onSheetOpenChange={onSheetOpenChange} prefill={ASK} />);

      // The rail ASKS to be opened. The flag stays the shell's, the same way it does
      // when the mobile nav opens the rail with nothing prefilled.
      expect(onSheetOpenChange).toHaveBeenCalledWith(true);
      view.rerender(<AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} prefill={ASK} />);

      const sheet = await view.findByTestId("agent-rail-sheet");
      expect(view.queryByTestId("agent-rail-panel")).toBeNull();
      expect(
        sheet.querySelector('[data-testid="agent-workflow-query-optimization"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(objectiveValue(sheet.querySelector('[data-testid="agent-objective"]'))).toBe(ASK.objective);

      // And an ask made while the SHEET is the presentation lands in the same state:
      // one instance serves both, so a seam wired into one branch would lose this.
      view.rerender(
        <AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} prefill={SECOND_ASK} />,
      );

      const filled = view.getByTestId("agent-rail-sheet");
      expect(
        filled.querySelector('[data-testid="agent-workflow-database-assessment"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(objectiveValue(filled.querySelector('[data-testid="agent-objective"]'))).toBe(SECOND_ASK.objective);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * The ask that is present in the rail's FIRST committed render, on a viewport that
     * was already narrow — which the T1 adversarial review named as a real defect this
     * suite had no test for.
     *
     * `useIsMobile` seeds false and resolves in an effect, so that first commit reads
     * as desktop no matter how narrow the window is. An ask that decided from the
     * hook's value would ask nobody to open the sheet: it would land in the panel
     * branch, which is `hidden md:flex`, and the user would see a shortcut that
     * visibly did nothing. The rail asks the viewport itself instead, in an effect
     * that runs after commit, where the platform's answer is exact.
     *
     * Today's wiring never produces that render — the shell starts at null and mounts
     * the rail behind the capability probe — but T2 and T3 wire entry points that are
     * not gated on it, so this is the case the seam has to survive rather than a
     * hypothetical.
     */
    test("an ask already present in the first render on a narrow viewport still opens the sheet", async () => {
      const fetchMock = refuseEveryRequest();
      const onSheetOpenChange = mock(() => {});
      // Narrow BEFORE the mount: the media query already matches, and it is
      // `useIsMobile`'s own effect — not a resize — that makes the rail read it.
      media.setMatches(true);

      const view = render(<AgentRail {...DEFAULT_PROPS} onSheetOpenChange={onSheetOpenChange} prefill={ASK} />);
      await act(async () => {});

      expect(onSheetOpenChange).toHaveBeenCalledWith(true);

      view.rerender(<AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} prefill={ASK} />);

      const sheet = await view.findByTestId("agent-rail-sheet");
      expect(view.queryByTestId("agent-rail-panel")).toBeNull();
      expect(objectiveValue(sheet.querySelector('[data-testid="agent-objective"]'))).toBe(ASK.objective);
      expect(
        sheet.querySelector('[data-testid="agent-workflow-query-optimization"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * The other half of the same rule: an ask is served once, at the moment it is
     * applied, and a viewport that changes afterwards is not a second serving. Without
     * that, an ask would re-open the sheet on every later crossing back to a narrow
     * viewport — reopening a sheet the user closed, which the reconciliation effect's
     * crossing behaviour must not turn into.
     */
    test("a crossing back to a narrow viewport does not re-open the sheet an ask already opened", async () => {
      const fetchMock = refuseEveryRequest();
      const onSheetOpenChange = mock((_open: boolean) => {});
      media.setMatches(true);

      const view = render(<AgentRail {...DEFAULT_PROPS} onSheetOpenChange={onSheetOpenChange} prefill={ASK} />);
      await act(async () => {});
      view.rerender(<AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} prefill={ASK} />);
      await view.findByTestId("agent-rail-sheet");

      await act(async () => {
        media.setMatches(false);
      });
      view.rerender(
        <AgentRail {...DEFAULT_PROPS} sheetOpen={false} onSheetOpenChange={onSheetOpenChange} prefill={ASK} />,
      );
      await act(async () => {
        media.setMatches(true);
      });

      const opens = onSheetOpenChange.mock.calls.filter(([open]) => open === true);
      expect(opens.length).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * The residual the T1 adversarial recheck named (R1/R2): an ask served on a
     * GENUINE desktop must leave nothing behind for a later narrowing to act on.
     *
     * The rail used to record an owed open and pay it when `useIsMobile` next
     * reported true. On a desktop that flag never changed, so the debt was never
     * cleared — and the first narrowing of the window paid it, popping the sheet open
     * for an ask the user had already been served in the panel minutes earlier. The
     * viewport is read synchronously at the moment the ask is applied instead, so
     * there is nothing owed and nothing to pay.
     */
    test("an ask served in the panel is not re-served as a sheet when the window later narrows", async () => {
      const fetchMock = refuseEveryRequest();
      const onSheetOpenChange = mock((_open: boolean) => {});
      // A genuine desktop: the media query does not match at the mount, and the ask
      // is applied against a viewport that really is wide.
      const view = render(<AgentRail {...DEFAULT_PROPS} onSheetOpenChange={onSheetOpenChange} prefill={ASK} />);
      await act(async () => {});

      expect(view.getByTestId("agent-rail-panel")).toBeTruthy();
      expect(objectiveValue(view.getByTestId("agent-objective"))).toBe(ASK.objective);
      expect(onSheetOpenChange).not.toHaveBeenCalled();

      // Later — a rotation, a split screen, a dragged window edge. The ask was served
      // in the panel and is over; narrowing must not reopen it as a sheet.
      await act(async () => {
        media.setMatches(true);
      });

      expect(onSheetOpenChange.mock.calls.filter(([open]) => open === true).length).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  /**
   * The stop control (#329 T10b).
   *
   * Stopping is an ASK, not an outcome — the run's own loop ends it at its next
   * checkpoint (T7a) — so what these pin is that the ask reaches the service and
   * that the rail then reports what the ledger says, never what the click hoped.
   */
  describe("controls", () => {
    async function startRun(lines: readonly string[], props = DEFAULT_PROPS) {
      const fetchMock = mockAgentFetch(lines);
      const view = render(<AgentRail {...props} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return { ...view, fetchMock };
    }

    test("there is nothing to stop before a run exists", () => {
      const { queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      expect(queryByTestId("agent-stop")).toBeNull();
    });

    test("a live run can be asked to stop, and the ask reaches the service", async () => {
      const { findByTestId, fetchMock } = await startRun([OPENED_LINE, STARTED_LINE]);

      await act(async () => {
        fireEvent.click(await findByTestId("agent-stop"));
      });

      const [url, init] = fetchMock.mock.calls[2];
      expect(url).toBe("/api/agent/runs/arun_1");
      expect(init?.method).toBe("DELETE");
    });

    /**
     * An ask the server accepted is not asked again, even before its ledger entry
     * has arrived — and nothing here reports the run as stopped. That is the
     * contract: the run's own loop ends it at its next checkpoint, so what the rail
     * shows next comes from the ledger.
     */
    test("an accepted stop is not repeated while its ledger entry is still on the way", async () => {
      const { findByTestId, queryByTestId, fetchMock } = await startRun([OPENED_LINE, STARTED_LINE]);

      await act(async () => {
        fireEvent.click(await findByTestId("agent-stop"));
      });

      expect(queryByTestId("agent-stop")).toBeNull();
      expect(queryByTestId("agent-error")).toBeNull();
      // The status still says what the ledger says, not what the ask hoped for.
      expect((await findByTestId("agent-run-status")).textContent).toBe("running");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test("a run whose stop the ledger already records is not asked twice", async () => {
      const { queryByTestId, findAllByTestId } = await startRun([OPENED_LINE, STARTED_LINE, CANCELLED_LINE]);

      await findAllByTestId("agent-timeline-item");
      expect(queryByTestId("agent-stop")).toBeNull();
    });

    test("a run that has ended cannot be stopped", async () => {
      const { queryByTestId, findAllByTestId } = await startRun([OPENED_LINE, STARTED_LINE, FINISHED_LINE]);

      await findAllByTestId("agent-timeline-item");
      expect(queryByTestId("agent-stop")).toBeNull();
    });

    test("a stop the server refuses is reported, and the ask can be made again", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const streamed = globalThis.fetch;
      const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") return jsonResponse({ error: "agent run is already succeeded" }, 409);
        return streamed(input, init);
      }) as unknown as typeof fetch;
      await act(async () => {
        fireEvent.click(await findByTestId("agent-stop"));
      });

      expect((await findByTestId("agent-error")).textContent).toContain("already succeeded");
      // Not swallowed into a permanent "stopping" state: the ask failed, so the
      // control comes back rather than leaving the user with a run they cannot stop.
      expect(await findByTestId("agent-stop")).toBeTruthy();
    });

    test("a stop that never reaches the server reports that", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const streamed = globalThis.fetch;
      const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") throw new Error("network down");
        return streamed(input, init);
      }) as unknown as typeof fetch;
      await act(async () => {
        fireEvent.click(await findByTestId("agent-stop"));
      });

      expect((await findByTestId("agent-error")).textContent).toContain("network down");
    });

    /**
     * Pausing and resuming are not offered, and that is the bar rather than an
     * omission: `AgentRunService` has no pause at all, and the resume path
     * (`POST /api/agent/drive`) is authenticated by a server-minted machine
     * credential a browser never holds. A control the service cannot honour is not
     * rendered — not even disabled, which would read as a capability that is merely
     * unavailable right now.
     */
    test("no pause or resume control is offered, because the service can honour neither", async () => {
      const { queryByTestId, findAllByTestId } = await startRun([OPENED_LINE, STARTED_LINE]);

      await findAllByTestId("agent-timeline-item");
      expect(queryByTestId("agent-pause")).toBeNull();
      expect(queryByTestId("agent-resume")).toBeNull();
    });
  });

  /**
   * The budget meter (#329 T10b): every figure is one the server enforces, and
   * every consumption is read off the run's durable ledger.
   */
  describe("budget meter", () => {
    // With no run open there is no header to read, so the meter shows the default
    // workflow's ceilings — the same reading the fold takes for a headerless ledger.
    test("an untouched meter shows the ceilings this server enforces", () => {
      const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);
      const budgets = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

      expect(getByTestId("agent-budget-statements").textContent).toContain(`0 / ${budgets.maxStatementsPerRun}`);
      expect(getByTestId("agent-budget-database-time").textContent).toContain(
        `0.0 / ${(budgets.maxTotalRunMs / 1_000).toFixed(1)} s`,
      );
      expect(getByTestId("agent-budget-repairs").textContent).toContain("0 / 3");
    });

    test("a run's consumption comes from its ledger", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, COMPLETED_LINE]);
      const { getByTestId, findByText } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      await findByText(`1 / ${AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxStatementsPerRun}`);
      expect(getByTestId("agent-budget-database-time").textContent).toContain("1.5 / 90.0 s");
    });

    /**
     * `docs/BACKLOG.md` A1: SQLite has no interrupt, so its statement timeout is
     * checked after the statement returns. A meter that showed a timeout without
     * saying so would imply a preemption the runtime cannot perform.
     */
    test("the meter says plainly that a SQLite statement is reported rather than interrupted", () => {
      const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      const caveats = getByTestId("agent-budget-caveats").textContent ?? "";
      expect(caveats).toContain("SQLite");
      expect(caveats).toContain("not interrupted");
    });

    /**
     * A ceiling is per drive while the ledger spans every drive, so a resumed run
     * can fold to more than one drive's allowance. The numeral says what the run
     * actually spent — hiding that would be the misleading direction — while the
     * bar is clamped, because a bar past its own track reads as a larger allowance
     * than exists.
     */
    test("a run past a per-drive ceiling shows the real figure and a bar that does not overflow", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, OVERSPENT_LINE]);
      const { getByTestId, findByText } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      await findByText("90.0 / 90.0 s");
      expect((getByTestId("agent-budget-database-time-bar") as HTMLElement).style.width).toBe("100%");
    });

    /**
     * The ledger records less than the tracker charges, in three known ways
     * (`docs/BACKLOG.md` B12 and B13) — the largest being that the run's schema
     * capture reaches `executeAuditedOperation` without going through `runStep`, so
     * its two-to-three catalog reads are paid for and never itemized. A meter that
     * did not say so would read as exact while sitting two statements low from the
     * first turn.
     */
    test("the meter says its figures are a floor, and names what the ledger leaves out", () => {
      const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      const caveats = getByTestId("agent-budget-caveats").textContent ?? "";
      expect(caveats).toContain("schema capture's catalog reads are not itemized");
      expect(caveats).toContain("records no duration");
      expect(caveats).toContain("a floor, never a ceiling");
    });

    // Every ceiling is per drive (`docs/BACKLOG.md` B6), so a resumed run starts
    // each of them again. A meter that read as a per-run total would understate
    // what a run can cost.
    test("the meter states the limits it cannot measure, and that they are per drive", () => {
      const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      // The approved investigation figures, written out rather than read back from
      // the constant: a test that renders the constant into its own expectation
      // proves the two agree with each other and nothing about what a user is shown.
      const limits = getByTestId("agent-budget-limits").textContent ?? "";
      expect(limits).toContain("10.0 s");
      expect(limits).toContain("7.5 min");
      expect(limits).toContain("36 model turns");
      expect(getByTestId("agent-budget-caveats").textContent).toContain("per drive");
    });

    /**
     * The reserve (the data-analyst design, §1.5). A run near either ceiling is asked
     * to stop and report what it has established, so a user watching a run end short
     * of its ceilings is reading a run that was asked to stop rather than one that
     * gave up. The meter is where that is said, because it is where the ceilings are.
     */
    test("the meter says the last turns are kept back for the report", () => {
      const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      // Written out rather than read back from the constants, for the same reason
      // the ceilings above are: a rendered constant proves nothing about the reading.
      const reserve = getByTestId("agent-budget-reserve").textContent ?? "";
      expect(reserve).toContain("2 model turns");
      expect(reserve).toContain("20.0 s");
      expect(reserve).toContain("asked to stop");
    });

    /**
     * The ceilings are per workflow, and the meter's whole promise is that it states
     * what the SERVER enforces for THIS run. Every figure on the line and on the two
     * measurable gauges is therefore asserted against the constant the enforcement
     * layer reads, workflow by workflow — a hard-coded expectation here would pass
     * while the two drifted.
     */
    test.each(["investigation", "query-optimization", "database-assessment", "operations", "data-analysis"] as const)(
      "a %s run's meter states that workflow's own ceilings, and they are the server's",
      async (workflowType) => {
        mockAgentFetch([openedFor(workflowType), STARTED_LINE]);
        const { getByTestId, findByText } = render(<AgentRail {...DEFAULT_PROPS} />);
        fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
        await act(async () => {
          fireEvent.click(getByTestId("agent-start"));
        });

        const budget = AGENT_WORKFLOW_BUDGETS[workflowType];
        await findByText(`0 / ${budget.policy.budgets.maxStatementsPerRun}`);
        expect(getByTestId("agent-budget-database-time").textContent).toContain(
          `/ ${(budget.policy.budgets.maxTotalRunMs / 1_000).toFixed(1)} s`,
        );

        const limits = getByTestId("agent-budget-limits").textContent ?? "";
        expect(limits).toContain(`${(budget.policy.budgets.statementTimeoutMs / 1_000).toFixed(1)} s`);
        expect(limits).toContain(`${(budget.runDeadlineMs / 60_000).toFixed(1)} min`);
        expect(limits).toContain(`${budget.maxModelTurns} model turns`);
      },
    );

    /**
     * Once a run is open it is the run's OWN workflow that binds, not whatever the
     * picker says now: the picker stays live during a run, and a user who clicks
     * another workflow mid-run must not be shown ceilings nothing is enforcing.
     */
    test("an open run's meter follows the run's header, not the picker", async () => {
      mockAgentFetch([openedFor("database-assessment"), STARTED_LINE]);
      const { getByTestId, findByText } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      const budget = AGENT_WORKFLOW_BUDGETS["database-assessment"];
      await findByText(`0 / ${budget.policy.budgets.maxStatementsPerRun}`);
      fireEvent.click(getByTestId("agent-workflow-operations"));

      const limits = getByTestId("agent-budget-limits").textContent ?? "";
      expect(limits).toContain(`${(budget.runDeadlineMs / 60_000).toFixed(1)} min`);
      expect(limits).toContain(`${budget.maxModelTurns} model turns`);
      expect(getByTestId("agent-budget-statements").textContent).toContain(
        `/ ${budget.policy.budgets.maxStatementsPerRun}`,
      );
    });
  });

  /**
   * Evidence citations (#329 T10b). The server refuses a claim whose evidence does
   * not match something the run produced; the rail's job is to show the user what
   * each claim rests on, and to keep the model's own words visibly the model's.
   */
  describe("evidence citations", () => {
    test("a composed report renders its claims quoted, with what backs each of them", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE, COMPLETED_LINE, REPORT_LINE]);
      const { getByTestId, findAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      const claims = await findAllByTestId("agent-report-claim");
      expect(claims).toHaveLength(1);
      expect(claims[0].textContent).toContain("checkout is slow because orders is scanned");

      const citations = getByTestId("agent-report").querySelectorAll('[data-testid="agent-report-citation"]');
      expect(citations).toHaveLength(1);
      expect(citations[0].textContent).toContain("Artifact corr_9");
      expect(citations[0].textContent).toContain("3 rows via sql.query.read");
      // The model's own pointer into that evidence, carried through as its words.
      expect(citations[0].textContent).toContain("row 2, total");
      // And the statement the artifact came from, quoted rather than narrated.
      expect(citations[0].querySelector("pre")?.textContent).toBe("SELECT count(*) FROM orders");
    });

    test("a run with no report renders no report section", () => {
      const { queryByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      expect(queryByTestId("agent-report")).toBeNull();
    });

    // The rail joined the stream after the read it cites, or skipped the line that
    // carried it. The server had already verified the reference, so the honest
    // rendering says what THIS timeline is missing rather than looking checked.
    test("a citation whose entry this timeline never saw is shown as unresolved, not as checked", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, REPORT_LINE]);
      const { getByTestId, findAllByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      const [citation] = await findAllByTestId("agent-report-citation");
      expect(citation.textContent).toContain("not in the part of this run's timeline the rail has read");
      expect(citation.querySelector("pre")).toBeNull();
    });
  });

  /**
   * Hydration affordances (#329 T11). The rail hands identifiers to its host and
   * renders nothing of the result itself: the bottom panel already owns the grid and
   * the explain view, and a second one inside the rail would be a second thing to
   * keep correct. Both controls are strictly user-driven, and neither exists when the
   * host cannot honour it.
   */
  describe("hydration affordances", () => {
    async function runWith(props: Record<string, unknown>) {
      const view = render(<AgentRail {...DEFAULT_PROPS} {...props} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return view;
    }

    test("a stored result offers to be shown, and shows nothing until the user asks", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, COMPLETED_LINE]);
      const onShowArtifact = mock(() => {});
      const { findAllByTestId } = await runWith({ onShowArtifact });

      const controls = await findAllByTestId("agent-show-result");
      expect(controls).toHaveLength(1);
      expect(onShowArtifact).not.toHaveBeenCalled();

      fireEvent.click(controls[0]);
      expect(onShowArtifact).toHaveBeenCalledWith({ runId: "arun_1", correlationId: "corr_9" });
    });

    test("an answer composed as a chart offers its result WITH the chart the run composed", async () => {
      // The host opens the surface the run named, so the decision travels with the
      // ask. Nothing here reads the rows: the rail has none.
      const spec = { type: "bar", x: "region", y: ["net_total"], caption: "Net total by region." };
      mockAgentFetch([
        OPENED_LINE,
        STARTED_LINE,
        `${JSON.stringify({
          kind: "event",
          event: {
            kind: "answer-composed",
            atMs: 1_003,
            sql: "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region",
            artifact: {
              correlationId: "corr_9",
              runId: "arun_1",
              operationId: "sql.query.read",
              summary: { rowCount: 4, columnNames: ["region", "net_total"], elapsedMs: 12 },
            },
            presentation: { kind: "chart", spec },
            handover: "none",
          },
        })}\n`,
      ]);
      const onShowArtifact = mock(() => {});
      const { findAllByTestId } = await runWith({ onShowArtifact });

      fireEvent.click((await findAllByTestId("agent-show-result"))[0]);
      expect(onShowArtifact).toHaveBeenCalledWith({ runId: "arun_1", correlationId: "corr_9", chartSpec: spec });
    });

    test("a drafted statement offers to be applied, and applies nothing until the user asks", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE]);
      const onApplyStatement = mock(() => {});
      const { findAllByTestId } = await runWith({ onApplyStatement });

      const controls = await findAllByTestId("agent-apply-statement");
      expect(controls).toHaveLength(1);
      expect(onApplyStatement).not.toHaveBeenCalled();

      fireEvent.click(controls[0]);
      expect(onApplyStatement).toHaveBeenCalledWith("SELECT count(*) FROM orders");
    });

    test("a host that offers neither gets no controls, rather than disabled ones", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE, COMPLETED_LINE]);
      const { findAllByTestId, queryAllByTestId } = await runWith({});

      await findAllByTestId("agent-timeline-item");
      expect(queryAllByTestId("agent-show-result")).toHaveLength(0);
      expect(queryAllByTestId("agent-apply-statement")).toHaveLength(0);
    });

    test("a resolved citation carries both affordances; an unresolved one carries neither", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE, COMPLETED_LINE, REPORT_LINE]);
      const onShowArtifact = mock(() => {});
      const onApplyStatement = mock(() => {});
      const { findAllByTestId, getByTestId } = await runWith({ onShowArtifact, onApplyStatement });

      const citations = await findAllByTestId("agent-report-citation");
      expect(citations).toHaveLength(1);

      fireEvent.click(getByTestId("agent-citation-show-result"));
      expect(onShowArtifact).toHaveBeenCalledWith({ runId: "arun_1", correlationId: "corr_9" });

      fireEvent.click(getByTestId("agent-citation-apply-statement"));
      expect(onApplyStatement).toHaveBeenCalledWith("SELECT count(*) FROM orders");
    });

    /*
      The bound is real and is stated where a user reads the citations rather than
      only when a click fails: results live in process memory and are released when
      the run ends (`docs/BACKLOG.md` B15), so a report read after its run finished
      cites rows the server no longer holds.
    */
    test("the report says that stored rows outlive nothing, next to the controls that ask for them", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, COMPLETED_LINE, REPORT_LINE, FINISHED_LINE]);
      const { findByTestId } = await runWith({ onShowArtifact: mock(() => {}) });

      const note = await findByTestId("agent-report-retention");
      expect(note.textContent).toContain("released when the run ends");
    });

    /*
      The milestone's own rule (T10b): a control the service cannot honour is not
      rendered. A finished run's results are released with it, so every "Show result"
      on it would answer 410 — the affordance goes away when the capability does, and
      the note is what says why. Applying a statement is unaffected: the ledger holds
      it, so it works for as long as the timeline does.
    */
    test("a finished run offers no result to show, because its rows were released with it", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE, COMPLETED_LINE, REPORT_LINE, FINISHED_LINE]);
      const onShowArtifact = mock(() => {});
      const onApplyStatement = mock(() => {});
      const { findAllByTestId, queryAllByTestId } = await runWith({ onShowArtifact, onApplyStatement });

      await findAllByTestId("agent-report-citation");
      expect(queryAllByTestId("agent-show-result")).toHaveLength(0);
      expect(queryAllByTestId("agent-citation-show-result")).toHaveLength(0);
      expect(queryAllByTestId("agent-apply-statement")).toHaveLength(1);
    });

    test("one callback without the other renders only the control it can honour", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE, COMPLETED_LINE, REPORT_LINE]);
      const { findAllByTestId, queryAllByTestId } = await runWith({ onShowArtifact: mock(() => {}) });

      await findAllByTestId("agent-report-citation");
      expect(queryAllByTestId("agent-citation-show-result")).toHaveLength(1);
      expect(queryAllByTestId("agent-citation-apply-statement")).toHaveLength(0);
      expect(queryAllByTestId("agent-apply-statement")).toHaveLength(0);
    });

    /*
      The note used to live inside the report section, which meant it appeared only
      for runs that composed one — and the runs that most need it compose nothing.
      Observed on 2026-08-12: a cancelled run showed six "Result stored" entries, no
      "Show result" control on any of them, and no sentence anywhere saying why. A
      user who watched the controls disappear was left to guess.

      The bound is a property of the RUN's stored rows, not of its report, so the note
      belongs wherever those rows are listed.
    */
    test("a run that ended without a report still says why its results cannot be shown", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, COMPLETED_LINE, CANCELLED_LINE, FINISHED_LINE]);
      const { findByTestId, queryByTestId } = await runWith({ onShowArtifact: mock(() => {}) });

      const note = await findByTestId("agent-report-retention");
      expect(note.textContent).toContain("released when the run ends");
      // No report was composed, which is exactly the case that had no explanation.
      expect(queryByTestId("agent-report")).toBeNull();
    });

    test("a run that stored nothing says nothing about retention", async () => {
      // Nothing was held, so there is no absence to explain.
      mockAgentFetch([OPENED_LINE, STARTED_LINE, FINISHED_LINE]);
      const { findByTestId, queryByTestId } = await runWith({ onShowArtifact: mock(() => {}) });

      await findByTestId("agent-run-status");
      expect(queryByTestId("agent-report-retention")).toBeNull();
    });

    test("with no way to show a result, the retention note is not shown either", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, COMPLETED_LINE, REPORT_LINE, FINISHED_LINE]);
      const { findByTestId, queryByTestId } = await runWith({});

      await findByTestId("agent-report");
      expect(queryByTestId("agent-report-retention")).toBeNull();
    });

    test("a citation this timeline cannot resolve offers nothing to show", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, REPORT_LINE]);
      const onShowArtifact = mock(() => {});
      const { findAllByTestId, queryByTestId } = await runWith({ onShowArtifact });

      await findAllByTestId("agent-report-citation");
      expect(queryByTestId("agent-citation-show-result")).toBeNull();
    });
  });

  /**
   * The answer a run composes is SHOWN, rather than described (#373 review).
   *
   * Driven live against Gemini twice on 2026-08-15: both runs reached
   * `answer-composed` with `presentation.kind === "chart"` and a valid spec, and
   * neither chart was ever displayed. By the time a user reads the answer the run has
   * ended, its rows are released, and "Show result" is gone with them — so the only
   * control left was "Apply to editor" and the run's entire output was unreachable.
   *
   * The delivery is keyed to the ENTRY arriving, not to the fold's status, because the
   * two are not the same moment: a stream chunk carrying `answer-composed` and
   * `run-finished` together folds to a finished run in the render that first sees the
   * answer, and a delivery gated on `LIVE_STATUSES` would then never fire — which is
   * exactly the state the defect was measured in.
   */
  describe("the answer a run composes", () => {
    const ANSWER_SQL = "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region";
    const CHART_SPEC = { type: "bar", x: "region", y: ["net_total"], caption: "Net total by region." };

    const answerLine = (presentation: unknown, correlationId = "corr_answer"): string =>
      `${JSON.stringify({
        kind: "event",
        event: {
          kind: "answer-composed",
          atMs: 1_003,
          sql: ANSWER_SQL,
          artifact: {
            correlationId,
            runId: "arun_1",
            operationId: "sql.query.read",
            summary: { rowCount: 4, columnNames: ["region", "net_total"], elapsedMs: 12 },
          },
          presentation,
          handover: "none",
        },
      })}\n`;

    async function runWith(props: Record<string, unknown>) {
      const view = render(<AgentRail {...DEFAULT_PROPS} {...props} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return view;
    }

    test("a chart answer is shown as it arrives, on a run that has already ended", async () => {
      const onShowArtifact = mock(() => {});
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine({ kind: "chart", spec: CHART_SPEC }), FINISHED_LINE]);
      const { findByTestId } = await runWith({ onShowArtifact });

      await findByTestId("agent-run-status");
      await waitFor(() => {
        expect(onShowArtifact).toHaveBeenCalledTimes(1);
      });
      // The surface the RUN named travels with the ask, exactly as it does when a user
      // clicks the control: the rail holds no rows and infers nothing from them.
      expect(onShowArtifact).toHaveBeenCalledWith({
        runId: "arun_1",
        correlationId: "corr_answer",
        chartSpec: CHART_SPEC,
      });
    });

    test("a table answer is shown too, with no chart key on the ask", async () => {
      const onShowArtifact = mock(() => {});
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine({ kind: "table" }), FINISHED_LINE]);
      await runWith({ onShowArtifact });

      await waitFor(() => {
        expect(onShowArtifact).toHaveBeenCalledWith({ runId: "arun_1", correlationId: "corr_answer" });
      });
    });

    test("an ordinary stored result is not shown on its own: only the answer is", async () => {
      // The rail still never opens a result by itself for a read the run took along
      // the way. What is delivered is the thing the run was asked to produce.
      const onShowArtifact = mock(() => {});
      mockAgentFetch([OPENED_LINE, STARTED_LINE, COMPLETED_LINE, DRAFTED_LINE, REPORT_LINE, FINISHED_LINE]);
      const { findByTestId } = await runWith({ onShowArtifact });

      await findByTestId("agent-report");
      expect(onShowArtifact).not.toHaveBeenCalled();
    });

    test("it is delivered once, however many entries follow it", async () => {
      const onShowArtifact = mock(() => {});
      mockAgentFetch([
        OPENED_LINE,
        STARTED_LINE,
        answerLine({ kind: "chart", spec: CHART_SPEC }),
        COMPLETED_LINE,
        REPORT_LINE,
        FINISHED_LINE,
      ]);
      const { findByTestId } = await runWith({ onShowArtifact });

      await findByTestId("agent-report");
      expect(onShowArtifact).toHaveBeenCalledTimes(1);
    });

    test("a second run's answer is delivered too, though the entry ids repeat", async () => {
      // Entry ids are positional within one run, so the NEXT run reuses them: without
      // clearing the record on the run id, the second answer would be recognised as
      // the first one's and silently dropped. The same trap the hand-over solves.
      const onShowArtifact = mock(() => {});
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine({ kind: "table" }), FINISHED_LINE]);
      const view = await runWith({ onShowArtifact });
      await waitFor(() => {
        expect(onShowArtifact).toHaveBeenCalledTimes(1);
      });

      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine({ kind: "table" }, "corr_second"), FINISHED_LINE]);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by month" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });

      await waitFor(() => {
        expect(onShowArtifact).toHaveBeenCalledTimes(2);
      });
      expect(onShowArtifact).toHaveBeenLastCalledWith({ runId: "arun_1", correlationId: "corr_second" });
    });

    test("a host with no way to show a result is not told a result was shown", async () => {
      // Nothing breaks, and nothing is recorded as delivered either: a host that gains
      // the callback later still gets the answer it never received.
      const onShowArtifact = mock(() => {});
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine({ kind: "chart", spec: CHART_SPEC }), FINISHED_LINE]);
      const view = await runWith({});
      await view.findByTestId("agent-run-status");

      view.rerender(<AgentRail {...DEFAULT_PROPS} onShowArtifact={onShowArtifact} />);
      await waitFor(() => {
        expect(onShowArtifact).toHaveBeenCalledTimes(1);
      });
    });

    /*
      Automatic delivery does not remove the manual one: a user who dismissed the panel
      has to be able to ask for the answer again, and while the run is live its rows are
      still held.
    */
    test("the answer entry still offers its result while the run is live", async () => {
      const onShowArtifact = mock(() => {});
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine({ kind: "chart", spec: CHART_SPEC })]);
      const { findAllByTestId } = await runWith({ onShowArtifact });

      const controls = await findAllByTestId("agent-show-result");
      expect(controls).toHaveLength(1);
      fireEvent.click(controls[0]);
      expect(onShowArtifact).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * The model's prose reads as prose (#373 review).
   *
   * Measured in plan mode, live: the closing statement came back as markdown —
   * `### Step 1: Schema Integrity and Consistency Check`, `* **What to inspect:** …` —
   * and the rail rendered it into a single paragraph as literal characters. Plan mode's
   * whole output is one such block, so the mode read as broken.
   *
   * What is NOT changed here is the quoted blocks. Verbatim is what quoting means, and
   * the boundary between what the application says and what came from elsewhere is a
   * security property rather than a style: the objective, the engine's own message, a
   * drafted statement and a report's claims are all shown exactly as they arrived.
   */
  describe("model prose", () => {
    const CLOSING = [
      "### Step 1: Schema Integrity",
      "",
      "* **What to inspect:** the `orders` table",
      "* Whether every order has a customer",
      "",
      "Nothing here has been run.",
    ].join("\n");

    const closingLine = (text: string): string =>
      `${JSON.stringify({ kind: "event", event: { kind: "closing-statement", atMs: 1_004, text } })}\n`;

    async function runWith(lines: readonly string[]) {
      mockAgentFetch(lines);
      const view = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "how would you check this" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return view;
    }

    test("a closing statement written as markdown is rendered as markdown, not as characters", async () => {
      const { findByTestId } = await runWith([OPENED_LINE, STARTED_LINE, closingLine(CLOSING), FINISHED_LINE]);

      const prose = await findByTestId("agent-prose");
      expect(prose.querySelector("h4")?.textContent).toBe("Step 1: Schema Integrity");
      expect(prose.querySelectorAll("ul").length).toBe(1);
      expect(prose.querySelectorAll("li").length).toBe(2);
      expect(prose.querySelector("li strong")?.textContent).toBe("What to inspect:");
      expect(prose.querySelector("li code")?.textContent).toBe("orders");
      expect(prose.querySelectorAll("p")[0]?.textContent).toBe("Nothing here has been run.");
      // The markers the user was reading before.
      expect(prose.textContent).not.toContain("###");
      expect(prose.textContent).not.toContain("**");
    });

    test("it is still the model speaking: nothing of it reaches the app's own line", async () => {
      const { findByTestId, findAllByTestId } = await runWith([
        OPENED_LINE,
        STARTED_LINE,
        closingLine(CLOSING),
        FINISHED_LINE,
      ]);

      const prose = await findByTestId("agent-prose");
      const items = await findAllByTestId("agent-timeline-item");
      const entry = items.find((item) => item.textContent?.includes("Closing statement"));
      // The headline is the app's; the prose is the model's, and it is inside its own
      // block rather than spliced into the sentence beside it.
      expect(entry?.contains(prose)).toBe(true);
      expect(prose.textContent).not.toContain("Closing statement");
    });

    test("an HTML payload a model wrote is still text after all of it", async () => {
      const { findByTestId } = await runWith([
        OPENED_LINE,
        STARTED_LINE,
        closingLine('### <img src=x onerror="steal()">'),
        FINISHED_LINE,
      ]);

      const prose = await findByTestId("agent-prose");
      expect(prose.querySelector("img")).toBeNull();
      expect(prose.querySelector("h4")?.textContent).toBe('<img src=x onerror="steal()">');
    });

    test("a quoted block stays verbatim, markers and all", async () => {
      // The objective is quoted content, and quoted content is what the user reads to
      // see where the application stops speaking. It is shown as it arrived.
      const objective = "why is **checkout** slow";
      const opened = `${JSON.stringify({
        kind: "run-opened",
        atMs: 1_000,
        runId: "arun_1",
        mode: "planning",
        actor: { sessionId: "ada", role: "user" },
        connectionId: "seed:sales",
        objective,
      })}\n`;
      const { findAllByTestId } = await runWith([opened, STARTED_LINE]);

      const items = await findAllByTestId("agent-timeline-item");
      expect(items[0].querySelector("pre")?.textContent).toBe(objective);
      expect(items[0].querySelector("strong")).toBeNull();
    });
  });

  /**
   * Taking what a run produced away with you (#389).
   *
   * The gap: **plan mode reaches none of the events that carry `applySql`.** Every one
   * of them — `statement-drafted`, `plan-comparison`, `recommendation`,
   * `answer-composed` — is written by a tool call, and planning is toolless by
   * contract. So the mode whose entire deliverable is a written plan was the one mode
   * that could offer neither the editor nor the clipboard, and its SQL could only be
   * dragged out of a scrolling panel by hand.
   *
   * Both halves are pinned here: the fenced statement inside a plan reaches the editor,
   * and every verbatim block in the rail can be copied — the quoted content, the plan
   * as a whole, a report's claims and the statements its citations rest on.
   */
  describe("taking a run's output away", () => {
    const PLAN_WITH_SQL = [
      "### Step 2: measure it",
      "",
      "Run this against `orders`:",
      "",
      "```sql",
      "SELECT count(*) FROM orders WHERE created_at > now() - interval '7 days';",
      "```",
      "",
      "It establishes the recent write rate.",
    ].join("\n");

    const closingLine = (text: string): string =>
      `${JSON.stringify({ kind: "event", event: { kind: "closing-statement", atMs: 1_004, text } })}\n`;

    async function planRun(props: Partial<React.ComponentProps<typeof AgentRail>> = {}) {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, closingLine(PLAN_WITH_SQL), FINISHED_LINE]);
      const view = render(<AgentRail {...DEFAULT_PROPS} {...props} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "how would you check this" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return view;
    }

    test("a plan's fenced statement reaches the editor, which no plan-mode entry could offer before", async () => {
      const onApplyStatement = mock((_sql: string) => {});
      const { findByTestId } = await planRun({ onApplyStatement });

      fireEvent.click(await findByTestId("prose-code-apply"));
      expect(onApplyStatement).toHaveBeenCalledWith(
        "SELECT count(*) FROM orders WHERE created_at > now() - interval '7 days';",
      );
    });

    test("the fence renders as a block, so the plan's SQL is readable at all", async () => {
      const { findByTestId } = await planRun();

      const prose = await findByTestId("agent-prose");
      expect(prose.querySelector("pre")?.textContent).toBe(
        "SELECT count(*) FROM orders WHERE created_at > now() - interval '7 days';",
      );
      expect(prose.textContent).not.toContain("```");
    });

    test("a host with no editor is offered no editor control, and still offers the clipboard", async () => {
      const { queryByTestId, findByTestId } = await planRun();

      expect(await findByTestId("prose-code-copy")).not.toBeNull();
      expect(queryByTestId("prose-code-apply")).toBeNull();
    });

    test("the plan can be copied whole, in the markdown the model wrote", async () => {
      const writeText = mock(() => Promise.resolve());
      Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
      const { findByTestId } = await planRun();

      fireEvent.click(await findByTestId("agent-prose-copy"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(PLAN_WITH_SQL));
    });

    test("a quoted block is copyable, which is the whole of what a user could not do", async () => {
      const writeText = mock(() => Promise.resolve());
      Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE, FINISHED_LINE]);
      const view = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "why" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });

      const copies = await view.findAllByTestId("agent-quoted-copy");
      // The objective and the drafted statement: every verbatim block, not a chosen one.
      expect(copies.length).toBe(2);
      fireEvent.click(copies[1]);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("SELECT count(*) FROM orders"));
    });

    test("a report's claim and the statement its citation rests on are both copyable", async () => {
      const writeText = mock(() => Promise.resolve());
      Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
      mockAgentFetch([OPENED_LINE, STARTED_LINE, DRAFTED_LINE, COMPLETED_LINE, REPORT_LINE, FINISHED_LINE]);
      const view = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "why" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });

      fireEvent.click(await view.findByTestId("agent-report-claim-copy"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("checkout is slow because orders is scanned"));

      fireEvent.click(await view.findByTestId("agent-citation-quoted-copy"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("SELECT count(*) FROM orders"));
    });
  });

  /**
   * The timeline follows the newest entry (#373 review).
   *
   * Measured on a completed run: the scroll container sat at `scrollTop: 0` with a
   * `scrollHeight` of 760 against a `clientHeight` of 360, so the report — the thing
   * the user was waiting for — was 400 pixels below the fold and had to be dragged to.
   *
   * The trap the other half of this pins: a user who scrolled up to read an earlier
   * step must not be yanked back down by the next entry. Following is therefore a
   * state the user leaves by scrolling away and returns to by scrolling back, not a
   * thing that happens to every append.
   *
   * happy-dom lays nothing out, so the geometry is defined on the element: the fold's
   * own numbers are what the effect reads, and `scrollTop` is an ordinary writable
   * property there.
   */
  describe("the timeline follows the newest entry", () => {
    const SCROLL_HEIGHT = 760;
    const CLIENT_HEIGHT = 360;
    const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT;

    /** A stream that stays open, so entries can arrive one at a time. */
    function mockOpenStream() {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.endsWith("/stream")) return jsonResponse({ runId: "arun_1", status: "queued", mode: "agent" }, 202);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(open) {
              controller = open;
            },
          }),
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );
      }) as unknown as typeof fetch;
      return {
        push: (line: string) => {
          controller?.enqueue(encoder.encode(line));
        },
      };
    }

    /*
      A `ResizeObserver` this environment does not ship, kept only so a test can BE the
      resize. It records what each instance observes, which is what lets `resizeObserved`
      fire the callback for one element and nothing else — the rail reads the geometry
      off the node rather than off the entry, so the entry may be empty.
    */
    const observed: { element: Element; notify: () => void }[] = [];
    class TestResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(element: Element) {
        observed.push({ element, notify: this.callback });
      }
      disconnect() {
        for (let i = observed.length - 1; i >= 0; i -= 1) {
          if (observed[i].notify === this.callback) observed.splice(i, 1);
        }
      }
      unobserve() {}
    }
    const resizeObserved = (element: Element): void => {
      for (const entry of observed) if (entry.element === element) entry.notify();
    };

    beforeEach(() => {
      observed.length = 0;
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = TestResizeObserver;
    });

    /** The container, with a layout happy-dom would otherwise report as zero. */
    function measured(element: HTMLElement): HTMLElement {
      Object.defineProperty(element, "scrollHeight", { value: SCROLL_HEIGHT, configurable: true });
      Object.defineProperty(element, "clientHeight", { value: CLIENT_HEIGHT, configurable: true });
      return element;
    }

    async function startRun() {
      const stream = mockOpenStream();
      const view = render(<AgentRail {...DEFAULT_PROPS} />);
      const scroller = measured(view.getByTestId("agent-timeline-scroll"));
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return { ...view, stream, scroller };
    }

    test("an entry that arrives brings the timeline with it", async () => {
      const { stream, scroller } = await startRun();
      // Put it back at the top WITHOUT a scroll event, which is what a browser's own
      // clamp does on an empty timeline: nothing has scrolled, so nothing was left.
      scroller.scrollTop = 0;

      await act(async () => {
        stream.push(OPENED_LINE);
      });

      await waitFor(() => {
        expect(scroller.scrollTop).toBe(BOTTOM);
      });
    });

    test("a user who scrolled up to read an earlier step is left where they are", async () => {
      const { stream, scroller } = await startRun();
      await act(async () => {
        stream.push(OPENED_LINE);
      });
      await waitFor(() => {
        expect(scroller.scrollTop).toBe(BOTTOM);
      });

      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      await act(async () => {
        stream.push(STARTED_LINE);
      });

      expect(scroller.scrollTop).toBe(0);
    });

    test("scrolling back to the bottom starts the following again", async () => {
      const { stream, scroller } = await startRun();
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      await act(async () => {
        stream.push(OPENED_LINE);
      });
      expect(scroller.scrollTop).toBe(0);

      // Near the bottom counts as the bottom: a fractional layout and a partly visible
      // last entry both leave a few pixels, and a user who dragged to the end should
      // not have to land on the exact pixel to be followed again.
      scroller.scrollTop = BOTTOM - 4;
      fireEvent.scroll(scroller);
      await act(async () => {
        stream.push(STARTED_LINE);
      });

      await waitFor(() => {
        expect(scroller.scrollTop).toBe(BOTTOM);
      });
    });

    /*
      The bottom also moves when nothing arrives (#373 review, found by driving the
      merged branch).

      A finished analysis run sat at `scrollTop: 245` of a 1090-pixel column, 637 short,
      with every entry already delivered. The column had not grown — the VIEWPORT had
      shrunk: showing the run's answer opens the host's result panel and the rail's own
      height fell from 360 to 208. No entry arrives to say so, so following keyed on the
      entries alone has nothing to re-run on.

      Driven here the way it happens: the last entry lands, the rail is followed to the
      bottom, and then the container is re-measured shorter and the observer told, with
      no further ledger line at all.
    */
    test("a viewport that shrinks under the timeline is followed too", async () => {
      const { stream, scroller } = await startRun();
      await act(async () => {
        stream.push(OPENED_LINE);
      });
      await waitFor(() => {
        expect(scroller.scrollTop).toBe(BOTTOM);
      });

      const SHRUNK = 208;
      Object.defineProperty(scroller, "clientHeight", { value: SHRUNK, configurable: true });
      await act(async () => {
        resizeObserved(scroller);
      });

      expect(scroller.scrollTop).toBe(SCROLL_HEIGHT - SHRUNK);
    });

    test("a reader who scrolled away is not pulled back by a resize either", async () => {
      const { stream, scroller } = await startRun();
      await act(async () => {
        stream.push(OPENED_LINE);
      });
      await waitFor(() => {
        expect(scroller.scrollTop).toBe(BOTTOM);
      });

      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      Object.defineProperty(scroller, "clientHeight", { value: 208, configurable: true });
      await act(async () => {
        resizeObserved(scroller);
      });

      expect(scroller.scrollTop).toBe(0);
    });
  });

  /**
   * Auto-execute (§2.1, §2.5, §2.6 of `docs/AGENT_ANALYST_DESIGN.md`).
   *
   * The control names the bound it gives up and the one it keeps, because "auto-mode"
   * transfers no responsibility: a checkbox that names no bound cannot be consented
   * to. And the RUN's own record is what the rail acts on — the three-condition gate
   * lives on the server (`auto-execute.ts`), so the browser carries out what the
   * ledger says happened and decides nothing again.
   */
  describe("auto-execute", () => {
    /** The statement the answer rests on. Multi-line on purpose: it is handed over verbatim. */
    const ANSWER_SQL = "SELECT region,\n       SUM(net_total) AS net_total\nFROM orders\nGROUP BY region";

    const answerLine = (handover: string, handoverWarning?: string): string =>
      `${JSON.stringify({
        kind: "event",
        event: {
          kind: "answer-composed",
          atMs: 1_003,
          sql: ANSWER_SQL,
          artifact: {
            correlationId: "corr_9",
            runId: "arun_1",
            operationId: "sql.query.read",
            summary: { rowCount: 4, columnNames: ["region", "net_total"], elapsedMs: 12 },
          },
          presentation: { kind: "table" },
          handover,
          ...(handoverWarning === undefined ? {} : { handoverWarning }),
        },
      })}\n`;

    /**
     * The rail with Analyze selected — the only workflow this control is offered on.
     *
     * Every test below goes through this rather than through the default
     * (Investigate) rail, because the control is scoped now: auto-execute is
     * `present_answer`'s hand-over, and `present_answer` is offered to `data-analysis`
     * alone. A test that still rendered the default rail would be asserting the
     * defect this scoping removes.
     */
    function analyze(props: Record<string, unknown> = {}) {
      // A runner by default, because the control is offered only to a host that has
      // one: what the checkbox promises is a run in the user's editor, and a host with
      // no way to run one cannot keep that promise. Tests about a host without a runner
      // pass `onRunStatement: undefined` explicitly.
      const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} {...props} />);
      // Both axes, because the rail opens in PLANNING mode on Investigate and the
      // control belongs to neither. That the block used to reach the checkbox without
      // either click is precisely the defect: it rendered in a toolless mode, on a
      // workflow with no `present_answer`, and offered to run an answer that could
      // not be composed.
      fireEvent.click(view.getByTestId("agent-mode-agent"));
      fireEvent.click(view.getByTestId("agent-workflow-data-analysis"));
      return view;
    }

    async function runWith(props: Record<string, unknown>) {
      const view = analyze(props);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return view;
    }

    test("the control is offered on Analyze alone, and in agent mode alone", () => {
      // The scoping, asserted over EVERY workflow rather than on a sample: the
      // checkbox used to render for all five in both modes, so ticking it on an
      // Investigate run promised a hand-over that workflow has no tool to perform
      // and had the server tell the model to inspect the plan of an answer it could
      // not present. That is the #350/#356 shape, and this is the test that keeps it
      // from returning.
      const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
      fireEvent.click(view.getByTestId("agent-mode-agent"));
      for (const workflow of ["investigation", "query-optimization", "database-assessment", "operations"]) {
        fireEvent.click(view.getByTestId(`agent-workflow-${workflow}`));
        expect(view.queryByTestId("agent-auto-execute"), workflow).toBeNull();
      }
      fireEvent.click(view.getByTestId("agent-workflow-data-analysis"));
      expect(view.queryByTestId("agent-auto-execute")).not.toBeNull();

      // Planning is toolless whatever the run is for, so there is no `present_answer`
      // in its empty tool set either.
      fireEvent.click(view.getByTestId("agent-mode-planning"));
      expect(view.queryByTestId("agent-auto-execute")).toBeNull();
    });

    test("a setting ticked on Analyze is not sent after a switch to a workflow that cannot honour it", async () => {
      // The checkbox's own state is not the authority. Hiding the control leaves the
      // ticked state behind it, and sending that `true` would now be REFUSED by the
      // route — a failed start rather than the silent no-op the hidden control
      // implies. Resolved from the same record the control is rendered from.
      const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const view = analyze();
      fireEvent.click(view.getByTestId("agent-auto-execute"));
      fireEvent.click(view.getByTestId("agent-workflow-investigation"));
      expect(view.queryByTestId("agent-auto-execute")).toBeNull();
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });

      const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(sent.workflowType).toBe("investigation");
      expect(sent.autoExecute).toBe(false);
    });

    test("the control names the bound it gives up, the one it keeps, and what happens instead", () => {
      const { getByTestId } = analyze();

      expect(getByTestId("agent-auto-execute-label").textContent).toBe("Also run the final answer in my editor");
      const terms = getByTestId("agent-auto-execute-terms").textContent ?? "";
      // The run's own bounds, read off the same policy the meter reads.
      expect(terms).toContain("200 rows");
      expect(terms).toContain("10 seconds");
      // The bound that remains, and the one being given up.
      expect(terms).toContain("500-row limit");
      expect(terms).toContain("no time limit");
      // What the run does INSTEAD when the gate declines, so an unrun statement in
      // the editor reads as the feature working.
      expect(terms).toContain("put in the editor without being run");
      // The sentence about writes, which the #373 review's security finding made
      // false and the hand-over route made true again. It says WHAT refuses them —
      // the engine, in the same read-only session the run's own read used — because
      // "writes are refused" was the claim the old wording made while the replay ran
      // in a read-write session guarded only by a check on the statement's text.
      expect(terms).toContain("same database-enforced read-only session either way");
      expect(terms).toContain("writes and DDL are refused by the engine rather than by reading the statement");
      // And the connection it names is the run's, not "yours": the server resolves it
      // from the run's own record, so the replay cannot reach another database.
      expect(terms).toContain("on the connection the run was opened on");
    });

    test("a SQLite connection is told what a long read there costs; another engine is not", () => {
      const sqlite = analyze({ connectionType: "sqlite" });
      expect(sqlite.getByTestId("agent-auto-execute-sqlite").textContent).toBe(
        "On SQLite a read is not interrupted when it runs long: it blocks other writers and this application until it finishes.",
      );
      cleanup();

      const postgres = analyze({ connectionType: "postgres" });
      expect(postgres.queryByTestId("agent-auto-execute-sqlite")).toBeNull();
    });

    test("the setting is sent at start, and off is sent as off", async () => {
      const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const { getByTestId } = analyze();

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).autoExecute).toBe(false);

      cleanup();
      const ticked = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const second = analyze();
      fireEvent.click(second.getByTestId("agent-auto-execute"));
      fireEvent.change(second.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(second.getByTestId("agent-start"));
      });
      expect(JSON.parse(String(ticked.mock.calls[0][1]?.body)).autoExecute).toBe(true);
    });

    // The server's own rule: the setting is decided by the request that opens the run
    // and no later request may widen it. A control that still moved would be offering
    // a change nothing would honour.
    test("the setting cannot be changed while a run is open, and is offered again once it is over", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const { getByTestId } = await runWith({});

      await waitFor(() => {
        expect((getByTestId("agent-auto-execute") as HTMLInputElement).disabled).toBe(true);
      });
      expect(getByTestId("agent-auto-execute-frozen").textContent).toContain("decided when the run is opened");

      cleanup();
      mockAgentFetch([OPENED_LINE, STARTED_LINE, FINISHED_LINE]);
      const over = await runWith({});
      await over.findByTestId("agent-run-status");
      await waitFor(() => {
        expect((over.getByTestId("agent-auto-execute") as HTMLInputElement).disabled).toBe(false);
      });
    });

    test("an auto-executed answer is placed in the editor AND run there, once, verbatim", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine("auto-executed")]);
      const onRunStatement = mock(() => {});
      const onApplyStatement = mock(() => {});
      const { findAllByTestId } = await runWith({ onRunStatement, onApplyStatement });

      await findAllByTestId("agent-apply-statement");
      await waitFor(() => {
        expect(onRunStatement).toHaveBeenCalledTimes(1);
      });
      // Byte for byte what the ledger holds: no injected LIMIT, no rewriting. And the
      // RUN goes with it (#373 review): the host does not execute this text, it names
      // the run whose ledger the server reads the statement from.
      expect(onRunStatement).toHaveBeenCalledWith(ANSWER_SQL, "arun_1");
      // Running it IS placing it — the host does both, so the rail does not ask twice.
      expect(onApplyStatement).not.toHaveBeenCalled();
    });

    /**
     * A capability the host lacks is not offered — the rule the stop control and the
     * hydration affordances already follow, applied to the one control that promises
     * something the host has to perform (#373 review).
     *
     * The rail used to offer the checkbox to any host and fall back to
     * `onApplyStatement` when no runner existed, so the statement was placed and not
     * run while the timeline entry told the user it "ran on your connection". A
     * surface may not claim an execution that did not happen, and the cheapest way not
     * to claim it is not to promise it: `onRunStatement` is an optional public prop,
     * so any embedding host can be in this state.
     */
    describe("a host with no runner is not offered the promise", () => {
      test("the checkbox is absent, terms and all, on the workflow that otherwise has it", () => {
        const view = analyze({ onRunStatement: undefined });

        expect(view.queryByTestId("agent-auto-execute")).toBeNull();
        expect(view.queryByTestId("agent-auto-execute-terms")).toBeNull();
      });

      test("a setting ticked while a runner existed is not sent after the host loses it", async () => {
        // The checkbox's own state is not the authority, exactly as it is not the
        // authority across a workflow switch: hiding the control leaves the ticked
        // state behind it, and `true` on a run this host cannot carry out would open a
        // run whose hand-over nothing here could perform.
        const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
        const view = analyze();
        fireEvent.click(view.getByTestId("agent-auto-execute"));
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });

        view.rerender(<AgentRail {...DEFAULT_PROPS} />);
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });

        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).autoExecute).toBe(false);
      });

      test("an auto-executed hand-over is never delivered through the apply path instead", async () => {
        // The ledger entry says the statement ran on the user's connection. Applying it
        // silently would make that entry false; the statement is still there to be
        // taken, as the user's own action, through the control beside it.
        mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine("auto-executed")]);
        const onApplyStatement = mock(() => {});
        const { findAllByTestId } = await runWith({ onApplyStatement, onRunStatement: undefined });

        expect(await findAllByTestId("agent-apply-statement")).toHaveLength(1);
        expect(onApplyStatement).not.toHaveBeenCalled();
      });

      test("an answer the run did NOT hand over is still applied there, as it always was", async () => {
        // The narrowing is about the hand-over alone: a declined answer is placed in
        // the editor unrun, which is a claim this host can keep.
        mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine("applied", "Not run for you: yours to run.")]);
        const onApplyStatement = mock(() => {});
        await runWith({ onApplyStatement, onRunStatement: undefined });

        await waitFor(() => {
          expect(onApplyStatement).toHaveBeenCalledWith(ANSWER_SQL);
        });
      });
    });

    /**
     * A hand-over may only run on the connection the run was opened on (#373 review).
     *
     * `onRunStatement` runs the statement against whatever the HOST's editor is
     * pointed at now — `use-query-execution.ts` resolves every execution from
     * `activeConnection` — while the run read its rows from the connection it was
     * opened on. A user who switches connection while a run is going would otherwise
     * have the approved statement run, without a timeout, against a database whose plan
     * was never inspected and whose elapsed time was never measured, and be shown that
     * other database's rows as "the answer".
     *
     * The check lives HERE rather than in the host's callback because the callback is
     * an optional public prop: a second host wiring it differently would not inherit a
     * guard written in Studio. Declining is the whole remedy — there is no way to reach
     * the run's connection from here, and inventing one would run a statement somewhere
     * the user is not looking.
     */
    describe("a hand-over is declined when the editor has moved to another connection", () => {
      /**
       * A stream that stays OPEN, so the answer can arrive after the connection has
       * changed. Every other test here streams its whole ledger before the first
       * assertion, which is the one ordering this defect cannot happen in.
       */
      function mockOpenAgentFetch() {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const fetchMock = mock(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (!url.endsWith("/stream")) {
            return jsonResponse({ runId: "arun_1", status: "queued", mode: "agent" }, 202);
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(open) {
                controller = open;
                open.enqueue(encoder.encode(OPENED_LINE));
                open.enqueue(encoder.encode(STARTED_LINE));
              },
            }),
            { status: 200, headers: { "content-type": "application/x-ndjson" } },
          );
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        return {
          push: (line: string) => {
            controller?.enqueue(encoder.encode(line));
          },
        };
      }

      test("the statement is not run, and the entry that claims it ran is contradicted", async () => {
        const stream = mockOpenAgentFetch();
        const onRunStatement = mock(() => {});
        const onApplyStatement = mock(() => {});
        const view = analyze({ onRunStatement, onApplyStatement });
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });

        // The user switches the editor to another database while the run is going.
        view.rerender(
          <AgentRail
            {...DEFAULT_PROPS}
            connectionId="seed:analytics"
            connectionName="Analytics"
            onRunStatement={onRunStatement}
            onApplyStatement={onApplyStatement}
          />,
        );
        await act(async () => {
          stream.push(answerLine("auto-executed"));
        });

        const declined = await view.findByTestId("agent-handover-declined");
        // Nothing ran anywhere: not on the run's connection, which this surface cannot
        // reach, and not on the one the editor moved to.
        expect(onRunStatement).not.toHaveBeenCalled();
        // And not quietly placed either: the entry says the statement RAN, and placing
        // it unrun beside that sentence is the claim the previous round removed.
        expect(onApplyStatement).not.toHaveBeenCalled();
        // Said beside the entry that claims the execution, because that is where the
        // sentence a user would otherwise believe is written.
        expect(declined.textContent).toContain("was not run");
        expect(declined.textContent).toContain("Sales");
      });

      test("an answer on the run's own connection is still run, so the check is about the change", async () => {
        // The pair: the same arc with the connection left alone hands the statement
        // over exactly as before. Without it the test above would pass on a rail that
        // never hands anything over at all.
        const stream = mockOpenAgentFetch();
        const onRunStatement = mock(() => {});
        const view = analyze({ onRunStatement });
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });

        await act(async () => {
          stream.push(answerLine("auto-executed"));
        });

        await waitFor(() => {
          expect(onRunStatement).toHaveBeenCalledWith(ANSWER_SQL, "arun_1");
        });
        expect(view.queryByTestId("agent-handover-declined")).toBeNull();
      });

      test("an APPLIED answer is unaffected, because placing a statement claims no execution", async () => {
        // The narrowing is about the hand-over that RUNS. Putting a statement in the
        // editor is the user's own next action either way, and the entry beside it says
        // exactly that.
        const stream = mockOpenAgentFetch();
        const onRunStatement = mock(() => {});
        const onApplyStatement = mock(() => {});
        const view = analyze({ onRunStatement, onApplyStatement });
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });

        view.rerender(
          <AgentRail
            {...DEFAULT_PROPS}
            connectionId="seed:analytics"
            connectionName="Analytics"
            onRunStatement={onRunStatement}
            onApplyStatement={onApplyStatement}
          />,
        );
        await act(async () => {
          stream.push(answerLine("applied", "Not run for you: yours to run."));
        });

        await waitFor(() => {
          expect(onApplyStatement).toHaveBeenCalledWith(ANSWER_SQL);
        });
        expect(view.queryByTestId("agent-handover-declined")).toBeNull();
      });
    });

    test("a declined answer is placed unrun, and the run's own reason is beside it", async () => {
      const warning = "Not run for you: the engine reported a full table read, so this one is yours to run.";
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine("applied", warning)]);
      const onRunStatement = mock(() => {});
      const onApplyStatement = mock(() => {});
      const { findAllByTestId } = await runWith({ onRunStatement, onApplyStatement });

      const items = await findAllByTestId("agent-timeline-item");
      await waitFor(() => {
        expect(onApplyStatement).toHaveBeenCalledWith(ANSWER_SQL);
      });
      expect(onRunStatement).not.toHaveBeenCalled();
      // Without this sentence an unrun statement is indistinguishable from a broken
      // feature, which is the whole reason the gate states its refusal.
      expect(items.at(-1)?.textContent).toContain(warning);
    });

    test("an answer the run handed nowhere is handed nowhere here either", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine("none")]);
      const onRunStatement = mock(() => {});
      const onApplyStatement = mock(() => {});
      const { findAllByTestId } = await runWith({ onRunStatement, onApplyStatement });

      // The control is still offered: taking the statement is the user's own action.
      expect(await findAllByTestId("agent-apply-statement")).toHaveLength(1);
      expect(onRunStatement).not.toHaveBeenCalled();
      expect(onApplyStatement).not.toHaveBeenCalled();
    });

    test("a host that offers neither callback survives a handover rather than throwing", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, answerLine("auto-executed")]);
      const { findAllByTestId, queryAllByTestId } = await runWith({ onRunStatement: undefined });

      await findAllByTestId("agent-timeline-item");
      expect(queryAllByTestId("agent-apply-statement")).toHaveLength(0);
    });
  });

  /**
   * The statement a plan run drafted, as a card (item 7 of the plan-mode SQL-generator
   * design of 2026-08-15).
   *
   * Plan mode's deliverable is now a ledger fact rather than a fence the browser
   * happened to find (item 5), and this is where the user meets it. Three of the four
   * tests below are about a claim rather than a control, because that is where this
   * surface can do harm:
   *
   *  - **A write must be unmissable, and not only to a sighted user.** The owner ruled
   *    that plan mode may draft one; what it may never do is let "Apply to editor" put
   *    a `DELETE` in the editor as though it were a `SELECT`. A colour says that to
   *    nobody using a screen reader, so the mark rides in the button's own accessible
   *    name.
   *  - **A finding must sit beside the statement it is about.** A table the inventory
   *    does not hold is what the identifier check exists to surface; swallowed, it
   *    leaves an unvalidated statement looking like a sound one.
   *  - **The refusal marker is a protocol token and never copy.** It reaches the user
   *    stripped, inside a card that says what the outcome is.
   */
  describe("the statement a plan run drafted", () => {
    const closingLine = (text: string): string =>
      `${JSON.stringify({ kind: "event", event: { kind: "closing-statement", atMs: 1_004, text } })}\n`;

    const draftedLine = (event: Record<string, unknown>): string =>
      `${JSON.stringify({
        kind: "event",
        event: { kind: "plan-statement-drafted", atMs: 1_005, dialect: "postgres", ...event },
      })}\n`;

    const READ = {
      sql: "SELECT title FROM film ORDER BY rental_count DESC",
      readOnly: true,
      identifiers: { kind: "checked", unknownTables: [] },
    };

    async function planRun(lines: readonly string[], props: Partial<React.ComponentProps<typeof AgentRail>> = {}) {
      mockAgentFetch(lines);
      const view = render(<AgentRail {...DEFAULT_PROPS} {...props} />);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "which films are popular" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return view;
    }

    test("the drafted statement gets a card of its own, showing the SQL verbatim", async () => {
      const { findByTestId } = await planRun([OPENED_LINE, STARTED_LINE, draftedLine(READ), FINISHED_LINE]);

      const card = await findByTestId("agent-plan-statement");
      // Verbatim, in a block of its own: this is model text, and the rail's standing
      // rule is that the user can see where the application stopped speaking.
      expect(card.querySelector("pre")?.textContent).toBe(READ.sql);
      expect(card.getAttribute("data-read-only")).toBe("true");
    });

    test("applying hands the host the exact statement the ledger recorded", async () => {
      const onApplyStatement = mock((_sql: string) => {});
      const { findByTestId } = await planRun([OPENED_LINE, STARTED_LINE, draftedLine(READ), FINISHED_LINE], {
        onApplyStatement,
      });

      fireEvent.click(await findByTestId("agent-plan-apply-statement"));
      expect(onApplyStatement).toHaveBeenCalledWith(READ.sql);
    });

    test("a host with no editor is offered no editor control, and still offers the clipboard", async () => {
      // The rule every affordance in this rail follows: nothing is offered that this
      // host could not carry out.
      const { findByTestId, queryByTestId } = await planRun([
        OPENED_LINE,
        STARTED_LINE,
        draftedLine(READ),
        FINISHED_LINE,
      ]);

      expect(queryByTestId("agent-plan-apply-statement")).toBeNull();
      expect(await findByTestId("agent-plan-statement-copy")).not.toBeNull();
    });

    test("the statement can be copied through the control that works over plain HTTP", async () => {
      // `CopyButton` rather than a second `navigator.clipboard` call: the API is
      // secure-context only and this product ships over plain HTTP on several channels.
      const writeText = mock(() => Promise.resolve());
      Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
      const { findByTestId } = await planRun([OPENED_LINE, STARTED_LINE, draftedLine(READ), FINISHED_LINE]);

      fireEvent.click(await findByTestId("agent-plan-statement-copy"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(READ.sql));
    });

    test("a guard objection is marked in the ACCESSIBLE NAME of the control that applies it, not only in colour", async () => {
      const onApplyStatement = mock((_sql: string) => {});
      const { findByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          draftedLine({
            sql: "DELETE FROM film WHERE rental_count = 0",
            readOnly: false,
            guardViolation: "NON_READ_STATEMENT",
            identifiers: { kind: "checked", unknownTables: [] },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement },
      );

      const apply = await findByTestId("agent-plan-apply-statement");
      const name = apply.getAttribute("aria-label") ?? "";
      expect(name).toContain("Apply");
      // WCAG 2.5.3: the accessible name contains the visible label, so a voice user
      // can still say what they read.
      expect(name).toContain("did not read this as a bounded read");
      // And visibly, for everyone else — carried on the card rather than on a class
      // name, so it can be asserted rather than inferred from styling.
      const card = await findByTestId("agent-plan-statement");
      expect(card.getAttribute("data-read-only")).toBe("false");
      const mark = await findByTestId("agent-plan-statement-guard");
      expect(mark.textContent).toContain("did not read this as a bounded read");
      // The guard's own reason, beside the mark: it is this repository's closed
      // vocabulary rather than model text, and it is what tells a reader whether the
      // objection was about an effect or about text the guard could not settle.
      expect(mark.textContent).toContain("NON_READ_STATEMENT");
    });

    /*
      `readOnly` is `inspectAgentStatement(sql) === null` and nothing else, and the
      guard's own header records that it over-refuses legitimate reads on purpose —
      PostgreSQL's `#>`/`#>>` jsonb operators are refused with everything carrying a
      `#`, because two dialects disagree about where such a statement ENDS.

      So this card, which is the most consequential sentence on the whole surface, says
      what the guard did and never what the SQL does. A pure jsonb read announced to a
      user, and to a screen reader, as SQL that can delete their data is the
      overstatement this repository is repeatedly caught in.
    */
    test("an objection the guard could not classify is not presented as a write", async () => {
      const onApplyStatement = mock((_sql: string) => {});
      const { findByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          draftedLine({
            sql: "SELECT payload #>> '{a,b}' FROM events",
            readOnly: false,
            guardViolation: "DIALECT_AMBIGUOUS_TEXT",
            identifiers: { kind: "checked", unknownTables: [] },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement },
      );

      const card = await findByTestId("agent-plan-statement");
      // Still marked, still amber, still not offered as an ordinary read: the run
      // could not establish that this only reads, and that is worth a user's attention.
      expect(card.getAttribute("data-read-only")).toBe("false");
      expect((await findByTestId("agent-plan-statement-guard")).textContent).toContain("DIALECT_AMBIGUOUS_TEXT");
      // And nowhere on it, or in the name the control carries, is the claim the server
      // never made.
      const name = (await findByTestId("agent-plan-apply-statement")).getAttribute("aria-label") ?? "";
      expect(`${card.textContent} ${name}`).not.toContain("change or delete");
      expect(`${card.textContent} ${name}`).not.toContain("This is not a read");
    });

    /*
      The ledger shape a real run produces, which none of the cases above has: the
      closing prose HOLDS the fenced statement, and the drafted event is written from
      it immediately after. So the same `DELETE` is on screen twice — inside the prose,
      where #389's per-block control offers "Apply to editor" with no mark, no
      accessible name and no colour, and in the card, which marks it.

      The unmarked control sits directly above the marked one and is the one a user
      reaches for first. It is the silent hand-off item 4 of the design exists to
      prevent, so it is withheld from the entry the statement was read out of; the
      card is the hand-off, and the block keeps its clipboard.
    */
    test("the prose the statement was read out of offers no second, unmarked editor control", async () => {
      const onApplyStatement = mock((_sql: string) => {});
      const sql = "DELETE FROM film WHERE rental_count = 0";
      const { findByTestId, queryByTestId, queryAllByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          closingLine(`\`\`\`postgres\n${sql}\n\`\`\`\n\nIt removes the unrented titles.`),
          draftedLine({
            sql,
            readOnly: false,
            guardViolation: "NON_READ_STATEMENT",
            identifiers: { kind: "checked", unknownTables: [] },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement },
      );

      // The marked control, and only it.
      expect(await findByTestId("agent-plan-apply-statement")).not.toBeNull();
      expect(queryByTestId("prose-code-apply")).toBeNull();
      // Nothing else is taken away: the block still renders and still copies.
      expect((await findByTestId("agent-prose")).textContent).toContain(sql);
      expect(queryAllByTestId("prose-code-copy").length).toBe(1);
    });

    test("a plan run that drafted no statement keeps the fence reading #389 gave it", async () => {
      // The fallback is unchanged where there is no card to defer to. Withholding it
      // everywhere would cost a user the one hand-off plan mode had before this design.
      const onApplyStatement = mock((_sql: string) => {});
      const { findByTestId } = await planRun(
        [OPENED_LINE, STARTED_LINE, closingLine("```postgres\nSELECT title FROM film\n```"), FINISHED_LINE],
        { onApplyStatement },
      );

      fireEvent.click(await findByTestId("prose-code-apply"));
      expect(onApplyStatement).toHaveBeenCalledWith("SELECT title FROM film");
    });

    test("a name the inventory does not hold is shown beside the statement, in the model's own text", async () => {
      const { findByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          draftedLine({
            sql: "SELECT * FROM payments",
            readOnly: true,
            identifiers: { kind: "checked", unknownTables: ["payments", "refunds"] },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement: mock((_sql: string) => {}) },
      );

      // The finding reaches a screen reader too, on the control that acts on it: a
      // user who never sees the amber list is otherwise told only "Apply to editor"
      // about a statement whose names were not all found.
      const name = (await findByTestId("agent-plan-apply-statement")).getAttribute("aria-label") ?? "";
      expect(name).toContain("2 table(s)");
      expect(name).toContain("does not hold");

      const findings = await findByTestId("agent-plan-statement-unknown");
      // The names are engine and model text, so they are shown as quoted content
      // rather than spliced into the app's sentence — and they ARE shown: a count
      // alone leaves the user with nothing to look for in the statement above.
      expect(findings.textContent).toContain("payments");
      expect(findings.textContent).toContain("refunds");
      expect(findings.textContent).toContain("not in the inventory");
    });

    test("a statement nothing checked says so, rather than passing for a checked one", async () => {
      const { findByTestId, queryByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          draftedLine({ sql: "SELECT 1", readOnly: true, identifiers: { kind: "no-inventory" } }),
          FINISHED_LINE,
        ],
        { onApplyStatement: mock((_sql: string) => {}) },
      );

      expect((await findByTestId("agent-plan-statement-unchecked")).textContent).toContain(
        "No schema inventory was read",
      );
      expect(queryByTestId("agent-plan-statement-unknown")).toBeNull();
      // An empty list of unknown names would be a CLAIM — that every name resolves —
      // and this run made none, so the control says nothing checked them.
      expect((await findByTestId("agent-plan-apply-statement")).getAttribute("aria-label")).toContain(
        "Nothing checked the names it uses",
      );
    });

    test("a statement whose names all resolve claims nothing further about it", async () => {
      const { queryByTestId, findByTestId } = await planRun([
        OPENED_LINE,
        STARTED_LINE,
        draftedLine(READ),
        FINISHED_LINE,
      ]);

      await findByTestId("agent-plan-statement");
      expect(queryByTestId("agent-plan-statement-unknown")).toBeNull();
      expect(queryByTestId("agent-plan-statement-unchecked")).toBeNull();
      expect(queryByTestId("agent-plan-statement-guard")).toBeNull();
    });

    test("a refusal renders as its own card, and the marker never reaches the user", async () => {
      const { findByTestId, queryByTestId } = await planRun([
        OPENED_LINE,
        STARTED_LINE,
        closingLine("NO STATEMENT: nothing here records a rental.\n\nWhich table holds them?"),
        FINISHED_LINE,
      ]);

      const card = await findByTestId("agent-plan-refusal");
      expect(card.textContent).toContain("nothing here records a rental.");
      expect(card.textContent).toContain("Which table holds them?");
      expect(card.textContent).not.toContain("NO STATEMENT");
      // A refusal is not a statement: there is nothing to apply and nothing is offered.
      expect(queryByTestId("agent-plan-statement")).toBeNull();
      expect(queryByTestId("agent-plan-apply-statement")).toBeNull();
    });

    test("an ordinary closing statement is not dressed as a refusal", async () => {
      const { findByTestId, queryByTestId } = await planRun([
        OPENED_LINE,
        STARTED_LINE,
        closingLine("Start with the rental index."),
        FINISHED_LINE,
      ]);

      expect((await findByTestId("agent-prose")).textContent).toContain("Start with the rental index.");
      expect(queryByTestId("agent-plan-refusal")).toBeNull();
    });
  });

  test("the sheet closes through the caller that opened it", async () => {
    const onSheetOpenChange = mock(() => {});
    media.setMatches(true);
    const { findByTestId } = render(<AgentRail {...DEFAULT_PROPS} sheetOpen onSheetOpenChange={onSheetOpenChange} />);

    const sheet = await findByTestId("agent-rail-sheet");
    fireEvent.keyDown(sheet, { key: "Escape" });

    await waitFor(() => {
      expect(onSheetOpenChange).toHaveBeenCalled();
    });
  });
});
