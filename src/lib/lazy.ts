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
 * missing file. A second failure is reported to the boundary above as a
 * `ChunkLoadError`, which can say so
 * (`src/components/LazyView.tsx`) instead of leaving a spinner running forever.
 */
const RETRY_DELAY_MS = 400;

/**
 * A view's code that did not arrive: what `lazyRetry` throws after its retry, and what
 * a view that fetches a library of its own throws when that fetch fails.
 *
 * Its own class because the boundary that catches it (`ChunkBoundary`) must tell it
 * from a view that threw while drawing, and the error's message cannot: a production
 * React or TanStack render error can have none at all. Only this one is answered with
 * Reload; the failure it wraps is kept as `cause`.
 */
export class ChunkLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChunkLoadError";
  }

  /** The failure of a load, whatever was rejected, as one of these. */
  static from(failure: unknown): ChunkLoadError {
    return new ChunkLoadError(failure instanceof Error ? failure.message : String(failure), { cause: failure });
  }
}

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
      try {
        return await load();
      } catch (second) {
        throw ChunkLoadError.from(second);
      }
    }
  };
}
