import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { forgetStorageLocation } from "@/lib/data-dir";
import { NO_FILE_AFTER_SCHEME, PATH_NOT_CHECKED, RESERVED_STORAGE_PATH } from "@/lib/db/provider-files";

/**
 * The button a user presses: a connection that names Studio's own storage database, sent inline to the real routes.
 *
 * Studio's provider factory refuses such a connection when it builds the provider (FND-2 slice 3, docs/SECURITY.md
 * control 3.45), so Test Connection answers with the reserved sentence as it did when the provider refused at connect,
 * and provider-meta, which builds a provider without connecting, now answers the same refusal instead of the provider's
 * capabilities. `@/lib/db` is not mocked: the routes reach the real factory. Only the session is: an administrator,
 * whom the SQLite file-access posture lets open a file, unless a test names the user role.
 */
let role: "admin" | "user" = "admin";
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role, username: role })),
  readSession: mock(async () => ({ kind: "authenticated", session: { role, username: role } })),
}));

const { POST: testConnectionPost } = await import("@/app/api/db/test-connection/route");
const { POST: providerMetaPost } = await import("@/app/api/db/provider-meta/route");

const workDir = mkdtempSync(join(tmpdir(), "libredb-reserved-routes-"));
const storageFile = join(workDir, "libredb-storage.db");
const previousStoragePath = process.env.STORAGE_SQLITE_PATH;
process.env.STORAGE_SQLITE_PATH = storageFile;
forgetStorageLocation();

const reservedSqlite = { id: "inline-reserved", name: "Reserved", type: "sqlite", database: storageFile };

beforeEach(() => {
  role = "admin";
  clearRateLimitState();
});

afterAll(() => {
  if (previousStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = previousStoragePath;
  forgetStorageLocation();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the routes answer a connection to Studio's own storage database with the reserved sentence (FND-2 slice 3)", () => {
  test("Test Connection answers a SQLite connection to the storage database with the reserved sentence and creates nothing", async () => {
    const response = await testConnectionPost(
      createMockRequest("/api/db/test-connection", { method: "POST", body: { connection: reservedSqlite } }) as never,
    );
    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: RESERVED_STORAGE_PATH,
      code: "CONFIG_ERROR",
      statusCode: 400,
    });
    expect(existsSync(storageFile)).toBe(false);
  });

  test("provider-meta answers the same connection with the reserved sentence", async () => {
    const response = await providerMetaPost(
      createMockRequest("/api/db/provider-meta", { method: "POST", body: { connection: reservedSqlite } }) as never,
    );
    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: RESERVED_STORAGE_PATH,
      code: "CONFIG_ERROR",
      statusCode: 400,
    });
    expect(existsSync(storageFile)).toBe(false);
  });
});

describe("the routes answer a connection whose file Studio cannot check or that names no file by name (FND-2 slice 3)", () => {
  test("a user, whom the SQLite file-access posture would refuse at connect, is answered with the reserved sentence first", async () => {
    role = "user";
    const response = await testConnectionPost(
      createMockRequest("/api/db/test-connection", { method: "POST", body: { connection: reservedSqlite } }) as never,
    );
    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: RESERVED_STORAGE_PATH,
      code: "CONFIG_ERROR",
      statusCode: 400,
    });
  });

  // POSIX reports a path through a regular file as ENOTDIR; Windows reports it as absent (ENOENT), so the factory admits
  // it there (measured in samples.test.ts, "a target through a regular file is refused as target-unreadable on POSIX
  // and admitted on Windows").
  test.skipIf(process.platform === "win32")(
    "Test Connection and provider-meta answer a path through a regular file with a client error naming the filesystem's reason (POSIX)",
    async () => {
      const plain = join(workDir, "plain-file");
      writeFileSync(plain, "");
      const throughFile = {
        id: "inline-enotdir",
        name: "Through a file",
        type: "sqlite",
        database: join(plain, "x.db"),
      };
      for (const [route, post] of [
        ["/api/db/test-connection", testConnectionPost],
        ["/api/db/provider-meta", providerMetaPost],
      ] as const) {
        const response = await post(
          createMockRequest(route, { method: "POST", body: { connection: throughFile } }) as never,
        );
        const body = await parseResponseJSON<Record<string, unknown>>(response);
        expect([route, response.status, body.code]).toEqual([route, 400, "CONFIG_ERROR"]);
        expect(String(body.error).startsWith(`${PATH_NOT_CHECKED}: ENOTDIR: `)).toBe(true);
      }
    },
  );

  test("Test Connection answers a SQLite connection string that names no file after file: with that sentence", async () => {
    const bareScheme = { id: "inline-bare-scheme", name: "Bare scheme", type: "sqlite", connectionString: "file:" };
    const response = await testConnectionPost(
      createMockRequest("/api/db/test-connection", { method: "POST", body: { connection: bareScheme } }) as never,
    );
    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: NO_FILE_AFTER_SCHEME,
      code: "CONFIG_ERROR",
      statusCode: 400,
    });
  });
});
