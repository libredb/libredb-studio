/**
 * The host page benchmark (scripts/host-page-benchmark.ts; docs/TOOLCHAIN.md, "The host page benchmark") cannot drift
 * from the path it measures: its case module imports the production facade, bridge and core and declares no pump,
 * source or measure of its own, both of its paths answer the same text, and its thresholds are the owner-signed T1 to
 * T5. The benchmark itself runs only when the lead runs it, never in the default test run.
 *
 * Specifiers are read with the scanner of tests/unit/lib/db/provider-imports/scan.ts, so a path in a comment or a
 * string is never one; declarations are read from the TypeScript syntax tree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { setImmediate as nextTurn } from "node:timers/promises";
import { compareAnswers, generateRows, heapAdded, hostText, todayText } from "../../scripts/host-page-benchmark/case";
import { THRESHOLDS } from "../../scripts/host-page-benchmark";
import { moduleSpecifiers } from "./lib/db/provider-imports/scan";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";

// The editor query reads the process's host core (src/lib/provider-host/instance.ts), so this file composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const CASE_FILE = path.join(import.meta.dir, "..", "..", "scripts", "host-page-benchmark", "case.ts");
const OWN_PUMP = new Set(["pumpPage", "rowsSource", "encodedRowBytes"]);

/** Every name the module declares as a function, a variable or a method, at any depth. */
function declaredNames(text: string): string[] {
  const source = ts.createSourceFile(CASE_FILE, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

describe("the host page benchmark", () => {
  test("the benchmark runs the production facade, bridge and core, with no pump of its own", () => {
    const text = readFileSync(CASE_FILE, "utf8");

    expect(moduleSpecifiers(text)).toEqual(
      expect.arrayContaining([
        "@/lib/api/editor-query",
        "@/lib/provider-host/legacy-bridge",
        "@/lib/provider-host/instance",
      ]),
    );
    expect(declaredNames(text).filter((name) => OWN_PUMP.has(name))).toEqual([]);
    expect(declaredNames("function pumpPage() {}\nconst rowsSource = () => 1;")).toEqual(["pumpPage", "rowsSource"]);
  });

  test("both paths answer the same text on a small page of each shape", async () => {
    const narrow = generateRows("narrow", 200);
    const wide = generateRows("wide", 50);

    const [narrowToday, narrowHost, wideToday, wideHost] = await Promise.all([
      todayText("narrow", narrow),
      hostText("narrow", narrow),
      todayText("wide", wide),
      hostText("wide", wide),
    ]);

    expect(narrow).toHaveLength(200);
    expect(wide).toHaveLength(50);
    expect(narrowHost).toBe(narrowToday);
    expect(wideHost).toBe(wideToday);
    expect(JSON.parse(wideHost).rows).toHaveLength(50);
  });

  test("the two paths are compared on every answered row, a page the host cut by bytes included", () => {
    const rowsOf = (count: number) => Array.from({ length: count }, (_, n) => ({ n, s: `row ${n}` }));
    const bodyOf = (rows: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
      fields: ["n", "s"],
      rowCount: 2_500,
      executionTime: 12,
      rows,
      pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited: false },
      ...over,
    });
    const today = bodyOf(rowsOf(2_500));

    expect(() => compareAnswers(today, bodyOf(rowsOf(2_500)))).not.toThrow();
    const late = rowsOf(2_500);
    late[2_400] = { n: 2_400, s: "another" };
    expect(() => compareAnswers(today, bodyOf(late))).toThrow("row 2400");
    expect(() => compareAnswers(today, bodyOf(rowsOf(2_500), { executionTime: 13 }))).toThrow();

    const cut = rowsOf(1_700);
    const cutPagination = { limit: 500, offset: 0, hasMore: false, totalReturned: 1_700, wasLimited: true };
    expect(() => compareAnswers(today, bodyOf(cut, { rowCount: 1_700, pagination: cutPagination }))).not.toThrow();
    const cutLate = rowsOf(1_700);
    cutLate[1_699] = { n: 1_699, s: "another" };
    expect(() => compareAnswers(today, bodyOf(cutLate, { rowCount: 1_700, pagination: cutPagination }))).toThrow(
      "row 1699",
    );
    expect(() => compareAnswers(today, bodyOf(cut, { rowCount: 2_500, pagination: cutPagination }))).toThrow();
    expect(() => compareAnswers(today, bodyOf(rowsOf(2_600)))).toThrow();
  });

  test("the heap reading's forced gc ends with its answer, so it never runs inside the slice read after it", async () => {
    const runtime = globalThis as unknown as { gc?: () => void };
    const own = runtime.gc;
    let collections = 0;
    runtime.gc = () => {
      collections += 1;
    };
    try {
      const added = await heapAdded("host", "wide", generateRows("wide", 50));
      const atAnswer = collections;
      await nextTurn();
      await nextTurn();

      expect(Number.isFinite(added)).toBe(true);
      expect(atAnswer).toBeGreaterThan(2);
      expect(collections).toBe(atAnswer);
    } finally {
      runtime.gc = own;
    }
  });

  test("the thresholds are the owner-signed T1 to T5", () => {
    expect(THRESHOLDS).toEqual({ T1: 150, T2: 250, T3: 600, T4: 50, T5: 160 });
    expect(Object.isFrozen(THRESHOLDS)).toBe(true);
  });
});
