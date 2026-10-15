/**
 * Freshness of the governance snapshot (spec 7.5): the state Studio is in follows from its last successful load, the
 * failure of its latest load when there is one, `GOVERNANCE_REFRESH_MS` and `GOVERNANCE_MAX_STALENESS_MS`, and only
 * `ok` and `degraded` serve data routes.
 *
 * Each case records loads in the state holder the way the loader does and reads the state at a chosen time, so every
 * boundary is checked to the millisecond.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  governanceFreshness,
  governanceServable,
  IncompatibleContractError,
  KeyringUnavailableError,
  loadFailureOf,
  SnapshotReadError,
} from "@/lib/governance/freshness";
import {
  type GovernanceSnapshot,
  type LoadFailure,
  recordGovernanceFailure,
  recordGovernanceSnapshot,
  resetGovernanceState,
} from "@/lib/governance/state";

const T = Date.parse("2026-10-15T08:00:00.000Z");

/** A snapshot loaded at `loadedAt` with nothing in it: freshness reads only its load time. */
const snapshotAt = (loadedAt: number): GovernanceSnapshot => ({
  loadedAt,
  contractVersion: 1,
  publishedVersions: [1],
  connections: new Map(),
  skipped: [],
  grants: new Map(),
  revocations: new Map(),
  settings: [],
  canaries: [],
});

const transientAt = (at: number): LoadFailure => ({
  at,
  kind: "transient",
  code: "ECONNREFUSED",
  detail: "connect ECONNREFUSED 10.0.0.5:5432",
});

const ENV_KEYS = ["GOVERNANCE_REFRESH_MS", "GOVERNANCE_MAX_STALENESS_MS"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  resetGovernanceState();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("freshness states", () => {
  test("a failing reload keeps serving as degraded until GOVERNANCE_MAX_STALENESS_MS and then reports unavailable", () => {
    recordGovernanceSnapshot(snapshotAt(T));
    expect(governanceFreshness(T + 29_999)).toBe("ok");

    // The regular reload, 30 s after the load, fails.
    recordGovernanceFailure(transientAt(T + 30_000));

    expect(governanceFreshness(T + 30_000)).toBe("degraded");
    expect(governanceServable(T + 30_000)).toBe(true);
    expect(governanceFreshness(T + 119_999)).toBe("degraded");
    expect(governanceServable(T + 119_999)).toBe(true);
    expect(governanceFreshness(T + 120_000)).toBe("unavailable");
    expect(governanceServable(T + 120_000)).toBe(false);
  });

  test("the configured refresh interval and maximum staleness set the boundaries", () => {
    process.env.GOVERNANCE_REFRESH_MS = "5000";
    process.env.GOVERNANCE_MAX_STALENESS_MS = "20000";
    recordGovernanceSnapshot(snapshotAt(T));
    recordGovernanceFailure(transientAt(T + 1000));

    expect(governanceFreshness(T + 4999)).toBe("ok");
    expect(governanceFreshness(T + 5000)).toBe("degraded");
    expect(governanceFreshness(T + 19_999)).toBe("degraded");
    expect(governanceFreshness(T + 20_000)).toBe("unavailable");
  });

  test("a snapshot younger than the refresh interval is ok even when a reload after it failed", () => {
    recordGovernanceSnapshot(snapshotAt(T));
    recordGovernanceFailure(transientAt(T + 1000));

    expect(governanceFreshness(T + 1000)).toBe("ok");
    expect(governanceServable(T + 1000)).toBe(true);
  });

  test("a snapshot past the refresh interval with no failed reload is ok while its reload runs, and unavailable at the maximum staleness", () => {
    recordGovernanceSnapshot(snapshotAt(T));

    expect(governanceFreshness(T + 45_000)).toBe("ok");
    expect(governanceFreshness(T + 120_000)).toBe("unavailable");
  });

  test("no successful load since the start is loading, whatever the failures before it", () => {
    expect(governanceFreshness(T)).toBe("loading");
    expect(governanceServable(T)).toBe(false);

    recordGovernanceFailure(transientAt(T));

    expect(governanceFreshness(T + 600_000)).toBe("loading");
    expect(governanceServable(T + 600_000)).toBe(false);
  });

  test("misconfigured and incompatible stop serving at once, even with a fresh snapshot, until a load succeeds", () => {
    recordGovernanceSnapshot(snapshotAt(T));
    recordGovernanceFailure({ at: T + 1, kind: "misconfigured", code: "42501", detail: "bridge.grants_v1: denied" });
    expect(governanceFreshness(T + 1)).toBe("misconfigured");
    expect(governanceServable(T + 1)).toBe(false);

    recordGovernanceFailure({ at: T + 2, kind: "incompatible", code: null, detail: "no common contract version" });
    expect(governanceFreshness(T + 2)).toBe("incompatible");
    expect(governanceServable(T + 2)).toBe(false);

    recordGovernanceSnapshot(snapshotAt(T + 3));
    expect(governanceFreshness(T + 3)).toBe("ok");
    expect(governanceServable(T + 3)).toBe(true);
  });

  test("without an explicit time the state is read at the current time", () => {
    recordGovernanceSnapshot(snapshotAt(Date.now()));

    expect(governanceFreshness()).toBe("ok");
    expect(governanceServable()).toBe(true);
  });
});

describe("the failure of a load", () => {
  /** A read refused by the server: `pg` hands over its SQLSTATE with the server's severity. */
  const read = (code: string, message: string) =>
    new SnapshotReadError("bridge.grants_v1", Object.assign(new Error(message), { code, severity: "ERROR" }));

  test.each([
    ["42P01", 'relation "bridge.grants_v1" does not exist'],
    ["42501", "permission denied for view grants_v1"],
    ["3F000", 'schema "bridge" does not exist'],
    ["42703", 'column "downgraded" does not exist'],
  ])("SQLSTATE %s is misconfigured and names the object it read", (code, message) => {
    expect(loadFailureOf(read(code, message), T)).toEqual({
      at: T,
      kind: "misconfigured",
      code,
      detail: `bridge.grants_v1: ${message} (SQLSTATE ${code})`,
    });
  });

  test("any other SQLSTATE of a read is transient and still names the object", () => {
    expect(loadFailureOf(read("57014", "canceling statement due to statement timeout"), T)).toEqual({
      at: T,
      kind: "transient",
      code: "57014",
      detail: "bridge.grants_v1: canceling statement due to statement timeout (SQLSTATE 57014)",
    });
  });

  test("a socket error during a read is transient with its Node code, and is never read as a SQLSTATE", () => {
    const broken = new SnapshotReadError(
      "bridge.grants_v1",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );

    expect(loadFailureOf(broken, T)).toEqual({
      at: T,
      kind: "transient",
      code: "EPIPE",
      detail: "bridge.grants_v1: write EPIPE",
    });
  });

  test("a read that failed with no driver code is transient and names the object", () => {
    const error = new SnapshotReadError("bridge.contract", new Error("Query read timeout"));

    expect(loadFailureOf(error, T)).toEqual({
      at: T,
      kind: "transient",
      code: null,
      detail: "bridge.contract: Query read timeout",
    });
  });

  test("a read that failed with something other than an Error keeps its text", () => {
    expect(loadFailureOf(new SnapshotReadError("bridge.contract", "socket hang up"), T).detail).toBe(
      "bridge.contract: socket hang up",
    );
  });

  test("no common contract version is incompatible and lists both version sets", () => {
    expect(loadFailureOf(new IncompatibleContractError([1], [2, 3]), T)).toEqual({
      at: T,
      kind: "incompatible",
      code: null,
      detail: "no common contract version: Studio supports [1], the governance source publishes [2, 3]",
    });
  });

  test("a keyring that does not load is misconfigured with the keyring's own reason", () => {
    const cause = new Error('GOVERNANCE_PRIVATE_KEYS_FILE "/etc/libredb/keyring.json" holds no keys');

    expect(loadFailureOf(new KeyringUnavailableError(cause), T)).toEqual({
      at: T,
      kind: "misconfigured",
      code: null,
      detail: 'GOVERNANCE_PRIVATE_KEYS_FILE "/etc/libredb/keyring.json" holds no keys',
    });
  });

  test("a connection that failed is transient with the driver's code, and a value that is no Error with its text", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });

    expect(loadFailureOf(refused, T)).toEqual({
      at: T,
      kind: "transient",
      code: "ECONNREFUSED",
      detail: "connect ECONNREFUSED 10.0.0.5:5432",
    });
    expect(loadFailureOf(new Error("timeout exceeded when trying to connect"), T)).toEqual({
      at: T,
      kind: "transient",
      code: null,
      detail: "timeout exceeded when trying to connect",
    });
    expect(loadFailureOf("unexpected", T)).toEqual({ at: T, kind: "transient", code: null, detail: "unexpected" });
  });
});
