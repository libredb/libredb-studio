import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { forgetStorageLocation } from "@/lib/data-dir";
import { RESERVED_STORAGE_PATH } from "@/lib/db/provider-files";

/**
 * The button a user presses: a connection that names Studio's own storage database, sent inline to the real routes.
 *
 * Studio's provider factory refuses such a connection when it builds the provider (FND-2 slice 3, docs/SECURITY.md
 * control 3.45), so Test Connection answers with the reserved sentence as it did when the provider refused at connect,
 * and provider-meta, which builds a provider without connecting, now answers the same refusal instead of the provider's
 * capabilities. `@/lib/db` is not mocked: the routes reach the real factory. Only the session is, as an administrator,
 * whom the SQLite file-access posture lets open a file.
 */
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
  readSession: mock(async () => ({ kind: "authenticated", session: { role: "admin", username: "admin" } })),
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
