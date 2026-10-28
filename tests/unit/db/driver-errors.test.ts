import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { DRIVER_ERROR_CLASSIFIERS } from "@/lib/db/driver-errors";
import { mapDatabaseError } from "@/lib/db/errors";
import {
  CORPUS_FIELDS,
  CORPUS_MESSAGES,
  CORPUS_PROVIDERS,
  classificationOf,
  corpusError,
} from "../../fixtures/driver-errors/corpus";

/**
 * Each driver's error classification is declared beside its provider, and the shared mapping reads them all in one
 * fixed order. The shared module keeps the generic error types and the generic words, and names no driver.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const GOLDEN: readonly unknown[] = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/driver-errors/golden-classification.json"), "utf8"),
);

describe("driver error classification", () => {
  test("answers every corpus input exactly as the shared mapping answered it before the move", () => {
    const answered: unknown[] = [];
    for (const provider of CORPUS_PROVIDERS)
      for (const message of CORPUS_MESSAGES)
        for (const fields of CORPUS_FIELDS)
          answered.push(classificationOf(mapDatabaseError(corpusError(message, fields), provider, "SELECT 1")));
    expect(answered.length).toBe(GOLDEN.length);
    expect(answered).toEqual([...GOLDEN]);
  });

  test("reads the drivers' rows in one fixed order, each frozen", () => {
    expect(DRIVER_ERROR_CLASSIFIERS.map((row) => row.driver)).toEqual([
      "mysql2",
      "mssql",
      "oracledb",
      "db2",
      "mongodb",
      "sqlite",
      "pg",
    ]);
    for (const row of DRIVER_ERROR_CLASSIFIERS) expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(DRIVER_ERROR_CLASSIFIERS)).toBe(true);
  });

  test("the shared module names no engine, driver or driver code in a string or an identifier", () => {
    const file = "src/lib/db/errors.ts";
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    const words =
      /oracle|mssql|tedious|mysql|maria|sqlite|postgres|\bpg\b|db2|mongo|ora-|njs-|dpi-|tns:|ecancel|login failed/i;
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteralLike(node) || ts.isIdentifier(node)) && words.test(node.text)) found.push(node.text);
      if (ts.isTemplateExpression(node)) {
        for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)]) {
          if (words.test(part.text)) found.push(part.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(found).toEqual([]);
  });
});
