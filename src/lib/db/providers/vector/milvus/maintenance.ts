/**
 * Load and Release, the only state changes the Milvus provider sends,
 * reached only through the admin-only, audited maintenance route and never from the console, the agent or MCP.
 *
 * Both are per-row operations with a preview: Load is confirmed plainly over the preview, and Release by the
 * collection's exact name. Read-only mode refuses both before any request, in etcd's sentences. One load at
 * a time per provider instance is Studio's own lock, because the server answers a second LoadCollection during a load
 * with Success; the preview and Load both refuse while GetLoadState answers LoadStateLoading, and Release is not
 * gated, so an administrator can still release a collection whose load does not finish.
 * LoadCollection returns in 15 to 103 ms and the load continues on the server, so Load then polls
 * GetLoadingProgress at once and every second for at most 10 s; a load the server continues after the poll is not
 * covered by the lock. A lost answer reads "may have been applied" and is never resent.
 */
import type { MaintenanceOperation, MaintenanceOperationSpec } from "@/lib/db/types";

/** Milvus's two operations, each its own member. */
export const MILVUS_MAINTENANCE_OPERATIONS: readonly MaintenanceOperation[] = ["load", "release"];

/** What Release does to every other client, the per-row control's description and the preview's summary. */
export const RELEASE_DESCRIPTION =
  "Every other client's search and query on this collection then fails with code 101 until it is loaded again.";

/** The two per-row specs: both previewed; Release confirmed by the collection's exact name. */
export const MILVUS_MAINTENANCE_SPECS: Partial<Record<MaintenanceOperation, MaintenanceOperationSpec>> = {
  load: { label: "Load", perEntity: true, global: false, preview: true },
  release: {
    label: "Release",
    perEntity: true,
    global: false,
    confirmation: "typed-target",
    preview: true,
    description: RELEASE_DESCRIPTION,
  },
};

/** The poll's interval and window: GetLoadingProgress reports only 0, 50 and 100. */
export const MILVUS_LOAD_POLL_MS = 1_000;
export const MILVUS_LOAD_WINDOW_MS = 10_000;

/**
 * One load at a time per provider instance: an in-memory FIFO lock, so per connection and per Studio process,
 * shared by every user of a shared seed. A waiter holds no limiter permit while it waits, and leaves the queue with
 * its signal's reason when that signal aborts, so `disconnect()` frees every waiter. A release given twice frees once.
 */
export class MilvusLoadLock {
  private locked = false;
  private readonly waiting: Array<() => void> = [];

  get held(): boolean {
    return this.locked;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const admit = (): void => {
        signal.removeEventListener("abort", leave);
        resolve(this.releaser());
      };
      const leave = (): void => {
        this.waiting.splice(this.waiting.indexOf(admit), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", leave, { once: true });
      this.waiting.push(admit);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.locked = false;
      else next();
    };
  }
}

/** The poll's pause, which holds no permit; an abort, the connection's close, ends it with the signal's reason. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
