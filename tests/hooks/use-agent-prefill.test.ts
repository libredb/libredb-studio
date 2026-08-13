import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { useAgentPrefill } from "@/components/agent/use-agent-prefill";
import { AGENT_MAX_OBJECTIVE_LENGTH } from "@/lib/agent/execution-policy";

/**
 * The shell's half of the prefill seam (#331 T1): who owns an ask, and what an ask is.
 *
 * The rail's half is covered in `tests/components/agent/AgentRail.test.tsx`. What is
 * pinned here is the shape of the request itself, because T2, T3 and T4 all construct
 * one through this hook and a field added or dropped later would change what three
 * callers mean:
 *
 *  - An ask names a workflow and an objective. It does NOT name a mode — the epic's
 *    three axes are independent, and a shortcut that picked the execution mode too
 *    would be merging two of them behind one click.
 *  - An ask carries a monotonic id, so the same question asked twice is two asks. The
 *    rail applies any id it has not applied yet; without one, a second click on the
 *    same shortcut would be a value-identical prop and silently do nothing.
 *  - Asking starts nothing. There is no run, no request and no fetch here — only the
 *    Start button spends model tokens and reads a database.
 */

describe("useAgentPrefill", () => {
  test("nothing is asked for until a shortcut asks", () => {
    const { result } = renderHook(() => useAgentPrefill());

    expect(result.current.request).toBeNull();
  });

  test("an ask names the workflow and the objective, and nothing else", () => {
    const { result } = renderHook(() => useAgentPrefill());

    act(() => {
      result.current.requestPrefill("query-optimization", "why is checkout slow");
    });

    expect(result.current.request).toEqual({
      id: 1,
      workflowType: "query-optimization",
      objective: "why is checkout slow",
    });
    // Asserted as the full key set rather than field by field: a `mode` added here
    // later is exactly the merge of two independent axes this seam refuses.
    expect(Object.keys(result.current.request ?? {}).sort()).toEqual(["id", "objective", "workflowType"]);
  });

  test("the same question asked twice is two asks", () => {
    const { result } = renderHook(() => useAgentPrefill());

    act(() => {
      result.current.requestPrefill("investigation", "why is checkout slow");
    });
    expect(result.current.request?.id).toBe(1);

    act(() => {
      result.current.requestPrefill("investigation", "why is checkout slow");
    });

    expect(result.current.request?.id).toBe(2);
  });

  test("an ask longer than a run may carry is cut to what the route accepts", () => {
    // Review on #348: the objective box bounds TYPING through `maxLength`, and a
    // shortcut does not type. An editor statement is the ask T3 builds, and one longer
    // than this is ordinary — unclamped it reached a Start the start route then
    // refused, so the click failed for a reason the user was never shown.
    const { result } = renderHook(() => useAgentPrefill());

    act(() => {
      result.current.requestPrefill("query-optimization", "s".repeat(AGENT_MAX_OBJECTIVE_LENGTH + 500));
    });

    expect(result.current.request?.objective.length).toBe(AGENT_MAX_OBJECTIVE_LENGTH);
  });

  test("an ask the route would accept is left exactly as it was asked", () => {
    const { result } = renderHook(() => useAgentPrefill());
    const asked = "s".repeat(AGENT_MAX_OBJECTIVE_LENGTH);

    act(() => {
      result.current.requestPrefill("investigation", asked);
    });

    expect(result.current.request?.objective).toBe(asked);
  });

  test("the requester keeps its identity across renders", () => {
    // The rail applies an ask from an effect that lists this among its dependencies,
    // and every caller in T2/T3 is handed it as a prop. A fresh identity each render
    // would re-run that effect and re-render every one of those callers.
    const { result, rerender } = renderHook(() => useAgentPrefill());
    const first = result.current.requestPrefill;

    rerender();

    expect(result.current.requestPrefill).toBe(first);
  });
});
