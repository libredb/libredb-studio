/**
 * The legacy adapter's engine records: one `EngineRecord` (src/lib/db/server-catalog.ts) per engine Studio still serves
 * through its own legacy providers, so the server's engine catalog holds every engine in one record shape, a legacy
 * engine beside a provider package's.
 *
 * Each record is composed when this module loads, once per process, from Studio's committed tables and never from a
 * declaration read at run time:
 * - `catalog`: the engine's row of the generated catalog (`BUNDLED_CATALOG`);
 * - `connection`: its rows of the generated connection tables and flags, its credential warnings (none where the
 *   generated table holds no row) and its declared TLS modes (`BUNDLED_CONNECTION_FORMS`);
 * - `fieldRules`: the four members the field rule readers read of its composed form entry (`CONNECTION_FORM`), each
 *   only where the entry states it, so a named check is the function Studio's own source holds for the engine;
 * - `grants`: Studio's grant of its claims against its legacy row of the grant register (`legacyEngineGrants`);
 * - `statementGrammar`: its row of Studio's grammar table (`sqlGrammarFor`);
 * - `statementLanguageRow`: Studio's code row of its id (`codeStatementLanguageRow`), as the one resolver answers it
 *   (`statementLanguageRow`) with no declared data, since no projection carries a legacy declaration's statement
 *   language data: every one states null, which tests/unit/db/engine-declarations.test.ts holds. The row is the one
 *   object the browser reads by type, frozen where its module declares it, and read here once, when the record is
 *   composed;
 * - `explainReading`: `"declared"`, the explain value its grammar declares;
 * - `source`: the legacy identity (./identity), with no digest and no package;
 * - `offers`: `LEGACY_OFFERS`, every offer a legacy provider makes today.
 * The records are kept in one `Map`, typed read-only and keyed in the engine catalog's order, each record and every
 * plain object and array it holds frozen; a compiled pattern and a bound check are Studio's shared objects, held by
 * reference. Nothing here opens a session: a legacy record's open is `openLegacyEngine` (./open), which the one open
 * function (`openEngine` in ../open-engine) calls.
 */
import type { CredentialWarning } from "@libredb/provider-sdk/manifest";
import { legacyEngineGrants } from "@/lib/db/claim-grants";
import { CONNECTION_FORM, type FieldRuleSpec } from "@/lib/db/connection-form";
import { codeStatementLanguageRow } from "@/lib/db/destructive-commands";
import { BUNDLED_CATALOG } from "@/lib/db/engine-catalog/catalog.generated";
import {
  BUNDLED_CONNECTION_STRING_ACCEPTED,
  BUNDLED_DIALOG_OFFERS_URI,
  BUNDLED_READS_TRUST_MATERIAL,
} from "@/lib/db/engine-catalog/connection-flags.generated";
import { BUNDLED_CONNECTION_FORMS } from "@/lib/db/engine-catalog/connection-form.generated";
import {
  BUNDLED_CONNECTION_FIELDS,
  BUNDLED_CREDENTIAL_WARNINGS,
  BUNDLED_REFUSED_FIELDS,
  BUNDLED_SEED_ONLY,
} from "@/lib/db/engine-catalog/connection.generated";
import type { EngineId, EngineOffers, EngineRecord } from "@/lib/db/server-catalog";
import { sqlGrammarFor } from "@/lib/db/sql-grammar";
import { statementLanguageRow } from "@/lib/db/statement-language-row";
import type { DatabaseType } from "@/lib/types";
import { LEGACY_ENGINE_IDS, LEGACY_SOURCE_NAME, LEGACY_SOURCE_VERSION } from "./identity";

/** What every legacy engine offers: everything a legacy provider serves today. */
export const LEGACY_OFFERS: EngineOffers = Object.freeze({
  legacyProvider: true,
  explain: true,
  database: true,
  catalog: true,
  unboundedPage: true,
  sshTunnel: true,
  hostFiles: true,
  testCautions: true,
});

/** Each engine's credential warnings, read by id as text: the generated table holds a row only for an engine with one. */
const CREDENTIAL_WARNINGS: Readonly<Record<string, readonly CredentialWarning[]>> = BUNDLED_CREDENTIAL_WARNINGS;

/** The legacy identity every legacy engine is served under. */
const LEGACY_SOURCE = Object.freeze({
  name: LEGACY_SOURCE_NAME,
  version: LEGACY_SOURCE_VERSION,
  digest: null,
  package: null,
});

/** The members of engine `id`'s form entry the field rule readers read, each only where the entry states it. */
function fieldRulesOf(id: DatabaseType): FieldRuleSpec {
  const { connectionFields, fieldRules, fieldShownWhen, fieldDefaults } = CONNECTION_FORM[id];
  return Object.freeze({
    connectionFields,
    ...(fieldRules === undefined ? {} : { fieldRules }),
    ...(fieldShownWhen === undefined ? {} : { fieldShownWhen }),
    ...(fieldDefaults === undefined ? {} : { fieldDefaults }),
  });
}

/** The record of legacy engine `id`, composed from Studio's committed tables. */
function legacyRecord(id: DatabaseType): EngineRecord {
  return Object.freeze({
    id: id as string as EngineId,
    source: LEGACY_SOURCE,
    catalog: BUNDLED_CATALOG[id],
    connection: Object.freeze({
      fields: BUNDLED_CONNECTION_FIELDS[id],
      seedOnly: BUNDLED_SEED_ONLY[id],
      refused: BUNDLED_REFUSED_FIELDS[id],
      credentialWarnings: CREDENTIAL_WARNINGS[id] ?? Object.freeze([]),
      tlsModes: BUNDLED_CONNECTION_FORMS[id].tls.modes,
      readsTrustMaterial: BUNDLED_READS_TRUST_MATERIAL[id],
      connectionStringAccepted: BUNDLED_CONNECTION_STRING_ACCEPTED[id],
      dialogOffersUri: BUNDLED_DIALOG_OFFERS_URI[id],
    }),
    fieldRules: fieldRulesOf(id),
    grants: legacyEngineGrants(id),
    statementGrammar: sqlGrammarFor(id).grammar,
    // No declared data: no projection carries a legacy declaration's statement language data, and every one states
    // null. The change that writes the first language as data hands its projection's data here and deletes the code
    // row.
    statementLanguageRow: statementLanguageRow(id, null, codeStatementLanguageRow(id)),
    explainReading: "declared",
    offers: LEGACY_OFFERS,
  });
}

/** Every legacy engine's record, keyed by its id in the engine catalog's order, composed once when this module loads. */
export const LEGACY_ENGINES: ReadonlyMap<string, EngineRecord> = new Map(
  (LEGACY_ENGINE_IDS as readonly DatabaseType[]).map((id) => [id, legacyRecord(id)]),
);
