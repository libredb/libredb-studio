/**
 * GET /api/admin/governance: the governance status for the admin Overview card (spec 9.3, 12.2).
 *
 * The state holder and the keyring are the real ones: each case records a snapshot or a failure the way the loader
 * does and points GOVERNANCE_PRIVATE_KEYS_FILE at a fresh keyring file. Only getSession is replaced, spread over the
 * real @/lib/auth (pattern: tests/api/admin/seed-sources.test.ts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as realAuth from "@/lib/auth";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { GovernanceStatusResponse } from "@/app/api/admin/governance/route";
import type { AdmittedConnection } from "@/lib/governance/admission";
import { resetGovernanceKeyring } from "@/lib/governance/keyring";
import {
  type GovernanceSnapshot,
  recordGovernanceFailure,
  recordGovernanceSnapshot,
  resetGovernanceState,
} from "@/lib/governance/state";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../helpers/governance/keyring-file";
import { parseResponseJSON } from "../../helpers/mock-next";

const ADMIN: realAuth.UserPayload = { role: "admin", username: "admin" };
const mockGetSession = mock(async (): Promise<realAuth.UserPayload | null> => ADMIN);

mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));

const { GET } = await import("@/app/api/admin/governance/route");

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
};

function snapshot(loadedAt: number): GovernanceSnapshot {
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
    // The raw rows the stores read: the status must not echo them.
    settings: [{ key: "statement.capture", value: PASSWORD, updated_at: new Date(0) }],
    canaries: [{ kid: KEY.kid, envelope: ENVELOPE }],
  };
}

const ENV_KEYS = [
  "GOVERNANCE_SOURCE",
  "GOVERNANCE_POSTGRES_SCHEMA",
  "GOVERNANCE_PRIVATE_KEYS_FILE",
  "GOVERNANCE_REFRESH_MS",
  "GOVERNANCE_MAX_STALENESS_MS",
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

afterEach(() => {
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
      const body = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(403);
      expect(body).toEqual({ error: "Unauthorized. Admin access required." });
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
    });
    expect(governance!.snapshot!.ageMs).toBeGreaterThanOrEqual(5000);
    expect(governance!.snapshot!.ageMs).toBeLessThan(60_000);
    for (const value of [PASSWORD, HOST, ENVELOPE, "reader", "seed:warehouse", KEY.text]) {
      expect(text).not.toContain(value);
    }
  });

  test("an unavailable governance source reports the failure's code next to the last snapshot", async () => {
    recordGovernanceSnapshot(snapshot(Date.now() - 200_000));
    recordGovernanceFailure({
      at: Date.now(),
      kind: "transient",
      code: "ECONNREFUSED",
      detail: "connect ECONNREFUSED",
    });

    const res = await GET(request());
    const { governance } = await parseResponseJSON<GovernanceStatusResponse>(res);

    expect(res.status).toBe(200);
    expect(governance?.freshness).toBe("unavailable");
    expect(governance?.lastError).toMatchObject({ kind: "transient", code: "ECONNREFUSED" });
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
