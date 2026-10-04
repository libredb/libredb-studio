/**
 * GET /api/admin/discovery: the CapRover discovery status for the admin Overview card.
 *
 * The discovery loader runs for real against export files in a temp directory. Only getSession is
 * replaced, spread over the real @/lib/auth (pattern: tests/api/agent/config.test.ts), so
 * readCookieSecureOverride and isLoopbackHost stay real. getDiscoveryStatus is wrapped so one case
 * can make it throw and the 403 case can prove it never ran.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAuth from "@/lib/auth";
import * as realLoader from "@/lib/seed/discovery-loader";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { resetSecurityConfigWarnings } from "@/lib/security/config";
import { parseResponseJSON } from "../../helpers/mock-next";

const ADMIN: realAuth.UserPayload = { role: "admin", username: "admin" };
const mockGetSession = mock(async (): Promise<realAuth.UserPayload | null> => ADMIN);

const realGetDiscoveryStatus = realLoader.getDiscoveryStatus;
let discoveryFailure: Error | null = null;
let discoveryCalls = 0;

// Spread over the real modules: a partial replacement stays installed process-wide and breaks the
// next import of an export this file forgot.
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
mock.module("@/lib/seed/discovery-loader", () => ({
  ...realLoader,
  getDiscoveryStatus: async (deps?: realLoader.DiscoveryDeps) => {
    discoveryCalls += 1;
    if (discoveryFailure) throw discoveryFailure;
    return realGetDiscoveryStatus(deps);
  },
}));

const { GET } = await import("@/app/api/admin/discovery/route");

interface DiscoveryBody {
  discovery: realLoader.DiscoveryStatus | null;
  transport?: { plainHttp: boolean; cookieSecureOff: boolean };
}

const ENV_KEYS = [
  "SEED_DISCOVERY_PATH",
  "SEED_DISCOVERY_MAX_AGE_MS",
  "SEED_CACHE_TTL_MS",
  "SEED_CONFIG_PATH",
  "AUTH_COOKIE_SECURE",
  "TRUST_PROXY_HEADERS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const dir = mkdtempSync(join(tmpdir(), "libredb-admin-discovery-"));
const exportPath = join(dir, "services.json");
const PG_PASSWORD = "pg-discovered-secret-value";

function service(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "svc-pgtest",
    name: "pgtest",
    appName: "pgtest",
    host: "srv-captain--pgtest",
    image: "postgres:16",
    env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: "appdb" },
    requirepassEnv: null,
    tasks: { running: 1, desired: 1 },
    ...overrides,
  };
}

function writeExport(overrides: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  const body = {
    version: 1,
    platform: "caprover",
    generatedAt: now,
    checkedAt: now,
    status: { ok: true },
    network: { name: "captain-overlay-network", id: "jolhlap6b0rctoqh21rk8sidt" },
    services: [service()],
    excluded: [],
    ...overrides,
  };
  writeFileSync(exportPath, JSON.stringify(body));
}

function request(url = "http://localhost:3000/api/admin/discovery", headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

async function answer(req: Request = request()): Promise<{ status: number; body: DiscoveryBody }> {
  const res = await GET(req);
  return { status: res.status, body: await parseResponseJSON<DiscoveryBody>(res) };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // A path that never exists: no developer seed file can change which ids are taken.
  process.env.SEED_CONFIG_PATH = join(dir, "no-seed-file.yaml");
  process.env.SEED_DISCOVERY_MAX_AGE_MS = "60000";
  rmSync(exportPath, { force: true });
  realLoader.resetDiscoveryCache();
  clearRateLimitState();
  resetSecurityConfigWarnings();
  realAuth.resetCookieSecurityWarning();
  discoveryFailure = null;
  discoveryCalls = 0;
  mockGetSession.mockImplementation(async () => ADMIN);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  realLoader.resetDiscoveryCache();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/admin/discovery: access", () => {
  // guardRoute rejects a missing session before the route's own role check runs.
  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport();

    const res = await GET(request());
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(401);
    expect(data).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(discoveryCalls).toBe(0);
  });

  // A standard user learns nothing: the body is the unchanged 403 and the loader never runs.
  test("returns 403 for a non-admin user without reading the discovery status", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport();

    const res = await GET(request());
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data).toEqual({ error: "Unauthorized. Admin access required." });
    expect(discoveryCalls).toBe(0);
  });
});

describe("GET /api/admin/discovery: states", () => {
  test("answers discovery null, and no transport, when SEED_DISCOVERY_PATH is unset", async () => {
    const { status, body } = await answer();

    expect(status).toBe(200);
    expect(body).toEqual({ discovery: null });
  });

  test("answers state ok with the connected list and the skipped entries", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport({
      services: [
        service(),
        // A repository match whose host breaks the host pattern: skipped with a reason.
        service({ id: "svc-legacy", name: "Legacy_DB", appName: "Legacy_DB", host: "Legacy_DB" }),
        // Not a database image: ignored without being counted as skipped.
        service({ id: "svc-web", name: "web", appName: "web", host: "srv-captain--web", image: "nginx:1.27", env: {} }),
      ],
    });

    const { status, body } = await answer();

    expect(status).toBe(200);
    expect(body.discovery?.platform).toBe("caprover");
    expect(body.discovery?.state).toBe("ok");
    expect(body.discovery?.error).toBeNull();
    expect(body.discovery?.connected).toEqual([{ name: "pgtest (PostgreSQL)", type: "postgres" }]);
    expect(body.discovery?.skipped.map((entry) => entry.appName)).toEqual(["Legacy_DB"]);
    // The route passes the loader's status through unchanged.
    expect(body.discovery).toEqual(JSON.parse(JSON.stringify(await realGetDiscoveryStatus())));
  });

  test("never carries a host name or an environment value", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport();

    const { body } = await answer();
    const text = JSON.stringify(body);

    expect(text).not.toContain(PG_PASSWORD);
    expect(text).not.toContain("srv-captain--");
  });

  test("answers state waiting while the export file does not exist", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;

    const { status, body } = await answer();

    expect(status).toBe(200);
    expect(body.discovery?.state).toBe("waiting");
    expect(body.discovery?.connected).toEqual([]);
  });

  test("answers state error with code invalid_export for an unparsable file", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeFileSync(exportPath, '{"version": 1, "platform": "capr');

    const { body } = await answer();

    expect(body.discovery?.state).toBe("error");
    expect(body.discovery?.error?.code).toBe("invalid_export");
    expect(body.discovery?.connected).toEqual([]);
  });

  test("answers state error with the exporter's code before the first successful scan", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport({
      generatedAt: null,
      services: [],
      network: null,
      status: { ok: false, code: "swarm_unavailable", httpStatus: 503, message: "This node is not a swarm manager." },
    });

    const { body } = await answer();

    expect(body.discovery?.state).toBe("error");
    expect(body.discovery?.error?.code).toBe("swarm_unavailable");
    expect(body.discovery?.generatedAt).toBeNull();
    expect(body.discovery?.connected).toEqual([]);
  });

  test("answers state error and still serves the last good scan while it is fresh", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport({ status: { ok: false, code: "docker_error", httpStatus: 500, message: "server error" } });

    const { body } = await answer();

    expect(body.discovery?.state).toBe("error");
    expect(body.discovery?.error?.code).toBe("docker_error");
    expect(body.discovery?.connected).toEqual([{ name: "pgtest (PostgreSQL)", type: "postgres" }]);
  });

  test("answers state stale and withdraws the connections once generatedAt is older than the max age", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport({ generatedAt: new Date(Date.now() - 120_000).toISOString() });

    const { body } = await answer();

    expect(body.discovery?.state).toBe("stale");
    expect(body.discovery?.connected).toEqual([]);
  });

  test("answers 500 through createErrorResponse when reading the status throws", async () => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    discoveryFailure = new Error("discovery status read failed");
    const error = spyOn(logger, "error").mockImplementation(() => {});

    try {
      const res = await GET(request());

      expect(res.status).toBe(500);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("GET /api/admin/discovery: transport", () => {
  beforeEach(() => {
    process.env.SEED_DISCOVERY_PATH = exportPath;
    writeExport();
  });

  test("plainHttp is false for a loopback request", async () => {
    const { body } = await answer(request("http://localhost:3000/api/admin/discovery"));

    expect(body.transport).toEqual({ plainHttp: false, cookieSecureOff: false });
  });

  test("plainHttp is true for http on a public host", async () => {
    const { body } = await answer(request("http://studio.example.com/api/admin/discovery"));

    expect(body.transport).toEqual({ plainHttp: true, cookieSecureOff: false });
  });

  test("plainHttp follows a trusted X-Forwarded-Proto of https", async () => {
    const { body } = await answer(
      request("http://studio.example.com/api/admin/discovery", { "x-forwarded-proto": "https" }),
    );

    expect(body.transport?.plainHttp).toBe(false);
  });

  // The template ships AUTH_COOKIE_SECURE=false, so the cookie can still travel over http on the
  // same domain while the admin browses over https.
  test("cookieSecureOff is true for an https request when AUTH_COOKIE_SECURE is false", async () => {
    process.env.AUTH_COOKIE_SECURE = "false";

    const { body } = await answer(request("https://studio.example.com/api/admin/discovery"));

    expect(body.transport).toEqual({ plainHttp: false, cookieSecureOff: true });
  });

  test("cookieSecureOff is false when AUTH_COOKIE_SECURE is true or unset", async () => {
    process.env.AUTH_COOKIE_SECURE = "true";
    expect((await answer()).body.transport?.cookieSecureOff).toBe(false);

    delete process.env.AUTH_COOKIE_SECURE;
    expect((await answer()).body.transport?.cookieSecureOff).toBe(false);
  });
});
