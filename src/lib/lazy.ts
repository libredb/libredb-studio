import { logger } from "@/lib/logger";

/**
 * Loading a code-split view, once retried.
 *
 * Splitting a view out of the first load moves its code from "already here" to "one
 * more request that can fail", and this product is deployed where that request is
 * least reliable: behind corporate proxies, on air-gapped networks, and — the case
 * that costs a user their place — across an upgrade. A tab left open still asks for
 * the chunk names the page was built with, and the container it is talking to has
 * replaced them, so the request 404s and the view never arrives.
 *
 * One retry, after a short delay, is what separates a transient blip from a genuinely
 * missing file. A second failure is reported to the boundary above, which can say so
 * (`src/components/LazyView.tsx`) instead of leaving a spinner running forever.
 */
const RETRY_DELAY_MS = 400;

export function lazyRetry<T>(load: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await load();
    } catch (error) {
      logger.warn("A split view did not load; retrying once", {
        route: "lazy",
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return load();
    }
  };
}
