import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor, act } from "@testing-library/react";
import { AgentRail } from "@/components/agent/AgentRail";

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
      objective: "why is checkout slow",
      connectionId: "seed:sales",
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
    const { getByTestId, findByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

    fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
    await act(async () => {
      fireEvent.click(getByTestId("agent-start"));
    });

    expect((await findByTestId("agent-error")).textContent).toContain("500");
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
    test("an untouched meter shows the ceilings this server enforces", () => {
      const { getByTestId } = render(<AgentRail {...DEFAULT_PROPS} />);

      expect(getByTestId("agent-budget-statements").textContent).toContain("0 / 20");
      expect(getByTestId("agent-budget-database-time").textContent).toContain("0.0 / 60.0 s");
      expect(getByTestId("agent-budget-repairs").textContent).toContain("0 / 3");
    });

    test("a run's consumption comes from its ledger", async () => {
      mockAgentFetch([OPENED_LINE, STARTED_LINE, COMPLETED_LINE]);
      const { getByTestId, findByText } = render(<AgentRail {...DEFAULT_PROPS} />);
      fireEvent.change(getByTestId("agent-objective"), { target: { value: "why is checkout slow" } });
      await act(async () => {
        fireEvent.click(getByTestId("agent-start"));
      });

      await findByText("1 / 20");
      expect(getByTestId("agent-budget-database-time").textContent).toContain("1.5 / 60.0 s");
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

      await findByText("90.0 / 60.0 s");
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

      const limits = getByTestId("agent-budget-limits").textContent ?? "";
      expect(limits).toContain("10.0 s");
      expect(limits).toContain("5.0 min");
      expect(limits).toContain("16");
      expect(getByTestId("agent-budget-caveats").textContent).toContain("per drive");
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
