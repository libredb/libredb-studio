/**
 * Freshness of the governance snapshot (docs/GOVERNANCE.md#freshness-and-readiness): which state Studio is in, and
 * whether data routes may be served.
 *
 * The state follows from the last successful load, the failure of the latest load when it failed,
 * `GOVERNANCE_REFRESH_MS` and `GOVERNANCE_MAX_STALENESS_MS`:
 *
 * - `misconfigured` while the latest load found an object, a column, the schema or a privilege missing (SQLSTATE 42P01,
 *   42501, 3F000 or 42703), or no usable keyring, and `incompatible` while it found no contract version both sides
 *   publish. Both stop data routes at once, even with a fresh snapshot, because the governance source is not what
 *   Studio can read.
 * - `loading` until a load succeeds.
 * - `unavailable` once the snapshot is `GOVERNANCE_MAX_STALENESS_MS` old, whatever kept it from being reloaded.
 * - `degraded` once the snapshot is `GOVERNANCE_REFRESH_MS` old and the latest reload failed.
 * - `ok` otherwise: younger than the refresh interval, or reloaded by a notification, or past the interval while its
 *   reload is still running.
 *
 * Data routes are served in `ok` and `degraded` only. Like `state.ts`, this module imports no `pg` and no Node
 * built-in, so any route can ask it.
 */
import { governanceMaxStalenessMs, governanceRefreshMs } from "./config";
import type { FRESHNESS_STATES } from "./contract";
import { type GovernanceState, governanceState, type LoadFailure } from "./state";

export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/**
 * The SQLSTATEs of a governance source that lacks a table or view (42P01), a privilege (42501), a schema (3F000) or a
 * column (42703). PostgreSQL reports a schema missing from a qualified name as 42P01, and a schema without USAGE as
 * 42501, so each of them names what to fix.
 */
const MISCONFIGURED_SQLSTATES: ReadonlySet<string> = new Set(["42P01", "42501", "3F000", "42703"]);

/** The states in which data routes are served. */
const SERVABLE: ReadonlySet<FreshnessState> = new Set(["ok", "degraded"]);

/** The variable that names the keyring file: what a keyring failure says in public, instead of the file's path. */
const KEYRING_VARIABLE = "GOVERNANCE_PRIVATE_KEYS_FILE";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The driver's code of an error: a SQLSTATE, or a Node error code such as ECONNREFUSED. */
function codeOf(error: unknown): string | null {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * The SQLSTATE of an error the server sent. `pg` hands it over with the server's severity, which a Node socket error
 * never has, so a five-letter Node code such as EPIPE is never read as one.
 */
function sqlstateOf(error: unknown): string | null {
  const severity = (error as { readonly severity?: unknown } | null | undefined)?.severity;
  return typeof severity === "string" ? codeOf(error) : null;
}

/**
 * A read of the snapshot that failed. The message names the object Studio read, as `<schema>.<object>`, then the
 * driver's message and the SQLSTATE, because a server's own message names a view without its schema and a column
 * without its view.
 */
export class SnapshotReadError extends Error {
  constructor(
    readonly object: string,
    cause: unknown,
  ) {
    const sqlstate = sqlstateOf(cause);
    super(`${object}: ${messageOf(cause)}${sqlstate === null ? "" : ` (SQLSTATE ${sqlstate})`}`, { cause });
    this.name = "SnapshotReadError";
  }
}

/** The governance source publishes no contract version this Studio supports. The message lists both sets. */
export class IncompatibleContractError extends Error {
  constructor(supported: readonly number[], published: readonly number[]) {
    super(
      `no common contract version: Studio supports [${supported.join(", ")}], the governance source publishes [${published.join(", ")}]`,
    );
    this.name = "IncompatibleContractError";
  }
}

/**
 * The keyring that opens sealed credentials did not load. Defence in depth only: the boot preflight refuses to start
 * without a keyring that loads, and the keyring is read once, at start. The message is the keyring's own, which names
 * GOVERNANCE_PRIVATE_KEYS_FILE and the reason and never key material.
 */
export class KeyringUnavailableError extends Error {
  constructor(cause: unknown) {
    super(messageOf(cause), { cause });
    this.name = "KeyringUnavailableError";
  }
}

/**
 * What a failed load reports, for the error it failed with. `publicDetail` is built from Studio's own words only: the
 * object it read with the driver's code, the keyring variable, or the version sets, which Studio itself listed.
 */
export function loadFailureOf(error: unknown, at: number): LoadFailure {
  if (error instanceof IncompatibleContractError) {
    return { at, kind: "incompatible", code: null, detail: error.message, publicDetail: error.message };
  }
  if (error instanceof KeyringUnavailableError) {
    return { at, kind: "misconfigured", code: null, detail: error.message, publicDetail: KEYRING_VARIABLE };
  }
  if (error instanceof SnapshotReadError) {
    const sqlstate = sqlstateOf(error.cause);
    const code = codeOf(error.cause);
    return {
      at,
      kind: MISCONFIGURED_SQLSTATES.has(sqlstate ?? "") ? "misconfigured" : "transient",
      code,
      detail: error.message,
      publicDetail: code === null ? error.object : `${error.object}: ${code}`,
    };
  }
  const code = codeOf(error);
  return { at, kind: "transient", code, detail: messageOf(error), publicDetail: code ?? "load failed" };
}

function freshnessOf({ snapshot, failure }: GovernanceState, nowMs: number): FreshnessState {
  if (failure !== null && failure.kind !== "transient") return failure.kind;
  if (snapshot === null) return "loading";
  const ageMs = nowMs - snapshot.loadedAt;
  if (ageMs >= governanceMaxStalenessMs()) return "unavailable";
  return failure !== null && ageMs >= governanceRefreshMs() ? "degraded" : "ok";
}

/** The freshness state of this process at `nowMs`. */
export function governanceFreshness(nowMs = Date.now()): FreshnessState {
  return freshnessOf(governanceState(), nowMs);
}

/**
 * Whether data routes may be served at `nowMs`: only in `ok` and `degraded`. Under governance every other state
 * answers 503 GOVERNANCE_UNAVAILABLE. Without governance nothing is loaded, so this answers false; callers ask it
 * under governance only.
 */
export function governanceServable(nowMs = Date.now()): boolean {
  return SERVABLE.has(governanceFreshness(nowMs));
}
