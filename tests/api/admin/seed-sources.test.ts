/**
 * GET /api/admin/seed-sources: the operator seed sources' status for the admin Overview card (Spec A 5.3).
 *
 * The operator loader runs for real against seed files in a temp directory, with SEED_CACHE_TTL_MS=0 so
 * every request fills again. Only getSession is replaced, spread over the real @/lib/auth (pattern:
 * tests/api/admin/discovery.test.ts). getOperatorSourceStatus is wrapped so one case can make it throw and
 * the 403 case can prove it never ran.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAuth from "@/lib/auth";
import * as realOperatorLoader from "@/lib/seed/operator-loader";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import type { SeedSourcesResponse } from "@/app/api/admin/seed-sources/route";
import { parseResponseJSON } from "../../helpers/mock-next";

const ADMIN: realAuth.UserPayload = { role: "admin", username: "admin" };
const mockGetSession = mock(async (): Promise<realAuth.UserPayload | null> => ADMIN);

const realGetOperatorSourceStatus = realOperatorLoader.getOperatorSourceStatus;
let statusFailure: Error | null = null;
let statusCalls = 0;

// Spread over the real modules: a partial replacement stays installed process-wide and breaks the
// next import of an export this file forgot.
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
mock.module("@/lib/seed/operator-loader", () => ({
  ...realOperatorLoader,
  getOperatorSourceStatus: async () => {
    statusCalls += 1;
    if (statusFailure) throw statusFailure;
    return realGetOperatorSourceStatus();
  },
}));

const { GET } = await import("@/app/api/admin/seed-sources/route");
const { GET: GET_MANAGED } = await import("@/app/api/connections/managed/route");

const ENV_KEYS = [
  "SEED_CONFIG_PATH",
  "SEED_CACHE_TTL_MS",
  "SEED_LITERAL_VALUES",
  "SEED_SOURCES_UNSET_PASSWORD",
  "TRUST_PROXY_HEADERS",
  "RATE_LIMIT_QUERY_MAX",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const dir = mkdtempSync(join(tmpdir(), "libredb-admin-seed-sources-"));
const seedPath = join(dir, "seed-connections.yaml");
const absentPath = join(dir, "absent.yaml");
/** A value that must never reach the response body, a log line or a message. */
const CANARY = "SEED-SOURCES-CANARY-7f3a";

function request(): Request {
  return new Request("http://localhost:3000/api/admin/seed-sources");
}

async function answer(): Promise<{ status: number; body: SeedSourcesResponse }> {
  const res = await GET(request());
  return { status: res.status, body: await parseResponseJSON<SeedSourcesResponse>(res) };
}

/** The audit events a console.log spy captured: one JSON line each. */
function auditLines(sink: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return sink.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // An explicit path that never exists: no developer seed file can change what the status reports.
  process.env.SEED_CONFIG_PATH = absentPath;
  process.env.SEED_CACHE_TTL_MS = "0";
  rmSync(seedPath, { force: true });
  realOperatorLoader.resetCache();
  clearRateLimitState();
  statusFailure = null;
  statusCalls = 0;
  mockGetSession.mockImplementation(async () => ADMIN);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  realOperatorLoader.resetCache();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/admin/seed-sources: access", () => {
  // guardRoute rejects a missing session before the route's own role check runs.
  test("returns 401 when no session exists, without reading the status", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const sink = spyOn(console, "log").mockImplementation(() => {});

    try {
      const res = await GET(request());
      const data = await parseResponseJSON<{ error: string; code: string }>(res);

      expect(res.status).toBe(401);
      expect(data).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
      expect(statusCalls).toBe(0);
      expect(auditLines(sink)).toEqual([
        expect.objectContaining({
          event: "permission_denied",
          reason: "no_session",
          actor: "anonymous",
          route: "GET /api/admin/seed-sources",
        }),
      ]);
    } finally {
      sink.mockRestore();
    }
  });

  // A standard user learns nothing: the body is the shared 403 and the loader never runs. The refusal is
  // recorded as a permission_denied event with reason insufficient_role.
  test("returns 403 for a non-admin user without reading the status", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });
    const sink = spyOn(console, "log").mockImplementation(() => {});

    try {
      const res = await GET(request());
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(403);
      expect(data).toEqual({ error: "Unauthorized. Admin access required." });
      expect(statusCalls).toBe(0);
      expect(auditLines(sink)).toEqual([
        expect.objectContaining({
          event: "permission_denied",
          reason: "insufficient_role",
          actor: "user",
          route: "GET /api/admin/seed-sources",
        }),
      ]);
    } finally {
      sink.mockRestore();
    }
  });

  // Metered on the query bucket and no other: the ai bucket allows 20 a minute by default, so a route moved
  // there would still answer 200 to all four requests below.
  test("is metered on the query bucket: the third request in a window answers 429", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "2";
    const sink = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const first = await GET(request());
      const second = await GET(request());
      const third = await GET(request());
      const fourth = await GET(request());

      expect([first.status, second.status, third.status, fourth.status]).toEqual([200, 200, 429, 429]);
      expect(auditLines(sink)).toEqual([
        expect.objectContaining({
          event: "rate_limit_exceeded",
          bucket: "query",
          actor: "admin",
          route: "GET /api/admin/seed-sources",
        }),
      ]);
    } finally {
      sink.mockRestore();
      warn.mockRestore();
      clearRateLimitState();
    }
  });
});

describe("GET /api/admin/seed-sources: reports", () => {
  test("answers an ok seed file with its connections, by id, name and type only", async () => {
    process.env.SEED_CONFIG_PATH = seedPath;
    writeFileSync(
      seedPath,
      [
        'version: "1"',
        "connections:",
        '  - id: "reporting"',
        '    name: "Reporting"',
        "    type: postgres",
        '    host: "db.internal"',
        '    roles: ["admin"]',
        "",
      ].join("\n"),
    );
    const info = spyOn(logger, "info").mockImplementation(() => {});

    try {
      const { status, body } = await answer();

      expect(status).toBe(200);
      expect(body).toEqual({
        sources: [
          {
            source: "SEED_CONFIG_PATH",
            location: seedPath,
            state: "ok",
            checkedAt: expect.any(String),
            error: null,
            connected: [{ id: "reporting", name: "Reporting", type: "postgres" }],
            skipped: [],
            notes: [],
          },
        ],
      });
      expect(new Date(body.sources[0].checkedAt).toISOString()).toBe(body.sources[0].checkedAt);
      expect(JSON.stringify(body)).not.toContain("db.internal");
    } finally {
      info.mockRestore();
    }
  });

  test("answers missing, with the path, for an explicit SEED_CONFIG_PATH that does not exist", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const { status, body } = await answer();

      expect(status).toBe(200);
      expect(body.sources).toEqual([
        {
          source: "SEED_CONFIG_PATH",
          location: absentPath,
          state: "missing",
          checkedAt: expect.any(String),
          error: null,
          connected: [],
          skipped: [],
          notes: [],
        },
      ]);
      expect(warn).toHaveBeenCalledWith("Seed config file not found, seed connections disabled", {
        route: "seed/sources/file",
        path: absentPath,
      });
    } finally {
      warn.mockRestore();
    }
  });

  // The Zod message shape: a zod failure on a string field must not put the field's value into the answer. The
  // first connection fails an enum (type), the second a regex (color), and the second also carries the canary
  // as a password, the field a careless message would echo first.
  test("answers error with code invalid for a schema failure, and the body carries no value from the file", async () => {
    process.env.SEED_CONFIG_PATH = seedPath;
    writeFileSync(
      seedPath,
      [
        'version: "1"',
        "connections:",
        '  - id: "first"',
        '    name: "First"',
        `    type: "${CANARY}"`,
        '    roles: ["admin"]',
        '  - id: "second"',
        '    name: "Second"',
        "    type: postgres",
        `    password: "${CANARY}"`,
        `    color: "${CANARY}"`,
        '    roles: ["admin"]',
        "",
      ].join("\n"),
    );

    const { status, body } = await answer();

    expect(status).toBe(200);
    expect(body.sources).toHaveLength(1);
    const [report] = body.sources;
    expect(report.state).toBe("error");
    expect(report.error?.code).toBe("invalid");
    expect(report.error?.message.startsWith(`Invalid seed config at ${seedPath}: `)).toBe(true);
    expect(report.error?.message).toContain("connections.0.type");
    expect(report.error?.message).toContain("connections.1.color");
    expect(report.connected).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(CANARY);
  });

  // Review Focus A1.6: a seed file that worked before this release, with a connectionString on a refused type, now
  // fails as a whole; the managed route answers 500 with its reason, and the card must name the connection, the type
  // and the fix, and never the string.
  test("answers error naming the connection, the type and the fix for a connectionString the provider does not read", async () => {
    process.env.SEED_CONFIG_PATH = seedPath;
    writeFileSync(
      seedPath,
      [
        'version: "1"',
        "connections:",
        '  - id: "cache"',
        '    name: "Cache"',
        "    type: redis",
        '    host: "cache.internal"',
        `    connectionString: "redis://:${CANARY}@cache.internal:6379"`,
        '    roles: ["admin"]',
        "",
      ].join("\n"),
    );

    const { status, body } = await answer();

    expect(status).toBe(200);
    expect(body.sources[0].state).toBe("error");
    expect(body.sources[0].error?.code).toBe("invalid");
    expect(body.sources[0].error?.message).toContain(
      'connections.0.connectionString: Seed connection "cache" sets connectionString, which the redis provider does not read: move the value into host, port, user, password and database',
    );
    expect(JSON.stringify(body)).not.toContain(CANARY);

    // The other half of A1.6: every role's list fails on the same file, with the reason the browser reads.
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const managed = await GET_MANAGED();

      expect(managed.status).toBe(500);
      expect(await parseResponseJSON<{ error: string; reason: string }>(managed)).toEqual({
        error: "Failed to load managed connections",
        reason: "seed-config-unreadable",
      });
      expect(error).toHaveBeenCalledWith("Failed to load the seed configuration", expect.anything(), {
        route: "GET /api/connections/managed",
      });
      expect(JSON.stringify(error.mock.calls.map((call) => call.map(String)))).not.toContain(CANARY);
    } finally {
      error.mockRestore();
    }
  });

  test("answers error with code unparseable for a file that is not YAML, and never quotes the file", async () => {
    process.env.SEED_CONFIG_PATH = seedPath;
    writeFileSync(
      seedPath,
      ['version: "1"', "connections:", `  - id: "${CANARY}`, "    name: [unclosed", ""].join("\n"),
    );

    const { status, body } = await answer();

    expect(status).toBe(200);
    expect(body.sources[0].state).toBe("error");
    expect(body.sources[0].error?.code).toBe("unparseable");
    expect(body.sources[0].error?.message.startsWith(`Failed to parse seed config at ${seedPath}: `)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(CANARY);
  });

  test("lists a connection skipped for an undefined ${ENV} reference, with its variable and field, beside the one that loaded", async () => {
    process.env.SEED_CONFIG_PATH = seedPath;
    writeFileSync(
      seedPath,
      [
        'version: "1"',
        "connections:",
        '  - id: "reporting"',
        '    name: "Reporting"',
        "    type: postgres",
        '    host: "db.internal"',
        '    roles: ["admin"]',
        '  - id: "billing"',
        '    name: "Billing"',
        "    type: postgres",
        '    host: "db.internal"',
        '    password: "${SEED_SOURCES_UNSET_PASSWORD}"',
        '    roles: ["admin"]',
        "",
      ].join("\n"),
    );
    const error = spyOn(logger, "error").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});

    try {
      const { status, body } = await answer();

      expect(status).toBe(200);
      expect(body.sources).toEqual([
        {
          source: "SEED_CONFIG_PATH",
          location: seedPath,
          state: "ok",
          checkedAt: expect.any(String),
          error: null,
          connected: [{ id: "reporting", name: "Reporting", type: "postgres" }],
          skipped: [
            {
              id: "billing",
              origin: seedPath,
              reason: "Environment variable SEED_SOURCES_UNSET_PASSWORD is not defined",
              variable: "SEED_SOURCES_UNSET_PASSWORD",
              field: "password",
            },
          ],
          notes: [],
        },
      ]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        "Seed connection skipped due to credential resolution failure",
        expect.any(Error),
        { route: "seed/operator-loader", connectionId: "billing" },
      );
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });

  test("answers 500 through createErrorResponse when reading the status throws", async () => {
    statusFailure = new Error("seed sources status read failed");
    const error = spyOn(logger, "error").mockImplementation(() => {});

    try {
      const res = await GET(request());
      const data = await parseResponseJSON<{ error: string; code: string; statusCode: number }>(res);

      expect(res.status).toBe(500);
      expect(data).toEqual({ error: "seed sources status read failed", code: "INTERNAL_ERROR", statusCode: 500 });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
