import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "@/lib/password-hash";
import { closeStorageProvider, getStorageProvider } from "@/lib/storage/factory";
import type { ServerStorageProvider, StoredAccount, StoredPasskey } from "@/lib/storage/types";

export const PASSKEY_TEST_ORIGIN = "http://localhost:3000";
export const PASSKEY_TEST_RP_ID = "localhost";

const SAVED_KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_SQLITE_PATH",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "PASSKEY_ORIGIN",
  "ADMIN_TOTP_SECRET",
  "USER_TOTP_SECRET",
  "ADMIN_PASSWORD_RESET",
] as const;

export interface StoreFixture {
  dir: string;
  provider(): Promise<ServerStorageProvider>;
  createAccount(input: {
    email: string;
    password: string;
    role: "admin" | "user";
    totpSecret?: string;
  }): Promise<StoredAccount>;
  close(): Promise<void>;
}

/** Temp SQLite store with local auth and PASSKEY_ORIGIN set; saves and restores every env var it touches. */
export async function openStoreFixture(): Promise<StoreFixture> {
  const saved = new Map(SAVED_KEYS.map((key) => [key, process.env[key]]));
  await closeStorageProvider();
  const dir = mkdtempSync(join(tmpdir(), "libredb-passkey-store-"));
  process.env.STORAGE_PROVIDER = "sqlite";
  process.env.STORAGE_SQLITE_PATH = join(dir, "store.db");
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
  process.env.PASSKEY_ORIGIN = PASSKEY_TEST_ORIGIN;
  delete process.env.ADMIN_TOTP_SECRET;
  delete process.env.USER_TOTP_SECRET;
  delete process.env.ADMIN_PASSWORD_RESET;

  async function provider(): Promise<ServerStorageProvider> {
    const opened = await getStorageProvider();
    if (!opened) throw new Error("the fixture's SQLite store did not open");
    return opened;
  }

  return {
    dir,
    provider,
    async createAccount({ email, password, role, totpSecret }) {
      const now = new Date().toISOString();
      const account: StoredAccount = {
        email,
        passwordHash: await hashPassword(password),
        role,
        totpSecret: totpSecret ?? null,
        totpPending: null,
        disabled: false,
        sessionVersion: randomInt(1, 2 ** 30),
        createdAt: now,
        updatedAt: now,
      };
      await (await provider()).insertAccount(account);
      return account;
    },
    async close() {
      await closeStorageProvider();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeStoredPasskey(overrides: Partial<StoredPasskey> & { accountEmail: string }): StoredPasskey {
  return {
    id: randomUUID(),
    credentialId: randomBytes(16).toString("base64url"),
    publicKey: "AA",
    signCount: 0,
    transports: ["internal"],
    backupEligible: false,
    backupState: false,
    rpId: PASSKEY_TEST_RP_ID,
    name: "Passkey",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    ...overrides,
  };
}
