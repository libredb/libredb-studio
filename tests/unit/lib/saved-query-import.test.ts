import { describe, expect, test } from "bun:test";
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
      const { parseSavedQueries } = await import(${JSON.stringify(import.meta.dir + "/../../../src/lib/saved-query-import.ts")});
      const rows = parseSavedQueries(${JSON.stringify(JSON.stringify([query]))});
      process.stdout.write(JSON.stringify({ evaluations, name: rows[0].name, date: rows[0].createdAt instanceof Date }));
    `;
    const processResult = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(processResult.stderr)).toBe("");
    expect(processResult.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(processResult.stdout))).toEqual({
      evaluations: 0,
      name: query.name,
      date: true,
    });
  });

  test("round-trips every saved field and revives both timestamps", () => {
    expect(parseSavedQueries(JSON.stringify([query], null, 2))).toEqual([query]);
    expect(parseSavedQueries("[]")).toEqual([]);
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
    JSON.stringify([{ ...query, connectionType: "unknown" }]),
    JSON.stringify([{ ...query, createdAt: null }]),
    JSON.stringify([query, { ...query, id: "bad", updatedAt: "not a date" }]),
  ])("rejects the entire invalid backup %s", (text) => {
    expect(() => parseSavedQueries(text)).toThrow();
  });

  test("accepts missing optional fields and strips unrecognized fields", () => {
    const { description: _description, tags: _tags, ...minimal } = query;
    expect(parseSavedQueries(JSON.stringify([{ ...minimal, connectionType: "mysql", extra: "ignored" }]))).toEqual([
      { ...minimal, connectionType: "mysql" },
    ]);
  });
});
