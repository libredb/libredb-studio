import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The guard over the Spark provider's pure modules. The sc:// reader is
 * imported by the connection-string parser, which the browser bundle carries, so it imports types only; every pure
 * module imports no I/O, no logger and no transport, and a sibling it imports, by a relative path or through the `@/`
 * alias, is only another pure module, the directory's constants, its errors or its name spelling. The lists name
 * the decoder modules, and only the listed files import apache-arrow, by an import, a re-export or a require() call,
 * in a file of any script extension.
 */
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SPARK = "src/lib/db/providers/sql/spark";

/** Files whose every import is `import type`. */
const TYPE_ONLY: readonly string[] = [`${SPARK}/sc-uri.ts`];
/** Files that import no I/O, no logger and no transport. */
const PURE: readonly string[] = [
  `${SPARK}/sc-uri.ts`,
  `${SPARK}/ipc-guard.ts`,
  `${SPARK}/arrow.ts`,
  `${SPARK}/temporal.ts`,
  `${SPARK}/variant.ts`,
  `${SPARK}/wkb.ts`,
  `${SPARK}/schema.ts`,
  `${SPARK}/values.ts`,
];
const FORBIDDEN: readonly RegExp[] = [
  /^(?:node:)?(?:fs|fs\/promises|net|tls|http|https|http2|dgram|dns|child_process|worker_threads)$/,
  /^@grpc\//,
  /\/grpc(?:\/|$)/,
  /(?:^|\/)logger$/,
];
const PURE_SIBLINGS: ReadonlySet<string> = new Set([
  "./constants",
  "./errors",
  "./namespace",
  ...PURE.map((path) => `./${basename(path, ".ts")}`),
]);

interface ImportLine {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/**
 * Every static import, re-export and side-effect import of a text, the `import type` ones marked, every dynamic import,
 * and every require() call, `import x = require()` among them.
 */
function importLinesIn(text: string): ImportLine[] {
  const lines: ImportLine[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    lines.push({ specifier: match[2], typeOnly: match[1] !== undefined });
  }
  for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    lines.push({ specifier: match[1], typeOnly: false });
  }
  for (const match of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    lines.push({ specifier: match[1], typeOnly: false });
  }
  return lines;
}

/** Every import line of a file of the repository. */
function importLines(path: string): ImportLine[] {
  return importLinesIn(readFileSync(join(ROOT, path), "utf8"));
}

const SPARK_ALIAS = "@/lib/db/providers/sql/spark";

/**
 * The specifiers a pure module may not import: I/O, a logger, a transport, or a sibling outside `PURE_SIBLINGS`. A
 * specifier under this directory's `@/` alias is read as the relative path it names before the sibling check
 * (`@/lib/db/providers/sql/spark/session` is `./session`, the directory itself is `.`), so the alias is held like a
 * relative import.
 */
function refusedSpecifiers(lines: readonly ImportLine[]): string[] {
  return lines
    .map((line) => line.specifier)
    .filter((specifier) => {
      const sibling =
        specifier === SPARK_ALIAS || specifier.startsWith(`${SPARK_ALIAS}/`)
          ? `.${specifier.slice(SPARK_ALIAS.length)}`
          : specifier;
      return (
        FORBIDDEN.some((pattern) => pattern.test(specifier)) || (sibling.startsWith(".") && !PURE_SIBLINGS.has(sibling))
      );
    });
}

/**
 * The files that import apache-arrow, held exactly: under src/ only arrow.ts; the test stream writer; and the test
 * that replaces the reader with a failing one, to reach the catch of readIpcColumns.
 */
const ARROW_IMPORTERS: readonly string[] = [
  "src/lib/db/providers/sql/spark/arrow.ts",
  "tests/helpers/spark-ipc.ts",
  "tests/unit/db/spark/arrow-reader-failure.test.ts",
];
const SCANNED = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function filesUnder(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((path) => SCANNED.test(path) && !path.split(/[\\/]/).includes("node_modules"))
    .map((path) => `${dir}/${path.split("\\").join("/")}`);
}

describe("the Spark pure-module seam guard", () => {
  test("the reader finds imports, so an empty answer below is not a reader that reads nothing", () => {
    const parser = importLines("src/lib/connection-string-parser.ts").map((line) => line.specifier);
    expect(parser).toContain("@/lib/db/providers/sql/spark/sc-uri");
    expect(importLines(`${SPARK}/sc-uri.ts`).length).toBeGreaterThan(0);
  });

  test("the type-only modules import types only", () => {
    for (const file of TYPE_ONLY) {
      const runtime = importLines(file).filter((line) => !line.typeOnly);
      expect({ file, runtime }).toEqual({ file, runtime: [] });
    }
  });

  test("the pure modules import no I/O, no logger, no transport and no impure sibling", () => {
    for (const file of PURE) {
      const refused = refusedSpecifiers(importLines(file));
      expect({ file, refused }).toEqual({ file, refused: [] });
    }
  });

  test("a sibling named through the @/ alias is held like a relative import (planted text)", () => {
    const planted = [
      'import { SparkSessions } from "@/lib/db/providers/sql/spark/session";',
      'import type { SparkWireChannel } from "@/lib/db/providers/sql/spark/grpc-client";',
      'import { SparkProvider } from "@/lib/db/providers/sql/spark";',
      'import { SPARK_ERROR_SENTENCES } from "@/lib/db/providers/sql/spark/errors";',
      'import type { SparkColumn } from "./schema";',
    ].join("\n");
    expect(refusedSpecifiers(importLinesIn(planted))).toStrictEqual([
      "@/lib/db/providers/sql/spark/session",
      "@/lib/db/providers/sql/spark/grpc-client",
      "@/lib/db/providers/sql/spark",
    ]);
  });

  // The planted names are not apache-arrow, since the importer rule below reads this file too.
  test("the reader finds a require() call, and the importer rule scans every script extension (planted text and names)", () => {
    const planted = [
      'const pad = require("left-pad");',
      "const { join } = require( 'node:path' );",
      'import sibling = require("./sibling");',
    ].join("\n");
    expect(importLinesIn(planted)).toStrictEqual([
      { specifier: "left-pad", typeOnly: false },
      { specifier: "node:path", typeOnly: false },
      { specifier: "./sibling", typeOnly: false },
    ]);
    const names = ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.json", "a.d.ts.map"];
    expect(names.filter((name) => SCANNED.test(name))).toStrictEqual(names.slice(0, 8));
  });

  test("only the listed files import apache-arrow", () => {
    const found = ["src", "tests", "scripts", "e2e"]
      .flatMap(filesUnder)
      .filter((file) =>
        importLines(file).some(
          (line) => line.specifier === "apache-arrow" || line.specifier.startsWith("apache-arrow/"),
        ),
      );
    expect(found.sort()).toStrictEqual([...ARROW_IMPORTERS].sort());
  });
});
