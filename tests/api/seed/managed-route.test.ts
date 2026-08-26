import { describe, it, expect, beforeEach, mock } from "bun:test";
import path from "path";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";

// Mock auth — must be before route import
mock.module("@/lib/auth", () => ({
  getSession: mock(() => ({ role: "admin", username: "admin@test.com" })),
  verifyJWT: mock(() => ({ role: "admin", username: "admin@test.com" })),
}));

import { GET } from "@/app/api/connections/managed/route";
import { resetCache } from "@/lib/seed/config-loader";
import { getSession } from "@/lib/auth";
import { setSqliteSampleSeedState, SQLITE_SAMPLE_SEED_ID } from "@/lib/seed/sqlite-sample";
import { SEED_CONFIG_UNREADABLE_REASON } from "@/hooks/use-connection-payload";

describe("GET /api/connections/managed", () => {
  beforeEach(() => {
    resetCache();
    // Reset mock to default admin session
    (getSession as ReturnType<typeof mock>).mockImplementation(() => ({ role: "admin", username: "admin@test.com" }));
  });

  it("returns managed connections for admin role", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connections.length).toBeGreaterThan(0);
    expect(data.cacheHint).toBe(60000);
  });

  it("filters connections by role", async () => {
    const res = await GET();
    const data = await res.json();
    const ids = data.connections.map((c: { seedId: string }) => c.seedId);
    expect(ids).toContain("admin-only");
    expect(ids).toContain("everyone");
    expect(ids).toContain("admin-and-user");
  });

  it("strips password from managed:true connections", async () => {
    const res = await GET();
    const data = await res.json();
    const managed = data.connections.find((c: { managed: boolean }) => c.managed);
    if (managed) {
      expect(managed.password).toBeUndefined();
    }
  });

  it("returns 401 when no session", async () => {
    (getSession as ReturnType<typeof mock>).mockImplementation(() => null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty array when config file missing", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = "/nonexistent/path.yaml";
    resetCache();
    const res = await GET();
    const data = await res.json();
    expect(data.connections).toHaveLength(0);
    process.env.SEED_CONFIG_PATH = origPath;
    resetCache();
  });

  it("includes credentials for managed:false connections", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(
      path.resolve(__dirname, "../../fixtures/seed-connections"),
      "valid-config.yaml",
    );
    process.env.TEST_PG_PASSWORD = "pg-pass";
    process.env.TEST_MYSQL_PASSWORD = "mysql-pass";
    process.env.TEST_MONGO_URI = "mongodb://host/db";
    process.env.TEST_REDIS_PASSWORD = "redis-pass";
    resetCache();

    const res = await GET();
    const data = await res.json();
    const unmanaged = data.connections.find((c: { managed: boolean }) => !c.managed);
    expect(unmanaged).toBeDefined();
    expect(unmanaged.password).toBe("mysql-pass");

    process.env.SEED_CONFIG_PATH = origPath;
    delete process.env.TEST_PG_PASSWORD;
    delete process.env.TEST_MYSQL_PASSWORD;
    delete process.env.TEST_MONGO_URI;
    delete process.env.TEST_REDIS_PASSWORD;
    resetCache();
  });

  it("returns no pending seeds when nothing is seeding", async () => {
    const res = await GET();
    const data = await res.json();
    expect(data.pendingSeeds).toEqual([]);
  });

  it("advertises the sqlite sample while its async seed is in flight", async () => {
    setSqliteSampleSeedState("seeding");
    try {
      const res = await GET();
      const data = await res.json();
      expect(data.pendingSeeds).toEqual([SQLITE_SAMPLE_SEED_ID]);
    } finally {
      setSqliteSampleSeedState("idle");
    }
  });

  it("returns 500 when config is invalid", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(
      path.resolve(__dirname, "../../fixtures/seed-connections"),
      "invalid-config.yaml",
    );
    resetCache();

    const res = await GET();
    expect(res.status).toBe(500);

    process.env.SEED_CONFIG_PATH = origPath;
    resetCache();
  });

  // B37. A 500 alone tells the browser only that this request failed, and a browser
  // that cannot tell "the server serves no seeds" from "the server could not read its
  // seed list" ends up saying the first about connections this application seeds
  // itself. So the failure NAMES itself: the seed configuration is what could not be
  // read, and that is the sentence a user is owed.
  it("names the seed configuration as the thing that failed, not just the request", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(
      path.resolve(__dirname, "../../fixtures/seed-connections"),
      "invalid-config.yaml",
    );
    resetCache();

    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load managed connections",
      reason: SEED_CONFIG_UNREADABLE_REASON,
    });

    process.env.SEED_CONFIG_PATH = origPath;
    resetCache();
  });

  // The other half of the same claim: a failure that is NOT the seed configuration must
  // not be reported as one. Without this arm the reason would be a synonym for 500 and
  // the rail would blame a config file for a broken session cookie.
  it("does not blame the seed configuration for a failure somewhere else", async () => {
    (getSession as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error("session store unreachable");
    });

    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("Failed to load managed connections");
    expect(body.reason).toBeUndefined();
  });
});
