/**
 * One-shot invitation to star the repository, shown after the tenth successful
 * query in a browser and never again.
 *
 * Persistence is localStorage ONLY - deliberately not the storage layer. This is
 * a per-browser nudge rather than user data: it must never sync to a server and
 * must never enter the embedded platform's server-side storage schema.
 *
 * Nothing here talks to the network, and every localStorage access is wrapped:
 * a disabled or full store (Safari private mode, quota exceeded) degrades to
 * "never prompt". A star prompt must not be able to break a query run.
 */

const COUNT_KEY = "libredb_star_prompt_query_count";
const HANDLED_KEY = "libredb_star_prompt_handled";

/** Successful queries before the prompt is offered, once. */
export const STAR_PROMPT_QUERY_THRESHOLD = 10;

function isClient(): boolean {
  return typeof window !== "undefined";
}

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count one successful query. Returns true on the single run where the count
 * reaches the threshold and the prompt has not already been handled.
 */
export function recordQuerySuccess(): boolean {
  if (!isClient()) return false;
  if (readItem(HANDLED_KEY) !== null) return false;

  const parsed = Number.parseInt(readItem(COUNT_KEY) ?? "", 10);
  const current = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const next = current + 1;

  if (!writeItem(COUNT_KEY, String(next))) return false;
  return next === STAR_PROMPT_QUERY_THRESHOLD;
}

/** Mark the prompt handled - starred or declined, it is never shown again. */
export function dismissStarPrompt(): void {
  if (!isClient()) return;
  writeItem(HANDLED_KEY, "1");
}
