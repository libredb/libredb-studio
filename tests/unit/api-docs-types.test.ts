/**
 * Drift guard for the four public type blocks in `docs/API_DOCS.md` (#567).
 *
 * The Data Types section restates `DatabaseConnection`, `QueryResult`, `TableSchema`
 * and `HealthInfo`. Nothing compared those restatements to the interfaces, which is
 * how `DatabaseConnection` and `QueryResult` fell behind `src/lib/types.ts` while
 * `TableSchema` and `HealthInfo` stayed in lockstep. The route-family guard in
 * `tests/unit/agent-documentation.test.ts` never looks at shapes (`docs/BACKLOG.md`,
 * B32).
 *
 * This extracts top-level field names from each doc block and from the matching
 * interface and asserts they are equal, so the next field added to the source fails
 * the gate until the doc follows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const API_DOCS = read("docs/API_DOCS.md");
const DATA_TYPES = API_DOCS.split(/^## Data Types\s*$/m)[1] ?? "";

const SHAPES = [
  { name: "DatabaseConnection", source: "src/lib/types.ts" },
  { name: "QueryResult", source: "src/lib/types.ts" },
  { name: "TableSchema", source: "src/lib/types.ts" },
  { name: "HealthInfo", source: "src/lib/db/types.ts" },
] as const;

function scanInterfaceBody(source: string, name: string): string {
  const match = source.match(new RegExp(`(?:export\\s+)?interface\\s+${name}\\s*\\{`));
  if (!match || match.index === undefined) {
    throw new Error(`interface ${name} not found`);
  }
  const open = match.index + match[0].length - 1;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTick = false;
  let inLine = false;
  let inBlock = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inTick) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "`") inTick = false;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "`") {
      inTick = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed interface ${name}`);
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function topLevelFields(source: string, name: string): string[] {
  const body = stripComments(scanInterfaceBody(source, name));
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
    if (match) fields.push(match[1]);
  }
  return fields;
}

describe("docs/API_DOCS.md Data Types blocks match the source interfaces", () => {
  test("the Data Types section was located", () => {
    expect(DATA_TYPES.length).toBeGreaterThan(0);
    expect(API_DOCS).toContain("## Data Types");
  });

  for (const { name, source } of SHAPES) {
    test(`${name} doc fields equal ${source}`, () => {
      const fromDocs = topLevelFields(DATA_TYPES, name);
      const fromSource = topLevelFields(read(source), name);
      expect(fromDocs.length).toBeGreaterThan(0);
      expect(fromSource.length).toBeGreaterThan(0);
      expect(fromDocs).toEqual(fromSource);
    });
  }
});
