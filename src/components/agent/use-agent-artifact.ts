"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentChartSpec } from "@/lib/agent/types";
import type { ExplainFormat } from "@/lib/db/types";
import { type AgentArtifactHydration, hydrateAgentArtifact } from "./hydration";

/**
 * Fetches one result a run stored, for the shell to hydrate (#329 T11).
 *
 * It lives beside the rail but is used by the SHELL, and that is the point: the rail
 * decides what a user may ask for, the shell owns the surfaces that render results,
 * and the request between them belongs to neither component's render. Nothing here
 * runs on its own — `show` is called from a user action and from nowhere else.
 *
 * Two things it deliberately does not do:
 *
 *  - **It does not retry.** A run's results live in process memory and are released
 *    when the run ends, so a refusal is usually final rather than transient, and
 *    asking again would only repeat it.
 *  - **It keeps no history.** One artifact is shown at a time; asking for another
 *    replaces it, and dismissing leaves the tab exactly as it was, because the tab's
 *    own result was never touched.
 */

export interface AgentArtifactReference {
  readonly runId: string;
  readonly correlationId: string;
  /**
   * How the run said to draw this result, for the one ask that has an answer behind
   * it. It comes from the run's ledger by way of the timeline, never from the rows
   * the route returns — which is what keeps the surface a decision the run recorded
   * rather than a guess about the data.
   */
  readonly chartSpec?: AgentChartSpec;
}

export interface AgentArtifactOptions {
  /** The connected provider's plan format, for a plan artifact. */
  readonly explainFormat: ExplainFormat | undefined;
  /** Called once an artifact is hydrated, so the caller can show that surface. */
  readonly onShown: (surface: AgentArtifactHydration["surface"]) => void;
  /** The app's own words about why a result could not be shown. */
  readonly onError: (message: string) => void;
}

export interface AgentArtifactHolder {
  readonly artifact: AgentArtifactHydration | null;
  readonly show: (reference: AgentArtifactReference) => Promise<void>;
  readonly dismiss: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAgentArtifact(options: AgentArtifactOptions): AgentArtifactHolder {
  const [artifact, setArtifact] = useState<AgentArtifactHydration | null>(null);
  /*
    Which ask the panel is showing. Two clicks in quick succession would otherwise be
    last-RESPONSE-wins, and the shown artifact would be whichever server answer
    happened to arrive last rather than the one the user asked for last. A failure is
    still reported when it is superseded: that ask really did fail, and saying so is
    true regardless of what the newer one went on to do.
  */
  const latestAsk = useRef(0);

  const show = async ({ runId, correlationId, chartSpec }: AgentArtifactReference): Promise<void> => {
    const ask = latestAsk.current + 1;
    latestAsk.current = ask;
    try {
      const res = await fetch(
        `/api/agent/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(correlationId)}`,
      );
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : `This result could not be read (${res.status})`);
      }
      const hydrated = hydrateAgentArtifact(body, options.explainFormat, chartSpec);
      if (hydrated === null) throw new Error("The server answered with a result this build cannot read");
      if (ask !== latestAsk.current) return;
      setArtifact(hydrated);
      options.onShown(hydrated.surface);
    } catch (error) {
      options.onError(messageFor(error));
    }
  };

  /*
    Dismissing INVALIDATES whatever is in flight, and that is the half that makes it a
    dismissal rather than a clear: a request already on its way would otherwise still
    satisfy the sequencing check and put the artifact back — and switch the panel to
    it — after the user had taken it away. The ordinary sequence that produces exactly
    that is "click Show, then run a query".

    Stable across renders on purpose: the shell dismisses from an effect keyed on the
    tab's own state, and a fresh identity each render would re-run that effect, taking
    the artifact away in the render right after it arrived.
  */
  const dismiss = useCallback(() => {
    latestAsk.current += 1;
    setArtifact(null);
  }, []);

  return { artifact, show, dismiss };
}
