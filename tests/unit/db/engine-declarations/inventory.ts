/**
 * Where the facts of each per-engine table in `src/` go under the provider contract, held complete by
 * `tests/unit/db/engine-table-inventory.test.ts`.
 *
 * A destination starts with one of three words:
 * - `engine declaration:` the facts are in `src/lib/db/engine-declarations/<type-id>.json` today, at the members
 *   named, and `tests/unit/db/engine-declarations.test.ts` reads them back to the table. A claim's table stays, as
 *   Studio's review record that grants the request its member states. A generated projection of the declarations is
 *   one too: its facts are the members named, authored in each declaration, and its own test holds it to them.
 * - `planned segment:` the facts move into a segment of the manifest a later contract minor adds, named in words.
 * - `core-owned:` the facts stay with Studio, for the reason given, and no manifest declares them.
 */

export interface InventoryEntry {
  /** The repository-relative path of the module that declares the table. */
  readonly module: string;
  /** The table's module-level name. */
  readonly name: string;
  readonly destination: string;
}

const CLAIM_GRANTS_MODULE = "src/lib/db/claim-grants.ts";
const COMPATIBILITY = "src/lib/db/compatibility.ts";
const CONNECTION_FIELDS_MODULE = "src/lib/db/connection-fields.ts";
const CONNECTION_MODULE = "src/lib/db/engine-catalog/connection.generated.ts";
const CONNECTION_FLAGS_MODULE = "src/lib/db/engine-catalog/connection-flags.generated.ts";

/** What a claim table is, in every claim table's destination: tests/unit/db/no-core-grant-records.test.ts finds them by it. */
export const REVIEW_RECORD_PHRASE = "Studio's review record of the claim";

/**
 * The destination of a claim table: the member that requests the claim, which the table grants as Studio's record. No
 * claim table is left in the inventory; the guards that find one by this destination plant one with it.
 */
export function claim(member: string): string {
  return `engine declaration: ${member}, the engine's request, which this table grants as ${REVIEW_RECORD_PHRASE}`;
}
/** The destination of a generated connection table: the member it projects, authored in each declaration. */
function projected(member: string): string {
  return `engine declaration: ${member}, authored in each declaration and projected into this generated record, which tests/unit/db/engine-catalog.test.ts holds to them`;
}
/**
 * The destination of a granted table: Studio's grant, computed from the declared request and Studio's record.
 * tests/unit/db/no-core-grant-records.test.ts finds the granted tables by it.
 */
export const GRANTED_DESTINATION =
  "core-owned: Studio's grant of a claim, computed from the engine's request and Studio's grant for the engine (docs/providers/CONTRACT.md, clause M-54)";
const STATEMENT_FAMILY =
  "core-owned: the vocabulary of a statement language family, which core keeps once for every engine that speaks it";

export const ENGINE_TABLE_INVENTORY: readonly InventoryEntry[] = [
  {
    module: "src/lib/agent/languages/engines/server.ts",
    name: "ENGINE_SERVER_FACETS",
    destination:
      "core-owned: a cache of each engine's server facet, derived on first read from its agent language overlay, which holds the facts",
  },
  {
    module: "src/lib/db-showcase.ts",
    name: "SHOWCASE_RANK",
    destination: "core-owned: the order the README shows engines in is Studio's presentation, not a fact of an engine",
  },
  {
    module: "src/lib/db-ui-config.ts",
    name: "DB_UI_CONFIG",
    destination: "planned segment: presentation, the icon as an SVG asset and the colour",
  },
  { module: CLAIM_GRANTS_MODULE, name: "GRANTED_AGENT_READINGS", destination: GRANTED_DESTINATION },
  { module: CLAIM_GRANTS_MODULE, name: "GRANTED_AGENT_STATEMENT_LANGUAGE", destination: GRANTED_DESTINATION },
  { module: CLAIM_GRANTS_MODULE, name: "GRANTED_SSH_TUNNEL_REFUSAL", destination: GRANTED_DESTINATION },
  { module: CLAIM_GRANTS_MODULE, name: "GRANTED_WRITE_REACH", destination: GRANTED_DESTINATION },
  {
    module: COMPATIBILITY,
    name: "READS_TRUST_MATERIAL",
    destination: "engine declaration: connection.readsTrustMaterial",
  },
  {
    module: COMPATIBILITY,
    name: "CONNECTION_FORM_URI_MODE",
    destination: "engine declaration: connection.connectionString.dialogOffersUri",
  },
  {
    module: COMPATIBILITY,
    name: "CONNECTION_STRING_ACCEPTED",
    destination: "engine declaration: connection.connectionString.accepted",
  },

  { module: CONNECTION_FIELDS_MODULE, name: "CONNECTION_FIELDS", destination: "engine declaration: connection.fields" },
  {
    module: CONNECTION_FIELDS_MODULE,
    name: "SEED_ONLY_FIELDS",
    destination: "engine declaration: connection.seedOnly",
  },
  {
    module: CONNECTION_FIELDS_MODULE,
    name: "REFUSED_CONNECTION_FIELDS",
    destination: "engine declaration: connection.refused, each field with its sentence",
  },
  {
    module: "src/lib/db/connection-form.ts",
    name: "CONNECTION_FORM",
    destination:
      "engine declaration: displayName, connection.defaults, connection.tls, connection.dialog, connection.hostUriSchemes, connection.credentialWarnings, connection.fieldRules, connection.hostHint, connection.hostIdentity and connection.import, authored in each declaration and composed from the generated connection forms, each named function bound by Studio's function table",
  },
  {
    module: "src/lib/db/connection-string/index.ts",
    name: "CONNECTION_STRING",
    destination:
      "engine declaration: connection.connectionString, its scheme, urlTls, paste with its reader, catch-all and formats, and seedCheck, authored in each declaration and composed from the generated connection strings, each named function bound by Studio's connection string function table",
  },
  {
    module: "src/lib/db/connection-string/index.ts",
    name: "ENGINE_URI_SCHEMES",
    destination: "engine declaration: connection.connectionString.scheme, from which core derives the map",
  },
  {
    module: "src/lib/db/credential-warnings.ts",
    name: "CREDENTIAL_WARNINGS",
    destination: "engine declaration: connection.credentialWarnings",
  },
  {
    module: "src/lib/db/destructive-commands.ts",
    name: "NON_SQL_DESTRUCTIVE_VOCABULARY",
    destination: STATEMENT_FAMILY,
  },
  {
    module: "src/lib/db/engine-catalog/catalog.generated.ts",
    name: "BUNDLED_CATALOG",
    destination:
      "engine declaration: id, location and connection.connectBudgetMs, authored in each declaration and projected into this generated record, which tests/unit/db/engine-catalog.test.ts holds to them",
  },
  {
    module: "src/lib/db/engine-catalog/claims.generated.ts",
    name: "BUNDLED_CLAIM_REQUESTS",
    destination: projected("policy and mcp"),
  },
  {
    module: CONNECTION_FLAGS_MODULE,
    name: "BUNDLED_CONNECTION_STRING_ACCEPTED",
    destination: projected("connection.connectionString.accepted"),
  },
  {
    module: CONNECTION_FLAGS_MODULE,
    name: "BUNDLED_DIALOG_OFFERS_URI",
    destination: projected("connection.connectionString.dialogOffersUri"),
  },
  {
    module: CONNECTION_FLAGS_MODULE,
    name: "BUNDLED_READS_TRUST_MATERIAL",
    destination: projected("connection.readsTrustMaterial"),
  },
  {
    module: "src/lib/db/engine-catalog/connection-form.generated.ts",
    name: "BUNDLED_CONNECTION_FORMS",
    destination: projected(
      "displayName, connection.defaults, connection.tls, connection.dialog, connection.hostUriSchemes, connection.fieldRules, connection.hostHint, connection.hostIdentity and connection.import",
    ),
  },
  {
    module: "src/lib/db/engine-catalog/connection-string.generated.ts",
    name: "BUNDLED_CONNECTION_STRINGS",
    destination: projected(
      "connection.connectionString.scheme, connection.connectionString.urlTls, connection.connectionString.paste and connection.connectionString.seedCheck",
    ),
  },
  {
    module: CONNECTION_MODULE,
    name: "BUNDLED_CONNECTION_FIELDS",
    destination: projected("connection.fields"),
  },
  {
    module: CONNECTION_MODULE,
    name: "BUNDLED_CREDENTIAL_WARNINGS",
    destination: projected("connection.credentialWarnings"),
  },
  {
    module: CONNECTION_MODULE,
    name: "BUNDLED_REFUSED_FIELDS",
    destination: projected("connection.refused"),
  },
  {
    module: CONNECTION_MODULE,
    name: "BUNDLED_SEED_ONLY",
    destination: projected("connection.seedOnly"),
  },
  {
    module: "src/lib/db/engine-catalog/editor.generated.ts",
    name: "BUNDLED_EXECUTION_UI",
    destination: projected("editor.commitKeyword and editor.consentDeadline"),
  },
  {
    module: "src/lib/db/engine-catalog/migration-ddl.generated.ts",
    name: "BUNDLED_MIGRATION_DDL",
    destination: projected("migrationDdl"),
  },
  {
    module: "src/lib/db/engine-catalog/sql-generators.generated.ts",
    name: "BUNDLED_SQL_GENERATORS",
    destination: projected("sqlGenerators"),
  },
  {
    module: "src/lib/db/engine-catalog/sql-text.generated.ts",
    name: "BUNDLED_SQL_TEXT",
    destination: projected("sqlText.readsSqlText, sqlText.grammar, sqlText.updateTarget and sqlText.completion"),
  },
  {
    module: "src/lib/db/engine-catalog/sql-writing.generated.ts",
    name: "BUNDLED_SQL_WRITING",
    destination: projected("sqlWriting"),
  },
  {
    module: "src/lib/db/engine-facets/index.ts",
    name: "ENGINE_FACETS",
    destination:
      "engine declaration: facets.monitoring and facets.maintenance, authored in each declaration, and each provider's row held equal to them by tests/unit/db/engine-facets/census.test.ts",
  },
  {
    module: "src/lib/db/execution-ui/index.ts",
    name: "EXECUTION_UI",
    destination:
      "engine declaration: editor.commitKeyword and editor.consentDeadline, authored in each declaration and read from the generated execution UI record",
  },
  { module: "src/lib/db/graph-policy-profiles.ts", name: "GRAPH_POLICY_PROFILES", destination: STATEMENT_FAMILY },
  {
    module: "src/lib/db/migration-ddl/index.ts",
    name: "MIGRATION_DDL",
    destination:
      "engine declaration: migrationDdl, authored in each declaration and composed with Studio's migration DDL function table",
  },
  {
    module: "src/lib/db/query-generators/index.ts",
    name: "SQL_ENGINE_GENERATORS",
    destination:
      "engine declaration: sqlGenerators, authored in each declaration and composed with Studio's SQL generator function table",
  },
  {
    module: "src/lib/db/sql-grammar/index.ts",
    name: "SQL_GRAMMAR",
    destination:
      "engine declaration: sqlText.readsSqlText, sqlText.grammar, sqlText.updateTarget and sqlText.completion, authored in each declaration and composed with Studio's grammar function table",
  },
  {
    module: "src/lib/db/sql-writing/index.ts",
    name: "SQL_WRITING",
    destination:
      "engine declaration: sqlWriting, authored in each declaration and composed with Studio's SQL writing function table",
  },
  {
    module: "src/lib/seed/samples.ts",
    name: "SAMPLES",
    destination: "core-owned: the sample databases are Studio's own, whichever provider serves them",
  },
  {
    module: "src/lib/sql/read-query-forms.ts",
    name: "READ_QUERY_FORMS",
    destination:
      "planned segment: MCP read forms, the statements an engine runs among those the read fence admits, its paging clause and its row limiting clause",
  },
];
