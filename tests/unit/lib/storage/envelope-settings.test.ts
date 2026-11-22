/**
 * The two operator settings of the credential envelope (docs/STORAGE.md, "Re-sealing the store"): STORAGE_ENCRYPTION_RESEAL
 * and STORAGE_ENCRYPTION_REQUIRE_V2 take the same spellings, and any other value is refused by name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InvalidStorageSetting,
  requiresVersionTwo,
  resealSetting,
  VERSION_TWO_NOT_RECORDED,
} from "@/lib/storage/envelope-settings";

const KEYS = ["STORAGE_ENCRYPTION_RESEAL", "STORAGE_ENCRYPTION_REQUIRE_V2"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const OFF_VALUES = [undefined, "", "  ", "false", "0", "off", "OFF", " False "];
const ON_VALUES = ["true", "1", "on", "TRUE", " On "];

function set(key: (typeof KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("STORAGE_ENCRYPTION_REQUIRE_V2", () => {
  test("is not set when unset, empty, false, 0 or off, in any letter case", () => {
    for (const value of OFF_VALUES) {
      set("STORAGE_ENCRYPTION_REQUIRE_V2", value);
      expect({ value, required: requiresVersionTwo() }).toEqual({ value, required: false });
    }
  });

  test("is set for true, 1 and on, in any letter case", () => {
    for (const value of ON_VALUES) {
      set("STORAGE_ENCRYPTION_REQUIRE_V2", value);
      expect({ value, required: requiresVersionTwo() }).toEqual({ value, required: true });
    }
  });

  test("any other value is refused by name, with the value quoted", () => {
    for (const value of ["yes", "leave-unopened", "2"]) {
      set("STORAGE_ENCRYPTION_REQUIRE_V2", value);
      let thrown: unknown;
      try {
        requiresVersionTwo();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidStorageSetting);
      expect(thrown).toMatchObject({
        name: "InvalidStorageSetting",
        variable: "STORAGE_ENCRYPTION_REQUIRE_V2",
        raw: value,
      });
      expect((thrown as Error).message).toBe(
        `STORAGE_ENCRYPTION_REQUIRE_V2 is invalid: got ${JSON.stringify(value)}; it must be true, on or 1, or false, off, 0 or unset.`,
      );
    }
  });
});

describe("STORAGE_ENCRYPTION_RESEAL", () => {
  test("is off when unset, empty, false, 0 or off", () => {
    for (const value of OFF_VALUES) {
      set("STORAGE_ENCRYPTION_RESEAL", value);
      expect({ value, setting: resealSetting() }).toEqual({ value, setting: "off" });
    }
  });

  test("re-seals for true, 1 and on, and re-seals leaving unopened values for leave-unopened, in any letter case", () => {
    for (const value of ON_VALUES) {
      set("STORAGE_ENCRYPTION_RESEAL", value);
      expect({ value, setting: resealSetting() }).toEqual({ value, setting: "reseal" });
    }
    for (const value of ["leave-unopened", " Leave-Unopened "]) {
      set("STORAGE_ENCRYPTION_RESEAL", value);
      expect({ value, setting: resealSetting() }).toEqual({ value, setting: "leave-unopened" });
    }
  });

  test("any other value is refused by name, with every accepted spelling listed", () => {
    set("STORAGE_ENCRYPTION_RESEAL", "yes");
    expect(() => resealSetting()).toThrow(
      'STORAGE_ENCRYPTION_RESEAL is invalid: got "yes"; it must be true, on, 1 or leave-unopened, or false, off, 0 or unset.',
    );
  });
});

test("the missing-marker refusal says the store records no re-seal, when to restore it, and that a re-seal takes a start without STORAGE_ENCRYPTION_REQUIRE_V2", () => {
  expect(VERSION_TWO_NOT_RECORDED).toContain("STORAGE_ENCRYPTION_REQUIRE_V2 is set, but this store records no re-seal");
  expect(VERSION_TWO_NOT_RECORDED).toContain("credential_envelope");
  expect(VERSION_TWO_NOT_RECORDED).toContain(
    "while STORAGE_ENCRYPTION_REQUIRE_V2 is set the re-seal runs only on a store that records it",
  );
  expect(VERSION_TWO_NOT_RECORDED).toContain(
    "If this store was re-sealed before, restore it from a backup taken after that re-seal.",
  );
  expect(VERSION_TWO_NOT_RECORDED).toContain(
    "To re-seal a store whose contents you know, start once with STORAGE_ENCRYPTION_RESEAL=true and without STORAGE_ENCRYPTION_REQUIRE_V2, then remove STORAGE_ENCRYPTION_RESEAL and set STORAGE_ENCRYPTION_REQUIRE_V2 again",
  );
  // The re-seal is never asked for together with the requirement.
  expect(VERSION_TWO_NOT_RECORDED).not.toContain("as well");
  expect(VERSION_TWO_NOT_RECORDED).not.toContain("has not been re-sealed");
});
