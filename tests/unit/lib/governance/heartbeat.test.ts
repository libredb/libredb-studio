/**
 * The governance heartbeat (docs/GOVERNANCE.md#heartbeat): every 30 s each instance upserts its row of
 * `studio_instances_v1` with the statement the manifest publishes, carrying its id, version, contract versions, key
 * ids, listener state, the snapshot's load time, the skipped rows by ids and codes only, the sink state and the canary
 * results.
 *
 * `pg` is the fake of tests/helpers/governance/pg-fake.ts, so each beat's statement and parameters are seen. The
 * listener is replaced by a status this file sets, as in status.test.ts, and the shapes of the JSON columns are checked
 * against the JSON Schema documents the manifest publishes, not against the zod schemas they were generated from.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AdmissionSkip } from "@/lib/governance/admission";
import type { GovernanceListenerStatus } from "@/lib/governance/listener";
import type { GovernanceSnapshot } from "@/lib/governance/state";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../../helpers/governance/keyring-file";
import { type FakeClient, FakePool, fakePg, nodeError, settle } from "../../../helpers/governance/pg-fake";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: realPg.Client, types: realPg.types }));
let listenerStatus: GovernanceListenerStatus | null = null;
mock.module("@/lib/governance/listener", () => ({ governanceListenerStatus: () => listenerStatus }));

const { sendGovernanceHeartbeat, startGovernanceHeartbeat, stopGovernanceHeartbeat } = await import(
  "@/lib/governance/heartbeat"
);
const { buildHeartbeatUpsert, HEARTBEAT_COLUMNS } = await import("@/lib/governance/contract");
const { closeGovernancePool } = await import("@/lib/governance/db");
const { governanceFreshness } = await import("@/lib/governance/freshness");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");
const { resetGovernanceKeyring } = await import("@/lib/governance/keyring");
const { validateSettings } = await import("@/lib/governance/settings");
const { logger } = await import("@/lib/logger");

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface Manifest {
  readonly statements: readonly { readonly id: string; readonly sql: string }[];
  readonly heartbeat: Record<"skipped" | "sink" | "canary", { readonly schema: Record<string, unknown> }>;
}

const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/governance/contract-v1.json"), "utf8"),
) as Manifest;

const MANIFEST_UPSERT = MANIFEST.statements.find((statement) => statement.id === "heartbeat.upsert")?.sql;

/** A validator built from a JSON Schema document the manifest publishes (see governance-contract-manifest.test.ts). */
const validatorFor = (name: keyof Manifest["heartbeat"]) => {
  const parsed = z.fromJSONSchema(MANIFEST.heartbeat[name].schema);
  return (value: unknown): boolean => parsed.safeParse(value).success;
};

const KEY_A = testKey();
const KEY_B = testKey();
const T = Date.parse("2026-10-15T08:00:00.000Z");

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full",
  GOVERNANCE_INSTANCE_ID: "libredb-studio",
  GOVERNANCE_PRIVATE_KEYS_FILE: keyringFileOf(KEY_A, KEY_B),
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
  NEXT_PUBLIC_APP_VERSION: "0.19.0",
};

let saved: Record<string, string | undefined> = {};
let spies: Record<"warn" | "info", ReturnType<typeof spyOn>>;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved = {};
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    setEnv(name, value);
  }
  fakePg.reset();
  fakePg.respond = async () => ({ rows: [] });
  listenerStatus = { state: "listening", since: T - 60_000, lastNotificationAt: T - 2500 };
  spies = {
    warn: spyOn(logger, "warn").mockImplementation(() => {}),
    // The keyring logs the kids it loaded.
    info: spyOn(logger, "info").mockImplementation(() => {}),
  };
});

afterEach(async () => {
  stopGovernanceHeartbeat();
  jest.useRealTimers();
  await closeGovernancePool();
  resetGovernanceState();
  resetGovernanceKeyring();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  for (const spy of Object.values(spies)) spy.mockRestore();
});

afterAll(() => {
  removeKeyringFiles();
});

const skip = (id: string, envelopeCode?: AdmissionSkip["envelopeCode"]): AdmissionSkip =>
  envelopeCode === undefined
    ? { item: { kind: "connection", id, path: "password", code: "DEFINITION_HAS_SECRET" } }
    : { item: { kind: "connection", id, level: "read", code: "READ_SECRET_UNOPENABLE" }, envelopeCode };

function snapshot(overrides: Partial<GovernanceSnapshot> = {}): GovernanceSnapshot {
  return {
    loadedAt: T - 4000,
    contractVersion: 1,
    publishedVersions: [1],
    connections: new Map(),
    skipped: [skip("billing", "UNKNOWN_KID"), skip("crm")],
    grants: new Map(),
    revocations: new Map(),
    settings: { values: new Map(), ignored: [], malformed: 0 },
    canary: { [KEY_A.kid]: "ok", [KEY_B.kid]: "UNKNOWN_KID" },
    ...overrides,
  };
}

/** Every client the governance pool handed out, in order. */
const clients = (): FakeClient[] => FakePool.made.flatMap((pool) => pool.clients);

/** The parameters of each heartbeat sent so far, by column. */
function beats(): Record<(typeof HEARTBEAT_COLUMNS)[number], unknown>[] {
  return clients().flatMap((client) =>
    client.parameters.map(
      (values) =>
        Object.fromEntries(HEARTBEAT_COLUMNS.map((column, index) => [column, values?.[index]])) as Record<
          (typeof HEARTBEAT_COLUMNS)[number],
          unknown
        >,
    ),
  );
}

describe("one beat", () => {
  test("the heartbeat statement is the manifest's upsert with kids, listener state, and skipped ids and codes only", async () => {
    recordGovernanceSnapshot(snapshot());

    await sendGovernanceHeartbeat();

    expect(clients().map((client) => client.statements)).toEqual([[buildHeartbeatUpsert("bridge")]]);
    expect(buildHeartbeatUpsert("bridge")).toBe(MANIFEST_UPSERT as string);
    expect(clients()[0].releases).toBe(1);
    const [beat] = beats();
    expect({ ...beat, started_at: undefined }).toEqual({
      instance_id: "libredb-studio",
      studio_version: "0.19.0",
      supported_contracts: [1],
      contract_version: 1,
      keyring_kids: [KEY_A.kid, KEY_B.kid],
      listener_state: "listening",
      last_notification_at: new Date(T - 2500),
      snapshot_loaded_at: new Date(T - 4000),
      skipped: JSON.stringify([
        { kind: "connection", id: "billing", level: "read", code: "READ_SECRET_UNOPENABLE" },
        { kind: "connection", id: "crm", path: "password", code: "DEFINITION_HAS_SECRET" },
      ]),
      sink: JSON.stringify({
        queued: 0,
        dropped: 0,
        rejected: 0,
        lastFlushAt: null,
        backingOff: false,
        lastSqlstate: null,
      }),
      canary: JSON.stringify({ [KEY_A.kid]: "ok", [KEY_B.kid]: "UNKNOWN_KID" }),
      started_at: undefined,
    });
    // The envelope code beside a skip stays in Studio's own status and log.
    expect(beat.skipped as string).not.toContain("envelopeCode");
  });

  test("the upsert writes started_at once and sets last_seen_at = now() on every beat", async () => {
    const sql = buildHeartbeatUpsert("bridge");
    const [, update] = sql.split(" ON CONFLICT (instance_id) DO UPDATE SET ");
    expect(sql).toContain("started_at) VALUES (");
    expect(update.split(", ")).toEqual([
      ...HEARTBEAT_COLUMNS.filter((column) => column !== "instance_id" && column !== "started_at").map(
        (column) => `${column} = EXCLUDED.${column}`,
      ),
      "last_seen_at = now()",
    ]);

    await sendGovernanceHeartbeat();
    recordGovernanceSnapshot(snapshot());
    await sendGovernanceHeartbeat();

    const [first, second] = beats();
    // Both beats send the process start time, which the insert writes and the update never touches.
    expect(first.started_at).toEqual(new Date(performance.timeOrigin));
    expect(second.started_at).toEqual(first.started_at);
    expect(first.snapshot_loaded_at).toBeNull();
    expect(second.snapshot_loaded_at).toEqual(new Date(T - 4000));
  });

  test("the skipped, sink and canary values of a beat validate against the manifest shapes", async () => {
    recordGovernanceSnapshot(snapshot());
    await sendGovernanceHeartbeat();

    const [beat] = beats();
    expect(validatorFor("skipped")(JSON.parse(beat.skipped as string))).toBe(true);
    expect(validatorFor("sink")(JSON.parse(beat.sink as string))).toBe(true);
    expect(validatorFor("canary")(JSON.parse(beat.canary as string))).toBe(true);
  });

  test("a SETTING_INVALID entry is a setting skip that validates against the manifest's skipped shape and carries no value", async () => {
    const value = "SETTING-VALUE-CANARY-7f3e";
    const settings = validateSettings(
      [
        { key: "query.timeoutMs", value, updated_at: new Date(T) },
        { key: "queryLog.onSinkFailure", value: "refuse", updated_at: new Date(T) },
      ],
      1,
    );
    recordGovernanceSnapshot(snapshot({ settings }));

    await sendGovernanceHeartbeat();

    const sent = JSON.parse(beats()[0].skipped as string) as unknown[];
    expect(sent).toEqual([
      { kind: "connection", id: "billing", level: "read", code: "READ_SECRET_UNOPENABLE" },
      { kind: "connection", id: "crm", path: "password", code: "DEFINITION_HAS_SECRET" },
      { kind: "setting", id: "query.timeoutMs", code: "SETTING_INVALID" },
    ]);
    expect(validatorFor("skipped")(sent)).toBe(true);
    expect(beats()[0].skipped as string).not.toContain(value);
  });

  test("more than 500 skipped rows are cut to 500", async () => {
    const skipped = Array.from({ length: 501 }, (_, index) => skip(`row-${index}`));
    recordGovernanceSnapshot(snapshot({ skipped }));

    await sendGovernanceHeartbeat();

    const sent = JSON.parse(beats()[0].skipped as string) as { id: string }[];
    expect(sent).toHaveLength(500);
    expect(sent.at(-1)?.id).toBe("row-499");
    expect(validatorFor("skipped")(sent)).toBe(true);
  });

  test("before any load the beat reports contract 0, no load time, no skips and no canary", async () => {
    listenerStatus = { state: "reconnecting", since: T, lastNotificationAt: null };
    process.env.GOVERNANCE_POSTGRES_SCHEMA = "governance";

    await sendGovernanceHeartbeat();

    expect(clients()[0].statements).toEqual([buildHeartbeatUpsert("governance")]);
    expect(beats()[0]).toMatchObject({
      contract_version: 0,
      listener_state: "reconnecting",
      last_notification_at: null,
      snapshot_loaded_at: null,
      skipped: "[]",
      canary: "{}",
    });
  });

  test("a beat fails with the reason when the build carries no version", async () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;

    await expect(sendGovernanceHeartbeat()).rejects.toThrow("NEXT_PUBLIC_APP_VERSION is not set");
    expect(FakePool.made).toEqual([]);
  });

  test("a beat fails with the reason when no listener runs", async () => {
    listenerStatus = null;

    await expect(sendGovernanceHeartbeat()).rejects.toThrow("the governance listener is not running");
  });

  test("a beat that the database refuses fails with the database's error and releases its client with it", async () => {
    const refused = Object.assign(new Error("permission denied for view studio_instances_v1"), { code: "42501" });
    fakePg.respond = async () => {
      throw refused;
    };

    await expect(sendGovernanceHeartbeat()).rejects.toBe(refused);
    expect(clients()[0].releasedWith).toBe(refused);
  });

  test("a beat gives up after 10 s, releasing its client with the deadline's error", async () => {
    jest.useFakeTimers();
    fakePg.respond = () => new Promise(() => {});

    const beat = sendGovernanceHeartbeat();
    const outcome = beat.then(
      () => "sent",
      (error: Error) => error.message,
    );
    await settle();
    jest.advanceTimersByTime(10_000);

    expect(await outcome).toBe("The governance heartbeat did not finish within 10000 ms");
    expect(clients()[0].releasedWith).toBeInstanceOf(Error);
  });
});

describe("the beat loop", () => {
  test("it beats at once and then every 30 s", async () => {
    jest.useFakeTimers();

    startGovernanceHeartbeat();
    await settle();
    expect(beats()).toHaveLength(1);
    jest.advanceTimersByTime(29_999);
    await settle();
    expect(beats()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await settle();
    expect(beats()).toHaveLength(2);
    jest.advanceTimersByTime(30_000);
    await settle();
    expect(beats()).toHaveLength(3);
  });

  test("starting twice runs one loop, and stopping clears its timer", async () => {
    jest.useFakeTimers();

    startGovernanceHeartbeat();
    startGovernanceHeartbeat();
    await settle();
    expect(beats()).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);

    stopGovernanceHeartbeat();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(beats()).toHaveLength(1);
  });

  test("a beat still running when the next is due is not joined by a second one", async () => {
    jest.useFakeTimers();
    let answer: () => void = () => {};
    fakePg.respond = () =>
      new Promise((resolve) => {
        answer = () => resolve({ rows: [] });
      });

    startGovernanceHeartbeat({ intervalMs: 1000 });
    await settle();
    jest.advanceTimersByTime(1000);
    await settle();
    expect(clients()).toHaveLength(1);

    answer();
    await settle();
    jest.advanceTimersByTime(1000);
    await settle();
    expect(clients()).toHaveLength(2);
  });

  test("a failed heartbeat is logged at most once a minute and never changes the freshness state", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T));
    recordGovernanceSnapshot(snapshot({ loadedAt: T }));
    fakePg.connecting = async () => {
      throw nodeError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
    };

    startGovernanceHeartbeat({ intervalMs: 10_000 });
    await settle();
    for (let beat = 0; beat < 5; beat += 1) {
      jest.advanceTimersByTime(10_000);
      // oxlint-disable-next-line no-await-in-loop -- each beat fails before virtual time moves on.
      await settle();
    }
    // Six failed beats in 50 s: one log line.
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledWith("Governance heartbeat failed", {
      route: "governance/heartbeat",
      code: "ECONNREFUSED",
      error: "connect ECONNREFUSED 10.0.0.5:5432",
    });
    expect(governanceFreshness(T + 10_000)).toBe("ok");

    jest.advanceTimersByTime(10_000);
    await settle();
    // The beat at 60 s is a minute after the first line.
    expect(spies.warn).toHaveBeenCalledTimes(2);

    fakePg.connecting = async () => {};
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(spies.warn).toHaveBeenCalledTimes(2);
  });

  test("a failure without a driver code is logged with a null code", async () => {
    listenerStatus = null;

    startGovernanceHeartbeat();
    await settle();

    expect(spies.warn).toHaveBeenCalledWith("Governance heartbeat failed", {
      route: "governance/heartbeat",
      code: null,
      error: "The heartbeat cannot report a listener state: the governance listener is not running",
    });
  });
});
