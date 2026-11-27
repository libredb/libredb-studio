/**
 * The grant register's legacy rows (packages/grant-register/src/register.json): one legacy row for every engine the
 * legacy adapter serves, each row's own words equal to the legacy adapter's offer, and the register's forms equal to
 * Studio's.
 *
 * The rows were written once from Studio's hand-written records and are hand-reviewed data from then on, never a
 * projection of a declaration. Every record has left core, so the register is the only copy of every grant member, the
 * redaction and the confirmation gate's claims included, and its review notes are the register's own. Each row's
 * confirmation claims are compared here with the ones its engine's shipped rows make, its declaration and its
 * statement vocabulary row, each with its review note, and each row's reviewed grammar digest with the SHA-256 of its
 * declaration's grammar, and each row's reviewed language data digest with the digest of its declaration's statement
 * language data, null for null, so a changed legacy grammar, changed language data or a new loosening claim fails here
 * until its row is reviewed again. It lives in core, not in the package's tests, because a package imports nothing of
 * Studio's.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LEGACY_KEY, type RegisterRow, readGrantRegister } from "@libredb/grant-register";
import registerSchema from "@libredb/grant-register/register.schema.json";
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import manifestSchema from "@libredb/provider-sdk/manifest.schema.json";
import {
  AGENT_READING_NAMES,
  HOST_PATH_FIELD_NAMES,
  SQL_NAME_QUOTES,
  STATEMENT_LANGUAGE_NAME_FORM,
} from "@/lib/db/claim-grants";
import { NON_SQL_DESTRUCTIVE_VOCABULARY } from "@/lib/db/destructive-commands";
import { grammarSha256 } from "@/lib/db/grammar-digest";
import { languageDataSha256 } from "@/lib/db/language-digest";
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

/** The SQL text members of `engine`'s declaration (src/lib/db/engine-declarations/<engine>.json). */
function declaredSqlText(engine: string): {
  readsSqlText: boolean;
  grammar: { confirmExemptForms?: string[][] } & Record<string, unknown>;
} {
  const declaration = JSON.parse(
    readFileSync(path.join(ROOT, "src/lib/db/engine-declarations", `${engine}.json`), "utf8"),
  ) as { sqlText: ReturnType<typeof declaredSqlText> };
  return declaration.sqlText;
}

/** The statement language data legacy engine `engine`'s committed declaration states, or null. */
function declaredLanguageData(engine: string): NonNullable<StatementLanguageData> | null {
  const declaration = JSON.parse(
    readFileSync(path.join(ROOT, "src/lib/db/engine-declarations", `${engine}.json`), "utf8"),
  ) as { statementLanguageData: StatementLanguageData };
  return declaration.statementLanguageData;
}

/** Whether `note` is one sentence: a capital first, one full stop, at the end. */
const oneSentence = (note: string | undefined): boolean =>
  note !== undefined && /^[A-Z][^\n]*\.$/.test(note) && note.split(/\.\s/).length === 1;

/**
 * What is wrong with `row`'s confirmation claims: each must be the one its engine's shipped rows make, text-not-SQL
 * exactly where its declaration states `readsSqlText: false`, its declaration's exempt forms, and decides-alone exactly
 * where its statement vocabulary row decides alone; and each claim it makes carries a one-sentence review note, which
 * a member it does not claim lacks.
 */
function confirmationClaimProblems(row: RegisterRow): string[] {
  const { engine, grants, reasons = {} } = row;
  const declared = declaredSqlText(engine);
  const vocabulary = (NON_SQL_DESTRUCTIVE_VOCABULARY as Readonly<Record<string, { decidesAlone?: boolean }>>)[engine];
  const claims = [
    ["readsSqlText", !grants.readsSqlText, !declared.readsSqlText],
    ["decidesAlone", grants.decidesAlone, vocabulary?.decidesAlone === true],
    [
      "confirmExemptForms",
      grants.confirmExemptForms.length > 0,
      JSON.stringify(grants.confirmExemptForms) === JSON.stringify(declared.grammar.confirmExemptForms ?? []),
    ],
  ] as const;
  const problems: string[] = [];
  for (const [member, claimed, made] of claims) {
    const note = reasons[member];
    if (member === "confirmExemptForms" ? !made : claimed !== made) {
      problems.push(`${engine}: ${member} is not the claim its shipped rows make`);
    }
    if (claimed ? !oneSentence(note) : note !== undefined) {
      problems.push(`${engine}: ${member} ${claimed ? "has no one-sentence review note" : "has a note but no claim"}`);
    }
  }
  return problems;
}

describe("the legacy rows' SQL text members", () => {
  test("each legacy row's confirmation claims are the ones its engine's shipped rows make: text-not-SQL exactly where its declaration states readsSqlText false, its declaration's exempt forms, and decides-alone exactly where its statement vocabulary row decides alone, each with a one-sentence review note", () => {
    const rows = legacyRows();

    expect(rows.flatMap(confirmationClaimProblems)).toEqual([]);
    expect(rows.filter((row) => !row.grants.readsSqlText)).toHaveLength(22);
    expect(rows.filter((row) => row.grants.decidesAlone)).toHaveLength(20);
    expect(rows.flatMap((row) => row.grants.confirmExemptForms)).toHaveLength(2);
    // Vacuity: a planted row whose claim has no note, or whose claim no shipped row makes, fails by name.
    const snowflake = rows.find((row) => row.engine === "snowflake") as RegisterRow;
    const unnoted = { ...snowflake, reasons: {} };
    expect(confirmationClaimProblems(unnoted)).toEqual([
      "snowflake: confirmExemptForms has no one-sentence review note",
    ]);
    const unmade = { ...snowflake, grants: { ...snowflake.grants, decidesAlone: true } };
    expect(confirmationClaimProblems(unmade)).toEqual([
      "snowflake: decidesAlone is not the claim its shipped rows make",
      "snowflake: decidesAlone has no one-sentence review note",
    ]);
  });

  test("each legacy row's redaction carries a review note where it keeps a name quote or reads a command, and its grammar digest is the SHA-256 of its declaration's grammar", () => {
    const rows = legacyRows();

    for (const row of rows) {
      const { engine, grants, reasons = {} } = row;
      const declaration = { sqlText: declaredSqlText(engine) };
      // A redaction keeping a name quote or reading a command carries the record's comment as its review note.
      const kept =
        grants.redaction.kind === "command" || (grants.redaction.kind === "sql" && grants.redaction.nameQuote !== null);
      expect({ engine, noted: reasons.redaction !== undefined }).toEqual({ engine, noted: kept });
      expect({ engine, grammarSha256: grants.grammarSha256 }).toEqual({
        engine,
        grammarSha256: grammarSha256(declaration.sqlText.grammar),
      });
    }
    // Vacuity: the rows grant every kind of redaction, so the review note check reads both of its answers.
    const kinds = rows.map((row) => row.grants.redaction.kind);
    expect(kinds.filter((kind) => kind === "sql")).toHaveLength(18);
    expect(kinds.filter((kind) => kind === "command")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "none")).toHaveLength(23);
  });

  test("every legacy row's language digest equals the digest of its declaration's statement language data, null for null", () => {
    const rows = legacyRows();

    for (const { engine, grants } of rows) {
      const data = declaredLanguageData(engine);
      expect({ engine, languageSha256: grants.languageSha256 }).toEqual({
        engine,
        languageSha256: data === null ? null : languageDataSha256(data),
      });
    }
    // Vacuity: the walk read every engine the legacy adapter serves.
    expect(rows).toHaveLength(LEGACY_ENGINE_IDS.length);
    expect(rows.length).toBeGreaterThan(40);
  });
});

/**
 * What is wrong with `row`'s review of the agent overlay's command-shaped catalog read: a row granting it carries a
 * one-sentence review note, and a row not granting it carries none.
 */
function catalogReadCommandProblems(row: RegisterRow): string[] {
  const { engine, grants, reasons = {} } = row;
  const note = reasons.catalogReadCommandShaped;
  if (grants.catalogReadCommandShaped) {
    return oneSentence(note) ? [] : [`${engine}: catalogReadCommandShaped has no one-sentence review note`];
  }
  return note === undefined ? [] : [`${engine}: catalogReadCommandShaped has a note but no grant`];
}

describe("the legacy rows' agent overlay claim", () => {
  test("a legacy row grants the command-shaped catalog read only with a review note", () => {
    const rows = legacyRows();

    expect(rows.flatMap(catalogReadCommandProblems)).toEqual([]);
    expect(rows.filter((row) => row.grants.catalogReadCommandShaped).map((row) => row.engine)).toEqual([
      "elasticsearch",
      "opensearch",
    ]);
    // Vacuity: a planted row granting the claim with no note, and one with a note but no grant, fail by name.
    const elasticsearch = rows.find((row) => row.engine === "elasticsearch") as RegisterRow;
    expect(catalogReadCommandProblems({ ...elasticsearch, reasons: {} })).toEqual([
      "elasticsearch: catalogReadCommandShaped has no one-sentence review note",
    ]);
    const ungranted = { ...elasticsearch, grants: { ...elasticsearch.grants, catalogReadCommandShaped: false } };
    expect(catalogReadCommandProblems(ungranted)).toEqual([
      "elasticsearch: catalogReadCommandShaped has a note but no grant",
    ]);
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
    // A language the register grants is null or a name of the form the grant reader and the SDK read a request in.
    const language = defs.grants.properties.statementLanguage as { type: unknown; pattern: string };
    expect(language.type).toEqual(["string", "null"]);
    expect(language.pattern).toBe(STATEMENT_LANGUAGE_NAME_FORM.source);
    expect(language.pattern).toBe(manifestSchema.$defs.statementLanguage.pattern);
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
