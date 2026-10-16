/**
 * The retry settings the provider unit tests build their providers with: no backoff.
 *
 * WHY. `withRetry` (`src/lib/llm/utils/retry.ts`) retries a retryable failure twice before it
 * gives up, and it WAITS between attempts: `DEFAULT_INITIAL_DELAY` is 1.000 ms and the multiplier
 * is 2, so 1.000 + 2.000 = 3.000 ms of real sleeping. MEASURED on main, with bun's junit reporter:
 * about twenty cases across the four provider files took 3.004 ms each, and those four files took
 * 12,2 to 18,3 s. None of those cases is about the backoff - they assert how a 500, a 429 or an
 * ECONNREFUSED is MAPPED to an LLM error class - so every one of those milliseconds was spent on
 * something the case does not check.
 *
 * It also put them at 60% of bun's 5.000 ms per-test budget, which is the reason this was looked
 * at: a case that spends three fifths of its budget sleeping fails on a busy machine for a reason
 * that has nothing to do with what it asserts.
 *
 * `initialDelay: 0` rather than `maxAttempts: 1`, on purpose: the retry path still runs three
 * times, so the number of attempts these cases make is the same as before. Only the waiting goes.
 *
 * WHAT THAT SENTENCE DOES NOT PROMISE, because it was measured and it does not hold: nothing in
 * this repository pins the DEFAULT attempt count. MEASURED - with `DEFAULT_MAX_ATTEMPTS` changed
 * from 3 to 1 in `src/lib/llm/utils/retry.ts`, all 89 cases of these four files and
 * `retry.test.ts` still pass. `retry.test.ts` does hold the retry behaviour, but every one of its
 * cases passes `maxAttempts` explicitly, so it holds the PARAMETER and not the default. The gap is
 * older than this change and this change does not widen it; it is named here so that a reader does
 * not take "the attempts are unchanged" for "something would notice if they changed".
 *
 * The backoff itself is held where it belongs, in `tests/unit/llm/retry.test.ts`, which asserts the
 * delays rather than living through them.
 */
export const NO_BACKOFF = Object.freeze({ initialDelay: 0 });
