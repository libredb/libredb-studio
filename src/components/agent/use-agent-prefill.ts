"use client";

import { useCallback, useState } from "react";
import { AGENT_MAX_OBJECTIVE_LENGTH } from "@/lib/agent/execution-policy";
import type { AgentRunWorkflowType } from "@/lib/agent/types";

/**
 * The prefill seam (#331 T1): how a shortcut somewhere else in the shell opens the
 * rail already asking the right question.
 *
 * It lives beside the rail but the state is the SHELL's, and that is the point: a
 * shortcut can be anywhere in the shell — the command palette, the mobile header, a
 * bottom-panel tab — while the rail is one instance behind both of its presentations.
 * So the shell owns the ask and the rail consumes it as a prop, which is the direction
 * the sheet's own open state already runs in rather than a second ownership rule
 * invented beside it.
 *
 * Three decisions are made here rather than at each caller, because T2, T3 and T4 all
 * construct an ask through this and a decision made per caller is a decision made
 * three ways:
 *
 *  - **An ask carries a workflow and an objective, and nothing about the MODE.** The
 *    epic's three axes — execution mode, workflow type, connection scope — are
 *    independent, and a shortcut that also chose how the run executes would be merging
 *    two of them behind one click. Whichever mode the user chose stays chosen.
 *  - **An ask carries a monotonic id.** Two consecutive clicks on the same shortcut
 *    are two asks and both must take effect; a request compared by value would make
 *    the second one a prop that did not change, and the click would silently do
 *    nothing.
 *  - **Asking starts nothing.** There is no run here and the rail starts none when it
 *    applies one: only the Start button spends model tokens and reads a database, and
 *    a shortcut that turned one click into both would be a different feature.
 */

export interface AgentPrefillRequest {
  /**
   * Which ask this is. The rail applies any id it has not applied yet, so this is an
   * identity rather than a counter anyone reads — the same question asked twice
   * differs here and nowhere else.
   */
  readonly id: number;
  /** What the run is FOR. A visible control the user can still change. */
  readonly workflowType: AgentRunWorkflowType;
  /**
   * What to ask, which the rail may only OFFER if the user is already typing.
   *
   * Never longer than `AGENT_MAX_OBJECTIVE_LENGTH`: an ask is built from something the
   * shell already has — an editor's statement, a panel's question — and none of those
   * is bounded the way the objective box is.
   */
  readonly objective: string;
}

export interface AgentPrefillHolder {
  readonly request: AgentPrefillRequest | null;
  readonly requestPrefill: (workflowType: AgentRunWorkflowType, objective: string) => void;
}

export function useAgentPrefill(): AgentPrefillHolder {
  const [request, setRequest] = useState<AgentPrefillRequest | null>(null);

  /*
    Stable across renders, and the id is read from the previous request rather than
    from a dependency: every caller is handed this as a prop and the rail lists it
    among an effect's dependencies, so a fresh identity each render would re-render
    each of those callers and re-run that effect.
  */
  const requestPrefill = useCallback((workflowType: AgentRunWorkflowType, objective: string) => {
    /*
      Clamped HERE, where an ask is minted, rather than at each place the rail writes
      one into the box. The rail writes it in two: the applied branch and the offer's
      Replace control, and a bound enforced at both is a bound that can be enforced at
      one of them. Found by review on #348: the box's own `maxLength` binds typing and
      nothing else, so a shortcut could put the rail into a state its UI forbids and
      the start route then refuses — a Start that fails for a reason the user was
      never shown. Truncating keeps the shortcut working and leaves the result in an
      editable box the user reads before pressing anything.
    */
    const bounded = objective.slice(0, AGENT_MAX_OBJECTIVE_LENGTH);
    setRequest((previous) => ({ id: (previous?.id ?? 0) + 1, workflowType, objective: bounded }));
  }, []);

  return { request, requestPrefill };
}
