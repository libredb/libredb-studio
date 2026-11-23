/**
 * The legacy provider interface gains no member (docs/providers/CONTRACT.md, clause C-46): a new capability lands
 * contract-first, in the manifest schema or a facet, then in the bridge that serves today's providers as contract
 * providers, then in the facade today's callers use, never as a new method on `DatabaseProvider`.
 *
 * The member names of `interface DatabaseProvider` in `src/lib/db/types.ts` are read with the TypeScript compiler's
 * public API and compared with `DATABASE_PROVIDER_MEMBERS` below, in any order. A member the list does not name fails
 * by name with the rule, and a listed member the interface no longer declares fails by name too, so the list stays
 * exact and only ever shrinks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const TYPES_FILE = path.resolve(import.meta.dir, "..", "..", "..", "..", "src", "lib", "db", "types.ts");

/** The members `DatabaseProvider` declares today. */
const DATABASE_PROVIDER_MEMBERS: readonly string[] = [
  "type",
  "config",
  "connect",
  "connectWarnings",
  "testConnectionWarnings",
  "disconnect",
  "hasRunsInFlight",
  "isConnected",
  "query",
  "queryReadOnly",
  "readClusterUsage",
  "readCatalogReadOnly",
  "readWorkloadProfile",
  "endOpenQueryTransaction",
  "listContainers",
  "inventoryNeedsConfiguration",
  "countObjects",
  "listObjects",
  "scanKeysPage",
  "describeObject",
  "describeObjects",
  "readObjectSource",
  "buildObjectEdit",
  "applyObjectEdit",
  "getHealth",
  "getMonitoringData",
  "getOverview",
  "getPerformanceMetrics",
  "getSlowQueries",
  "getActiveSessions",
  "getTableStats",
  "getIndexStats",
  "getStorageStats",
  "runMaintenance",
  "previewMaintenance",
  "engineUser",
  "forCatalog",
  "validate",
  "getCapabilities",
  "getLabels",
  "prepareQuery",
];

const CONTRACT_FIRST =
  "land it contract-first: the manifest schema or a facet, then the bridge, then the facade (docs/providers/CONTRACT.md, clause C-46)";

/** The member names `interface DatabaseProvider` declares in `text`, its heritage included; throws when it has none. */
function declaredMembers(text: string): string[] {
  const source = ts.createSourceFile("types.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "DatabaseProvider",
  );
  if (declaration === undefined) throw new Error("No interface DatabaseProvider is declared");
  // An `extends` clause would add members this list cannot see, so it is refused by name too.
  const heritage = (declaration.heritageClauses ?? []).map((clause) => clause.getText(source));
  return [...declaration.members.map((member) => member.name?.getText(source) ?? member.getText(source)), ...heritage];
}

/** One refusal per member added to or removed from the committed list, each naming the member. */
function memberRefusals(declared: readonly string[], listed: readonly string[]): string[] {
  return [
    ...declared
      .filter((member) => !listed.includes(member))
      .map((member) => `DatabaseProvider gains "${member}": ${CONTRACT_FIRST}`),
    ...listed
      .filter((member) => !declared.includes(member))
      .map((member) => `DatabaseProvider no longer declares "${member}": remove it from DATABASE_PROVIDER_MEMBERS`),
  ];
}

const TYPES_TEXT = readFileSync(TYPES_FILE, "utf8");

describe("the legacy provider interface", () => {
  test("DatabaseProvider gains no member, so every SPI change lands contract-first", () => {
    expect(memberRefusals(declaredMembers(TYPES_TEXT), DATABASE_PROVIDER_MEMBERS)).toEqual([]);
  });

  test("a planted member is refused by name", () => {
    const planted = [
      "export interface DatabaseProvider {",
      "  readonly type: string;",
      "  connect(): Promise<void>;",
      "  readTopology?(): Promise<string>;",
      "}",
      "",
    ].join("\n");
    expect(memberRefusals(declaredMembers(planted), ["type", "connect"])).toEqual([
      `DatabaseProvider gains "readTopology": ${CONTRACT_FIRST}`,
    ]);
    const extended = "export interface DatabaseProvider extends Topology { readonly type: string; }";
    expect(memberRefusals(declaredMembers(extended), ["type"])).toEqual([
      `DatabaseProvider gains "extends Topology": ${CONTRACT_FIRST}`,
    ]);
  });

  test("a removed member is refused by name, so the list stays exact", () => {
    const planted = ["export interface DatabaseProvider {", "  readonly type: string;", "}", ""].join("\n");
    expect(memberRefusals(declaredMembers(planted), ["type", "connect"])).toEqual([
      'DatabaseProvider no longer declares "connect": remove it from DATABASE_PROVIDER_MEMBERS',
    ]);
    expect(() => declaredMembers("export interface OtherProvider {}")).toThrow(
      "No interface DatabaseProvider is declared",
    );
  });
});
