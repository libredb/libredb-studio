import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { sealVersionOne } from "../../helpers/storage-envelope-v1";

/**
 * The storage routes over a real SQLite store (docs/STORAGE.md, "Where a sealed value opens"): every write seals each
 * credential for the session's owner key and the record as written, and keeps only a v2 value that already opens there,
 * so whatever text a client sends is stored and read back as that text. Only the session is stood in for, as
 * tests/api/storage/storage-routes.test.ts does; the factory, the encryption and the provider are the real ones.
 */

let session: { username: string; role: string } = { username: "alice@example.com", role: "user" };

mock.module("@/lib/auth", () => ({
  getSession: async () => session,
  readSession: mock(async () => ({ kind: "authenticated", session })),
}));

const { GET } = await import("@/app/api/storage/route");
const { PUT } = await import("@/app/api/storage/[collection]/route");
const { closeStorageProvider } = await import("@/lib/storage/factory");
const { resetStorageEncryptionKey } = await import("@/lib/storage/encryption");

const KEYS = ["STORAGE_PROVIDER", "STORAGE_SQLITE_PATH", "JWT_SECRET", "STORAGE_ENCRYPTION_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const dir = mkdtempSync(join(tmpdir(), "libredb-binding-routes-"));
const path = join(dir, "store.db");

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.STORAGE_PROVIDER = "sqlite";
  process.env.STORAGE_SQLITE_PATH = path;
  process.env.JWT_SECRET = randomBytes(32).toString("base64url");
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

afterAll(async () => {
  await closeStorageProvider();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetStorageEncryptionKey();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clearRateLimitState();
  session = { username: "alice@example.com", role: "user" };
});

function connection(password: string, overrides: Record<string, unknown> = {}) {
  return { id: "c1", name: "Orders", type: "postgres", host: "db.internal", user: "app", password, ...overrides };
}

async function put(data: unknown): Promise<number> {
  return (await putResponse(data)).status;
}

async function putResponse(data: unknown): Promise<Response> {
  return putBody(JSON.stringify({ data }));
}

/** PUT with `body` as the request's text, for a body JSON.stringify cannot write. */
async function putBody(body: string): Promise<Response> {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    return await PUT(
      new NextRequest("http://localhost/api/storage/connections", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      }),
      { params: Promise.resolve({ collection: "connections" }) },
    );
  } finally {
    warn.mockRestore();
  }
}

async function get(): Promise<{ connections?: Record<string, unknown>[] }> {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const response = await GET(new NextRequest("http://localhost/api/storage"));
    expect(response.status).toBe(200);
    return response.json();
  } finally {
    warn.mockRestore();
  }
}

/** The stored password of `owner`'s first connection, read with raw SQL. */
function storedPassword(owner: string): string {
  const db = new Database(path);
  try {
    const row = db
      .prepare("SELECT data FROM user_storage WHERE user_id = ? AND collection = 'connections'")
      .get(owner) as { data: string };
    return JSON.parse(row.data)[0].password;
  } finally {
    db.close();
  }
}

describe("the storage routes seal for the session's place", () => {
  test("a connection saved through PUT reads back through GET and is a v2 envelope at rest", async () => {
    const secret = randomUUID();

    expect(await put([connection(secret)])).toBe(200);

    expect(storedPassword("alice@example.com")).toStartWith("v2:");
    expect(storedPassword("alice@example.com")).not.toContain(secret);
    expect((await get()).connections?.[0].password).toBe(secret);
  });

  test("an edit of the host through PUT re-seals the password and GET opens it", async () => {
    const secret = randomUUID();
    await put([connection(secret)]);
    const before = storedPassword("alice@example.com");
    const [read] = (await get()).connections ?? [];

    expect(await put([{ ...read, host: "replica.internal" }])).toBe(200);

    expect(storedPassword("alice@example.com")).not.toBe(before);
    const [after] = (await get()).connections ?? [];
    expect([after.host, after.password]).toEqual(["replica.internal", secret]);
  });

  test("a v1 or v2 envelope sent as a password through PUT is stored and read back as the text it is", async () => {
    await put([connection(randomUUID(), { id: "elsewhere" })]);
    const foreignV2 = storedPassword("alice@example.com");
    // A version 1 envelope that opens under the store's key: the write must seal it as text, never open it.
    const versionOne = sealVersionOne(randomUUID());

    for (const text of [foreignV2, versionOne]) {
      // oxlint-disable-next-line no-await-in-loop -- one write and one read per value, in order.
      expect(await put([connection(text)])).toBe(200);

      expect(storedPassword("alice@example.com")).not.toBe(text);
      // oxlint-disable-next-line no-await-in-loop -- the read of the write just made.
      expect((await get()).connections?.[0].password).toBe(text);
    }
  });

  test("a password copied in the store from one account's row into another's is omitted from that account's GET", async () => {
    await put([connection(randomUUID())]);
    session = { username: "bob@example.com", role: "user" };
    await put([connection(randomUUID())]);
    const db = new Database(path);
    try {
      db.prepare(
        "UPDATE user_storage SET data = (SELECT data FROM user_storage WHERE user_id = 'alice@example.com' AND collection = 'connections') WHERE user_id = 'bob@example.com' AND collection = 'connections'",
      ).run();
    } finally {
      db.close();
    }

    const [read] = (await get()).connections ?? [];

    expect(read.id).toBe("c1");
    expect("password" in read).toBe(false);
  });

  test("a connection that cannot be sealed for its place is refused through PUT with a 400 naming its index, and nothing is stored", async () => {
    const kept = randomUUID();
    await put([connection(kept)]);
    const before = storedPassword("alice@example.com");
    let deep: unknown = "db.internal";
    for (let level = 0; level < 100; level++) deep = { inner: deep };

    for (const [record, message] of [
      [
        connection(randomUUID(), { sshTunnel: { password: [randomUUID()] } }),
        "connections[1] holds a value that is not text at sshTunnel.password",
      ],
      [connection(randomUUID(), { host: deep }), "connections[1] cannot be stored"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one request and one store read per case, in order.
      const response = await putResponse([connection(kept), record]);
      expect(response.status).toBe(400);
      // oxlint-disable-next-line no-await-in-loop -- the body of the response just answered.
      expect(((await response.json()) as { error: string }).error).toContain(message);
      expect(storedPassword("alice@example.com")).toBe(before);
    }
  });

  test("a connection nested deeper than JSON.stringify can write is refused through PUT with a 400, and nothing is stored", async () => {
    const kept = randomUUID();
    await put([connection(kept)]);
    const before = storedPassword("alice@example.com");
    const depth = 200_000;
    const record = JSON.stringify(connection(randomUUID(), { host: "HOST" })).replace(
      '"HOST"',
      `${"[".repeat(depth)}"db.internal"${"]".repeat(depth)}`,
    );

    const response = await putBody(`{"data":[${JSON.stringify(connection(kept))},${record}]}`);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("connections[1] cannot be stored");
    expect(storedPassword("alice@example.com")).toBe(before);
  });
});
