/**
 * Each engine's connection fields and seed-only fields, declared once in src/lib/db/connection-fields.ts, a module
 * the seed loader can load: one row per type-id in both records, the dialog's table holding each row by reference,
 * and an import graph that reaches neither React's icon set nor src/lib/db-ui-config.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECTION_FIELDS, SEED_ONLY_FIELDS } from "@/lib/db/connection-fields";
import type { DatabaseType } from "@/lib/types";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MODULE = join(ROOT, "src/lib/db/connection-fields.ts");
const EVERY_TYPE = [...EXTERNAL_DATABASE_TYPES, "libredb"].sort();

/** Every specifier a module loads at run time: value imports and re-exports, never a type-only one. */
function valueImports(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (onlyTypes) continue;
    } else if (statement.isTypeOnly) continue;
    found.push(specifier.text);
  }
  return found;
}

/** The repository file a specifier names, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier}, imported by ${from}, resolves to no file`);
}

/** Every specifier the module's run-time import graph reaches, followed through repository files. */
function reachedSpecifiers(entry: string): string[] {
  const seen = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of valueImports(path)) {
      specifiers.add(specifier);
      const local = resolveLocal(path, specifier);
      if (local !== null) queue.push(local);
    }
  }
  return [...specifiers];
}

describe("the connection-field records (src/lib/db/connection-fields.ts)", () => {
  test("each record has exactly one row per type-id", () => {
    expect(Object.keys(CONNECTION_FIELDS).sort()).toEqual(EVERY_TYPE);
    expect(Object.keys(SEED_ONLY_FIELDS).sort()).toEqual(EVERY_TYPE);
  });

  test("the dialog's table holds each engine's row by reference, never a copy", () => {
    for (const id of EVERY_TYPE as DatabaseType[]) {
      expect(DB_UI_CONFIG[id].connectionFields).toBe(CONNECTION_FIELDS[id]);
    }
  });

  test("rows keep today's lists, in order", () => {
    expect(CONNECTION_FIELDS.postgres).toEqual(["host", "port", "user", "password", "database"]);
    expect(CONNECTION_FIELDS.opcua).toEqual([
      "host",
      "user",
      "password",
      "securityMode",
      "serverCertificateThumbprint",
    ]);
    expect(CONNECTION_FIELDS.libredb).toEqual(["database"]);
  });

  test("only Elasticsearch, Modbus, NETCONF and OPC UA declare seed-only fields", () => {
    const declared = (Object.keys(SEED_ONLY_FIELDS) as DatabaseType[]).filter((id) => SEED_ONLY_FIELDS[id] !== null);
    expect(declared.sort()).toEqual(["elasticsearch", "modbus", "netconf", "opcua"]);
  });

  test("a seed-only field is in no other engine's connection fields, so no engine's seed is refused for its own box", () => {
    for (const [owner, row] of Object.entries(SEED_ONLY_FIELDS)) {
      if (row === null) continue;
      for (const [type, fields] of Object.entries(CONNECTION_FIELDS)) {
        if (type === owner) continue;
        expect({ type, shared: fields.filter((field) => row.fields.includes(field)) }).toEqual({ type, shared: [] });
      }
    }
  });

  test("both records are frozen", () => {
    expect(Object.isFrozen(CONNECTION_FIELDS)).toBe(true);
    expect(Object.isFrozen(SEED_ONLY_FIELDS)).toBe(true);
  });

  test("a fresh process loads the module on its own", () => {
    const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(MODULE)})`], { cwd: ROOT });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("its import graph reaches neither the icon set nor the dialog's table", () => {
    const reached = reachedSpecifiers(MODULE);
    expect(reached.filter((specifier) => specifier === "lucide-react" || specifier === "@/lib/db-ui-config")).toEqual(
      [],
    );
  });
});
