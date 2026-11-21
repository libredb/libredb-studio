import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseConfigError, UnknownProviderError } from "@/lib/db/errors";
import { unknownTypeSentence } from "@/lib/db/type-id";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { parseSavedQueries } from "@/lib/saved-query-import";
import type { SavedQuery } from "@/lib/types";

const query: SavedQuery = {
  id: "saved-1",
  name: "Team report",
  query: "SELECT '你好';\n-- report",
  description: "A saved report",
  connectionType: "postgres",
  tags: ["monthly", "shared"],
  createdAt: new Date("2025-04-03T01:02:03Z"),
  updatedAt: new Date("2026-04-03T01:02:03Z"),
};

describe("parseSavedQueries", () => {
  test("loading and using the browser importer never probes dynamic code evaluation", () => {
    // A CSP violation is reported even when a library catches the EvalError.
    // A fresh process also observes the schema's import-time capability probe.
    const script = `
      let evaluations = 0;
      globalThis.Function = new Proxy(Function, {
        construct() { evaluations++; throw new EvalError("CSP blocks eval"); },
      });
      const { parseSavedQueries } = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../../src/lib/saved-query-import.ts")).href)});
      const backup = parseSavedQueries(${JSON.stringify(JSON.stringify([query, { ...query, id: "acme", connectionType: "acmefoo" }]))});
      const rows = backup.queries;
      process.stdout.write(JSON.stringify({
        evaluations,
        name: rows[0].name,
        date: rows[0].createdAt instanceof Date,
        refused: backup.refused.map((entry) => entry.error.typeId),
      }));
    `;
    // A file: URL, not a bare path: a Windows absolute path ("C:\\...") reads "C:" as a URL
    // scheme in an ESM specifier. cwd is pinned to the repository root because the module under
    // import resolves "@/lib/db/compatibility", and that alias comes from the tsconfig.json found
    // from the child's working directory, not from the importing file.
    const processResult = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(processResult.stderr)).toBe("");
    expect(processResult.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(processResult.stdout))).toEqual({
      evaluations: 0,
      name: query.name,
      date: true,
      refused: ["acmefoo"],
    });
  });

  test("round-trips every saved field and revives both timestamps", () => {
    expect(parseSavedQueries(JSON.stringify([query], null, 2))).toEqual({ queries: [query], refused: [] });
    expect(parseSavedQueries("[]")).toEqual({ queries: [], refused: [] });
  });

  test.each([
    "{",
    JSON.stringify({ queries: [] }),
    JSON.stringify([null]),
    JSON.stringify([{ ...query, id: "" }]),
    JSON.stringify([{ ...query, name: "" }]),
    JSON.stringify([{ ...query, query: 1 }]),
    JSON.stringify([{ ...query, tags: [1] }]),
    JSON.stringify([{ ...query, description: null }]),
    JSON.stringify([{ ...query, createdAt: null }]),
    JSON.stringify([query, { ...query, id: "bad", updatedAt: "not a date" }]),
  ])("rejects the entire invalid backup %s", (text) => {
    expect(() => parseSavedQueries(text)).toThrow();
  });

  test("accepts missing optional fields and strips unrecognized fields", () => {
    const { description: _description, tags: _tags, ...minimal } = query;
    expect(
      parseSavedQueries(JSON.stringify([{ ...minimal, connectionType: "mysql", extra: "ignored" }])).queries,
    ).toEqual([{ ...minimal, connectionType: "mysql" }]);
  });
});

describe("parseSavedQueries and an entry whose type names no provider (FND-1)", () => {
  const named = (id: string, name: string, connectionType: string) => ({ ...query, id, name, connectionType });

  function expectRefusal(entry: { name: string; error: UnknownProviderError }, name: string, typeId: string) {
    expect(entry.name).toBe(name);
    expect(entry.error).toBeInstanceOf(UnknownProviderError);
    expect(entry.error).toBeInstanceOf(DatabaseConfigError);
    expect(entry.error.reason).toBe("unknown");
    expect(entry.error.typeId).toBe(typeId);
    expect(entry.error.message).toBe(unknownTypeSentence(typeId));
    expect(entry.error.code).toBe(ApiErrorCode.PROVIDER_UNKNOWN);
  }

  test("imports every entry whose type is a type id and refuses each entry whose type names no provider, by name", () => {
    const backup = parseSavedQueries(
      JSON.stringify([
        query,
        named("acme", "Acme report", "acmefoo"),
        named("ctor", "Prototype key", "constructor"),
        named("upper", "Capitalised", "Postgres"),
        named("padded", "Padded", " postgres"),
      ]),
    );

    expect(backup.queries).toEqual([query]);
    expect(backup.refused).toHaveLength(4);
    expectRefusal(backup.refused[0], "Acme report", "acmefoo");
    expectRefusal(backup.refused[1], "Prototype key", "constructor");
    expectRefusal(backup.refused[2], "Capitalised", "Postgres");
    expectRefusal(backup.refused[3], "Padded", " postgres");
  });

  test("the refusal quotes a type with a control character on one line and keeps it verbatim in typeId", () => {
    const typeId = "acme\nfoo\u202e";
    const [entry] = parseSavedQueries(JSON.stringify([named("ctl", "Control", typeId)])).refused;

    expectRefusal(entry, "Control", typeId);
    expect(entry.error.message).toContain('"acme\\nfoo\\u202e"');
    expect(entry.error.message).not.toContain("\n");
  });

  test("a backup whose every entry names no provider imports nothing and refuses each", () => {
    const backup = parseSavedQueries(JSON.stringify([named("a", "First", "acmefoo"), named("b", "Second", "zeta")]));

    expect(backup.queries).toEqual([]);
    expect(backup.refused.map((entry) => entry.name)).toEqual(["First", "Second"]);
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["null", null],
    ["a number", 5],
    ["a list", ["postgres"]],
    ["an object", { id: "postgres" }],
  ])("rejects the entire backup whose entry has a connection type that is %s", (_label, connectionType) => {
    const text = JSON.stringify([query, { ...query, id: "bad", connectionType }]);
    expect(() => parseSavedQueries(text)).toThrow(
      expect.objectContaining({
        issues: [expect.objectContaining({ path: [1, "connectionType"] })],
      }),
    );
  });

  test.each([
    ["an updatedAt that is not a date", { updatedAt: "not a date" }],
    ["an empty name", { name: "" }],
  ])("an entry whose type names no provider is still validated whole: %s", (_label, field) => {
    const text = JSON.stringify([query, { ...named("acme", "Acme report", "acmefoo"), ...field }]);
    expect(() => parseSavedQueries(text)).toThrow();
  });
});
