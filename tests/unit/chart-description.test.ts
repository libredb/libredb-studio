import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

/**
 * The chart's description and keywords, derived from the external-engine list rather than copied into a provider's
 * own test, so a new provider edits this list's source and never another provider's test file.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const chart = parseYaml(readFileSync(path.join(ROOT, "charts/libredb-studio/Chart.yaml"), "utf8")) as {
  readonly description: string;
  readonly keywords: readonly string[];
};

const UNITS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function word(count: number): string {
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error(`no numeral for ${count}`);
  if (count < 20) return UNITS[count];
  const unit = count % 10;
  return unit === 0 ? TENS[Math.floor(count / 10)] : `${TENS[Math.floor(count / 10)]}-${UNITS[unit]}`;
}

/** The engine's name as the chart writes it: the dialog label without a trailing "(dialect)". */
const chartName = (type: DatabaseType): string => DB_UI_CONFIG[type].label.replace(/ \([^)]*\)$/, "");

/** The keyword an evaluator searches for, where it is not the type id itself. */
const KEYWORD_ALIAS: Partial<Record<DatabaseType, string>> = { postgres: "postgresql" };

const PREFIX = "Web-based SQL IDE for cloud-native teams supporting ";

/** The names the description lists after " engines - ", split on ", " and the final " and ". */
function listedNames(description: string): string[] {
  const list = description.slice(description.indexOf(" engines - ") + " engines - ".length);
  const last = list.lastIndexOf(" and ");
  return [...list.slice(0, last).split(", "), list.slice(last + " and ".length)];
}

describe("the chart description and keywords follow the external engines", () => {
  test("the description counts the external engines in words", () => {
    expect(chart.description.startsWith(`${PREFIX}${word(EXTERNAL_DATABASE_TYPES.length)} engines - `)).toBe(true);
  });

  test("the description names every external engine once, and nothing else", () => {
    const listed = listedNames(chart.description);
    const expected = EXTERNAL_DATABASE_TYPES.map(chartName);
    expect(listed).toHaveLength(expected.length);
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  test("every external engine has its keyword", () => {
    for (const type of EXTERNAL_DATABASE_TYPES) expect(chart.keywords).toContain(KEYWORD_ALIAS[type] ?? type);
  });
});
