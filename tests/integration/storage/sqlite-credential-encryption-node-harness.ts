/**
 * Node-runtime harness for a real STORAGE_PROVIDER=sqlite credential-encryption round trip.
 *
 * Bun cannot load better-sqlite3 in-process ("'better-sqlite3' is not yet supported in Bun"), so
 * the storage layer's SQLite provider - decorated with the same withCredentialEncryption() the
 * factory applies in production - is exercised in a real `node` subprocess: the test bundles this
 * file with `bun build --target=node --external better-sqlite3` and runs the bundle with
 * `node <bundle> <db-path>`.
 *
 * What this proves that tests/security/credential-at-rest.test.ts cannot: that file uses an
 * in-memory CaptureProvider standing in for a real store. This harness writes through a REAL
 * better-sqlite3 file, checkpoints its WAL, and inspects the actual bytes on disk - the threat
 * model the posture page names (a stolen file, dump, backup or snapshot) - rather than an
 * in-process JavaScript object.
 */

import fs from "node:fs";
import { withCredentialEncryption } from "../../../src/lib/storage/encrypting-provider";
import { resetStorageEncryptionKey } from "../../../src/lib/storage/encryption";
import { SQLiteStorageProvider } from "../../../src/lib/storage/providers/sqlite";
import type { DatabaseConnection } from "../../../src/lib/types";

const USER_ID = "u@example.org";
const CANARY = "HARNESS-CANARY-PASSWORD";

function connection(): DatabaseConnection {
  return {
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    password: CANARY,
    createdAt: new Date(0),
  };
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    throw new Error("usage: node sqlite-credential-encryption-node-harness.mjs <db-path>");
  }

  const report: Record<string, unknown> = { runtime: typeof Bun === "undefined" ? "node" : "bun" };

  // Phase 1: write a connection carrying the canary password, under the FIRST key.
  process.env.JWT_SECRET = "harness-first-jwt-secret-at-least-32-chars";
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();

  const writer = withCredentialEncryption(new SQLiteStorageProvider(dbPath));
  await writer.initialize();
  await writer.setCollection(USER_ID, "connections", [connection()]);
  await writer.close();

  // Checkpoint the WAL into the main file and inspect the ACTUAL PERSISTED ROW plus the RAW BYTES
  // ON DISK - not the API surface, the file a backup or volume snapshot would actually contain.
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(dbPath);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  const row = raw
    .prepare("SELECT data FROM user_storage WHERE user_id = ? AND collection = ?")
    .get(USER_ID, "connections") as { data: string };
  raw.close();

  const fileBytes = fs.readFileSync(dbPath).toString("latin1");
  report.canaryInFile = fileBytes.includes(CANARY);
  report.rowContainsCanary = row.data.includes(CANARY);
  report.rowLooksSealed = /"password":"v1:/.test(row.data);

  // Phase 2: rotate the key (a fresh JWT_SECRET, exactly what an operator does) and read back
  // through a NEW provider instance against the SAME on-disk file.
  process.env.JWT_SECRET = "harness-second-jwt-secret-totally-different-value";
  resetStorageEncryptionKey();

  const reader = withCredentialEncryption(new SQLiteStorageProvider(dbPath));
  await reader.initialize();
  const afterRotation = await reader.getCollection(USER_ID, "connections");
  await reader.close();

  report.survivesRotation = Array.isArray(afterRotation) && afterRotation.length === 1;
  const first = afterRotation?.[0] as (DatabaseConnection & Record<string, unknown>) | undefined;
  report.passwordOmittedAfterRotation = first ? !("password" in first) : null;
  report.hostStillReadableAfterRotation = first?.host ?? null;

  console.log(JSON.stringify(report));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
