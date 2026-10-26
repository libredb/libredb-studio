/**
 * GET /api/admin/governance: the governance status for the admin Overview card (docs/GOVERNANCE.md#admin-status).
 *
 * The state holder, the keyring and the listener are the real ones: each case records a snapshot or a failure the
 * way the loader does and points GOVERNANCE_PRIVATE_KEYS_FILE at a fresh keyring file, and the listener runs on the
 * fake `pg` of tests/helpers/governance/pg-fake.ts. Only getSession is replaced, spread over the real @/lib/auth
 * (pattern: tests/api/admin/seed-sources.test.ts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import * as realAuth from "@/lib/auth";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { GovernanceStatusResponse } from "@/app/api/admin/governance/route";
import type { AdmittedConnection } from "@/lib/governance/admission";
import { NOTIFY_CHANNEL } from "@/lib/governance/contract";
import { resetGovernanceKeyring } from "@/lib/governance/keyring";
import { validateSettings } from "@/lib/governance/settings";
import {
  type GovernanceSnapshot,
  recordGovernanceFailure,
  recordGovernanceSnapshot,
  resetGovernanceState,
} from "@/lib/governance/state";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../helpers/governance/keyring-file";
import { FakeListenerClient, FakePool, fakePg, settle } from "../../helpers/governance/pg-fake";
import { parseResponseJSON } from "../../helpers/mock-next";

const ADMIN: realAuth.UserPayload = { role: "admin", username: "admin" };
const mockGetSession = mock(async (): Promise<realAuth.UserPayload | null> => ADMIN);

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
}));
const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: FakeListenerClient, types: realPg.types }));

const { GET } = await import("@/app/api/admin/governance/route");
const { GET: GET_READY } = await import("@/app/api/ready/route");
const { startGovernanceListener, stopGovernanceListener } = await import("@/lib/governance/listener");
const { logger } = await import("@/lib/logger");

const ROUTE = "GET /api/admin/governance";

/** Values that must never reach the response body: a credential, a definition value and an envelope. */
const PASSWORD = "GOVERNANCE-STATUS-CANARY-91c2";
const HOST = "warehouse.internal.example";
const ENVELOPE = "lsb1.ENVELOPE-CANARY-5d0a";

const KEY = testKey();

const CONNECTION: AdmittedConnection = {
  id: "warehouse",
  read: {
    id: "seed:warehouse",
    name: "Warehouse",
    type: "postgres",
    host: HOST,
    port: 5432,
    user: "reader",
    password: PASSWORD,
    database: "warehouse",
    createdAt: new Date(0),
    managed: true,
    roles: [],
    seedId: "warehouse",
    literal: true,
  },
  envelopes: { read: ENVELOPE },
};

/** The rows of `settings_v1` a snapshot was loaded from, as the settings store checks them. */
type SettingRows = Parameters<typeof validateSettings>[0];

function snapshot(
  loadedAt: number,
  // A row for a key the registry does not have: the status must not echo its value.
  settingRows: SettingRows = [{ key: "statement.capture", value: PASSWORD, updated_at: new Date(0) }],
): GovernanceSnapshot {
  return {
    loadedAt,
    contractVersion: 1,
    publishedVersions: [1],
    connections: new Map([[CONNECTION.id, CONNECTION]]),
    skipped: [
      {
        item: { kind: "connection", id: "billing", level: "write", code: "WRITE_SECRET_UNOPENABLE" },
        envelopeCode: "AUTH_FAILED",
      },
    ],
    grants: new Map(),
    revocations: new Map(),
    settings: validateSettings(settingRows, 1),
    canary: { [KEY.kid]: "ok", "0123456789abcdef": "UNKNOWN_KID" },
  };
}

const ENV_KEYS = [
  "GOVERNANCE_SOURCE",
  "GOVERNANCE_POSTGRES_SCHEMA",
  "GOVERNANCE_PRIVATE_KEYS_FILE",
  "GOVERNANCE_REFRESH_MS",
  "GOVERNANCE_MAX_STALENESS_MS",
  "GOVERNANCE_POSTGRES_URL",
  "GOVERNANCE_INSTANCE_ID",
  "TRUST_PROXY_HEADERS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function request(): Request {
  return new Request("http://localhost:3000/api/admin/governance");
}

/** The JSON lines a console.log spy captured, which is where audit events go. */
function auditLines(sink: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return sink.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

let infoSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GOVERNANCE_SOURCE = "postgres";
  process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(KEY);
  resetGovernanceKeyring();
  resetGovernanceState();
  clearRateLimitState();
  mockGetSession.mockImplementation(async () => ADMIN);
  // The keyring logs the kids it loaded when it first loads.
  infoSpy = spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  await stopGovernanceListener();
  setSystemTime();
  infoSpy.mockRestore();
  resetGovernanceKeyring();
  resetGovernanceState();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  removeKeyringFiles();
});

describe("GET /api/admin/governance: access", () => {
  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const sink = spyOn(console, "log").mockImplementation(() => {});

    try {
      const res = await GET(request());

      expect(res.status).toBe(401);
      expect(await parseResponseJSON<{ error: string; code: string }>(res)).toEqual({
        error: "Authentication required",
        code: "AUTH_REQUIRED",
      });
      expect(auditLines(sink)).toEqual([
        expect.objectContaining({ event: "permission_denied", reason: "no_session", route: ROUTE }),
      ]);
    } finally {
      sink.mockRestore();
    }
  });

  test("a user session gets 403 and an audited insufficient_role denial", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });
    recordGovernanceSnapshot(snapshot(Date.now()));
    const sink = spyOn(console, "log").mockImplementation(() => {});

    try {
      const res = await GET(request());
      const body = await parseResponseJSON<{ error: string; code?: string }>(res);

      expect(res.status).toBe(403);
      expect(body).toEqual({ error: "Unauthorized. Admin access required.", code: "ADMIN_REQUIRED" });
      expect(auditLines(sink)).toEqual([
        expect.objectContaining({
          event: "permission_denied",
          reason: "insufficient_role",
          actor: "user",
          route: ROUTE,
        }),
      ]);
    } finally {
      sink.mockRestore();
    }
  });
});

describe("GET /api/admin/governance: status", () => {
  test("answers { governance: null } with governance off", async () => {
    delete process.env.GOVERNANCE_SOURCE;
    delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await parseResponseJSON<GovernanceStatusResponse>(res)).toEqual({ governance: null });
  });

  test("an admin gets contract, state, snapshot age, skipped rows and kids, and the body holds no envelope or definition value", async () => {
    const loadedAt = Date.now() - 5000;
    recordGovernanceSnapshot(snapshot(loadedAt));

    const res = await GET(request());
    const text = await res.text();
    const { governance } = JSON.parse(text) as GovernanceStatusResponse;

    expect(res.status).toBe(200);
    expect(governance).not.toBeNull();
    expect(governance).toMatchObject({
      source: "postgres",
      schema: "bridge",
      contract: { supported: [1], published: [1], active: 1 },
      freshness: "ok",
      snapshot: { loadedAt: new Date(loadedAt).toISOString() },
      lastError: null,
      admittedConnections: 1,
      skipped: [
        {
          kind: "connection",
          id: "billing",
          level: "write",
          code: "WRITE_SECRET_UNOPENABLE",
          envelopeCode: "AUTH_FAILED",
        },
      ],
      keyringKids: [KEY.kid],
      canary: { [KEY.kid]: "ok", "0123456789abcdef": "UNKNOWN_KID" },
      listener: null,
    });
    expect(governance!.snapshot!.ageMs).toBeGreaterThanOrEqual(5000);
    expect(governance!.snapshot!.ageMs).toBeLessThan(60_000);
    for (const value of [PASSWORD, HOST, ENVELOPE, "reader", "seed:warehouse", KEY.text]) {
      expect(text).not.toContain(value);
    }
  });

  test("the status names each setting's source and the ignored keys with their code", async () => {
    const updatedAt = new Date(0);
    recordGovernanceSnapshot(
      snapshot(Date.now(), [
        { key: "ai.enabled", value: false, updated_at: updatedAt },
        { key: "mcp.enabled", value: true, updated_at: updatedAt },
        { key: "query.timeoutMs", value: 30_000, updated_at: updatedAt },
        { key: "queryLog.statementCapture", value: PASSWORD, updated_at: updatedAt },
        { key: "statement.capture", value: PASSWORD, updated_at: updatedAt },
      ]),
    );

    const res = await GET(request());
    const text = await res.text();
    const { governance } = JSON.parse(text) as GovernanceStatusResponse;

    expect(res.status).toBe(200);
    expect(governance?.settings).toEqual([
      { key: "ai.enabled", source: "runtime" },
      { key: "agent.enabled", source: "environment", held: true, note: "MCP and agent governance ship in v1.1" },
      { key: "mcp.enabled", source: "runtime", held: true, note: "MCP and agent governance ship in v1.1" },
      { key: "query.timeoutMs", source: "runtime" },
      { key: "provider.poolMaxPerUser", source: "default" },
      { key: "queryLog.statementCapture", source: "default" },
      { key: "queryLog.maxStatementBytes", source: "default" },
      { key: "queryLog.onSinkFailure", source: "default" },
    ]);
    expect(governance?.ignoredSettings).toEqual([
      { key: "queryLog.statementCapture", code: "SETTING_INVALID" },
      { key: "statement.capture", code: "SETTING_INVALID" },
    ]);
    expect(text).not.toContain(PASSWORD);
  });

  test("an unavailable governance source reports the failure's code next to the last snapshot", async () => {
    recordGovernanceSnapshot(snapshot(Date.now() - 200_000));
    recordGovernanceFailure({
      at: Date.now(),
      kind: "transient",
      code: "ECONNREFUSED",
      detail: "connect ECONNREFUSED",
      publicDetail: "ECONNREFUSED",
    });

    const res = await GET(request());
    const { governance } = await parseResponseJSON<GovernanceStatusResponse>(res);

    expect(res.status).toBe(200);
    expect(governance?.freshness).toBe("unavailable");
    expect(governance?.lastError).toMatchObject({ kind: "transient", code: "ECONNREFUSED" });
  });

  test("an admin sees the full message of the last load failure, which /api/ready never shows", async () => {
    // The server's own message names a role and a host, which the public readiness route must not repeat.
    const detail =
      'bridge.grants_v1: permission denied for view grants_v1 of role "libredb_studio" on db.internal (SQLSTATE 42501)';
    recordGovernanceFailure({
      at: Date.now(),
      kind: "misconfigured",
      code: "42501",
      detail,
      publicDetail: "bridge.grants_v1: 42501",
    });

    const res = await GET(request());
    const { governance } = await parseResponseJSON<GovernanceStatusResponse>(res);
    const ready = await GET_READY();
    const readyText = await ready.text();

    expect(res.status).toBe(200);
    expect(governance?.lastError).toMatchObject({ kind: "misconfigured", code: "42501", message: detail });
    expect(ready.status).toBe(503);
    expect(JSON.parse(readyText)).toMatchObject({ status: "misconfigured", detail: "bridge.grants_v1: 42501" });
    expect(readyText).not.toContain("permission denied");
    expect(readyText).not.toContain("db.internal");
  });

  test("an admin gets the listener's state, how long it has held and when the last change notification arrived", async () => {
    process.env.GOVERNANCE_POSTGRES_URL = "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full";
    process.env.GOVERNANCE_INSTANCE_ID = "libredb-studio";
    fakePg.reset();
    const quiet = (["info", "debug"] as const).map((level) => spyOn(logger, level).mockImplementation(() => {}));
    const startedAt = Date.parse("2026-10-15T08:00:00.000Z");
    setSystemTime(new Date(startedAt));

    try {
      startGovernanceListener(async () => {});
      await settle();
      setSystemTime(new Date(startedAt + 1500));
      FakeListenerClient.made[0].notify(NOTIFY_CHANNEL, JSON.stringify({ v: 1, kind: "grants" }));
      setSystemTime(new Date(startedAt + 4000));

      const res = await GET(request());
      const { governance } = await parseResponseJSON<GovernanceStatusResponse>(res);

      expect(res.status).toBe(200);
      expect(governance?.listener).toEqual({
        state: "listening",
        since: "2026-10-15T08:00:00.000Z",
        heldMs: 4000,
        lastNotificationAt: "2026-10-15T08:00:01.500Z",
      });
    } finally {
      for (const spy of quiet) spy.mockRestore();
    }
  });

  test("answers 500 when the status cannot be built", async () => {
    delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await GET(request());

      expect(res.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
