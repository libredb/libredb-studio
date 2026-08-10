import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveBootstrapPath } from "@/lib/auth-bootstrap";
import { getDataDir } from "@/lib/data-dir";
import { withCredentialEncryption } from "@/lib/storage/encrypting-provider";
import { resetStorageEncryptionKey } from "@/lib/storage/encryption";
import type { ServerStorageProvider, StorageCollection, StorageData } from "@/lib/storage/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Threat: someone who obtains the server store - a stolen SQLite file, a PostgreSQL dump, a leaked
 * backup, a misconfigured volume snapshot - can read every database credential the user configured.
 *
 * The assertion is deliberately about the BYTES that reach the persistence layer, not about which
 * function was called: an implementation that encrypts and then also writes a plaintext copy under
 * a different key would pass a call-shape test and fail this one.
 *
 * No mock.module here on purpose. `bun run test` runs tests/security as ONE process and
 * route-auth.test.ts imports every API route (hence every driver), so mocking pg or better-sqlite3
 * in this file would poison it. Provider faithfulness is pinned instead in
 * tests/unit/lib/storage/providers/*.test.ts.
 */

const CANARIES = [
  "CANARY-DB-PASSWORD",
  "CANARY-IN-URL",
  "CANARY-TLS-CLIENT-KEY",
  "CANARY-SSH-PASSWORD",
  "CANARY-SSH-PRIVATE-KEY",
  "CANARY-SSH-PASSPHRASE",
];

function connectionWithEverySecret(): DatabaseConnection {
  return {
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    user: "app",
    password: "CANARY-DB-PASSWORD",
    database: "prod",
    connectionString: "postgres://app:CANARY-IN-URL@db.internal:5432/prod",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ssl: { mode: "verify-full", clientKey: "CANARY-TLS-CLIENT-KEY", rejectUnauthorized: true },
    sshTunnel: {
      enabled: true,
      host: "bastion.internal",
      port: 22,
      username: "tunnel",
      authMethod: "privateKey",
      password: "CANARY-SSH-PASSWORD",
      privateKey: "CANARY-SSH-PRIVATE-KEY",
      passphrase: "CANARY-SSH-PASSPHRASE",
    },
  };
}

/**
 * Stands in for a real provider at exactly the point one receives its argument. Both shipped
 * providers do `JSON.stringify(data)` into a bound parameter and nothing else
 * (src/lib/storage/providers/sqlite.ts:118, postgres.ts:107), which is what `persisted()` models.
 */
class CaptureProvider implements ServerStorageProvider {
  readonly rows = new Map<string, unknown>();

  async initialize(): Promise<void> {}
  async isHealthy(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async getAllData(): Promise<Partial<StorageData>> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of this.rows) data[key] = value;
    return data as Partial<StorageData>;
  }
  async getCollection<K extends StorageCollection>(_userId: string, collection: K): Promise<StorageData[K] | null> {
    return (this.rows.get(collection) as StorageData[K]) ?? null;
  }
  async setCollection<K extends StorageCollection>(
    _userId: string,
    collection: K,
    data: StorageData[K],
  ): Promise<void> {
    this.rows.set(collection, data);
  }
  async mergeData(_userId: string, data: Partial<StorageData>): Promise<void> {
    for (const [key, value] of Object.entries(data)) this.rows.set(key, value);
  }

  /** Everything this store holds, as the bytes a dump would contain. */
  persisted(): string {
    return JSON.stringify([...this.rows.entries()]);
  }
}

const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot.JWT_SECRET = process.env.JWT_SECRET;
  snapshot.STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.JWT_SECRET = "credential-at-rest-test-jwt-secret-32";
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

afterEach(() => {
  if (snapshot.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = snapshot.JWT_SECRET;
  if (snapshot.STORAGE_ENCRYPTION_KEY === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = snapshot.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

describe("no plaintext credential reaches the server store", () => {
  test("through a single-collection write, the path the sync hook uses on every change", async () => {
    const inner = new CaptureProvider();
    await withCredentialEncryption(inner).setCollection("u@example.org", "connections", [connectionWithEverySecret()]);

    for (const canary of CANARIES) {
      expect({ canary, inTheStore: inner.persisted().includes(canary) }).toEqual({ canary, inTheStore: false });
    }
  });

  test("through the migration write, the path that carries a whole localStorage dump at once", async () => {
    const inner = new CaptureProvider();
    await withCredentialEncryption(inner).mergeData("u@example.org", {
      connections: [connectionWithEverySecret()],
      history: [],
    });

    for (const canary of CANARIES) {
      expect({ canary, inTheStore: inner.persisted().includes(canary) }).toEqual({ canary, inTheStore: false });
    }
  });

  test("the record is still there, still identifiable, and still usable after a round trip", async () => {
    const inner = new CaptureProvider();
    const provider = withCredentialEncryption(inner);
    const original = connectionWithEverySecret();
    await provider.setCollection("u@example.org", "connections", [original]);

    // The store names the host in the clear on purpose: an operator holding a dump must be able to
    // answer "which of my databases is in here". That is incident response, not leakage.
    expect(inner.persisted()).toContain("db.internal");
    expect(await provider.getCollection("u@example.org", "connections")).toEqual([original]);
  });

  test("a store written before this feature existed still opens, with no migration step", async () => {
    const inner = new CaptureProvider();
    // Seed the INNER provider directly: this is a row that predates the decorator.
    await inner.setCollection("u@example.org", "connections", [connectionWithEverySecret()]);

    const data = await withCredentialEncryption(inner).getAllData("u@example.org");

    expect(data.connections?.[0].password).toBe("CANARY-DB-PASSWORD");
  });

  test("a credential is never readable through a collection that does not hold one", async () => {
    const inner = new CaptureProvider();
    await withCredentialEncryption(inner).setCollection("u@example.org", "saved_queries", [
      {
        id: "q1",
        name: "canary",
        query: "SELECT 'CANARY-DB-PASSWORD'",
        connectionType: "postgres",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    // SQL text is the product's data, not its secrets, and is stored as written. This pins the
    // scope of the control so nobody later reads its absence here as a gap.
    expect(inner.persisted()).toContain("CANARY-DB-PASSWORD");
  });
});

describe("a key the store cannot be opened with", () => {
  test("returns the connection without its secrets instead of failing the whole read", async () => {
    const inner = new CaptureProvider();
    await withCredentialEncryption(inner).setCollection("u@example.org", "connections", [connectionWithEverySecret()]);

    process.env.JWT_SECRET = "an-entirely-different-secret-value-32c";
    resetStorageEncryptionKey();
    const data = await withCredentialEncryption(inner).getAllData("u@example.org");

    expect(data.connections).toHaveLength(1);
    expect(data.connections?.[0].name).toBe("Prod");
    expect(data.connections?.[0].password).toBeUndefined();
    // Never the envelope itself: "v1:..." reaching a driver as a password is undiagnosable.
    expect(JSON.stringify(data.connections)).not.toContain("v1:");
  });
});

/**
 * A stolen database file "on its own" and a stolen backup or volume snapshot are different
 * threats, and the difference matters only for STORAGE_PROVIDER=sqlite with no
 * STORAGE_ENCRYPTION_KEY set: the fallback key derives from JWT_SECRET, which the first-run
 * bootstrap persists in auth-bootstrap.json (src/lib/auth-bootstrap.ts), and both that file and the
 * SQLite store resolve their directory through the SAME function - getDataDir() - reading the SAME
 * STORAGE_SQLITE_PATH. The Helm chart then mounts that one directory as a single /app/data volume
 * (charts/libredb-studio/templates/deployment.yaml). A snapshot of it therefore contains the
 * ciphertext and the key that opens it side by side; docs/SECURITY.md and docs/STORAGE.md scope
 * their "protects a backup or volume snapshot" claim to exclude this case for exactly that reason.
 *
 * This test pins the fact the caveat depends on, not the prose. If a future change gives the
 * bootstrap file its own directory (or its own env var), this test fails - which is the signal that
 * the docs can be widened back, not a sign this test is stale.
 */
describe("the SQLite default-key backup boundary the docs carve out", () => {
  test("the auth-bootstrap file (carrying the fallback key) resolves to the same directory as the SQLite store", () => {
    expect(path.dirname(resolveBootstrapPath())).toBe(path.resolve(getDataDir()));
  });

  test("both resolve through the same STORAGE_SQLITE_PATH, not independent configuration", () => {
    const original = process.env.STORAGE_SQLITE_PATH;
    process.env.STORAGE_SQLITE_PATH = "/custom/deployment/path/store.db";
    try {
      expect(path.dirname(resolveBootstrapPath())).toBe(path.resolve(getDataDir()));
    } finally {
      if (original === undefined) delete process.env.STORAGE_SQLITE_PATH;
      else process.env.STORAGE_SQLITE_PATH = original;
    }
  });
});
