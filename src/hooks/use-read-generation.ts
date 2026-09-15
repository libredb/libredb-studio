"use client";

import { useMemo, useRef } from "react";

/**
 * Which catalog read is the CURRENT one, as a counter (#789).
 *
 * A read writes its result when it settles, and a slow one settles after the reader has
 * already switched connections. Without a guard that write lands under whichever connection
 * is on screen, which is not merely stale: the object inventory DECORATES a list with kinds,
 * so connection A's kinds applied to connection B's list tag nothing where the names differ
 * and tag WRONGLY where they coincide, and the consumers then hide a row of B's or offer an
 * import into a view on the strength of a declaration about A. A stale result that HIDES
 * objects is worse than one that shows old ones.
 *
 * A counter rather than an `AbortSignal`, because the request is not the thing to cancel: a
 * deferred connection issues no request at all and still supersedes a read in flight, which
 * is what `supersede()` is for. What is being sequenced is the READ, not the socket.
 *
 * Stated once and used twice, deliberately. `src/hooks/use-connection-manager.ts` reads this
 * application's own routes and `src/workspace/hooks/use-connection-adapter.ts` calls back
 * into an embedded host whose latency is not ours to bound, and the embedded one shipped
 * without the guard because the rule lived inside the other hook rather than beside both.
 */
export interface ReadGeneration {
  /**
   * Begin a read, superseding anything in flight. The returned predicate answers whether
   * this read is still the current one, and EVERY write the read performs asks it first.
   */
  begin(): () => boolean;
  /** Supersede whatever is in flight without beginning a read of your own. */
  supersede(): void;
}

export function useReadGeneration(): ReadGeneration {
  const current = useRef(0);
  // Stable for the life of the hook: a caller holds it in a `useCallback` dependency list,
  // and an object rebuilt per render would re-create every read function around it.
  return useMemo(
    () => ({
      begin: () => {
        const generation = ++current.current;
        return () => current.current === generation;
      },
      supersede: () => {
        current.current++;
      },
    }),
    [],
  );
}
