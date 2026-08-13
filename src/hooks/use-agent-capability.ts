"use client";

import { useEffect, useState } from "react";
import { logger } from "@/lib/logger";

/**
 * Discovers whether this server runs agents (#329 T10a).
 *
 * The same shape as the storage-mode discovery in `use-storage-sync.ts`: everything
 * that decides the answer is server-side only and the standalone pages are statically
 * prerendered, so the answer has to come from the running server rather than from the
 * bundle. Since #331 T5 that answer is derived — a model configuration plus a writable
 * ledger path — and the route reports which condition is missing, but this hook still
 * reads only `enabled`, because the rail renders nothing either way.
 *
 * Everything that is not an explicit `enabled: true` resolves to off — a refusal, an
 * unreachable server, a body of another shape. The surface this gates starts
 * model-driven database work, so "we could not tell" has to mean absent, not
 * present-and-probably-broken.
 *
 * A boolean, and deliberately not a `{ enabled, isResolved }` pair: nothing renders
 * differently between "not asked yet" and "answered no", so a resolved flag would be
 * a declared-but-unread field. `WorkspaceFeatures.inlineEditing` in
 * `src/workspace/types.ts` is deprecated for being exactly that, which is the state
 * this repository avoids. Cited by symbol rather than by line: the reference has
 * drifted twice, both times because an unrelated edit moved the docblock it points at.
 */
export function useAgentCapability(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function probe(): Promise<void> {
      try {
        const res = await fetch("/api/agent/config");
        if (cancelled) return;
        if (!res.ok) return;
        const body = (await res.json()) as { enabled?: unknown };
        if (cancelled) return;
        setEnabled(body.enabled === true);
      } catch (error) {
        // Debug, not warn: a server without the route is the ordinary case for
        // every deployment that has not enabled the runtime.
        logger.debug("Agent capability probe failed; the agent surface stays hidden", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
