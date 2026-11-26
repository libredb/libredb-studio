/**
 * The legacy adapter (src/lib/provider-host/legacy-adapter/): one engine record per committed declaration of Studio's
 * own, composed from Studio's committed tables when the module loads and never from a declaration read at run time,
 * under the legacy identity `@libredb/studio` at the root package.json's version.
 *
 * The parity cases read each declaration's JSON file here, in the test, and project it with the very projections the
 * server catalog's composer projects an admitted package's declaration with, so a legacy record and a package record of
 * the same declaration are held to one composition. Two differences are stated by name, since they are what the two
 * composers are for, not a drift between them:
 * - a field rule naming a `check`: the legacy record binds the function Studio's own source holds for the engine
 *   (`CONNECTION_FORM_FUNCTIONS`), where a package's record answers core's unbound sentence, since Studio binds no
 *   function of a package;
 * - `connectionFields`: a legacy record lists every field its form draws (`CONNECTION_FORM`), a package's only the
 *   ruled ones, and only a ruled field is ever checked, so the two are compared over the ruled fields.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FieldName } from "@libredb/provider-sdk/manifest";
import * as grants from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECTION_FORM_FUNCTIONS, type ConnectionFieldRule, packageFieldRules } from "@/lib/db/connection-form";
import {
  type AuthoredDeclaration,
  projectCatalog,
  projectConnectionForms,
  projectConnectionTables,
} from "@/lib/db/engine-catalog/projection";
import { BUNDLED_CLAIM_REQUESTS } from "@/lib/db/engine-catalog/claims.generated";
import { boundFunction } from "@/lib/db/function-table";
import type { EngineRecord } from "@/lib/db/server-catalog";
import { sqlGrammarFor } from "@/lib/db/sql-grammar";
import {
  LEGACY_ENGINE_IDS,
  LEGACY_SOURCE_NAME,
  LEGACY_SOURCE_VERSION,
} from "@/lib/provider-host/legacy-adapter/identity";
import { LEGACY_ENGINES, LEGACY_OFFERS } from "@/lib/provider-host/legacy-adapter/records";
import type { DatabaseType } from "@/lib/types";
import { legacyAgentCredentialTable, legacyRegisterTable } from "../../../helpers/legacy-register";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const DECLARATIONS = path.join(ROOT, "src/lib/db/engine-declarations");

/** Every committed declaration, read from its file. */
const declarations: readonly AuthoredDeclaration[] = readdirSync(DECLARATIONS)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(path.join(DECLARATIONS, file), "utf8")) as AuthoredDeclaration);

/** The legacy record of `id`. */
function legacyRecord(id: string): EngineRecord {
  const engine = LEGACY_ENGINES.get(id);
  if (engine === undefined) throw new Error(`the legacy adapter holds no record of ${id}`);
  return engine;
}

/** One field rule as plain data a comparison reads: the pattern as its source and flags, the check left out. */
function ruleData(rule: ConnectionFieldRule | undefined) {
  if (rule === undefined) return undefined;
  const { required, format, charRange } = rule;
  return {
    required,
    format:
      format === undefined
        ? undefined
        : { source: format.pattern.source, flags: format.pattern.flags, sentence: format.sentence },
    charRange,
  };
}

/**
 * Each shipped engine's request at the choice of database, `connection.serverLevelWithoutDatabase`, read against its
 * legacy row as that gate reads it: true only where the request and the row both are.
 */
const SERVER_LEVEL_AT_CATALOG_CHOICE = Object.fromEntries(
  SHIPPED_DATABASE_TYPES.map((id) => [
    id,
    BUNDLED_CLAIM_REQUESTS[id].connection.serverLevelWithoutDatabase &&
      legacyRegisterTable("serverLevelWithoutDatabase")[id],
  ]),
) as Readonly<Record<DatabaseType, boolean>>;

/** Whether each shipped engine keeps a read-only connection's promise: where its legacy row's write reach is not open. */
const READ_ONLY_ENFORCED_FROM_ROWS = Object.fromEntries(
  SHIPPED_DATABASE_TYPES.map((id) => [id, legacyRegisterTable("writeReach")[id] !== "open"]),
) as Readonly<Record<DatabaseType, boolean>>;

/** The refusal at open no grant covers, for every shipped engine: none, since each request equals its legacy row. */
const NO_UNGRANTED_REFUSAL = Object.fromEntries(SHIPPED_DATABASE_TYPES.map((id) => [id, null])) as Readonly<
  Record<DatabaseType, null>
>;

/**
 * Each member of an engine's grants, for every shipped engine: the grant reader's exported table where a reader still
 * reads one, the register's legacy rows of the member where the grant is the row, and, for a member the grant reader
 * derives, that derivation written here from the rows.
 */
const GRANT_TABLES: Readonly<Record<keyof EngineRecord["grants"], Readonly<Record<DatabaseType, unknown>>>> = {
  writeReach: grants.GRANTED_WRITE_REACH,
  readsFileAccessPosture: legacyRegisterTable("readsFileAccessPosture"),
  deniedFileAccessRefusal: grants.GRANTED_DENIED_FILE_ACCESS_REFUSAL,
  singleWriterFile: legacyRegisterTable("singleWriterFile"),
  readRootsRequired: grants.GRANTED_READ_ROOTS_REQUIRED,
  agentCredentialForm: legacyRegisterTable("agentCredentialForm"),
  maskingExemptColumns: legacyRegisterTable("maskingExemptColumns"),
  exposable: grants.GRANTED_MCP_EXPOSABLE,
  statementRead: grants.GRANTED_MCP_STATEMENT_READ,
  metadataReadChangesState: grants.GRANTED_MCP_METADATA_READ_CHANGES_STATE,
  agentCredentialRequired: grants.GRANTED_MCP_AGENT_CREDENTIAL_REQUIRED,
  readOnlyEnforced: READ_ONLY_ENFORCED_FROM_ROWS,
  ungrantedRefusals: NO_UNGRANTED_REFUSAL,
  opensLocalFile: legacyRegisterTable("opensLocalFile"),
  hostPathFields: legacyRegisterTable("hostPathFields"),
  // A legacy engine's request equals its row, so the grant restrictive when true is the row.
  serverLevelAtAdmission: legacyRegisterTable("serverLevelWithoutDatabase"),
  serverLevelAtCatalogChoice: SERVER_LEVEL_AT_CATALOG_CHOICE,
  sshTunnel: grants.GRANTED_SSH_TUNNEL_REFUSAL,
  agentCredential: legacyAgentCredentialTable(),
  statementLanguage: grants.GRANTED_AGENT_STATEMENT_LANGUAGE,
  agentReadings: grants.GRANTED_AGENT_READINGS,
  ownWords: legacyRegisterTable("ownWords"),
  servesOneSession: legacyRegisterTable("servesOneSession"),
  agentExecution: legacyRegisterTable("agentExecution"),
};

/** The grant members the grant reader builds as a new value rather than handing on its row's own. */
const COPIED_GRANT_MEMBERS: ReadonlySet<string> = new Set([
  "maskingExemptColumns",
  "hostPathFields",
  "agentCredential",
]);

/**
 * The plain objects and arrays `value` holds, itself included, that are not frozen, by their path. A compiled pattern
 * (`RegExp`) and a bound function are leaves: they are Studio's shared objects, which the record holds by reference.
 */
function unfrozen(value: unknown, at = "$"): string[] {
  if (typeof value !== "object" || value === null || value instanceof RegExp) return [];
  const own = Object.isFrozen(value) ? [] : [at];
  return own.concat(Object.entries(value).flatMap(([key, member]) => unfrozen(member, `${at}.${key}`)));
}

describe("the legacy adapter's records", () => {
  test("each legacy record's catalog entry, connection tables and field rules equal the package projection of its committed declaration", () => {
    expect(declarations).toHaveLength(43);
    for (const declaration of declarations) {
      const { id } = declaration;
      const engine = legacyRecord(id);
      const tables = projectConnectionTables([declaration]);
      const form = projectConnectionForms([declaration])[id];
      if (form === undefined) throw new Error(`no form projected for ${id}`);
      expect(engine.catalog).toEqual(projectCatalog([declaration])[id] as never);
      expect(engine.connection).toEqual({
        fields: tables.fields[id],
        seedOnly: tables.seedOnly[id],
        refused: tables.refused[id],
        credentialWarnings: tables.credentialWarnings[id] ?? [],
        tlsModes: declaration.connection.tls.modes,
        readsTrustMaterial: tables.readsTrustMaterial[id],
        connectionStringAccepted: tables.connectionStringAccepted[id],
        dialogOffersUri: tables.dialogOffersUri[id],
      } as never);

      const packaged = packageFieldRules(id, form, tables.fields[id] as readonly FieldName[]);
      const ruled = packaged.connectionFields;
      expect(engine.fieldRules.connectionFields.filter((field) => ruled.includes(field))).toEqual([...ruled]);
      expect(Object.keys(engine.fieldRules.fieldRules ?? {})).toEqual(Object.keys(packaged.fieldRules ?? {}));
      for (const rule of form.fieldRules) {
        const legacy = engine.fieldRules.fieldRules?.[rule.field as keyof typeof engine.fieldRules.fieldRules];
        const fromPackage = packaged.fieldRules?.[rule.field as keyof typeof packaged.fieldRules];
        expect(ruleData(legacy)).toEqual(ruleData(fromPackage));
        if (rule.check === null) {
          expect(legacy?.check).toBeUndefined();
        } else {
          // The one difference by design: Studio binds its own function for its own engine.
          expect(legacy?.check).toBe(boundFunction(id as DatabaseType, CONNECTION_FORM_FUNCTIONS.checks, rule.check));
        }
      }
      expect(engine.fieldRules.fieldShownWhen).toEqual(packaged.fieldShownWhen as never);
      expect(engine.fieldRules.fieldDefaults).toEqual(packaged.fieldDefaults as never);
    }
  });

  test("each legacy record's grants equal the grant reader's rows for its id", () => {
    for (const id of SHIPPED_DATABASE_TYPES) {
      const engine = legacyRecord(id);
      expect(Object.keys(engine.grants).sort()).toEqual(Object.keys(GRANT_TABLES).sort());
      for (const [member, table] of Object.entries(GRANT_TABLES)) {
        const granted = engine.grants[member as keyof EngineRecord["grants"]];
        // Equal rather than identical only where the grant reader builds a new value: a masking exemption, a host path
        // field list the request adds to, and an agent credential, whose superseding fields it narrows.
        if (COPIED_GRANT_MEMBERS.has(member)) expect([member, granted]).toEqual([member, table[id] as never]);
        else expect(granted).toBe(table[id] as never);
      }
    }
  });

  test("each legacy record's statement grammar is its sqlGrammarFor row", () => {
    for (const id of SHIPPED_DATABASE_TYPES) {
      expect(legacyRecord(id).statementGrammar).toBe(sqlGrammarFor(id).grammar);
    }
  });

  test("every legacy record is frozen to its leaves, its offers are the legacy offers, and its source is the legacy identity", () => {
    expect(LEGACY_OFFERS).toEqual({
      legacyProvider: true,
      explain: true,
      database: true,
      catalog: true,
      unboundedPage: true,
      consoleTextBound: true,
      statementVocabulary: true,
      queryEventText: true,
      sshTunnel: true,
      hostFiles: true,
      testCautions: true,
    });
    const version = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    expect([LEGACY_SOURCE_NAME, LEGACY_SOURCE_VERSION]).toEqual(["@libredb/studio", version]);
    for (const id of SHIPPED_DATABASE_TYPES) {
      const engine = legacyRecord(id);
      expect(unfrozen(engine)).toEqual([]);
      expect(engine.offers).toBe(LEGACY_OFFERS);
      expect(engine.source).toEqual({ name: "@libredb/studio", version, digest: null, package: null });
    }
  });

  test("the adapter's ids are the committed declarations' and its map is built once", async () => {
    const declared = declarations.map(({ id }) => id);
    expect([...LEGACY_ENGINE_IDS].sort()).toEqual(declared);
    expect([...LEGACY_ENGINES.keys()]).toEqual([...LEGACY_ENGINE_IDS]);
    expect(Object.isFrozen(LEGACY_ENGINE_IDS)).toBe(true);
    const again = await import("@/lib/provider-host/legacy-adapter/records");
    expect(again.LEGACY_ENGINES).toBe(LEGACY_ENGINES);
    for (const id of declared) {
      expect(again.LEGACY_ENGINES.get(id)).toBe(legacyRecord(id));
      expect(legacyRecord(id).id as string).toBe(id);
    }
  });
});
