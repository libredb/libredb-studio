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

/**
 * POST /api/agent/runs accepted, then a stream of whatever lines are given — including
 * the run-opened header, which this one does not build for itself.
 *
 * It answers the classify request with the start body, which is not a classification at
 * all. That is deliberate for the suites that predate this seam: it exercises the path
 * every failure lands on, an investigation marked unclassified, which is exactly what
 * those tests asked for before a classifier existed.
 */
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
 * The one open request out of everything the rail sent.
 *
 * Read by URL rather than by position: an Automatic start now sends
 * `POST /api/agent/classify` first, so `calls[0]` is no longer the run being opened
 * and a positional read would silently assert against the classification.
 */
function startBodyOf(fetchMock: ReturnType<typeof mock>): Record<string, unknown> {
  const call = (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][]).find(
    ([url]) => String(url) === "/api/agent/runs",
  );
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

/** Every request the rail made to the classifier, in order. */
const classifyCalls = (fetchMock: ReturnType<typeof mock>): unknown[] =>
  (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][]).filter(
    ([url]) => String(url) === "/api/agent/classify",
  );

/**
 * The header a server writes for a run it has just opened: the open request, persisted.
 *
 * Built from the request the rail actually made rather than written by hand, because
 * the rail reads what a run was opened AS off this header — a hand-written one lets a
 * test assert a sentence the run's own record would not support.
 */
const openedLineFrom = (body: Record<string, unknown>): string =>
  `${JSON.stringify({
    kind: "run-opened",
    atMs: 1_000,
    runId: "arun_1",
    mode: body.mode ?? "planning",
    ...(body.workflowType === undefined ? {} : { workflowType: body.workflowType }),
    ...(body.workflowSource === undefined ? {} : { workflowSource: body.workflowSource }),
    ...(body.workflowReading === undefined ? {} : { workflowReading: body.workflowReading }),
    actor: { sessionId: "ada", role: "user" },
    connectionId: "seed:sales",
    objective: body.objective ?? "why is checkout slow",
  })}\n`;

/**
 * A server that persists what it is sent: the classifier answers however the test says,
 * and the ledger the rail then follows opens with a header built from the open request
 * the rail made. The lines given are what FOLLOWS that header.
 */
function mockAgentServer(
  classify: (init?: RequestInit) => Promise<Response>,
  lines: readonly string[] = [STARTED_LINE],
) {
  let opened: Record<string, unknown> = {};
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/agent/classify") return classify(init);
    if (url.endsWith("/stream")) return ndjsonResponse([openedLineFrom(opened), ...lines]);
    if (url === "/api/agent/runs" && init?.method === "POST") opened = JSON.parse(String(init.body));
    return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The same server, with the classifier answering one fixed body. */
function mockClassifiedFetch(classification: unknown, lines: readonly string[] = [STARTED_LINE], status = 200) {
  return mockAgentServer(async () => jsonResponse(classification, status), lines);
}

/**
 * The same server again, except that it will not stop a run: the DELETE answers `500`.
 *
 * A refused stop is the case a "change" has to survive, because the replacement may not
 * be opened over a run that is still executing.
 */
function mockServerRefusingStop(classification: unknown) {
  let opened: Record<string, unknown> = {};
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/agent/classify") return jsonResponse(classification);
    if (init?.method === "DELETE") return jsonResponse({ error: "the run could not be stopped" }, 500);
    if (url.endsWith("/stream")) return ndjsonResponse([openedLineFrom(opened), STARTED_LINE]);
    if (url === "/api/agent/runs" && init?.method === "POST") opened = JSON.parse(String(init.body));
    return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/**
 * A server whose RECORD disagrees with what the rail asked for: the classifier answers
 * one thing and the ledger header says another.
 *
 * That divergence is the only way to tell a surface reading the run from a surface
 * repeating its own memory of the request it sent — which is exactly what a reload, or a
 * second surface joining the stream, would be.
 */
function mockDivergentServer(classification: unknown, header: Record<string, unknown>) {
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/agent/classify") return jsonResponse(classification);
    if (url.endsWith("/stream")) return ndjsonResponse([openedLineFrom(header), STARTED_LINE]);
    void init;
    return jsonResponse({ runId: "arun_1", status: "queued", mode: "planning" }, 202);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The five workflows live behind the disclosure now, so a test that names one opens it. */
const openAdvanced = (view: { getByTestId: (id: string) => HTMLElement }): void => {
  fireEvent.click(view.getByTestId("agent-advanced-toggle"));
};

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

    // The classification comes first now, and the open request carries what it said —
    // here the answer every failure reaches, since this mock is not a classifier.
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent/classify");
    expect(startBodyOf(fetchMock)).toEqual({
      mode: "agent",
      workflowType: "investigation",
      workflowSource: "inferred",
      workflowReading: "unclassified",
      autoExecute: false,
      objective: "why is checkout slow",
      connectionId: "seed:sales",
    });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/agent/runs/arun_1/stream");
  });

  test("the workflow control is offered in BOTH modes, because the axes are independent", () => {
    // Found by review on #344: an agent-only control made the rail unable to open a
    // planning run of a query optimization, which the epic's independent axes exist
    // to allow.
    const view = render(<AgentRail {...DEFAULT_PROPS} />);
    const { getByTestId } = view;
    openAdvanced(view);

    // Automatic is what the disclosure opens on: the axis is offered, and unanswered.
    expect(getByTestId("agent-workflow-automatic").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByTestId("agent-workflow-investigation"));
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
    const view = render(<AgentRail {...DEFAULT_PROPS} />);
    const { getByTestId } = view;
    openAdvanced(view);

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

    expect(startBodyOf(fetchMock)).toEqual({
      mode: "agent",
      workflowType: "operations",
      // Named by the user, so nothing was inferred and nothing was asked of a model.
      workflowSource: "chosen",
      // And nothing classified anything, so there is no outcome to record.
      workflowReading: "unrecorded",
      autoExecute: false,
      objective: "what is blocked right now",
      connectionId: "seed:sales",
    });
    expect(classifyCalls(fetchMock)).toHaveLength(0);
  });

  test("the Analyze workflow is offered, and starting it asks the server for it", async () => {
    // Same assertion as Operate's, for the same reason: the button row is generated
    // from the label record, so this is what makes the workflow reachable by a user
    // rather than merely present in a type.
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const view = render(<AgentRail {...DEFAULT_PROPS} />);
    const { getByTestId } = view;
    openAdvanced(view);

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

    expect(startBodyOf(fetchMock)).toEqual({
      mode: "agent",
      workflowType: "data-analysis",
      workflowSource: "chosen",
      workflowReading: "unrecorded",
      autoExecute: false,
      objective: "sales by region today",
      connectionId: "seed:sales",
    });
  });

  test("a workflow chosen in one mode survives the switch to the other", () => {
    const view = render(<AgentRail {...DEFAULT_PROPS} />);
    const { getByTestId } = view;
    openAdvanced(view);

    fireEvent.click(getByTestId("agent-workflow-query-optimization"));
    fireEvent.click(getByTestId("agent-mode-agent"));

    expect(getByTestId("agent-workflow-query-optimization").getAttribute("aria-pressed")).toBe("true");
  });

  test("the chosen workflow is what the start request asks for", async () => {
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const view = render(<AgentRail {...DEFAULT_PROPS} />);
    const { getByTestId } = view;
    openAdvanced(view);

    fireEvent.click(getByTestId("agent-mode-agent"));
    fireEvent.click(getByTestId("agent-workflow-query-optimization"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(startBodyOf(fetchMock)).toEqual({
      mode: "agent",
      workflowType: "query-optimization",
      workflowSource: "chosen",
      workflowReading: "unrecorded",
      autoExecute: false,
      objective: "why is checkout slow",
      connectionId: "seed:sales",
    });
  });

  test("a planning run carries its workflow too — a plan FOR an optimization is still about one", async () => {
    const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
    const view = render(<AgentRail {...DEFAULT_PROPS} />);
    const { getByTestId } = view;
    openAdvanced(view);

    fireEvent.click(getByTestId("agent-workflow-query-optimization"));
    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect(startBodyOf(fetchMock)).toEqual({
      mode: "planning",
      workflowType: "query-optimization",
      workflowSource: "chosen",
      workflowReading: "unrecorded",
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
    // The classification and the refused open. Nothing was followed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
   * Small print is print (#100). `text-fg-muted` — zinc-500 in the dark palette — on
   * this rail's `bg-surface` (#0a0a0a), under the alert's own `bg-red-500/5`, computes
   * to 3.98:1 against WCAG AA's 4.5:1 — measured from the installed Tailwind 4 palette,
   * not estimated — and this text is 10px, so the large-text allowance does not apply.
   * `text-fg-tertiary` (zinc-400) is 7.33:1.
   *
   * Stated in token names on purpose: asserting the old literal would pass trivially
   * now that no component carries it, and the guard would silently stop guarding.
   * The dark palette is the binding case — light puts the same zinc-500 on a near-white
   * ground, where it clears AA.
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
    expect(missing.querySelector("span")?.className).not.toContain("text-fg-muted");
    expect(getByTestId("agent-model-refusal-action").className).not.toContain("text-fg-muted");
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
    // The classification and the refused start, and nothing after them.
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

      const [url, init] = fetchMock.mock.calls[3];
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
      expect(fetchMock).toHaveBeenCalledTimes(4);
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
    /**
     * The gauges measure a RUN, so before one exists there is nothing to measure and
     * nothing is shown. They used to read a full set of zeroes against the default
     * workflow's ceilings, which under Automatic is a workflow nobody has chosen and
     * the classifier may not pick — a bound stated before anything could enforce it.
     */
    test("the gauges wait for a run rather than reading a workflow nobody chose", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const { getByTestId, queryByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);
      const budgets = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

      expect(queryByTestId("agent-budget-statements")).toBeNull();
      expect(getByTestId("agent-budget-unknown").textContent).toContain("Automatic decides the workflow");

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      expect((await findByTestId("agent-budget-statements")).textContent).toContain(
        `0 / ${budgets.maxStatementsPerRun}`,
      );
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
      const view = render(<AgentRail {...DEFAULT_PROPS} />);
      const { getByTestId } = view;
      // Stated for a workflow the user NAMED: under Automatic there is no workflow yet
      // and therefore no ceiling this rail could promise.
      openAdvanced(view);
      fireEvent.click(getByTestId("agent-workflow-investigation"));

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
      fireEvent.click(getByTestId("agent-advanced-toggle"));
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
   * Auto-execute (§2.1, §2.5, §2.6 of `docs/AGENT_ANALYST_DESIGN.md`), which is now
   * asked for in the consent step rather than beside the objective.
   *
   * The control names the bound it gives up and the one it keeps, because "auto-mode"
   * transfers no responsibility: a checkbox that names no bound cannot be consented
   * to. And the RUN's own record is what the rail acts on — the three-condition gate
   * lives on the server (`auto-execute.ts`), so the browser carries out what the
   * ledger says happened and decides nothing again.
   *
   * What moved, and why it is not a rename: the pre-start checkbox sat in a panel the
   * user could change under it — a workflow switch, a mode switch or a host that lost
   * its runner all left a tick behind a hidden control. Asked between the decision and
   * the open request, there is nothing left to drift: the workflow is settled and the
   * next thing that happens is the request that opens the run with it. It is still
   * consent given at OPEN time, which is what `src/lib/agent/types.ts` requires of
   * every widening decision.
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
      // A runner by default, because the consent step is offered only to a host that
      // has one: what the checkbox promises is a run in the user's editor, and a host
      // with no way to run one cannot keep that promise. Tests about a host without a
      // runner pass `onRunStatement: undefined` explicitly.
      const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} {...props} />);
      // Both axes, because the rail opens in PLANNING mode on Automatic and the consent
      // step belongs to neither. Naming the workflow here rather than letting the
      // classifier reach it keeps these tests about the hand-over: an explicit choice
      // sends no classify request at all.
      fireEvent.click(view.getByTestId("agent-mode-agent"));
      openAdvanced(view);
      fireEvent.click(view.getByTestId("agent-workflow-data-analysis"));
      return view;
    }

    /** Presses Start, and takes the consent step where one is offered. */
    async function runWith(props: Record<string, unknown>) {
      const view = analyze(props);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      if (view.queryByTestId("agent-consent") !== null) {
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
        });
      }
      return view;
    }

    test("there is no such control before a run is started: it lives in the consent step", () => {
      // The pre-start checkbox is gone rather than relocated. It rendered wherever the
      // workflow happened to be Analyze, which is a state the user could leave without
      // the tick leaving with them.
      const view = analyze();

      expect(view.queryByTestId("agent-auto-execute")).toBeNull();
      expect(view.queryByTestId("agent-auto-execute-terms")).toBeNull();
      expect(view.queryByTestId("agent-consent")).toBeNull();
    });

    test.each(["investigation", "query-optimization", "database-assessment", "operations"] as const)(
      "a %s run is opened uninterrupted, because it has nothing to hand over",
      async (workflow) => {
        // The scoping, asserted over EVERY workflow rather than on a sample: the
        // checkbox used to render for all five in both modes, so ticking it on an
        // Investigate run promised a hand-over that workflow has no tool to perform
        // and had the server tell the model to inspect the plan of an answer it could
        // not present. That is the #350/#356 shape, and this is the test that keeps it
        // from returning.
        const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
        const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
        fireEvent.click(view.getByTestId("agent-mode-agent"));
        openAdvanced(view);
        fireEvent.click(view.getByTestId(`agent-workflow-${workflow}`));
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });

        expect(view.queryByTestId("agent-consent")).toBeNull();
        expect(startBodyOf(fetchMock).workflowType).toBe(workflow);
        expect(startBodyOf(fetchMock).autoExecute).toBe(false);
      },
    );

    test("planning is toolless whatever the run is for, so Analyze is opened uninterrupted there too", async () => {
      const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const view = analyze();
      // Back to the mode the rail opens in, with Analyze still selected.
      fireEvent.click(view.getByTestId("agent-mode-planning"));
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });

      expect(view.queryByTestId("agent-consent")).toBeNull();
      expect(startBodyOf(fetchMock).autoExecute).toBe(false);
    });

    test("a tick is not sent when the host that would run it is gone by the time the run opens", async () => {
      // The checkbox's own state is not the authority. The MODE can no longer move out
      // from under a held start — both axes are frozen for exactly that window, and the
      // "axes are frozen" tests below are where that is pinned — but the host's half of
      // the promise is a PROP, and an embedding host may withdraw its runner between
      // the consent step and the open. `true` on a run that cannot present an answer is
      // refused outright by the route, a failed start rather than the silent no-op the
      // old hidden control implied, so the setting is resolved once more from the same
      // three conditions the step was offered on.
      const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const view = analyze();
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });

      fireEvent.click(view.getByTestId("agent-auto-execute"));
      view.rerender(<AgentRail {...DEFAULT_PROPS} />);
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-consent-open"));
      });

      expect(startBodyOf(fetchMock).mode).toBe("agent");
      expect(startBodyOf(fetchMock).autoExecute).toBe(false);
    });

    test("the control names the bound it gives up, the one it keeps, and what happens instead", async () => {
      const view = analyze();
      const { getByTestId } = view;
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "sales by region" } });
      mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      expect(getByTestId("agent-consent-workflow").textContent).toContain("open as Analyze");
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
      // And where the decision is made, which is what makes this consent rather than a
      // preference: the request that opens the run settles it, and no later one widens
      // a run the server already holds.
      expect(getByTestId("agent-consent-frozen").textContent).toContain("opens the run");
    });

    /** Reaches the consent step, where the terms are now stated. */
    async function consentOf(props: Record<string, unknown>) {
      mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const view = analyze(props);
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      return view;
    }

    test("a SQLite connection is told what a long read there costs; another engine is not", async () => {
      const sqlite = await consentOf({ connectionType: "sqlite" });
      expect(sqlite.getByTestId("agent-auto-execute-sqlite").textContent).toBe(
        "On SQLite a read is not interrupted when it runs long: it blocks other writers and this application until it finishes.",
      );
      cleanup();

      const postgres = await consentOf({ connectionType: "postgres" });
      expect(postgres.queryByTestId("agent-auto-execute-sqlite")).toBeNull();
    });

    test("the setting is sent at start, and off is sent as off", async () => {
      const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const { getByTestId } = analyze();

      fireEvent.change(getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });
      await act(async () => {
        fireEvent.click(getByTestId("agent-consent-open"));
      });
      expect(startBodyOf(fetchMock).autoExecute).toBe(false);

      cleanup();
      const ticked = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const second = analyze();
      fireEvent.change(second.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(second.getByTestId("agent-start"));
      });
      fireEvent.click(second.getByTestId("agent-auto-execute"));
      await act(async () => {
        fireEvent.click(second.getByTestId("agent-consent-open"));
      });
      expect(startBodyOf(ticked).autoExecute).toBe(true);
    });

    // The server's own rule: the setting is decided by the request that opens the run
    // and no later request may widen it. So there is no control to change once the run
    // is open — the step that carried it is gone with the decision it made.
    test("the consent step is gone once the run it decided is open", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const { queryByTestId, findByTestId } = await runWith({});

      await findByTestId("agent-run-status");
      expect(queryByTestId("agent-consent")).toBeNull();
      expect(queryByTestId("agent-auto-execute")).toBeNull();
    });

    // A tick the user gave and then thought better of: Cancel opens nothing at all, and
    // the objective they wrote is still in the box.
    test("Cancel in the consent step opens no run and keeps the objective", async () => {
      const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
      const view = analyze();
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });

      fireEvent.click(view.getByTestId("agent-auto-execute"));
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-consent-cancel"));
      });

      expect(view.queryByTestId("agent-consent")).toBeNull();
      expect((view.getByTestId("agent-objective") as HTMLTextAreaElement).value).toBe("sales by region");
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/agent/runs")).toBe(false);

      // And the tick does not survive the step it was given in: the next consent step
      // starts from off, so a hand-over is never carried over from a decision the user
      // abandoned.
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
      expect((view.getByTestId("agent-auto-execute") as HTMLInputElement).checked).toBe(false);
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
      test("no consent step is reached at all on the workflow that otherwise has one", async () => {
        const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
        const view = analyze({ onRunStatement: undefined });
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });

        // Not a step the host is walked through and then denied: the run opens, and the
        // promise is never made.
        expect(view.queryByTestId("agent-consent")).toBeNull();
        expect(view.queryByTestId("agent-auto-execute")).toBeNull();
        expect(startBodyOf(fetchMock).autoExecute).toBe(false);
      });

      test("a tick given while a runner existed is not sent after the host loses it", async () => {
        // The tick is not the authority, exactly as it is not the authority across a
        // mode switch: `true` on a run this host cannot carry out would open a run whose
        // hand-over nothing here could perform.
        const fetchMock = mockAgentFetch([OPENED_LINE, STARTED_LINE]);
        const view = analyze();
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });
        fireEvent.click(view.getByTestId("agent-auto-execute"));

        view.rerender(<AgentRail {...DEFAULT_PROPS} />);
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
        });

        expect(startBodyOf(fetchMock).autoExecute).toBe(false);
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
        // Analyze in agent mode asks for the hand-over consent before it opens anything.
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
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
        // Analyze in agent mode asks for the hand-over consent before it opens anything.
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
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
        // Analyze in agent mode asks for the hand-over consent before it opens anything.
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
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

    test("the same finding names the objects in the engine's own word (#414)", async () => {
      // Druid's inventory rows are datasources, and it speaks SQL — so it is the
      // engine where the name check runs AND the word "table" is not the one the
      // sidebar, the prompt or the engine itself uses. The word rides in on the run's
      // own capture entry, which is where the fold reads it from.
      const { findByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          `${JSON.stringify({
            kind: "event",
            event: {
              kind: "context-captured",
              atMs: 1_003,
              fingerprint: "ctx_druid00",
              tableCount: 3,
              noun: { singular: "datasource", plural: "datasources" },
            },
          })}\n`,
          draftedLine({
            sql: "SELECT page FROM clickstream",
            readOnly: true,
            identifiers: { kind: "checked", unknownTables: ["clickstream"] },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement: mock((_sql: string) => {}) },
      );

      const name = (await findByTestId("agent-plan-apply-statement")).getAttribute("aria-label") ?? "";
      expect(name).toContain("1 datasource(s)");
      expect(name).not.toContain("table");
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
      expect(queryByTestId("agent-plan-statement-guard-unread")).toBeNull();
      expect(queryByTestId("agent-plan-statement-unread")).toBeNull();
    });

    /*
      #414. Grounding reached the engines that speak no SQL, and this card's two most
      consequential sentences are both written by SQL readers. The guard reads every
      string as SQL — a correct MongoDB aggregation leads with the word `DB`, which is
      in no read allowlist — so the amber banner told a user that nothing established
      this pipeline only reads, as though something had looked and been unconvinced. And
      the name check found no table keyword in it, which is not the same as finding that
      every name resolves.

      Both banners therefore move to the CHECK and away from the draft: what it can
      read, and that it did not read this. The mark on the applying control moves with
      them, because a screen-reader user has only that sentence.
    */
    test("a draft the guard cannot read is marked as unexamined, on the card and in the control's name", async () => {
      const aggregation = 'db.orders.aggregate([{ $group: { _id: "$customerId", n: { $sum: 1 } } }])';
      const { findByTestId, queryByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          draftedLine({
            sql: aggregation,
            readOnly: false,
            guardApplicable: false,
            identifiers: { kind: "not-applicable" },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement: mock((_sql: string) => {}) },
      );

      const unread = await findByTestId("agent-plan-statement-guard-unread");
      expect(unread.textContent).toContain("The statement guard reads SQL");
      expect(unread.textContent).toContain("nothing examined this draft");
      // The banner that blames the draft is not also on the card: one card, one claim.
      expect(queryByTestId("agent-plan-statement-guard")).toBeNull();
      // And the MACHINE-readable half says the same thing as the prose. `"false"` is
      // the objection the guard makes, and it made none here; a consumer keying on the
      // attribute must not be able to read one out of a draft nothing looked at.
      expect((await findByTestId("agent-plan-statement")).getAttribute("data-read-only")).toBe("unexamined");

      // WCAG 2.5.3 still holds — the visible label is in the accessible name — and the
      // mark a screen-reader user hears is the one about the guard's reach, not the one
      // asserting that nothing established this only reads.
      const name = (await findByTestId("agent-plan-apply-statement")).getAttribute("aria-label") ?? "";
      expect(name).toContain("Apply");
      expect(name).toContain("this engine's statements are not SQL");
      expect(name).not.toContain("did not read this as a bounded read");
      // No reason code anywhere, because there was no objection to report.
      expect(`${unread.textContent} ${name}`).not.toContain("NON_READ_STATEMENT");
    });

    /*
      Its own line and its own words. The `no-inventory` sentence reports a run that
      read no schema; this run usually HAS one — grounding is what reached these engines
      — and what it lacks is a reader that can find a collection name inside a pipeline.
      A user told "no inventory was read" would go looking for a grounding failure that
      did not happen.
    */
    test("the name check says its own reach failed, and never that no inventory was read", async () => {
      const { findByTestId, queryByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          draftedLine({
            sql: "INFO memory",
            readOnly: false,
            guardApplicable: false,
            identifiers: { kind: "not-applicable" },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement: mock((_sql: string) => {}) },
      );

      const unread = await findByTestId("agent-plan-statement-unread");
      expect(unread.textContent).toContain("the check that would do it reads SQL");
      expect(queryByTestId("agent-plan-statement-unchecked")).toBeNull();
      expect(queryByTestId("agent-plan-statement-unknown")).toBeNull();

      const name = (await findByTestId("agent-plan-apply-statement")).getAttribute("aria-label") ?? "";
      expect(name).toContain("The name check reads SQL too");
      expect(name).not.toContain("Nothing checked the names it uses.");
    });

    /*
      The field is optional on the event, because ledgers written before #414 carry no
      value — and absent reads as `true` truthfully, since plan mode was then grounded
      on PostgreSQL and SQLite alone. An old entry must render exactly as it always did.
    */
    test("a ledger written before the field existed still renders the objection it recorded", async () => {
      const { findByTestId, queryByTestId } = await planRun(
        [
          OPENED_LINE,
          STARTED_LINE,
          draftedLine({
            sql: "DELETE FROM film",
            readOnly: false,
            guardViolation: "NON_READ_STATEMENT",
            identifiers: { kind: "checked", unknownTables: [] },
          }),
          FINISHED_LINE,
        ],
        { onApplyStatement: mock((_sql: string) => {}) },
      );

      expect((await findByTestId("agent-plan-statement-guard")).textContent).toContain("NON_READ_STATEMENT");
      expect(queryByTestId("agent-plan-statement-guard-unread")).toBeNull();
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
  /**
   * Inferred workflow selection
   * (`docs/superpowers/specs/2026-08-16-agent-workflow-inference-design.md`).
   *
   * The axis and all five workflows are unchanged. What these tests pin is who decides
   * and when:
   *
   *  - **The five are one disclosure away and Automatic is the default**, because the
   *    row used to sit ABOVE the objective, asking the user to classify a question they
   *    had not written yet.
   *  - **An explicit choice makes NO classification request.** Not an optimisation: it
   *    spends no latency and no model tokens, and the user who knows what they want
   *    never depends on the least reliable component in the path.
   *  - **The consent step is the only place auto-execute is asked for**, and it exists
   *    only where the run could actually hand something over.
   *  - **A fallback is never presented as a verdict.** A classification that failed
   *    opens an investigation and says that is what happened.
   */
  describe("inferred workflow selection", () => {
    const classified = (workflowType: string) => ({ workflowType, outcome: "classified" });

    /** Every stop the rail asked for, which is how a replaced run ends. */
    const deleteCalls = (fetchMock: ReturnType<typeof mock>): unknown[] =>
      (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][]).filter(([, init]) => init?.method === "DELETE");

    /** Every open request the rail made, oldest first. */
    const openRequests = (fetchMock: ReturnType<typeof mock>): Record<string, unknown>[] =>
      (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][])
        .filter(([url, init]) => String(url) === "/api/agent/runs" && init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

    async function startWith(view: { getByTestId: (id: string) => HTMLElement }, objective = "sales by region") {
      fireEvent.change(view.getByTestId("agent-objective"), { target: { value: objective } });
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-start"));
      });
    }

    test("the five workflows are folded away, and Automatic is what the rail opens on", () => {
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      // Nothing of the row is in the document until the disclosure is opened: a
      // collapsed panel is not a hidden one that screen readers still walk into.
      expect(view.queryByTestId("agent-workflow-investigation")).toBeNull();
      expect(view.getByTestId("agent-advanced-toggle").getAttribute("aria-expanded")).toBe("false");
      expect(view.getByTestId("agent-workflow-choice").textContent).toBe("Automatic");

      openAdvanced(view);
      expect(view.getByTestId("agent-advanced-toggle").getAttribute("aria-expanded")).toBe("true");
      expect(view.getByTestId("agent-workflow-automatic").getAttribute("aria-pressed")).toBe("true");
      expect(view.getByTestId("agent-workflow-data-analysis").getAttribute("aria-pressed")).toBe("false");
    });

    test("an Automatic start classifies the objective and opens the run for what came back", async () => {
      const fetchMock = mockClassifiedFetch(classified("query-optimization"));
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      await startWith(view, "why is checkout slow");

      expect(classifyCalls(fetchMock)).toHaveLength(1);
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
        objective: "why is checkout slow",
      });
      expect(openRequests(fetchMock)[0]).toEqual({
        mode: "planning",
        workflowType: "query-optimization",
        // The whole point of the field: the surface owes this user a sentence it does
        // not owe one who named the workflow themselves.
        workflowSource: "inferred",
        // And this is the other half of that sentence: the reading SUCCEEDED, which is
        // a different claim from the fallback below and is recorded as one.
        workflowReading: "classified",
        autoExecute: false,
        objective: "why is checkout slow",
        connectionId: "seed:sales",
      });
      // And it says what it opened as, in a workflow's own label.
      expect((await view.findByTestId("agent-opened-as")).textContent).toContain("Opened as Optimize");
    });

    test("a classification that is not data-analysis opens the run with no consent step at all", async () => {
      const fetchMock = mockClassifiedFetch(classified("operations"));
      const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
      fireEvent.click(view.getByTestId("agent-mode-agent"));

      await startWith(view, "what is blocked right now");

      expect(view.queryByTestId("agent-consent")).toBeNull();
      expect(openRequests(fetchMock)[0].workflowType).toBe("operations");
      expect(openRequests(fetchMock)[0].autoExecute).toBe(false);
    });

    test("a data-analysis classification in agent mode asks for consent, and only then opens", async () => {
      const fetchMock = mockClassifiedFetch(classified("data-analysis"));
      const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
      fireEvent.click(view.getByTestId("agent-mode-agent"));

      await startWith(view);

      // Nothing has opened yet: the classification is a decision the run does not carry
      // until the user has answered the one question it raised.
      expect(view.getByTestId("agent-consent")).toBeTruthy();
      expect(openRequests(fetchMock)).toHaveLength(0);

      fireEvent.click(view.getByTestId("agent-auto-execute"));
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-consent-open"));
      });

      expect(openRequests(fetchMock)).toHaveLength(1);
      expect(openRequests(fetchMock)[0]).toMatchObject({
        mode: "agent",
        workflowType: "data-analysis",
        workflowSource: "inferred",
        autoExecute: true,
      });
    });

    test("Cancel in the consent step opens nothing", async () => {
      const fetchMock = mockClassifiedFetch(classified("data-analysis"));
      const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
      fireEvent.click(view.getByTestId("agent-mode-agent"));

      await startWith(view);
      await act(async () => {
        fireEvent.click(view.getByTestId("agent-consent-cancel"));
      });

      expect(view.queryByTestId("agent-consent")).toBeNull();
      expect(openRequests(fetchMock)).toHaveLength(0);
      expect(view.queryByTestId("agent-opened-as")).toBeNull();
      // Back to idle rather than stuck: the objective is untouched and Start is live.
      expect((view.getByTestId("agent-start") as HTMLButtonElement).disabled).toBe(false);
    });

    /**
     * What a run was opened AS is a fact about the RUN, so it is read off the run's own
     * header rather than remembered from the request this rail sent. That is the whole
     * reason `workflowSource` is persisted: a rail that reloads, or a second surface
     * joining the stream, has no such memory and must say the same thing.
     */
    test("the workflow the header names is the one the banner names", async () => {
      // The rail asked for an investigation here (this server answers the classify
      // request with something that is not a classification at all), and the run was
      // opened for operations. The record wins.
      mockAgentFetch([openedLineFrom({ workflowType: "operations", workflowSource: "inferred" }), STARTED_LINE]);
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      await startWith(view, "what is blocked right now");

      expect((await view.findByTestId("agent-opened-as")).textContent).toContain("Opened as Operate");
    });

    test("a run the header says was chosen is offered no way out of it", async () => {
      // Same request, and a header that records a workflow somebody picked. There is
      // nothing to correct, so there is nothing to say and no "change" to offer.
      mockAgentFetch([openedLineFrom({ workflowType: "operations" }), STARTED_LINE]);
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      await startWith(view, "what is blocked right now");
      await waitFor(() => {
        expect(view.getByTestId("agent-run-status").textContent).toBe("running");
      });

      expect(view.queryByTestId("agent-opened-as")).toBeNull();
    });

    /**
     * What the reading PRODUCED is a fact about the run, and is read off the run's own
     * header for the reason `workflowSource` is (#407 review).
     *
     * It was the one part of the sentence held in this component alone, defaulting to
     * `"classified"` — so a surface that had not made the reading itself said "read from
     * your objective" over a run whose classification had failed and fallen back. That
     * is the fallback presented as a verdict, which is the one thing this affordance may
     * not do, and it is what a reloaded rail or a second surface would have said every
     * time.
     */
    describe("what the reading produced", () => {
      test("the record's outcome wins over what this rail's own classify call returned", async () => {
        // The classifier answered, and answered successfully. The header says the run
        // was opened on a reading that did NOT: a rail rebuilt from the ledger, which
        // is all a reload has, must say what the record says.
        mockDivergentServer(classified("query-optimization"), {
          workflowType: "investigation",
          workflowSource: "inferred",
          workflowReading: "unclassified",
        });
        const view = render(<AgentRail {...DEFAULT_PROPS} />);

        await startWith(view, "why is checkout slow");

        const header = (await view.findByTestId("agent-opened-as")).textContent ?? "";
        expect(header).toContain("could not be classified");
        expect(header).not.toContain("read from your objective");
      });

      test("a header that records no reading is presented as neither a verdict nor a failure", async () => {
        // The one header a reader can say nothing certain about: a provenance with no
        // outcome beside it. Both other sentences would be claims the record does not
        // make — one credits a classification that may never have succeeded, the other
        // asserts a failure nobody recorded, and can contradict the workflow beside it.
        mockDivergentServer(classified("operations"), {
          workflowType: "operations",
          workflowSource: "inferred",
        });
        const view = render(<AgentRail {...DEFAULT_PROPS} />);

        await startWith(view, "what is blocked right now");

        const header = (await view.findByTestId("agent-opened-as")).textContent ?? "";
        expect(header).toContain("Opened as Operate");
        expect(header).toContain("does not say");
        expect(header).not.toContain("could not be classified");
        expect(header).not.toContain("read from your objective");
      });

      test("a failed reading is sent to the server, so the run's own record carries it", async () => {
        // The half that makes the fold above possible: a rail that kept the outcome to
        // itself would leave every reader after it with a header it cannot describe.
        const fetchMock = mockClassifiedFetch({ error: "the model endpoint is unreachable" }, [STARTED_LINE], 500);
        const view = render(<AgentRail {...DEFAULT_PROPS} />);

        await startWith(view, "why is checkout slow");

        expect(openRequests(fetchMock)[0]).toMatchObject({
          workflowSource: "inferred",
          workflowReading: "unclassified",
        });
      });
    });

    /**
     * The connection a start was asked ON (#407 review).
     *
     * `connectionId` is a prop resolved from the shell's active connection on every
     * render, and a start is no longer synchronous: it waits on a classification, and
     * may then wait on the user answering the consent step. The consent step's "Open"
     * runs in the LATEST render's closure, so a run could open against a database the
     * rail was no longer displaying — and against one the consent copy had just promised
     * it would not use.
     */
    describe("the connection a start was asked on", () => {
      test("a run opens on the connection Start was pressed on, not on whatever the shell moved to", async () => {
        const fetchMock = mockClassifiedFetch(classified("data-analysis"));
        const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
        fireEvent.click(view.getByTestId("agent-mode-agent"));

        await startWith(view);

        // The shell moves while the consent step stands, which is an ordinary thing for
        // a user to do: the rail is beside a database selector.
        view.rerender(
          <AgentRail
            {...DEFAULT_PROPS}
            connectionId="seed:analytics"
            connectionName="Analytics"
            onRunStatement={() => {}}
          />,
        );
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
        });

        expect(openRequests(fetchMock)[0].connectionId).toBe("seed:sales");
      });

      test("the consent copy names that connection, and keeps naming it when the shell moves", async () => {
        // The copy promises the statement runs "on the connection the run was opened
        // on", and the SQLite line is true of one engine only. Both have to describe the
        // run that will actually open, not the rail's surroundings when Open is pressed.
        mockClassifiedFetch(classified("data-analysis"));
        const view = render(<AgentRail {...DEFAULT_PROPS} connectionType="sqlite" onRunStatement={() => {}} />);
        fireEvent.click(view.getByTestId("agent-mode-agent"));

        await startWith(view);

        expect(view.getByTestId("agent-consent-workflow").textContent).toContain("on Sales");
        expect(view.getByTestId("agent-auto-execute-sqlite")).toBeTruthy();

        view.rerender(
          <AgentRail
            {...DEFAULT_PROPS}
            connectionId="seed:analytics"
            connectionName="Analytics"
            connectionType="postgres"
            onRunStatement={() => {}}
          />,
        );

        expect(view.getByTestId("agent-consent-workflow").textContent).toContain("on Sales");
        expect(view.getByTestId("agent-consent-workflow").textContent).not.toContain("Analytics");
        expect(view.getByTestId("agent-auto-execute-sqlite")).toBeTruthy();
      });

      test("a start held by the classification opens on the connection it was asked on too", async () => {
        // The other held window, and it must answer the same way: the two paths differ
        // in which render's closure they run in, and a user cannot be expected to know
        // which one their click took.
        let release: (() => void) | null = null;
        const fetchMock = mockAgentServer(
          () =>
            new Promise<Response>((resolve) => {
              release = () => resolve(jsonResponse(classified("operations")));
            }),
        );
        const view = render(<AgentRail {...DEFAULT_PROPS} />);

        await startWith(view, "what is blocked right now");
        view.rerender(<AgentRail {...DEFAULT_PROPS} connectionId="seed:analytics" connectionName="Analytics" />);
        await act(async () => {
          release?.();
        });

        expect(openRequests(fetchMock)[0].connectionId).toBe("seed:sales");
      });
    });

    /**
     * The consent step is announced and takes focus (#407 review, and #100's standing
     * a11y rules).
     *
     * It is inserted after an asynchronous classification, below a Start button that is
     * disabled in the same commit. Without a name and without focus, a keyboard or
     * screen-reader user is left on a dead control with no indication that two buttons
     * and the terms of a consent have appeared below it.
     */
    describe("the consent step's announcement", () => {
      async function consentStep() {
        mockClassifiedFetch(classified("data-analysis"));
        const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
        fireEvent.click(view.getByTestId("agent-mode-agent"));
        fireEvent.change(view.getByTestId("agent-objective"), { target: { value: "sales by region" } });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-start"));
        });
        return view;
      }

      test("it is a named region and takes focus when it appears", async () => {
        const view = await consentStep();

        const consent = view.getByTestId("agent-consent");
        // Compared by test id rather than by node: a failed element comparison prints
        // the whole document, and this file's DOM is large enough to hang the runner.
        expect(document.activeElement?.getAttribute("data-testid")).toBe("agent-consent");
        // Its name is the sentence naming the workflow and the connection, so entering
        // the region reads out what is being consented to rather than "group".
        expect(consent.getAttribute("aria-labelledby")).toBe("agent-consent-workflow");
        expect(document.getElementById("agent-consent-workflow")?.textContent).toContain("Analyze");
        // And the terms describe it, so they are announced with it rather than being
        // text the user has to go looking for.
        expect(consent.getAttribute("aria-describedby")).toBe("agent-consent-terms");
        expect(document.getElementById("agent-consent-terms")?.textContent).toContain("read-only");
      });

      test("Cancel returns focus to the control that raised it", async () => {
        const view = await consentStep();

        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-cancel"));
        });

        const start = view.getByTestId("agent-start") as HTMLButtonElement;
        expect(document.activeElement?.getAttribute("data-testid")).toBe("agent-start");
        // Focus that lands on a disabled control is focus lost a beat later, so this is
        // half the assertion: Start is live again, which is why it is the destination.
        expect(start.disabled).toBe(false);
      });

      test("Open leaves focus on a control that is still there and still enabled", async () => {
        const view = await consentStep();

        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
        });

        // NOT Start: it is disabled from the moment the run is busy, and the browser
        // drops focus to the body when the focused element disables under it.
        expect(document.activeElement?.getAttribute("data-testid")).toBe("agent-objective");
        expect((view.getByTestId("agent-start") as HTMLButtonElement).disabled).toBe(true);
      });
    });

    /**
     * The axes are frozen from the click that asked for a start until a run is open or
     * the user abandons it.
     *
     * A start is asynchronous now — it waits on the classification — and everything it
     * does afterwards was decided by the render the click happened in. A mode switched
     * during that wait would therefore be discarded in silence, which is the opposite
     * of what pressing it looks like: the request would carry the mode that was pressed
     * BEFORE, and the consent step (agent mode only, by construction) could be raised
     * over a rail displaying Plan.
     */
    describe("the axes are frozen while a start is held", () => {
      test("the mode cannot be switched while the classification is in flight", async () => {
        let release: (() => void) | null = null;
        const fetchMock = mockAgentServer(
          () =>
            new Promise<Response>((resolve) => {
              release = () => resolve(jsonResponse(classified("data-analysis")));
            }),
        );
        const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
        fireEvent.click(view.getByTestId("agent-mode-agent"));

        await startWith(view);

        expect((view.getByTestId("agent-mode-planning") as HTMLButtonElement).disabled).toBe(true);
        expect((view.getByTestId("agent-mode-agent") as HTMLButtonElement).disabled).toBe(true);
        // Pressed anyway — a disabled button ignores it, and the mode the start was
        // asked for is the mode it opens in.
        fireEvent.click(view.getByTestId("agent-mode-planning"));
        expect(view.getByTestId("agent-mode-agent").getAttribute("aria-pressed")).toBe("true");

        await act(async () => {
          release?.();
        });
        // The consent step belongs to agent mode, and the rail still shows agent mode.
        expect(view.getByTestId("agent-consent")).toBeTruthy();
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
        });
        expect(openRequests(fetchMock)[0]).toMatchObject({ mode: "agent" });
      });

      test("the workflow axis is frozen with it, and both are live again after Cancel", async () => {
        const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
        mockClassifiedFetch(classified("data-analysis"));
        fireEvent.click(view.getByTestId("agent-mode-agent"));
        openAdvanced(view);

        await startWith(view);

        // Held at the consent step: neither axis may move under a start already asked
        // for, because the answer to that consent is about THIS mode and THIS workflow.
        expect((view.getByTestId("agent-workflow-operations") as HTMLButtonElement).disabled).toBe(true);
        expect((view.getByTestId("agent-mode-planning") as HTMLButtonElement).disabled).toBe(true);

        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-cancel"));
        });

        expect((view.getByTestId("agent-workflow-operations") as HTMLButtonElement).disabled).toBe(false);
        expect((view.getByTestId("agent-mode-planning") as HTMLButtonElement).disabled).toBe(false);
      });
    });

    /**
     * The classify request carries a ceiling of its own.
     *
     * The server bounds its model call so that no model failure blocks a start; a
     * browser `fetch` has no default timeout, so a response that never arrives would
     * strand this rail on "Reading your objective" with Start disabled and no way to
     * open any run short of reloading the page — reintroducing, in front of the same
     * button, the exact failure the server's bound exists to prevent.
     */
    test("a classify request that is never answered still opens a run", async () => {
      const realTimeout = AbortSignal.timeout;
      // Driven at 1ms rather than the rail's own ceiling: what is under test is that a
      // ceiling is WIRED to this request, not how many seconds it is.
      AbortSignal.timeout = ((ms: number) => {
        expect(ms).toBeGreaterThan(0);
        return realTimeout.call(AbortSignal, 1);
      }) as typeof AbortSignal.timeout;
      try {
        const fetchMock = mockAgentServer(
          (init) =>
            // A server that holds the connection and answers nothing, which is what a
            // proxy or a dropped socket looks like from here. The only thing that ends
            // it is the ceiling the rail attached to the request — with none, this
            // promise never settles and the rail never opens a run at all.
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            }),
        );
        const view = render(<AgentRail {...DEFAULT_PROPS} />);

        await startWith(view, "why is checkout slow");
        await waitFor(() => {
          expect(openRequests(fetchMock)).toHaveLength(1);
        });

        // The same answer every other classification failure reaches, and the rail is
        // idle again rather than stuck behind a request nobody will answer.
        expect(openRequests(fetchMock)[0]).toMatchObject({ workflowType: "investigation" });
        await waitFor(() => {
          expect(view.queryByTestId("agent-classifying")).toBeNull();
        });
      } finally {
        AbortSignal.timeout = realTimeout;
      }
    });

    test("plan mode never shows a consent step, whatever the classification says", async () => {
      // Planning is toolless, so `present_answer` is not in its tool set and there is
      // nothing for the user to consent to. The classification still happens: plan-mode
      // framing genuinely differs per workflow.
      const fetchMock = mockClassifiedFetch(classified("data-analysis"));
      const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);

      await startWith(view);

      expect(view.queryByTestId("agent-consent")).toBeNull();
      expect(openRequests(fetchMock)[0]).toMatchObject({
        mode: "planning",
        workflowType: "data-analysis",
        autoExecute: false,
      });
    });

    test("a workflow named under Advanced makes no classification request at all", async () => {
      const fetchMock = mockClassifiedFetch(classified("data-analysis"));
      const view = render(<AgentRail {...DEFAULT_PROPS} />);
      openAdvanced(view);
      fireEvent.click(view.getByTestId("agent-workflow-database-assessment"));

      await startWith(view, "how healthy is this database");

      expect(classifyCalls(fetchMock)).toHaveLength(0);
      expect(openRequests(fetchMock)[0]).toMatchObject({
        workflowType: "database-assessment",
        workflowSource: "chosen",
      });
      // And a run the user's own choice opened is offered no way out of it: there is
      // nothing to correct, and "change" would be the rail second-guessing them.
      expect(view.queryByTestId("agent-opened-as")).toBeNull();
    });

    test("the wait is said while the classification is in flight", async () => {
      let release: (() => void) | null = null;
      mockAgentServer(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(jsonResponse(classified("investigation")));
          }),
      );
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      await startWith(view, "why is checkout slow");

      expect(view.getByTestId("agent-classifying")).toBeTruthy();
      // And Start cannot be pressed a second time into the same wait.
      expect((view.getByTestId("agent-start") as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        release?.();
      });
      expect(view.queryByTestId("agent-classifying")).toBeNull();
    });

    test("a classification that failed still opens a run, and the header says it could not be read", async () => {
      // The classifier's own contract is that it never blocks a run. The network in
      // front of it can fail in ways it cannot, so the same answer is reached here.
      const fetchMock = mockClassifiedFetch({ error: "the model endpoint is unreachable" }, [STARTED_LINE], 500);
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      await startWith(view, "why is checkout slow");

      expect(openRequests(fetchMock)[0]).toMatchObject({
        workflowType: "investigation",
        workflowSource: "inferred",
      });
      const header = (await view.findByTestId("agent-opened-as")).textContent ?? "";
      expect(header).toContain("could not be classified");
      // The fallback is not presented as a verdict: the run investigates BECAUSE
      // nothing could be established, which is a different sentence from "this is an
      // investigation".
      expect(header).not.toContain("read from your objective");
    });

    test("a request the classifier never answered is the same fallback, not a broken start", async () => {
      const fetchMock = mockAgentServer(() => {
        throw new Error("network down");
      });
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      await startWith(view, "why is checkout slow");

      expect(openRequests(fetchMock)[0]).toMatchObject({ workflowType: "investigation" });
      expect((await view.findByTestId("agent-opened-as")).textContent).toContain("could not be classified");
      // Nothing is reported as an error: the run opened, and the user can see what it
      // opened as.
      expect(view.queryByTestId("agent-error")).toBeNull();
    });

    test("a workflow id this build does not know is not guessed at", async () => {
      // The route echoes the classifier verbatim, and a newer server could name a
      // workflow this browser has no label, no budget and no meaning for.
      const fetchMock = mockClassifiedFetch({ workflowType: "capacity-planning", outcome: "classified" });
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      await startWith(view, "why is checkout slow");

      expect(openRequests(fetchMock)[0]).toMatchObject({ workflowType: "investigation" });
      expect((await view.findByTestId("agent-opened-as")).textContent).toContain("could not be classified");
    });

    test("the pre-start ceilings are withheld under Automatic and stated for a workflow the user named", () => {
      const view = render(<AgentRail {...DEFAULT_PROPS} />);

      expect(view.queryByTestId("agent-budget-limits")).toBeNull();
      expect(view.getByTestId("agent-budget-unknown").textContent).toContain("per workflow");

      openAdvanced(view);
      fireEvent.click(view.getByTestId("agent-workflow-data-analysis"));

      // The workflow is known now, so the figures are the ones that workflow's runs are
      // actually held to.
      const analysis = AGENT_WORKFLOW_BUDGETS["data-analysis"];
      const limits = view.getByTestId("agent-budget-limits").textContent ?? "";
      expect(limits).toContain(`${(analysis.runDeadlineMs / 60_000).toFixed(1)} min`);
      expect(limits).toContain(`${analysis.maxModelTurns} model turns`);
      expect(view.queryByTestId("agent-budget-unknown")).toBeNull();
    });

    /**
     * "change" (§5 of the design).
     *
     * An opened run's workflow cannot be edited — there is deliberately no parameter
     * through which a workflow could arrive twice — so changing it is two acts, and
     * both of their consequences are stated where the control is rather than
     * discovered afterwards.
     */
    describe("change", () => {
      async function inferredRun() {
        const fetchMock = mockClassifiedFetch(classified("query-optimization"));
        const view = render(<AgentRail {...DEFAULT_PROPS} />);
        await startWith(view, "why is checkout slow");
        await view.findByTestId("agent-opened-as");
        return { view, fetchMock };
      }

      test("the two consequences are stated before the click, not after it", async () => {
        const { view } = await inferredRun();

        fireEvent.click(view.getByTestId("agent-opened-as-change"));
        const terms = view.getByTestId("agent-change-workflow-terms").textContent ?? "";
        expect(terms).toContain("stops this run");
        expect(terms).toContain("not instant");
        expect(terms).toContain("new id");
        expect(terms).toContain("stays in the ledger");
      });

      test("it stops the open run and opens a new one for the workflow the user picked", async () => {
        const { view, fetchMock } = await inferredRun();

        fireEvent.click(view.getByTestId("agent-opened-as-change"));
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-change-workflow-operations"));
        });

        // The same ask the Stop control makes, on the run that was open.
        expect(
          (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][]).some(
            ([url, init]) => String(url) === "/api/agent/runs/arun_1" && init?.method === "DELETE",
          ),
        ).toBe(true);
        // And a second run, for the workflow the user named, asking the same question
        // the first one was opened with — the box was emptied when that run opened.
        expect(openRequests(fetchMock)).toHaveLength(2);
        expect(openRequests(fetchMock)[1]).toMatchObject({
          workflowType: "operations",
          workflowSource: "chosen",
          objective: "why is checkout slow",
        });
        // Nothing is inferred for the second run, so nothing is asked of the model.
        expect(classifyCalls(fetchMock)).toHaveLength(1);
        // And it is the user's own choice now, so the way out is not offered again.
        expect(view.queryByTestId("agent-opened-as")).toBeNull();
      });

      test("changing to Analyze in agent mode asks for the hand-over consent, as any open does", async () => {
        const fetchMock = mockClassifiedFetch(classified("query-optimization"));
        const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
        fireEvent.click(view.getByTestId("agent-mode-agent"));
        await startWith(view, "why is checkout slow");
        await view.findByTestId("agent-opened-as");

        fireEvent.click(view.getByTestId("agent-opened-as-change"));
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-change-workflow-data-analysis"));
        });

        expect(view.getByTestId("agent-consent")).toBeTruthy();
        expect(openRequests(fetchMock)).toHaveLength(1);

        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-open"));
        });
        expect(openRequests(fetchMock)[1]).toMatchObject({
          workflowType: "data-analysis",
          workflowSource: "chosen",
        });
      });

      test("abandoning the consent step leaves the run that is open exactly as it was", async () => {
        // The cancellation belongs to the moment a replacement is actually opened. Fired
        // at the click that chose the workflow, it ended the run for a replacement that
        // never arrived — and since the objective box is emptied the moment a run opens,
        // the question was gone too, leaving the user nothing to ask again with.
        const fetchMock = mockClassifiedFetch(classified("query-optimization"));
        const view = render(<AgentRail {...DEFAULT_PROPS} onRunStatement={() => {}} />);
        fireEvent.click(view.getByTestId("agent-mode-agent"));
        await startWith(view, "why is checkout slow");
        await view.findByTestId("agent-opened-as");

        fireEvent.click(view.getByTestId("agent-opened-as-change"));
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-change-workflow-data-analysis"));
        });
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-consent-cancel"));
        });

        expect(deleteCalls(fetchMock)).toHaveLength(0);
        expect(openRequests(fetchMock)).toHaveLength(1);
        // Still the run it was, still saying what it opened as, still offering the way
        // out — the user has lost nothing by looking at the offer and declining it.
        expect(view.getByTestId("agent-opened-as").textContent).toContain("Opened as Optimize");
        expect(view.getByTestId("agent-opened-as-change")).toBeTruthy();
      });

      /**
       * A stop that the server did not accept.
       *
       * `run.cancel()` used to resolve whatever happened — it caught every failure,
       * reported it through `error` and returned normally — so awaiting it established
       * only that the DELETE had been ATTEMPTED. The replacement was then opened
       * regardless, and the run that was supposed to end kept going beside it: same
       * connection, its own budget, and a rail that had stopped following it. The copy
       * beside "change" promises a cancel-and-replace, so this is a promise the code
       * has to keep rather than describe.
       */
      test("a change whose stop the server refused opens nothing, and says the run is still going", async () => {
        const fetchMock = mockServerRefusingStop(classified("query-optimization"));
        const view = render(<AgentRail {...DEFAULT_PROPS} />);
        await startWith(view, "why is checkout slow");
        await view.findByTestId("agent-opened-as");

        fireEvent.click(view.getByTestId("agent-opened-as-change"));
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-change-workflow-operations"));
        });

        // The ask was made, and refused. Nothing was opened for it.
        expect(deleteCalls(fetchMock)).toHaveLength(1);
        expect(openRequests(fetchMock)).toHaveLength(1);
        // And the user is told, rather than left believing the run they asked to stop
        // has stopped: the server's own words are on the error line, and this says what
        // the rail did about them.
        expect(view.getByTestId("agent-change-failed").textContent).toContain("still going");
        expect(view.getByTestId("agent-error")).toBeTruthy();
        // The run they had is the run they still have, way out and all.
        expect(view.getByTestId("agent-opened-as").textContent).toContain("Opened as Optimize");
        expect(view.getByTestId("agent-opened-as-change")).toBeTruthy();
      });

      test("asking again clears the last attempt's failure before the new one is answered", async () => {
        const fetchMock = mockServerRefusingStop(classified("query-optimization"));
        const view = render(<AgentRail {...DEFAULT_PROPS} />);
        await startWith(view, "why is checkout slow");
        await view.findByTestId("agent-opened-as");

        fireEvent.click(view.getByTestId("agent-opened-as-change"));
        await act(async () => {
          fireEvent.click(view.getByTestId("agent-change-workflow-operations"));
        });
        expect(view.getByTestId("agent-change-failed")).toBeTruthy();

        fireEvent.click(view.getByTestId("agent-opened-as-change"));
        fireEvent.click(view.getByTestId("agent-change-workflow-database-assessment"));

        // Cleared at the click and set again only if this attempt fails too: a notice
        // about the previous ask standing over a request nobody has answered yet reads
        // as the answer to that one.
        expect(view.queryByTestId("agent-change-failed")).toBeNull();
        await act(async () => {});
        expect(deleteCalls(fetchMock)).toHaveLength(2);
      });

      test("a run that is over is not offered a change, because there is nothing to stop", async () => {
        mockClassifiedFetch(classified("query-optimization"), [STARTED_LINE, FINISHED_LINE]);
        const view = render(<AgentRail {...DEFAULT_PROPS} />);
        await startWith(view, "why is checkout slow");

        // The statement about what it opened as still stands — it is a fact about the
        // run — but the way out of it is gone with the run.
        await waitFor(() => {
          expect(view.getByTestId("agent-run-status").textContent).toBe("succeeded");
        });
        expect(view.getByTestId("agent-opened-as").textContent).toContain("Opened as Optimize");
        expect(view.queryByTestId("agent-opened-as-change")).toBeNull();
      });
    });
  });
});
