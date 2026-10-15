/**
 * The governance status an administrator reads (spec 9.3, 12.2): built from the state holder at the moment of the
 * request, with ids, levels, paths and codes only, never a value, an envelope or a driver message.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AdmittedConnection } from "@/lib/governance/admission";
import { resetGovernanceKeyring } from "@/lib/governance/keyring";
import {
  type GovernanceSnapshot,
  recordGovernanceFailure,
  recordGovernanceSnapshot,
  resetGovernanceState,
} from "@/lib/governance/state";
import { governanceStatus } from "@/lib/governance/status";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../../helpers/governance/keyring-file";

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
  settings: [],
  canaries: [],
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
    });
  });

  test("a loaded snapshot reports its versions, age, load time, admitted count and skips with their envelope code", () => {
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
    });
  });

  test("a failed load keeps the snapshot and reports the failure's kind and code without the driver message", () => {
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
    expect(status.lastError).toEqual({ at: "2026-10-15T08:02:30.000Z", kind: "transient", code: "ECONNREFUSED" });
    const body = JSON.stringify(status);
    expect(body).not.toContain("10.0.0.5");
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain("db.internal.example");
  });

  test("throws when the keyring does not load", () => {
    delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;

    expect(() => governanceStatus(T)).toThrow("GOVERNANCE_PRIVATE_KEYS_FILE is not set");
  });
});
