/**
 * The idle sweep's two numbers, shared by the provider factory's caches (./factory) and the package session cache
 * (./package-sessions), which each sweep their own entries on their own timer: an entry unused for `IDLE_TIMEOUT_MS` is
 * closed, checked every `SWEEP_INTERVAL_MS`.
 */

/** Idle timeout: an entry unused for 30 minutes is closed. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Sweep interval: idle entries are looked for every 5 minutes. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
