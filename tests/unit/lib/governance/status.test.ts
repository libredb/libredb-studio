/**
 * The governance status an administrator reads (spec 9.3, 12.2): built from the state holder and the listener at the
 * moment of the request, with ids, levels, paths and codes only, never a value or an envelope, and the full message of
 * the latest load failure, which only an administrator reads.
 *
 * The listener and the query event sink are replaced by states this file sets, so each case reports the listener and
 * the sink it names; tests/api/admin/governance.test.ts reports a real listener, and
 * tests/unit/lib/query-events/sink.test.ts drives a real sink.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AdmittedConnection } from "@/lib/governance/admission";
import { resetGovernanceKeyring } from "@/lib/governance/keyring";
import type { GovernanceListenerStatus } from "@/lib/governance/listener";
import { validateSettings } from "@/lib/governance/settings";
import type { GovernanceStatus } from "@/lib/governance/status";
import type { QueryEventSinkState } from "@/lib/query-events/sink";
import {
  type GovernanceSnapshot,
  recordGovernanceFailure,
  recordGovernanceSnapshot,
  resetGovernanceState,
} from "@/lib/governance/state";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../../helpers/governance/keyring-file";

let listenerStatus: GovernanceListenerStatus | null = null;
mock.module("@/lib/governance/listener", () => ({ governanceListenerStatus: () => listenerStatus }));

/** The state of a sink that has recorded no event. */
const IDLE_SINK: QueryEventSinkState = {
  queued: 0,
  dropped: 0,
  rejected: 0,
  lastFlushAt: null,
  backingOff: false,
  lastSqlstate: null,
};
let sinkState: QueryEventSinkState = IDLE_SINK;
mock.module("@/lib/query-events/sink", () => ({ queryEventSinkState: () => sinkState }));

const { governanceStatus, HELD_SETTING_NOTE } = await import("@/lib/governance/status");

const T = Date.parse("2026-10-15T08:00:00.000Z");
const PASSWORD = "STATUS-UNIT-CANARY-4b1e";

const KEY_A = testKey();
const KEY_B = testKey();

const CONNECTION: AdmittedConnection = {
  id: "reporting",
  read: {
    id: "seed:reporting",
    name: "Reporting",
    type: "postgres",
    host: "db.internal.example",
    port: 5432,
    user: "reader",
    password: PASSWORD,
    database: "reporting",
    createdAt: new Date(T),
    managed: true,
    roles: [],
    seedId: "reporting",
    literal: true,
  },
  envelopes: { read: "lsb1.STATUS-UNIT-ENVELOPE" },
};

const snapshotAt = (loadedAt: number): GovernanceSnapshot => ({
  loadedAt,
  contractVersion: 1,
  publishedVersions: [1, 2],
  connections: new Map([[CONNECTION.id, CONNECTION]]),
  skipped: [
    {
      item: { kind: "connection", id: "billing", level: "read", code: "READ_SECRET_UNOPENABLE" },
      envelopeCode: "UNKNOWN_KID",
    },
    { item: { kind: "connection", id: "crm", path: "password", code: "DEFINITION_HAS_SECRET" } },
  ],
  grants: new Map(),
  revocations: new Map(),
  settings: { values: new Map(), ignored: [], malformed: 0 },
  canary: { [KEY_A.kid]: "ok", [KEY_B.kid]: "AUTH_FAILED" },
});

const ENV_KEYS = [
  "GOVERNANCE_SOURCE",
  "GOVERNANCE_POSTGRES_SCHEMA",
  "GOVERNANCE_PRIVATE_KEYS_FILE",
  "GOVERNANCE_REFRESH_MS",
  "GOVERNANCE_MAX_STALENESS_MS",
] as const;
let saved: Record<string, string | undefined> = {};
let infoSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GOVERNANCE_SOURCE = "postgres";
  process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(KEY_A, KEY_B);
  resetGovernanceKeyring();
  // The keyring logs the kids it loaded; nothing here reads that line.
  infoSpy = spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  listenerStatus = null;
  sinkState = IDLE_SINK;
  resetGovernanceState();
  resetGovernanceKeyring();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

afterAll(() => {
  removeKeyringFiles();
});

/**
 * Where each key's value comes from while the control plane set none: its environment variable or Studio's default.
 * The agent and MCP keys are held, because this version runs neither under governance.
 */
const NO_RUNTIME_VALUES: GovernanceStatus["settings"] = [
  { key: "ai.enabled", source: "default" },
  { key: "agent.enabled", source: "environment", held: true, note: "MCP and agent governance ship in v1.1" },
  { key: "mcp.enabled", source: "environment", held: true, note: "MCP and agent governance ship in v1.1" },
  { key: "query.timeoutMs", source: "default" },
  { key: "provider.poolMaxPerUser", source: "default" },
  { key: "queryLog.statementCapture", source: "default" },
  { key: "queryLog.maxStatementBytes", source: "default" },
  { key: "queryLog.onSinkFailure", source: "default" },
];

describe("governanceStatus", () => {
  test("before any load it reports loading, the supported versions and the keyring kids, and nothing else", () => {
    expect(governanceStatus(T)).toEqual({
      source: "postgres",
      schema: "bridge",
      contract: { supported: [1], published: null, active: null },
      freshness: "loading",
      snapshot: null,
      lastError: null,
      admittedConnections: null,
      skipped: [],
      keyringKids: [KEY_A.kid, KEY_B.kid],
      canary: null,
      settings: NO_RUNTIME_VALUES,
      ignoredSettings: [],
      listener: null,
      sink: IDLE_SINK,
    });
  });

  test("a loaded snapshot reports its versions, age, load time, admitted count, skips with their envelope code and canaries", () => {
    process.env.GOVERNANCE_POSTGRES_SCHEMA = "governance";
    recordGovernanceSnapshot(snapshotAt(T));

    expect(governanceStatus(T + 4000)).toEqual({
      source: "postgres",
      schema: "governance",
      contract: { supported: [1], published: [1, 2], active: 1 },
      freshness: "ok",
      snapshot: { loadedAt: "2026-10-15T08:00:00.000Z", ageMs: 4000 },
      lastError: null,
      admittedConnections: 1,
      skipped: [
        {
          kind: "connection",
          id: "billing",
          level: "read",
          code: "READ_SECRET_UNOPENABLE",
          envelopeCode: "UNKNOWN_KID",
        },
        { kind: "connection", id: "crm", path: "password", code: "DEFINITION_HAS_SECRET" },
      ],
      keyringKids: [KEY_A.kid, KEY_B.kid],
      canary: { [KEY_A.kid]: "ok", [KEY_B.kid]: "AUTH_FAILED" },
      settings: NO_RUNTIME_VALUES,
      ignoredSettings: [],
      listener: null,
      sink: IDLE_SINK,
    });
  });

  test("the listener reports its state, since when and how long it has held, and the last change notification", () => {
    listenerStatus = { state: "listening", since: T - 90_000, lastNotificationAt: T - 2500 };

    expect(governanceStatus(T).listener).toEqual({
      state: "listening",
      since: "2026-10-15T07:58:30.000Z",
      heldMs: 90_000,
      lastNotificationAt: "2026-10-15T07:59:57.500Z",
    });
  });

  test("a listener that has heard no change notification reports none", () => {
    listenerStatus = { state: "polling", since: T, lastNotificationAt: null };

    expect(governanceStatus(T + 1000).listener).toEqual({
      state: "polling",
      since: "2026-10-15T08:00:00.000Z",
      heldMs: 1000,
      lastNotificationAt: null,
    });
  });

  test("the sink section is the query event sink's state, as the heartbeat reports it", () => {
    sinkState = {
      queued: 12,
      dropped: 3,
      rejected: 1,
      lastFlushAt: "2026-10-15T07:59:58.000Z",
      backingOff: true,
      lastSqlstate: "57P01",
    };

    expect(governanceStatus(T).sink).toEqual(sinkState);
  });

  test("a failed load keeps the snapshot and reports the failure's kind, code and full message, and no value", () => {
    recordGovernanceSnapshot(snapshotAt(T));
    recordGovernanceFailure({
      at: T + 150_000,
      kind: "transient",
      code: "ECONNREFUSED",
      detail: "connect ECONNREFUSED 10.0.0.5:5432",
      publicDetail: "ECONNREFUSED",
    });

    const status = governanceStatus(T + 150_000);

    expect(status.freshness).toBe("unavailable");
    expect(status.snapshot).toEqual({ loadedAt: "2026-10-15T08:00:00.000Z", ageMs: 150_000 });
    expect(status.lastError).toEqual({
      at: "2026-10-15T08:02:30.000Z",
      kind: "transient",
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 10.0.0.5:5432",
    });
    const body = JSON.stringify(status);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain("db.internal.example");
    expect(body).not.toContain(CONNECTION.envelopes.read);
  });

  test("a runtime key whose consumer is held is reported as held with the v1.1 note", () => {
    recordGovernanceSnapshot({
      ...snapshotAt(T),
      settings: validateSettings(
        [
          { key: "ai.enabled", value: false, updated_at: new Date() },
          { key: "agent.enabled", value: true, updated_at: new Date() },
          { key: "mcp.enabled", value: true, updated_at: new Date() },
        ],
        1,
      ),
    });

    const settings = governanceStatus(T).settings;

    expect(HELD_SETTING_NOTE).toBe("MCP and agent governance ship in v1.1");
    expect(settings.slice(0, 3)).toEqual([
      { key: "ai.enabled", source: "runtime" },
      { key: "agent.enabled", source: "runtime", held: true, note: HELD_SETTING_NOTE },
      { key: "mcp.enabled", source: "runtime", held: true, note: HELD_SETTING_NOTE },
    ]);
    expect(settings.slice(3).every((setting) => !("held" in setting))).toBe(true);
  });

  test("throws when the keyring does not load", () => {
    delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;

    expect(() => governanceStatus(T)).toThrow("GOVERNANCE_PRIVATE_KEYS_FILE is not set");
  });
});
