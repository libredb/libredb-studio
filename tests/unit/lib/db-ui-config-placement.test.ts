/**
 * Where the connection dialog draws a field, and what it calls it, as each engine declares it on `DB_UI_CONFIG`
 * (engine contract design, row 8). Oracle's service name and SQL Server's instance name are the two fields drawn
 * behind the Advanced accordion; every other field is drawn in the open. The labels, placeholders and hints the
 * dialog used to choose by type id are declarations now, so neither the dialog nor `buildConnection` compares the
 * type with an engine's id: the last case parses both files and holds them to that.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { CONNECTION_FIELDS, PLACEABLE_FIELDS } from "@/lib/db/connection-fields";
import {
  DB_UI_CONFIG,
  type DatabaseUIConfig,
  type FieldPlacementDeclaration,
  connectionFieldLabel,
  connectionFieldPlacement,
  connectionFieldPlaceholder,
} from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ADVANCED: Readonly<Record<string, string>> = { oracle: "serviceName", mssql: "instanceName" };

describe("connectionFieldPlacement", () => {
  test("Oracle's service name and SQL Server's instance name are drawn behind Advanced", () => {
    expect(connectionFieldPlacement(DB_UI_CONFIG.oracle, "serviceName")).toBe("advanced");
    expect(connectionFieldPlacement(DB_UI_CONFIG.mssql, "instanceName")).toBe("advanced");
  });

  test("every other placeable field an engine takes is drawn in the open", () => {
    const misplaced: string[] = [];
    for (const [id, fields] of Object.entries(CONNECTION_FIELDS)) {
      for (const field of PLACEABLE_FIELDS) {
        if (!fields.includes(field) || ADVANCED[id] === field) continue;
        const placement = connectionFieldPlacement(DB_UI_CONFIG[id as DatabaseType], field);
        if (placement !== "open") misplaced.push(`${id}.${field}=${placement}`);
      }
    }
    expect(misplaced).toEqual([]);
  });

  test("each engine declares a placement for exactly the placeable fields it takes, and no other", () => {
    const declared: Record<string, string[]> = {};
    const taken: Record<string, string[]> = {};
    for (const [id, fields] of Object.entries(CONNECTION_FIELDS)) {
      const config: DatabaseUIConfig = DB_UI_CONFIG[id as DatabaseType];
      declared[id] = Object.keys(config.fieldPlacement ?? {}).sort();
      taken[id] = PLACEABLE_FIELDS.filter((field) => fields.includes(field)).sort();
    }
    expect(declared).toEqual(taken);
  });

  test("a field with no declared placement is refused, not drawn in the open by default", () => {
    expect(() => connectionFieldPlacement(DB_UI_CONFIG.postgres, "serviceName")).toThrow(
      "PostgreSQL declares no placement for serviceName",
    );
  });

  /**
   * Held by the compiler: `bun run typecheck` reads this file, and each `@ts-expect-error` below fails it the day its
   * line compiles. The runtime assertion only keeps the fixtures from being unused.
   */
  test("the declaration is required where an engine takes a placeable field, and refused elsewhere", () => {
    const fixtures: readonly unknown[] = [
      // @ts-expect-error: Oracle takes serviceName, so it must say where the dialog draws it.
      {} satisfies FieldPlacementDeclaration<"oracle">,
      // @ts-expect-error: PostgreSQL takes no placeable field, so it declares no placement.
      { fieldPlacement: { serviceName: "open" } } satisfies FieldPlacementDeclaration<"postgres">,
      // @ts-expect-error: only the four placeable fields are drawn where a placement says.
      { fieldPlacement: { warehouse: "advanced" } } satisfies FieldPlacementDeclaration<"databend">,
      {
        // @ts-expect-error: SQL Server does not take serviceName, so it cannot place one.
        fieldPlacement: { instanceName: "advanced", serviceName: "open" },
      } satisfies FieldPlacementDeclaration<"mssql">,
      { fieldPlacement: { serviceName: "advanced" } } satisfies FieldPlacementDeclaration<"oracle">,
      {} satisfies FieldPlacementDeclaration<"postgres">,
    ];
    expect(fixtures).toHaveLength(6);
  });
});

describe("the labels and placeholders the dialog used to choose by type id", () => {
  test("Cassandra's database box is its keyspace", () => {
    expect(connectionFieldLabel(DB_UI_CONFIG.cassandra, "database", "x")).toBe("Keyspace Name");
  });

  test("ClickHouse's connection URI box keeps the MongoDB example it has always shown", () => {
    expect(connectionFieldPlaceholder(DB_UI_CONFIG.clickhouse, "connectionString", "")).toBe(
      "mongodb://localhost:27017/mydb  or  mongodb+srv://...",
    );
  });
});

describe("no comparison with an engine's id", () => {
  const TYPE_IDS = new Set(Object.keys(CONNECTION_FIELDS));
  const EQUALITY = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);

  /** Each `a === "<type id>"` (or `!==`, `==`, `!=`) in a source text, as written. */
  const typeIdComparisons = (file: string, text: string): string[] => {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const found: string[] = [];
    const isTypeId = (node: ts.Expression): boolean =>
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && TYPE_IDS.has(node.text);
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        EQUALITY.has(node.operatorToken.kind) &&
        (isTypeId(node.left) || isTypeId(node.right))
      ) {
        found.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  test("the planted sample is found, so an empty answer below means something", () => {
    expect(
      typeIdComparisons("s.tsx", 'const a = <p>{type === "mongodb" && "x"}</p>; const b = "oracle" !== t;'),
    ).toEqual(['type === "mongodb"', '"oracle" !== t']);
    expect(typeIdComparisons("s.ts", 'const a = mode === "connectionString";')).toEqual([]);
  });

  test.each(["src/components/ConnectionModal.tsx", "src/hooks/use-connection-form.ts"])("%s", (file) => {
    expect(typeIdComparisons(file, readFileSync(join(ROOT, file), "utf8"))).toEqual([]);
  });
});
