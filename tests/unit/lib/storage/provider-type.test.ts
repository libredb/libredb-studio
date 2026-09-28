import { describe, test, expect, beforeEach } from "bun:test";
import { getStorageProviderType } from "@/lib/storage/provider-type";

// Clean env before every test to prevent leakage
beforeEach(() => {
  delete process.env.STORAGE_PROVIDER;
});

describe("storage provider type: getStorageProviderType", () => {
  test('returns "local" when STORAGE_PROVIDER not set', () => {
    expect(getStorageProviderType()).toBe("local");
  });

  test('returns "local" for empty string', () => {
    process.env.STORAGE_PROVIDER = "";
    expect(getStorageProviderType()).toBe("local");
  });

  test('returns "sqlite" when STORAGE_PROVIDER=sqlite', () => {
    process.env.STORAGE_PROVIDER = "sqlite";
    expect(getStorageProviderType()).toBe("sqlite");
  });

  test('returns "postgres" when STORAGE_PROVIDER=postgres', () => {
    process.env.STORAGE_PROVIDER = "postgres";
    expect(getStorageProviderType()).toBe("postgres");
  });

  test('returns "local" for unknown values', () => {
    process.env.STORAGE_PROVIDER = "redis";
    expect(getStorageProviderType()).toBe("local");
  });

  test("is case-insensitive", () => {
    process.env.STORAGE_PROVIDER = "SQLite";
    expect(getStorageProviderType()).toBe("sqlite");
  });
});
