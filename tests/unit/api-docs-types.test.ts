/**
 * Drift guard for the public type blocks in `docs/API_DOCS.md` (#567).
 *
 * The Data Types section restates `DatabaseConnection`, `QueryResult`, `DatabaseObject`
 * and `HealthInfo`. Nothing compared those restatements to the interfaces, which is
 * how `DatabaseConnection` and `QueryResult` fell behind `src/lib/types.ts` while the
 * other two stayed in lockstep. The route-family guard in
 * `tests/unit/agent-documentation.test.ts` never looks at shapes (`docs/BACKLOG.md`,
 * B32).
 *
 * This extracts top-level field names from each doc block and from the matching
 * interface and asserts they are equal, so the next field added to the source fails
 * the gate until the doc follows.
 *
 * `VectorColumn` joined the list with the vector results grid, and its block inlines three published unions
 * (`VectorKind`, `VectorDType`, `SparseEncoding`), so their members are compared too: a member added to the
 * source fails the gate until the doc's inlined union follows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const API_DOCS = read("docs/API_DOCS.md");
const DATA_TYPES = API_DOCS.split(/^## Data Types\s*$/m)[1] ?? "";

const SHAPES = [
  { name: "DatabaseConnection", source: "src/lib/types.ts" },
  { name: "QueryResult", source: "src/lib/types.ts" },
  { name: "DatabaseObject", source: "src/lib/db/types.ts" },
  { name: "HealthInfo", source: "src/lib/db/types.ts" },
  { name: "VectorColumn", source: "src/lib/db/vector/types.ts" },
] as const;

/** The `VectorColumn` fields whose doc line inlines a published union, which must list exactly its members. */
const INLINED_UNIONS = [
  { field: "kind", union: "VectorKind" },
  { field: "dtype", union: "VectorDType" },
  { field: "sparseEncoding", union: "SparseEncoding" },
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

function quotedMembers(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

function unionMembers(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export\\s+type\\s+${name}\\s*=([^;]*);`));
  if (!match) throw new Error(`type ${name} not found`);
  return quotedMembers(stripComments(match[1]));
}

function fieldTypeText(source: string, name: string, field: string): string {
  const body = stripComments(scanInterfaceBody(source, name));
  const line = body
    .split("\n")
    .find((candidate) => new RegExp(`^\\s*(?:readonly\\s+)?${field}\\??\\s*:`).test(candidate));
  if (line === undefined) throw new Error(`${name}.${field} not found`);
  return line;
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

describe("the unions docs/API_DOCS.md inlines in VectorColumn match the published types", () => {
  for (const { field, union } of INLINED_UNIONS) {
    test(`VectorColumn.${field} lists exactly the members of ${union}`, () => {
      const fromSource = unionMembers(read("src/lib/db/vector/types.ts"), union);
      expect(fromSource.length).toBeGreaterThan(0);
      expect(quotedMembers(fieldTypeText(DATA_TYPES, "VectorColumn", field))).toEqual(fromSource);
    });
  }
});

describe("the allowInsecureAuth field names every engine that reads it", () => {
  test("docs/API_DOCS.md and docs/SEED_CONNECTIONS.md name Db2, both InfluxDB types, Oxia, Databend and S3, the types whose form offers the field", () => {
    const readers = Object.entries(DB_UI_CONFIG)
      .filter(([, config]) => (config.connectionFields as readonly string[] | undefined)?.includes("allowInsecureAuth"))
      .map(([type]) => type);
    // The control: a seventh type taking the field fails here until both docs name it.
    expect(readers).toEqual(["db2", "influxdb", "influxdb3", "oxia", "databend", "s3"]);
    expect(API_DOCS).toContain("`allowInsecureAuth` (Db2, InfluxDB, InfluxDB 3, Oxia, Databend, S3)");
    expect(DATA_TYPES).toContain(
      "allowInsecureAuth?: boolean; // Db2, both InfluxDB types, Oxia, Databend and S3 (#786):",
    );
    expect(read("docs/SEED_CONNECTIONS.md")).toContain(
      "| `connections[].allowInsecureAuth` | No | absent | Db2, both InfluxDB types, Oxia, Databend and S3 (#786):",
    );
  });
});

describe("the warehouse field", () => {
  test("docs/API_DOCS.md names it among the fields the server reads, as Databend's, in the source's field order", () => {
    expect(API_DOCS).toContain("`dataServers` (Oxia), `warehouse` (Databend)");
    const fields = topLevelFields(DATA_TYPES, "DatabaseConnection");
    expect(fields.indexOf("warehouse")).toBe(fields.indexOf("dataServers") + 1);
    expect(DATA_TYPES).toMatch(/warehouse\?: string; +\/\/ Databend only:/);
  });
});

describe("the region field", () => {
  test("docs/API_DOCS.md names it among the fields the server reads, as S3's, right after the warehouse", () => {
    expect(API_DOCS).toContain("`warehouse` (Databend), `region` (S3)");
    const fields = topLevelFields(DATA_TYPES, "DatabaseConnection");
    expect(fields.indexOf("region")).toBe(fields.indexOf("warehouse") + 1);
    expect(DATA_TYPES).toMatch(/region\?: string; +\/\/ S3-compatible object storage only:/);
  });
});
