import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { forgetStorageLocation } from "@/lib/data-dir";
import { resetCache as resetSeedCache } from "@/lib/seed";
import { NO_FILE_AFTER_SCHEME, PATH_NOT_CHECKED, RESERVED_STORAGE_PATH } from "@/lib/db/provider-files";

/**
 * The button a user presses: a connection that names Studio's own storage database, sent inline to the real routes.
 *
 * Studio's provider factory refuses such a connection when it builds the provider (FND-2 slice 3, docs/SECURITY.md
 * control 3.45), so Test Connection answers with the reserved sentence as it did when the provider refused at connect,
 * and provider-meta, which builds a provider without connecting, now answers the same refusal instead of the provider's
 * capabilities. `@/lib/db` is not mocked: the routes reach the real factory. Only the session is: an administrator,
 * whom the SQLite file-access posture lets open a file, unless a test names the user role, whose posture SQLite
 * refuses: the factory answers that role SQLite's own refusal before it reads the path the connection names, so the
 * answer is the same for every path.
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
const { POST: queryPost } = await import("@/app/api/db/query/route");

const workDir = mkdtempSync(join(tmpdir(), "libredb-reserved-routes-"));
const storageFile = join(workDir, "libredb-storage.db");
const previousStoragePath = process.env.STORAGE_SQLITE_PATH;
process.env.STORAGE_SQLITE_PATH = storageFile;
forgetStorageLocation();

const reservedSqlite = { id: "inline-reserved", name: "Reserved", type: "sqlite", database: storageFile };

// An operator's seed file whose OPC UA connection names the storage database as its client private key: the one place
// such a path can come from, since a connection a browser or a client supplies inline cannot set it.
const seedConfigFile = join(workDir, "seed-connections.json");
writeFileSync(
  seedConfigFile,
  JSON.stringify({
    version: "1",
    connections: [
      {
        id: "opcua-reserved-key",
        name: "OPC UA",
        type: "opcua",
        host: "opc.tcp://127.0.0.1:1/",
        clientCertificatePath: join(workDir, "client.pem"),
        clientPrivateKeyPath: storageFile,
        roles: ["*"],
      },
    ],
  }),
);
const previousSeedConfigPath = process.env.SEED_CONFIG_PATH;
process.env.SEED_CONFIG_PATH = seedConfigFile;
resetSeedCache();

beforeEach(() => {
  role = "admin";
  clearRateLimitState();
});

afterAll(() => {
  if (previousSeedConfigPath === undefined) delete process.env.SEED_CONFIG_PATH;
  else process.env.SEED_CONFIG_PATH = previousSeedConfigPath;
  resetSeedCache();
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
      kind: "config",
      outcome: "unknown",
    });
    expect(existsSync(storageFile)).toBe(false);
  });

  test("Test Connection answers an OPC UA seed whose client private key names the storage database with the reserved sentence after the field", async () => {
    const response = await testConnectionPost(
      createMockRequest("/api/db/test-connection", {
        method: "POST",
        body: { connectionId: "seed:opcua-reserved-key" },
      }) as never,
    );
    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: `clientPrivateKeyPath: ${RESERVED_STORAGE_PATH}`,
      code: "CONFIG_ERROR",
      statusCode: 400,
      kind: "config",
      outcome: "unknown",
    });
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
      kind: "config",
      outcome: "unknown",
    });
    expect(existsSync(storageFile)).toBe(false);
  });
});

describe("the routes answer a connection whose file Studio cannot check or that names no file by name (FND-2 slice 3)", () => {
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
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is read on its own.
        const response = await post(
          createMockRequest(route, { method: "POST", body: { connection: throughFile } }) as never,
        );
        // oxlint-disable-next-line no-await-in-loop -- as above.
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
      kind: "config",
      outcome: "unknown",
    });
  });
});

/** SQLite's own refusal of a connection whose file-access posture is denied, as its provider raises it. */
const ADMINISTRATOR_REFUSAL =
  "SQLite connections require an administrator because this driver cannot confine statement-level file access";

/** The filesystem reads the reserved check makes, each spied on to see which paths Studio read. */
const FILESYSTEM_READS = ["realpathSync", "lstatSync", "statSync", "readlinkSync"] as const;

describe("a role whose file-access posture SQLite refuses is answered with that refusal before Studio reads the path it names (FND-2 slice 3)", () => {
  test("Test Connection, provider-meta and a query naming a database answer the user role the administrator refusal for Studio's storage file, a path under a regular file, an unreadable directory and a self-referencing link, and read none of them", async () => {
    role = "user";
    const plain = join(workDir, "plain-for-user");
    writeFileSync(plain, "");
    const locked = join(workDir, "locked-for-user");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const selfLink = join(workDir, "self-link");
    symlinkSync(selfLink, selfLink);
    const paths = [storageFile, join(plain, "x.db"), join(locked, "x.db"), selfLink];
    // The query route reads the connection's declarations before it opens one when the body names a database (a key's
    // database), so it builds a provider there too.
    const routes = [
      ["/api/db/test-connection", testConnectionPost, {}],
      ["/api/db/provider-meta", providerMetaPost, {}],
      ["/api/db/query", queryPost, { sql: "SELECT 1", database: 0 }],
    ] as const;
    const spies = FILESYSTEM_READS.map((name) => spyOn(fs, name));
    try {
      const answers: unknown[] = [];
      for (const database of paths) {
        for (const [route, post, fields] of routes) {
          const connection = { id: "inline-user-file", name: "User file", type: "sqlite", database };
          const body = { connection, ...fields };
          // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is read on its own.
          const response = await post(createMockRequest(route, { method: "POST", body }) as never);
          // oxlint-disable-next-line no-await-in-loop -- as above.
          answers.push([route, database, response.status, await parseResponseJSON(response)]);
        }
      }
      const refusal = {
        error: ADMINISTRATOR_REFUSAL,
        code: "CONFIG_ERROR",
        statusCode: 400,
        kind: "config",
        outcome: "unknown",
      };
      expect(answers).toEqual(paths.flatMap((database) => routes.map(([route]) => [route, database, 400, refusal])));
      const read = spies.flatMap((spy) =>
        spy.mock.calls.map((call) => String(call[0])).filter((file) => paths.some((named) => file.startsWith(named))),
      );
      expect(read).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
      chmodSync(locked, 0o700);
    }
    expect(existsSync(storageFile)).toBe(false);
  });
});
