/**
 * The idle sweep's two numbers, read by the provider factory's caches (./factory), a provider package's sessions among
 * the editor cache's entries: an entry unused for `IDLE_TIMEOUT_MS` is closed, checked every `SWEEP_INTERVAL_MS`.
 */

/** Idle timeout: an entry unused for 30 minutes is closed. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Sweep interval: idle entries are looked for every 5 minutes. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
