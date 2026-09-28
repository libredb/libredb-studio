import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  consumeAuthenticationChallenge,
  consumeRegistrationChallenge,
  getOrCreateWebAuthnUserId,
  getPasskeyById,
  getPasskeysForUser,
  saveAuthenticationChallenge,
  savePasskey,
  saveRegistrationChallenge,
  updatePasskeyCounter,
} from "@/lib/passkey/passkey-store";

const originalStoragePath = process.env.STORAGE_SQLITE_PATH;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-passkey-test-"));

process.env.STORAGE_SQLITE_PATH = path.join(tempDir, "storage.db");

afterAll(() => {
  if (originalStoragePath === undefined) {
    delete process.env.STORAGE_SQLITE_PATH;
  } else {
    process.env.STORAGE_SQLITE_PATH = originalStoragePath;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tempDir, "auth-passkeys.json"), { force: true });
});

const passkey = {
  id: "credential-1",
  userId: "alice@example.com",
  publicKey: "test-public-key",
  counter: 0,
  transports: ["internal"],
  createdAt: "2026-09-22T00:00:00.000Z",
};

describe("passkey store", () => {
  test("saves and retrieves a passkey for its user", () => {
    savePasskey(passkey);

    expect(getPasskeyById(passkey.id)).toEqual(passkey);
    expect(getPasskeysForUser(passkey.userId)).toEqual([passkey]);
  });

  test("does not return another user's passkeys", () => {
    savePasskey(passkey);

    expect(getPasskeysForUser("bob@example.com")).toEqual([]);
  });

  test("rejects duplicate credential IDs", () => {
    savePasskey(passkey);

    expect(() => savePasskey(passkey)).toThrow("Passkey is already registered");
  });

  test("updates the authenticator counter and last-used time", () => {
    savePasskey(passkey);

    updatePasskeyCounter(passkey.id, 7);

    const updated = getPasskeyById(passkey.id);

    expect(updated?.counter).toBe(7);
    expect(updated?.lastUsedAt).toEqual(expect.any(String));
  });

  test("throws when updating a missing passkey", () => {
    expect(() => updatePasskeyCounter("missing", 1)).toThrow("Passkey not found");
  });

  test("creates a stable opaque WebAuthn user ID", () => {
    const first = getOrCreateWebAuthnUserId("alice@example.com");
    const second = getOrCreateWebAuthnUserId("alice@example.com");

    expect(first).toBe(second);
    expect(first).not.toBe("alice@example.com");
  });

  test("creates different WebAuthn user IDs for different users", () => {
    const alice = getOrCreateWebAuthnUserId("alice@example.com");
    const bob = getOrCreateWebAuthnUserId("bob@example.com");

    expect(alice).not.toBe(bob);
    expect(alice).not.toBe("alice@example.com");
    expect(bob).not.toBe("bob@example.com");
  });

  test("registration challenges are one-time", () => {
    saveRegistrationChallenge("alice@example.com", "registration-123", Date.now() + 60_000);

    expect(consumeRegistrationChallenge("alice@example.com")).toBe("registration-123");
    expect(consumeRegistrationChallenge("alice@example.com")).toBeNull();
  });

  test("expired registration challenges are rejected", () => {
    saveRegistrationChallenge("alice@example.com", "expired", Date.now() - 1);

    expect(consumeRegistrationChallenge("alice@example.com")).toBeNull();
  });

  test("authentication challenges are one-time", () => {
    saveAuthenticationChallenge(
      "session-123",
      "authentication-123",
      Date.now() + 60_000,
    );

    expect(consumeAuthenticationChallenge("session-123")).toBe("authentication-123");
    expect(consumeAuthenticationChallenge("session-123")).toBeNull();
  });

  test("expired authentication challenges are rejected", () => {
    saveAuthenticationChallenge(
      "session-expired",
      "expired-auth",
      Date.now() - 1,
    );

    expect(consumeAuthenticationChallenge("session-expired")).toBeNull();
  });
});