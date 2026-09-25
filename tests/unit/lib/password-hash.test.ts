import { describe, expect, test } from "bun:test";
import {
  hashPassword,
  needsRehash,
  passwordVerificationCount,
  placeholderPasswordHash,
  SCRYPT_N,
  verifyPassword,
} from "@/lib/password-hash";

describe("password hash", () => {
  test("a fresh hash verifies and does not need a rehash", async () => {
    const encoded = await hashPassword("correct horse battery");
    expect(encoded.startsWith(`scrypt$${SCRYPT_N}$8$1$`)).toBe(true);
    expect(encoded.includes("correct horse battery")).toBe(false);
    expect(needsRehash(encoded)).toBe(false);
    expect(await verifyPassword("correct horse battery", encoded)).toBe(true);
    expect(await verifyPassword("wrong horse battery", encoded)).toBe(false);
  });

  test("an older cost verifies and is marked for rehash", async () => {
    const encoded = await hashPassword("correct horse battery", 1024);
    expect(encoded.startsWith("scrypt$1024$")).toBe(true);
    expect(needsRehash(encoded)).toBe(true);
    expect(await verifyPassword("correct horse battery", encoded)).toBe(true);
  });

  test("a value that is not a hash still costs one scrypt and does not match", async () => {
    const before = passwordVerificationCount();
    expect(await verifyPassword("guess", "not-a-hash")).toBe(false);
    expect(await verifyPassword("guess", "scrypt$1$8$1$aa$bb")).toBe(false);
    expect(await verifyPassword("guess", "scrypt$nope$8$1$aa$bb")).toBe(false);
    expect(await verifyPassword("guess", "scrypt$16384$8$1$$aa")).toBe(false);
    expect(passwordVerificationCount() - before).toBe(4);
    expect(needsRehash("not-a-hash")).toBe(false);
  });

  test("a cost scrypt refuses is a failed verification, not a throw", async () => {
    const salt = Buffer.alloc(16, 3).toString("base64url");
    const key = Buffer.alloc(32, 4).toString("base64url");
    expect(await verifyPassword("guess", `scrypt$3$8$1$${salt}$${key}`)).toBe(false);
  });

  test("a stored key of the wrong length does not match", async () => {
    const encoded = await hashPassword("correct horse battery");
    const parts = encoded.split("$");
    parts[5] = Buffer.from("short").toString("base64url");
    expect(await verifyPassword("correct horse battery", parts.join("$"))).toBe(false);
  });

  test("the placeholder hash is stable and is not the caller's password", async () => {
    const first = await placeholderPasswordHash();
    const second = await placeholderPasswordHash();
    expect(second).toBe(first);
    expect(await verifyPassword("libredb-dummy-password-never-a-credential", first)).toBe(true);
    expect(await verifyPassword("something-else", first)).toBe(false);
  });
});
