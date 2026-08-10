/**
 * Run-scoped execution artifacts (#328).
 *
 * An allowed agent execution produces a result that a later turn may want to
 * reference without re-running the statement. Those results live here, in
 * process memory only: nothing is written through a storage provider, so this
 * milestone adds no new place where result data rests on disk and no new schema
 * to migrate. That is a deliberate limit, not an omission — persisting agent
 * results at rest raises encryption, retention and tenancy questions #328 does
 * not answer.
 *
 * Three bounds keep the map from growing without limit, in decreasing order of
 * determinism:
 *
 * 1. `releaseRun` — the normal path, called with the budget tracker's `endRun`
 *    when a run finishes. Everything that run produced is gone at that moment.
 * 2. TTL — the backstop for a run that never ends (an agent process dies, a
 *    caller forgets to release). An expired artifact is never served, whether
 *    or not anything has swept it yet, and `put` sweeps before it stores.
 * 3. `maxArtifacts` — a memory bound, evicting the oldest entry first. It is
 *    explicitly NOT a security control: dropping an artifact loses a result,
 *    it never grants access to one. (Contrast the rate limiter's capacity
 *    eviction, which `budgets.ts` rejected for budget accounting because
 *    restarting a counter at zero fails open.) It bounds the entry COUNT, so
 *    the worst-case footprint is `maxArtifacts` times whatever the execution
 *    profile's `maxResultBytes` admitted — the byte cap is enforced where the
 *    rows are read, not here.
 *
 * There is no clock in this module, for the same reason `ExecutionBudgetTracker`
 * has none: every time-dependent method takes the caller's `nowMs`, which keeps
 * expiry deterministic under test instead of sleep-dependent.
 */

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    Object.setPrototypeOf(this, ArtifactStoreError.prototype);
  }
}

export interface ExecutionArtifact<T = unknown> {
  /** The audit correlation id of the execution that produced it — the join key. */
  readonly correlationId: string;
  readonly runId: string;
  /** Registry-resolved operation id; never a caller-supplied string. */
  readonly operationId: string;
  readonly createdAtMs: number;
  readonly value: T;
}

export interface ExecutionArtifactStoreOptions {
  readonly ttlMs: number;
  readonly maxArtifacts: number;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ArtifactStoreError(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function assertIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArtifactStoreError(`${label} must be a non-empty string`);
  }
  return value;
}

export class ExecutionArtifactStore<T = unknown> {
  private readonly artifacts = new Map<string, ExecutionArtifact<T>>();
  private readonly ttlMs: number;
  private readonly maxArtifacts: number;

  constructor(options: ExecutionArtifactStoreOptions) {
    this.ttlMs = assertPositiveInteger(options.ttlMs, "ttlMs");
    this.maxArtifacts = assertPositiveInteger(options.maxArtifacts, "maxArtifacts");
  }

  put(artifact: ExecutionArtifact<T>, nowMs: number): void {
    assertIdentifier(artifact.correlationId, "correlationId");
    assertIdentifier(artifact.runId, "runId");
    if (typeof artifact.createdAtMs !== "number" || !Number.isFinite(artifact.createdAtMs)) {
      throw new ArtifactStoreError(`createdAtMs must be a finite number, got ${String(artifact.createdAtMs)}`);
    }
    // Sweep before the uniqueness check, not after: an entry that has already
    // expired is not a live artifact, so it must not be what refuses a new one.
    this.sweep(nowMs);
    if (this.artifacts.has(artifact.correlationId)) {
      throw new ArtifactStoreError(`artifact "${artifact.correlationId}" already exists — correlation ids are unique`);
    }
    // Map iteration is insertion order, and executions are stored as they
    // finish, so keys arrive oldest-first. Deleting the entry the loop is
    // currently on is well-defined for a Map iterator, and the size check
    // leads rather than follows so a store already under the cap deletes
    // nothing.
    for (const oldest of this.artifacts.keys()) {
      if (this.artifacts.size < this.maxArtifacts) break;
      this.artifacts.delete(oldest);
    }
    this.artifacts.set(artifact.correlationId, artifact);
  }

  /** Pure read: an expired artifact is invisible here and reclaimed by `sweep`. */
  get(correlationId: string, nowMs: number): ExecutionArtifact<T> | undefined {
    const artifact = this.artifacts.get(correlationId);
    if (!artifact) return undefined;
    return this.hasExpired(artifact, nowMs) ? undefined : artifact;
  }

  /** Deterministic cleanup: everything one run produced, released together. */
  releaseRun(runId: string): number {
    const id = assertIdentifier(runId, "runId");
    let released = 0;
    for (const [correlationId, artifact] of this.artifacts) {
      if (artifact.runId === id) {
        this.artifacts.delete(correlationId);
        released += 1;
      }
    }
    return released;
  }

  sweep(nowMs: number): number {
    let swept = 0;
    for (const [correlationId, artifact] of this.artifacts) {
      if (this.hasExpired(artifact, nowMs)) {
        this.artifacts.delete(correlationId);
        swept += 1;
      }
    }
    return swept;
  }

  get size(): number {
    return this.artifacts.size;
  }

  private hasExpired(artifact: ExecutionArtifact<T>, nowMs: number): boolean {
    return nowMs - artifact.createdAtMs >= this.ttlMs;
  }
}
