/**
 * The exit of milestone M3 of the provider plugins program: no module of Studio's `src/` keeps a hand-written grant
 * record or grant projection keyed by engine id. Until then, every such record or projection core still exports is on
 * `CORE_GRANT_RECORDS`, a closed list, each entry with the change that removes it: an item of M3 (issue #2557 and its
 * siblings), or, for a projection a browser module reads, milestone M7 and those readers.
 *
 * The list is `CORE_GRANT_RECORDS` (tests/helpers/core-grant-records.ts). A record is found two ways:
 * - every entry of the engine table inventory (tests/unit/db/engine-declarations/inventory.ts) whose destination is a
 *   claim table, `REVIEW_RECORD_PHRASE`, or a granted table, `GRANTED_DESTINATION`;
 * - by name, `UNINVENTORIED_GRANT_RECORDS`, the records the inventory cannot see or classifies otherwise: a list of
 *   engine ids and an array of rows.
 * A detected record the list does not name fails by name, and so does an entry whose module no longer exports its name
 * or an M7 reader file that does not exist or does not import the name.
 *
 * The list may only shrink. A new record keyed by engine id raises the isolation ratchet's `engineKeyedTypePositions`,
 * and a new list of engine ids its `coreHandwritten.linesNamingAnEngine`, both gate counters that only fall, so an
 * addition is refused there; a change that turns an entry into a browser projection replaces it one for one.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CLAIM_GRANTS, CORE_GRANT_RECORDS, type GrantRecordEntry } from "../../helpers/core-grant-records";
import { ENGINE_TABLE_INVENTORY, GRANTED_DESTINATION, REVIEW_RECORD_PHRASE } from "./engine-declarations/inventory";

const ROOT = path.resolve(import.meta.dir, "../../..");

const COMPATIBILITY = "src/lib/db/compatibility.ts";

/** The grant records the engine table inventory cannot see or classifies otherwise, each with why. */
const UNINVENTORIED_GRANT_RECORDS: readonly (Pick<GrantRecordEntry, "module" | "name"> & { readonly why: string })[] = [
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_EXECUTION_ENGINES",
    why: "a list of engine ids, not a table keyed by engine",
  },
  {
    module: "src/lib/db/confirmation-claim-review.ts",
    name: "CONFIRMATION_CLAIM_REVIEW",
    why: "an array of reviewed rows, not a table keyed by engine",
  },
];

function key(entry: { readonly module: string; readonly name: string }): string {
  return `${entry.module} ${entry.name}`;
}

/** Whether `module` exports a value declaration named `name`. */
function exportsName(module: string, name: string): boolean {
  const file = path.join(ROOT, module);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
  return source.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
      statement.declarationList.declarations.some((declaration) => declaration.name.getText(source) === name),
  );
}

/** Whether `module` imports `name` by an import declaration, a type-only one excepted. */
function importsName(module: string, name: string): boolean {
  const file = path.join(ROOT, module);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const kind = module.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true, kind);
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name)
    );
  });
}

describe("the exit of M3", () => {
  test("every module of src exporting a grant record or projection keyed by engine id is on the closed list, each with the item or the browser reader and milestone that removes it", () => {
    const detected = [
      ...ENGINE_TABLE_INVENTORY.filter(
        (entry) => entry.destination.includes(REVIEW_RECORD_PHRASE) || entry.destination === GRANTED_DESTINATION,
      ),
      ...UNINVENTORIED_GRANT_RECORDS,
    ];
    const listed = new Set(CORE_GRANT_RECORDS.map(key));

    expect(detected.filter((entry) => !listed.has(key(entry))).map(key)).toEqual([]);
    expect(new Set(detected.map(key)).size).toBe(CORE_GRANT_RECORDS.length);
    expect(listed.size).toBe(CORE_GRANT_RECORDS.length);
    expect(CORE_GRANT_RECORDS.filter((entry) => !exportsName(entry.module, entry.name)).map(key)).toEqual([]);
    for (const entry of CORE_GRANT_RECORDS) {
      if (!("milestone" in entry.removedBy)) continue;
      expect(entry.removedBy.readers.length).toBeGreaterThan(0);
      for (const reader of entry.removedBy.readers) {
        expect({ entry: key(entry), reader, imports: importsName(reader, entry.name) }).toEqual({
          entry: key(entry),
          reader,
          imports: true,
        });
      }
    }
  });

  test("the inventory finds every claim table and granted table it records, and the list counts each item's records", () => {
    const claimTables = ENGINE_TABLE_INVENTORY.filter((entry) => entry.destination.includes(REVIEW_RECORD_PHRASE));
    const grantedTables = ENGINE_TABLE_INVENTORY.filter((entry) => entry.destination === GRANTED_DESTINATION);
    const count = (removedBy: string) =>
      CORE_GRANT_RECORDS.filter((entry) => JSON.stringify(entry.removedBy).startsWith(removedBy)).length;

    expect(claimTables).toHaveLength(0);
    expect(grantedTables).toHaveLength(4);
    expect(count('{"item":4}')).toBe(1);
    expect(count('{"milestone":"M7"')).toBe(5);
  });

  test("the list's checks fail by name on a stale entry, a module that does not export the name and a reader that does not import it", () => {
    expect(exportsName(COMPATIBILITY, "SHIPPED_DATABASE_TYPES")).toBe(true);
    expect(exportsName(COMPATIBILITY, "NOT_A_RECORD")).toBe(false);
    expect(exportsName("src/lib/db/absent-module.ts", "WRITE_REACH")).toBe(false);
    expect(importsName("src/components/read-only-marker.tsx", "GRANTED_WRITE_REACH")).toBe(true);
    expect(importsName("src/components/read-only-marker.tsx", "GRANTED_SSH_TUNNEL_REFUSAL")).toBe(false);
    expect(importsName("src/components/absent.tsx", "GRANTED_WRITE_REACH")).toBe(false);
  });
});
