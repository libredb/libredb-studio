/**
 * The grant register's legacy rows (packages/grant-register/src/register.json): one legacy row for every engine the
 * legacy adapter serves, each row's own words equal to the legacy adapter's offer, and the register's forms equal to
 * Studio's.
 *
 * The rows were written once from Studio's hand-written records and are hand-reviewed data from then on, never a
 * projection of a declaration. Every record has left core, so the register is the only copy of every grant member and
 * its review notes are the register's own: no record is compared with it here. It lives in core, not in the package's
 * tests, because a package imports nothing of Studio's.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LEGACY_KEY, type RegisterRow, readGrantRegister } from "@libredb/grant-register";
import registerSchema from "@libredb/grant-register/register.schema.json";
import { HOST_PATH_FIELD_NAMES, STATEMENT_LANGUAGE_NAMES } from "@/lib/db/claim-grants";
import {
  DIGEST_FORM,
  ENGINE_ID_FORM,
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
} from "@/lib/provider-host/providers-lock-format";
import { LEGACY_ENGINE_IDS, LEGACY_SOURCE_NAME } from "@/lib/provider-host/legacy-adapter/identity";
import { LEGACY_OFFERS } from "@/lib/provider-host/legacy-adapter/records";
import { namingPattern } from "../../../scripts/isolation-ratchet";

const ROOT = path.resolve(import.meta.dir, "../../..");
const REGISTER_PACKAGE = "packages/grant-register";

/** Every legacy row, in the legacy adapter's order, refusing by name an engine the register holds no row for. */
function legacyRows(): RegisterRow[] {
  const register = readGrantRegister(LEGACY_ENGINE_IDS);
  return LEGACY_ENGINE_IDS.map((engine) => {
    const row = register.rowFor({ legacy: LEGACY_KEY, engine });
    if (row === null) throw new Error(`the grant register holds no legacy row for ${engine}`);
    return row;
  });
}

describe("the legacy rows", () => {
  test("every engine the legacy adapter serves has a legacy row, and its own words are the legacy adapter's offer", () => {
    const rows = legacyRows();

    expect(rows.map((row) => row.engine)).toEqual([...LEGACY_ENGINE_IDS]);
    for (const row of rows) {
      expect({ engine: row.engine, ownWords: row.grants.ownWords }).toEqual({
        engine: row.engine,
        ownWords: LEGACY_OFFERS.ownWords,
      });
    }
  });
});

describe("the register's forms", () => {
  const defs = registerSchema.$defs;

  test("the register's legacy key is the legacy adapter's source name, and its key patterns are the lock's", () => {
    expect(LEGACY_KEY).toBe(LEGACY_SOURCE_NAME);
    expect(defs.row.properties.legacy.const).toBe(LEGACY_SOURCE_NAME);
    const forms = [
      [defs.packageKey.properties.name, PACKAGE_NAME_FORM],
      [defs.packageKey.properties.version, PACKAGE_VERSION_FORM],
      [defs.packageKey.properties.digest, DIGEST_FORM],
      [defs.row.properties.engine, ENGINE_ID_FORM],
    ] as const;
    for (const [property, form] of forms) {
      expect({ pattern: property.pattern, maxLength: property.maxLength }).toEqual({
        pattern: form.pattern.source,
        maxLength: form.maxLength,
      });
    }
  });

  test("the register's vocabularies are the grant reader's", () => {
    expect(defs.grants.properties.statementLanguage.enum).toEqual([...STATEMENT_LANGUAGE_NAMES, null]);
    expect(defs.grants.properties.hostPathFields.items.enum).toEqual([...HOST_PATH_FIELD_NAMES]);
  });

  test("the register package names an engine only on a legacy row's engine line or in a row's review note", () => {
    const declared = readdirSync(path.join(ROOT, "src/lib/db/engine-declarations"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length));
    const pattern = namingPattern(declared);
    const directory = path.join(ROOT, REGISTER_PACKAGE);
    const files = readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .filter((file) => !file.startsWith("tests/"))
      .sort();
    const naming: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(path.join(directory, file), "utf8").split("\n")) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) naming.push(`${file}: ${line.trim()}`);
      }
    }

    // A review note is the register's own, so it may name another engine; no grant value, schema line or reader line
    // does.
    const notes = new Set(
      legacyRows().flatMap((row) =>
        Object.entries(row.reasons ?? {}).flatMap(([member, note]) => {
          const line = `src/register.json: ${JSON.stringify(member)}: ${JSON.stringify(note)}`;
          return [line, `${line},`];
        }),
      ),
    );

    expect(naming.filter((line) => !notes.has(line))).toEqual(
      LEGACY_ENGINE_IDS.map((engine) => `src/register.json: "engine": "${engine}",`),
    );
  });
});
