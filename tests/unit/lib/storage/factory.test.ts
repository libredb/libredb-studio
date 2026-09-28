import { describe, test, expect, beforeEach } from "bun:test";
import { isServerStorageEnabled, getStorageConfig } from "@/lib/storage/factory";

// Clean env before every test to prevent leakage
beforeEach(() => {
  delete process.env.STORAGE_PROVIDER;
});

describe("storage factory: isServerStorageEnabled", () => {
  test("returns false when local", () => {
    expect(isServerStorageEnabled()).toBe(false);
  });

  test("returns true for sqlite", () => {
    process.env.STORAGE_PROVIDER = "sqlite";
    expect(isServerStorageEnabled()).toBe(true);
  });

  test("returns true for postgres", () => {
    process.env.STORAGE_PROVIDER = "postgres";
    expect(isServerStorageEnabled()).toBe(true);
  });
});

describe("storage factory: getStorageConfig", () => {
  test("returns correct shape for local", () => {
    const config = getStorageConfig();
    expect(config).toEqual({ provider: "local", serverMode: false });
  });

  test("returns correct shape for sqlite", () => {
    process.env.STORAGE_PROVIDER = "sqlite";
    const config = getStorageConfig();
    expect(config).toEqual({ provider: "sqlite", serverMode: true });
  });
});
