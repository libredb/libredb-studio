import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetCache as resetSeedCache } from "@/lib/seed/config-loader";

/**
 * The end-to-end B1 / K1 reproduction, through the real route and the real DuckDB engine.
 *
 * Unlike the other api/db tests, this file does NOT mock `@/lib/db`: the whole point is that a
 * `user`-role request reaches the real factory, which opens the DuckDB handle with the posture the
 * route derived from the session, so the engine itself refuses the file read. Only `getSession` is
 * mocked, to choose the role. The connection is inline `:memory:` DuckDB, and the "secret" every
 * scratch file holds is the placeholder PROBE-DUMMY-NOT-A-SECRET, never a real credential.
 *
 * This is the CapRover exposure, generalised: before this change a standard user could read any
 * file the Studio process can, `/app/discovery/services.json` included, with
 * `SELECT * FROM read_text(...)`. After it, only an admin can, and not on a seed a non-admin role
 * can use: that record is served by one handle for every role, opened with file access denied,
 * because DuckDB serves one file through one read-write handle per process.
 */

let role = "user";
mock.module("@/lib/auth", () => ({
  getSession: mock(async () => ({ role, username: role })),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

const { POST: queryPost } = await import("@/app/api/db/query/route");
const { POST: multiQueryPost } = await import("@/app/api/db/multi-query/route");
const { POST: testConnectionPost } = await import("@/app/api/db/test-connection/route");
const { clearProviderCache, getProviderCacheStats } = await import("@/lib/db/factory");

const workDir = mkdtempSync(join(tmpdir(), "libredb-duckdb-api-"));
const SECRET_PLACEHOLDER = "PROBE-DUMMY-NOT-A-SECRET";
const secretFile = join(workDir, "services.json");
writeFileSync(secretFile, JSON.stringify({ services: [{ env: { POSTGRES_PASSWORD: SECRET_PLACEHOLDER } }] }));

/**
 * The operator's seed file: one DuckDB seed every role can use, and one only admins can. Read
 * through the real loader and resolveConnection, so the record each role resolves is the one the
 * product builds.
 */
const sharedSeedFile = join(workDir, "shared-seed.duckdb");
const adminSeedFile = join(workDir, "admin-seed.duckdb");
const seedConfigFile = join(workDir, "seed-connections.json");
writeFileSync(
  seedConfigFile,
  JSON.stringify({
    version: "1",
    connections: [
      { id: "duck-shared", name: "Shared DuckDB", type: "duckdb", database: sharedSeedFile, roles: ["*"] },
      { id: "duck-admin", name: "Admin DuckDB", type: "duckdb", database: adminSeedFile, roles: ["admin"] },
    ],
  }),
);
const previousSeedConfigPath = process.env.SEED_CONFIG_PATH;
process.env.SEED_CONFIG_PATH = seedConfigFile;

/** An inline DuckDB connection; `:memory:`, so the file-read vector is independent of the target. */
function duckdbBody(sql: string): Record<string, unknown> {
  return {
    connection: { id: "inline-duck", name: "Inline DuckDB", type: "duckdb", database: ":memory:" },
    sql,
  };
}

async function postQuery(sql: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await queryPost(
    createMockRequest("/api/db/query", { method: "POST", body: duckdbBody(sql) }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
}

async function postMultiQuery(sql: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await multiQueryPost(
    createMockRequest("/api/db/multi-query", { method: "POST", body: duckdbBody(sql) }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
}

/** POST /api/db/query with any body: a seed id, or an inline connection of the caller's own. */
async function queryWith(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await queryPost(createMockRequest("/api/db/query", { method: "POST", body }) as never);
  return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
}

/** The `id` column of a result, in order. */
function ids(body: Record<string, unknown>): unknown[] {
  return (body.rows as { id: unknown }[]).map((row) => row.id);
}

beforeEach(async () => {
  clearRateLimitState();
  resetSeedCache();
  await clearProviderCache();
});

afterEach(async () => {
  await clearProviderCache();
});

afterAll(() => {
  if (previousSeedConfigPath === undefined) delete process.env.SEED_CONFIG_PATH;
  else process.env.SEED_CONFIG_PATH = previousSeedConfigPath;
  resetSeedCache();
  rmSync(workDir, { recursive: true, force: true });
});

describe("POST /api/db/query reads no file for a standard user on DuckDB (K1/B1)", () => {
  test("a user running read_text of the discovery-style file is refused, and the file never surfaces", async () => {
    role = "user";
    const { status, body } = await postQuery(`SELECT * FROM read_text('${secretFile}')`);

    expect(status).toBe(400);
    expect(String(body.error)).toContain("file system operations are disabled by configuration");
    expect(JSON.stringify(body)).not.toContain(SECRET_PLACEHOLDER);
  });

  test("the refusal names Studio's file-access policy, so it does not read as a server fault", async () => {
    role = "user";
    const { body } = await postQuery(`SELECT * FROM read_text('${secretFile}')`);

    expect(String(body.error)).toStartWith(
      "File and network access is off on this DuckDB connection, because Studio allows it only to an admin on a connection no non-admin role can use: Permission Error: Cannot access file",
    );
  });

  test("the same request as an admin returns the file's contents", async () => {
    role = "admin";
    const { status, body } = await postQuery(`SELECT content FROM read_text('${secretFile}')`);

    expect(status).toBe(200);
    expect(JSON.stringify(body.rows)).toContain(SECRET_PLACEHOLDER);
  });

  test("a user keeps a read-write DuckDB database: CREATE, INSERT and SELECT all succeed", async () => {
    role = "user";
    expect((await postQuery("CREATE TABLE t (id INTEGER, label VARCHAR)")).status).toBe(200);
    expect((await postQuery("INSERT INTO t VALUES (1, 'a')")).status).toBe(200);
    // One handle per (connection, posture) for the whole process, so the table persists across
    // these requests: the user's own database is fully writable, only the filesystem is closed.
    const read = await postQuery("SELECT label FROM t ORDER BY id");
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body.rows)).toContain("a");
  });

  test("a quoted read_text, which no name denylist could catch, is refused for a user by the engine", async () => {
    role = "user";
    const { status, body } = await postQuery(`SELECT * FROM "read_text"('${secretFile}')`);

    expect(status).toBe(400);
    expect(String(body.error)).toContain("file system operations are disabled by configuration");
    expect(JSON.stringify(body)).not.toContain(SECRET_PLACEHOLDER);
  });
});

describe("POST /api/db/multi-query carries the same per-role split (K1/B1)", () => {
  test("a user running read_text through multi-query is refused and the file never surfaces", async () => {
    role = "user";
    const { status, body } = await postMultiQuery(`SELECT * FROM read_text('${secretFile}')`);

    expect(status).toBe(200);
    // The route answers 200 with the per-statement outcome; the statement itself failed.
    expect(JSON.stringify(body)).toContain("file system operations are disabled by configuration");
    expect(JSON.stringify(body)).not.toContain(SECRET_PLACEHOLDER);
  });

  test("the same multi-query as an admin returns the file's contents", async () => {
    role = "admin";
    const { status, body } = await postMultiQuery(`SELECT content FROM read_text('${secretFile}')`);

    expect(status).toBe(200);
    expect(JSON.stringify(body)).toContain(SECRET_PLACEHOLDER);
  });
});

describe("one DuckDB seed a non-admin role can use is one handle for every role (B1/K1)", () => {
  // DuckDB serves one file through one read-write handle per process. A second read-write handle
  // on the same file opens on Linux and macOS, keeps its own copy of the catalog, and whichever
  // closes last checkpoints over the other's committed rows; Windows refuses it. So the record
  // every role resolves must stay one cache key, which means one posture for all of them.
  const SHARED = { connectionId: "seed:duck-shared" };

  test("an admin and a user share one cache entry, and every acknowledged row reaches the file", async () => {
    role = "admin";
    expect((await queryWith({ ...SHARED, sql: "CREATE TABLE t (id INTEGER)" })).status).toBe(200);
    expect((await queryWith({ ...SHARED, sql: "INSERT INTO t VALUES (1)" })).status).toBe(200);
    role = "user";
    expect((await queryWith({ ...SHARED, sql: "INSERT INTO t VALUES (2)" })).status).toBe(200);
    role = "admin";
    expect((await queryWith({ ...SHARED, sql: "INSERT INTO t VALUES (3)" })).status).toBe(200);
    role = "user";
    expect((await queryWith({ ...SHARED, sql: "CHECKPOINT" })).status).toBe(200);
    role = "admin";
    expect((await queryWith({ ...SHARED, sql: "INSERT INTO t VALUES (4)" })).status).toBe(200);

    // One record, one entry: both roles were served by the same handle.
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: ["seed:duck-shared"] });

    // Every handle closes, which is what the idle sweep and a shutdown do, and the file is read
    // back by a fresh handle: every row the route acknowledged is on disk.
    await clearProviderCache();
    role = "user";
    const read = await queryWith({ ...SHARED, sql: "SELECT id FROM t ORDER BY id" });
    expect(read.status).toBe(200);
    expect(ids(read.body)).toEqual([1, 2, 3, 4]);
  });

  test("on that seed an admin's read_text is refused too: the one handle is the non-admin posture", async () => {
    role = "admin";
    const { status, body } = await queryWith({ ...SHARED, sql: `SELECT * FROM read_text('${secretFile}')` });

    expect(status).toBe(400);
    expect(String(body.error)).toContain("file system operations are disabled by configuration");
    expect(JSON.stringify(body)).not.toContain(SECRET_PLACEHOLDER);
  });

  test("a seed only admins can use keeps the admin's full file access", async () => {
    role = "admin";
    const { status, body } = await queryWith({
      connectionId: "seed:duck-admin",
      sql: `SELECT content FROM read_text('${secretFile}')`,
    });

    expect(status).toBe(200);
    expect(JSON.stringify(body.rows)).toContain(SECRET_PLACEHOLDER);
  });

  test("an admin's own file-backed connection keeps its full file access", async () => {
    role = "admin";
    const { status, body } = await queryWith({
      connection: { id: "admin-file", name: "Admin file", type: "duckdb", database: join(workDir, "admin-own.duckdb") },
      sql: `SELECT content FROM read_text('${secretFile}')`,
    });

    expect(status).toBe(200);
    expect(JSON.stringify(body.rows)).toContain(SECRET_PLACEHOLDER);
  });
});

describe("POST /api/db/test-connection beside a writer of the other posture (B1/K1)", () => {
  test("a user's test of a file an admin holds open opens no second read-write handle, and the WAL stays", async () => {
    const file = join(workDir, "held-by-admin.duckdb");
    const adminConnection = { id: "admin-held", name: "Admin held", type: "duckdb", database: file };
    role = "admin";
    expect((await queryWith({ connection: adminConnection, sql: "CREATE TABLE t (id INTEGER)" })).status).toBe(200);
    expect((await queryWith({ connection: adminConnection, sql: "CHECKPOINT" })).status).toBe(200);
    expect((await queryWith({ connection: adminConnection, sql: "INSERT INTO t VALUES (1)" })).status).toBe(200);
    // The admin's committed row is in the write-ahead log, not yet in the file.
    expect(existsSync(`${file}.wal`)).toBe(true);

    role = "user";
    const response = await testConnectionPost(
      createMockRequest("/api/db/test-connection", {
        method: "POST",
        body: { connection: { id: "user-test", name: "User test", type: "duckdb", database: file } },
      }) as never,
    );
    const answer = await parseResponseJSON<Record<string, unknown>>(response);

    if (process.platform === "win32") {
      // Windows refuses any second handle on a file this process holds (docs/providers/duckdb.md
      // section 3.8), so the test reports the refusal rather than a connection.
      expect(answer.success).not.toBe(true);
    } else {
      expect(response.status).toBe(200);
      expect(answer.success).toBe(true);
    }
    // A read-write handle closing here would have checkpointed its own view over the file and
    // removed the WAL under the admin's open handle. A read-only one leaves it where it is.
    expect(existsSync(`${file}.wal`)).toBe(true);

    role = "admin";
    expect((await queryWith({ connection: adminConnection, sql: "INSERT INTO t VALUES (2)" })).status).toBe(200);
    await clearProviderCache();
    const read = await queryWith({ connection: adminConnection, sql: "SELECT id FROM t ORDER BY id" });
    expect(ids(read.body)).toEqual([1, 2]);
  });
});
