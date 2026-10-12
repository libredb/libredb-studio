/**
 * A route's request, gone, as a cancel of the one run it bound.
 *
 * A browser that closes the tab or drops the request aborts `request.signal`, and nothing else tells the provider:
 * the statement would run on until its own deadline. This sends `cancelQuery(queryId)` once, for the id the route
 * itself handed the provider, so it needs no owner check (`POST /api/db/cancel` keeps its own rule, see that route).
 * It fires and forgets: the route never waits on the cancel, and a rejected cancel is logged by route alone, because
 * its message can carry a server's text.
 */
import { supportsQueryCancel } from "@/lib/db/query-cancel";
import { logger } from "@/lib/logger";

export function bridgeAbortToCancel(
  signal: AbortSignal,
  provider: object,
  queryId: string | undefined,
  route: string,
): () => void {
  if (queryId === undefined || !supportsQueryCancel(provider)) return () => {};
  let sent = false;
  const cancel = () => {
    if (sent) return;
    sent = true;
    provider.cancelQuery(queryId).catch(() => {
      logger.warn("The cancel sent after the request was aborted failed", { route });
    });
  };
  if (signal.aborted) {
    cancel();
    return () => {};
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}
