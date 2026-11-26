/**
 * The grant register's legacy rows (packages/grant-register/src/register.json): one legacy row for every engine the
 * legacy adapter serves, each row's own words equal to the legacy adapter's offer, and the register's forms equal to
 * Studio's.
 *
 * The rows were written once from Studio's hand-written records and are hand-reviewed data from then on, never a
 * projection of a declaration. Every record but two has left core, so the register is the only copy of every other
 * grant member and its review notes are the register's own. The two still in core, the statement redaction record
 * (`SQL_TEXT_REDACTION`) and the confirmation gate's review record (`CONFIRMATION_CLAIM_REVIEW`), are compared with the
 * rows' SQL text members here until they leave core, and each row's reviewed grammar digest with the SHA-256 of its
 * declaration's grammar, so a changed legacy grammar fails here until its row is reviewed again. It lives in core, not
 * in the package's tests, because a package imports nothing of Studio's.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LEGACY_KEY, type RegisterRow, readGrantRegister } from "@libredb/grant-register";
import registerSchema from "@libredb/grant-register/register.schema.json";
import manifestSchema from "@libredb/provider-sdk/manifest.schema.json";
import {
  AGENT_READING_NAMES,
  HOST_PATH_FIELD_NAMES,
  SQL_NAME_QUOTES,
  STATEMENT_LANGUAGE_NAMES,
} from "@/lib/db/claim-grants";
import { CONFIRMATION_CLAIM_REVIEW } from "@/lib/db/confirmation-claim-review";
import { grammarSha256 } from "@/lib/db/grammar-digest";
import { SQL_TEXT_REDACTION } from "@/lib/db/sql-grammar/redaction";
import {
  DIGEST_FORM,
  ENGINE_ID_FORM,
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
} from "@/lib/provider-host/providers-lock-format";
import { LEGACY_ENGINE_IDS, LEGACY_SOURCE_NAME } from "@/lib/provider-host/legacy-adapter/identity";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
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
  test("every engine the legacy adapter serves has a legacy row, and its record grants its row's own words", () => {
    const rows = legacyRows();

    expect(rows.map((row) => row.engine)).toEqual([...LEGACY_ENGINE_IDS]);
    for (const row of rows) {
      expect({ engine: row.engine, ownWords: LEGACY_ENGINES.get(row.engine)?.grants.ownWords }).toEqual({
        engine: row.engine,
        ownWords: row.grants.ownWords,
      });
      // Every legacy engine's words reach the client through core's scrub, as they did before the register held them.
      expect({ engine: row.engine, ownWords: row.grants.ownWords }).toEqual({
        engine: row.engine,
        ownWords: "scrubbed",
      });
    }
  });
});

describe("the legacy rows' SQL text members", () => {
  /** The confirmation gate's review record's entries of `kind` for `engine`, in the record's order. */
  const entries = (engine: string, kind: string) =>
    CONFIRMATION_CLAIM_REVIEW.filter(({ claim }) => claim.kind === kind && claim.type === engine);

  test("each legacy row's SQL text members are Studio's records of them: the redaction row, the text-not-SQL, exempt-form and decides-alone entries with their reasons, and the SHA-256 of its declaration's grammar", () => {
    const rows = legacyRows();
    const record = SQL_TEXT_REDACTION as Readonly<Record<string, unknown>>;

    for (const row of rows) {
      const { engine, grants, reasons = {} } = row;
      const textNotSql = entries(engine, "text-not-sql");
      const decidesAlone = entries(engine, "decides-alone");
      const exempt = entries(engine, "exempt-form");
      const declaration = JSON.parse(
        readFileSync(path.join(ROOT, "src/lib/db/engine-declarations", `${engine}.json`), "utf8"),
      ) as { sqlText: { grammar: unknown } };
      expect({ engine, redaction: grants.redaction }).toEqual({ engine, redaction: record[engine] as never });
      expect({ engine, readsSqlText: grants.readsSqlText, reason: reasons.readsSqlText }).toEqual({
        engine,
        readsSqlText: textNotSql.length === 0,
        reason: textNotSql[0]?.reason,
      });
      expect({ engine, decidesAlone: grants.decidesAlone, reason: reasons.decidesAlone }).toEqual({
        engine,
        decidesAlone: decidesAlone.length > 0,
        reason: decidesAlone[0]?.reason,
      });
      expect({ engine, forms: grants.confirmExemptForms }).toEqual({
        engine,
        forms: exempt.map(({ claim }) => (claim.kind === "exempt-form" ? [...claim.form] : [])),
      });
      expect({ engine, noted: reasons.confirmExemptForms !== undefined }).toEqual({ engine, noted: exempt.length > 0 });
      // A redaction keeping a name quote or reading a command carries the record's comment as its review note.
      const kept =
        grants.redaction.kind === "command" || (grants.redaction.kind === "sql" && grants.redaction.nameQuote !== null);
      expect({ engine, noted: reasons.redaction !== undefined }).toEqual({ engine, noted: kept });
      expect({ engine, grammarSha256: grants.grammarSha256 }).toEqual({
        engine,
        grammarSha256: grammarSha256(declaration.sqlText.grammar),
      });
    }
    // Every entry of the review record is on a row, and the rows hold each kind of entry.
    expect(CONFIRMATION_CLAIM_REVIEW.filter(({ claim }) => !LEGACY_ENGINE_IDS.includes(claim.type))).toEqual([]);
    expect(rows.filter((row) => !row.grants.readsSqlText)).toHaveLength(22);
    expect(rows.filter((row) => row.grants.decidesAlone)).toHaveLength(20);
    expect(rows.flatMap((row) => row.grants.confirmExemptForms)).toHaveLength(2);
    expect(Object.keys(record).sort()).toEqual([...LEGACY_ENGINE_IDS].sort());
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
    expect(defs.grants.properties.agentReadings.items.enum).toEqual([...AGENT_READING_NAMES]);
    const redactions = defs.grants.properties.redaction.enum;
    expect(redactions.flatMap((redaction) => (redaction.kind === "sql" ? [redaction.nameQuote] : []))).toEqual([
      ...SQL_NAME_QUOTES,
    ]);
    // A form's word is the SDK's SQL keyword, so a declared exempt form and a row's are written alike.
    expect(defs.keyword.pattern).toBe(manifestSchema.$defs.sqlKeyword.pattern);
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
