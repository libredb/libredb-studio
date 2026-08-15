import { describe, expect, test } from "bun:test";
import { ArtifactStoreError, ExecutionArtifactStore } from "@/lib/db/operations/artifacts";

/**
 * Run-scoped execution artifacts (#328 T6). The store holds an allowed agent
 * execution's result in memory so a later agent turn can reference it without
 * re-running the statement, and it is bounded three ways: an explicit release
 * when the run ends (the deterministic path), a TTL for runs that never end,
 * and a hard entry cap so a flood of abandoned runs cannot grow without limit.
 * The cap is spent run-fairly: the run that reaches it gives up its own oldest
 * artifact, never another run's.
 *
 * There is no clock inside the store, exactly as `ExecutionBudgetTracker` has
 * none: every time-dependent method takes the caller's `nowMs`, so the TTL is
 * asserted here by arithmetic rather than by sleeping.
 */

const artifact = (correlationId: string, runId: string, createdAtMs: number, value: unknown = { rows: [] }) => ({
  correlationId,
  runId,
  operationId: "sql.query.read",
  createdAtMs,
  value,
});

describe("ExecutionArtifactStore construction", () => {
  test.each([
    ["ttlMs of zero", { ttlMs: 0, maxArtifacts: 4 }],
    ["a fractional ttlMs", { ttlMs: 1.5, maxArtifacts: 4 }],
    ["a NaN ttlMs", { ttlMs: Number.NaN, maxArtifacts: 4 }],
    ["maxArtifacts of zero", { ttlMs: 1_000, maxArtifacts: 0 }],
    ["a fractional maxArtifacts", { ttlMs: 1_000, maxArtifacts: 2.5 }],
  ])("refuses %s instead of silently disabling the bound", (_label, options) => {
    expect(() => new ExecutionArtifactStore(options)).toThrow(ArtifactStoreError);
  });
});

describe("ExecutionArtifactStore lifecycle", () => {
  test("stores an artifact and serves it back within its TTL", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 1_000, maxArtifacts: 4 });
    store.put(artifact("corr-1", "run-1", 5_000, { rows: [1, 2] }), 5_000);

    const found = store.get("corr-1", 5_999);
    expect(found?.value).toEqual({ rows: [1, 2] });
    expect(found?.runId).toBe("run-1");
    expect(store.size).toBe(1);
  });

  test("never serves an artifact past its TTL, even before a sweep reclaims it", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 1_000, maxArtifacts: 4 });
    store.put(artifact("corr-1", "run-1", 5_000), 5_000);

    // Expiry is decided by the deadline, not by whether anything has swept yet:
    // a stale result must not be readable just because no later call happened.
    expect(store.get("corr-1", 6_000)).toBeUndefined();
    expect(store.size).toBe(1);

    expect(store.sweep(6_000)).toBe(1);
    expect(store.size).toBe(0);
  });

  test("returns undefined for a correlation id it never held", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 1_000, maxArtifacts: 4 });
    expect(store.get("corr-absent", 1)).toBeUndefined();
  });

  test("refuses a second artifact under a correlation id it already holds", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 1_000, maxArtifacts: 4 });
    store.put(artifact("corr-1", "run-1", 5_000, { rows: ["first"] }), 5_000);

    // Overwriting would let one execution's result be served as another's, which
    // is precisely what a correlation id exists to prevent.
    expect(() => store.put(artifact("corr-1", "run-1", 5_100, { rows: ["second"] }), 5_100)).toThrow(
      ArtifactStoreError,
    );
    expect(store.get("corr-1", 5_100)?.value).toEqual({ rows: ["first"] });
  });

  test("lets a new artifact take the correlation id of an expired one", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 1_000, maxArtifacts: 4 });
    store.put(artifact("corr-1", "run-1", 1_000, { rows: ["first"] }), 1_000);

    // An expired entry is not a live artifact, so it must not be what refuses a
    // replacement - the sweep has to run before the uniqueness check, not after.
    // (Unreachable with real UUID keys; asserted because the ORDER is the
    // behaviour, and both orders execute the same lines.)
    store.put(artifact("corr-1", "run-1", 2_000, { rows: ["second"] }), 2_000);

    expect(store.get("corr-1", 2_000)?.value).toEqual({ rows: ["second"] });
    expect(store.size).toBe(1);
  });

  test.each([
    ["a blank correlation id", artifact("   ", "run-1", 1)],
    ["a blank run id", artifact("corr-1", "", 1)],
    ["a non-finite creation time", artifact("corr-1", "run-1", Number.POSITIVE_INFINITY)],
  ])("refuses %s", (_label, candidate) => {
    const store = new ExecutionArtifactStore({ ttlMs: 1_000, maxArtifacts: 4 });
    expect(() => store.put(candidate, 1)).toThrow(ArtifactStoreError);
  });

  test("releases every artifact of one run and leaves the others alone", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 10_000, maxArtifacts: 8 });
    store.put(artifact("corr-1", "run-1", 1_000), 1_000);
    store.put(artifact("corr-2", "run-1", 1_100), 1_100);
    store.put(artifact("corr-3", "run-2", 1_200), 1_200);

    expect(store.releaseRun("run-1")).toBe(2);
    expect(store.get("corr-1", 1_300)).toBeUndefined();
    expect(store.get("corr-2", 1_300)).toBeUndefined();
    expect(store.get("corr-3", 1_300)?.runId).toBe("run-2");
    expect(store.size).toBe(1);
  });

  test("releasing a run that holds nothing is a no-op, not an error", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 10_000, maxArtifacts: 8 });
    expect(store.releaseRun("run-never-seen")).toBe(0);
  });

  test("refuses a blank run id on release rather than sweeping something unintended", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 10_000, maxArtifacts: 8 });
    expect(() => store.releaseRun("  ")).toThrow(ArtifactStoreError);
  });

  test("sweeps expired artifacts on write, so an abandoned run cannot accumulate", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 1_000, maxArtifacts: 8 });
    store.put(artifact("corr-1", "abandoned-run", 1_000), 1_000);
    store.put(artifact("corr-2", "abandoned-run", 1_500), 1_500);

    store.put(artifact("corr-3", "live-run", 2_600), 2_600);

    expect(store.size).toBe(1);
    expect(store.get("corr-3", 2_600)?.runId).toBe("live-run");
  });

  test("evicts the oldest artifact when the entry cap is reached", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 2 });
    store.put(artifact("corr-1", "run-1", 1_000), 1_000);
    store.put(artifact("corr-2", "run-1", 1_100), 1_100);
    store.put(artifact("corr-3", "run-1", 1_200), 1_200);

    expect(store.size).toBe(2);
    expect(store.get("corr-1", 1_200)).toBeUndefined();
    expect(store.get("corr-2", 1_200)?.correlationId).toBe("corr-2");
    expect(store.get("corr-3", 1_200)?.correlationId).toBe("corr-3");
  });

  test("a busy run at the cap gives up its OWN oldest, so a quiet run keeps every artifact", () => {
    // The store is process-wide, so without this the run that reaches the cap
    // first pays for it with somebody else's evidence: a rail offering "Show
    // result" on a live run would 404 on a run that had done nothing wrong.
    const store = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 4 });
    store.put(artifact("quiet-1", "run-quiet", 1_000), 1_000);
    store.put(artifact("quiet-2", "run-quiet", 1_100), 1_100);
    store.put(artifact("busy-1", "run-busy", 1_200), 1_200);
    store.put(artifact("busy-2", "run-busy", 1_300), 1_300);

    store.put(artifact("busy-3", "run-busy", 1_400), 1_400);
    store.put(artifact("busy-4", "run-busy", 1_500), 1_500);

    expect(store.size).toBe(4);
    expect(store.get("quiet-1", 1_500)?.correlationId).toBe("quiet-1");
    expect(store.get("quiet-2", 1_500)?.correlationId).toBe("quiet-2");
    expect(store.get("busy-1", 1_500)).toBeUndefined();
    expect(store.get("busy-2", 1_500)).toBeUndefined();
    expect(store.get("busy-3", 1_500)?.correlationId).toBe("busy-3");
    expect(store.get("busy-4", 1_500)?.correlationId).toBe("busy-4");
  });

  test("falls back to the store's oldest when the storing run holds nothing to give up", () => {
    // The memory bound is the reason the cap exists at all, so a run storing its
    // FIRST artifact into a full store still stores it: run-fairness decides WHO
    // pays, it never lets the entry count past the cap.
    const store = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 2 });
    store.put(artifact("corr-1", "run-1", 1_000), 1_000);
    store.put(artifact("corr-2", "run-1", 1_100), 1_100);

    store.put(artifact("corr-3", "run-2", 1_200), 1_200);

    expect(store.size).toBe(2);
    expect(store.get("corr-1", 1_200)).toBeUndefined();
    expect(store.get("corr-2", 1_200)?.correlationId).toBe("corr-2");
    expect(store.get("corr-3", 1_200)?.runId).toBe("run-2");
  });
});
