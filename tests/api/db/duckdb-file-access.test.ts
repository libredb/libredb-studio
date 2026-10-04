import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";

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
 * `SELECT * FROM read_text(...)`. After it, only an admin can.
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
const { clearProviderCache } = await import("@/lib/db/factory");

const workDir = mkdtempSync(join(tmpdir(), "libredb-duckdb-api-"));
const SECRET_PLACEHOLDER = "PROBE-DUMMY-NOT-A-SECRET";
const secretFile = join(workDir, "services.json");
writeFileSync(secretFile, JSON.stringify({ services: [{ env: { POSTGRES_PASSWORD: SECRET_PLACEHOLDER } }] }));

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

beforeEach(async () => {
  clearRateLimitState();
  await clearProviderCache();
});

afterEach(async () => {
  await clearProviderCache();
});

afterAll(() => {
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
