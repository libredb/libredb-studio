/**
 * The provider loader's registry of admitted records, in the test process (docs/providers/CONTRACT.md, clause C-90).
 *
 * The registry is the loader module's own, so a process holds one; this file runs in its own process (tests/run-tests.ts)
 * and every case registers names of its own, since the registry has no reset.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { admitted, loadPackage, registerAdmitted } from "@/lib/provider-loader/index.cjs";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "provider-loader-registry-"));
  writeFileSync(path.join(dir, "record.mjs"), 'export default { marker: "loaded" };\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the process's one registry of admitted records", () => {
  test("the registry starts empty, and a loaded record is not registered by its load", async () => {
    expect(admitted()).toEqual([]);

    const answer = await loadPackage(path.join(dir, "record.mjs"), {
      deadlineMs: 5_000,
      onLateSettle: () => undefined,
    });

    expect(answer.loaded).toBe(true);
    expect(admitted()).toEqual([]);
  });

  test("a record enters the registry only through registerAdmitted, listed frozen in the order registered", () => {
    const second = { marker: "second" };
    const first = { marker: "first" };

    registerAdmitted("@example/provider-second", second);
    registerAdmitted("@example/provider-first", first);
    const listed = admitted();

    expect(listed).toEqual([
      { name: "@example/provider-second", record: second },
      { name: "@example/provider-first", record: first },
    ]);
    expect(listed[0]?.record).toBe(second);
    expect(listed[1]?.record).toBe(first);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.every((item) => Object.isFrozen(item))).toBe(true);
    expect(Object.isFrozen(second)).toBe(false);
  });

  test("a name registered twice is refused by name, and the first record stays", () => {
    const kept = { marker: "kept" };
    registerAdmitted("@example/provider-twice", kept);

    expect(() => registerAdmitted("@example/provider-twice", { marker: "dropped" })).toThrow(
      new Error('registerAdmitted: "@example/provider-twice" is registered already'),
    );
    expect(admitted().filter((item) => item.name === "@example/provider-twice")).toEqual([
      { name: "@example/provider-twice", record: kept },
    ]);
  });

  test("a name that is not a non-empty string and a record that is not an object are refused", () => {
    const before = admitted();

    for (const name of ["", 1, undefined, null]) {
      expect(() => registerAdmitted(name as unknown as string, {})).toThrow(
        new TypeError("registerAdmitted: name must be a non-empty string"),
      );
    }
    for (const record of [null, undefined, 1, "record", () => undefined]) {
      expect(() => registerAdmitted("@example/provider-refused", record as unknown as object)).toThrow(
        new TypeError("registerAdmitted: record must be an object"),
      );
    }
    expect(admitted()).toEqual(before);
  });
});
