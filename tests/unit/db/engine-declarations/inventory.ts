/**
 * Where the facts of each per-engine table in `src/` go under the provider contract, held complete by
 * `tests/unit/db/engine-table-inventory.test.ts`.
 *
 * A destination starts with one of three words:
 * - `engine declaration:` the facts are in `src/lib/db/engine-declarations/<type-id>.json` today, at the members
 *   named, and `tests/unit/db/engine-declarations.test.ts` reads them back to the table.
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

const COMPATIBILITY = "src/lib/db/compatibility.ts";
const CONNECTION_FIELDS_MODULE = "src/lib/db/connection-fields.ts";

const POLICY_CLAIM =
  "planned segment: policy claims, each a request a provider makes that only core's review record grants";
const MCP_CLAIM = "planned segment: MCP claims, each a request a provider makes that only core's review record grants";
const STATEMENT_FAMILY =
  "core-owned: the vocabulary of a statement language family, which core keeps once for every engine that speaks it";

export const ENGINE_TABLE_INVENTORY: readonly InventoryEntry[] = [
  {
    module: "src/lib/agent/agent-manifest.ts",
    name: "AGENT_STATEMENT_LANGUAGE",
    destination: "engine declaration: agent.statementLanguage",
  },
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
  {
    module: COMPATIBILITY,
    name: "SHIPPED",
    destination: "engine declaration: id, one declaration per shipped type-id",
  },
  { module: COMPATIBILITY, name: "EXTERNAL", destination: "engine declaration: location" },
  { module: COMPATIBILITY, name: "WRITE_REACH", destination: POLICY_CLAIM },
  { module: COMPATIBILITY, name: "READS_FILE_ACCESS_POSTURE", destination: POLICY_CLAIM },
  { module: COMPATIBILITY, name: "READS_TRUST_MATERIAL", destination: POLICY_CLAIM },
  { module: COMPATIBILITY, name: "REFUSES_DENIED_FILE_ACCESS", destination: POLICY_CLAIM },
  { module: COMPATIBILITY, name: "SINGLE_WRITER_FILE", destination: POLICY_CLAIM },
  { module: COMPATIBILITY, name: "MCP_EXPOSABLE", destination: MCP_CLAIM },
  { module: COMPATIBILITY, name: "MCP_STATEMENT_READ", destination: MCP_CLAIM },
  { module: COMPATIBILITY, name: "MCP_METADATA_READ_CHANGES_STATE", destination: MCP_CLAIM },
  { module: COMPATIBILITY, name: "MCP_AGENT_CREDENTIAL_REQUIRED", destination: MCP_CLAIM },
  { module: COMPATIBILITY, name: "READ_ROOTS_REQUIRED", destination: MCP_CLAIM },
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
  { module: COMPATIBILITY, name: "OPENS_LOCAL_FILE", destination: "engine declaration: connection.opensLocalFile" },
  { module: COMPATIBILITY, name: "HOST_PATH_FIELDS", destination: "engine declaration: connection.hostPathFields" },
  { module: COMPATIBILITY, name: "SSH_TUNNEL_REFUSAL", destination: "engine declaration: connection.sshTunnel" },
  {
    module: COMPATIBILITY,
    name: "OPENS_SERVER_LEVEL_WITHOUT_DATABASE",
    destination: "engine declaration: connection.serverLevelWithoutDatabase",
  },
  {
    module: CONNECTION_FIELDS_MODULE,
    name: "CONNECTION_FIELD_ROWS",
    destination: "engine declaration: connection.fields, the rows CONNECTION_FIELDS freezes",
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
    module: CONNECTION_FIELDS_MODULE,
    name: "SEED_AGENT_CREDENTIAL",
    destination: "engine declaration: connection.agentCredential",
  },
  {
    module: "src/lib/db/connect-budget.ts",
    name: "CONNECT_BUDGET",
    destination: "engine declaration: connection.connectBudgetMs",
  },
  {
    module: "src/lib/db/connection-form.ts",
    name: "CONNECTION_FORM",
    destination:
      "engine declaration: displayName, connection.defaults, connection.tls, connection.dialog, connection.hostUriSchemes, connection.credentialWarnings, connection.fieldRules, connection.hostHint, connection.hostIdentity and connection.import, each function named by the slot it fills",
  },
  {
    module: "src/lib/db/connection-string/index.ts",
    name: "CONNECTION_STRING",
    destination:
      "engine declaration: connection.connectionString, its scheme, urlTls, paste with its reader, catch-all and formats, and seedCheck, each function named by the slot it fills",
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
  { module: "src/lib/db/engine-facets/index.ts", name: "ENGINE_FACETS", destination: "engine declaration: facets" },
  {
    module: "src/lib/db/execution-ui/index.ts",
    name: "EXECUTION_UI",
    destination: "engine declaration: editor.commitKeyword and editor.consentDeadline",
  },
  { module: "src/lib/db/graph-policy-profiles.ts", name: "GRAPH_POLICY_PROFILES", destination: STATEMENT_FAMILY },
  {
    module: "src/lib/db/migration-ddl/index.ts",
    name: "MIGRATION_DDL",
    destination:
      "engine declaration: migrationDdl, its table DDL refused with its refusal line or written with its transaction wrapper and CREATE TABLE form, its reasons, each function named by the slot it fills",
  },
  {
    module: "src/lib/db/query-generators/index.ts",
    name: "SQL_ENGINE_GENERATORS",
    destination: "engine declaration: sqlGenerators, its count expression, each form named by the slot it fills",
  },
  {
    module: "src/lib/db/sql-grammar/index.ts",
    name: "SQL_GRAMMAR",
    destination:
      "engine declaration: sqlText, its grammar with each trailing limit clause by its source and flags, redaction, updateTarget and completion, each function named by the slot it fills",
  },
  {
    module: "src/lib/db/sql-writing/index.ts",
    name: "SQL_WRITING",
    destination:
      "engine declaration: sqlWriting, its inline edit type names, its export facts and type vocabulary with each pattern by its source and flags, each function named by the slot it fills",
  },
  {
    module: "src/lib/seed/samples.ts",
    name: "SAMPLES",
    destination: "core-owned: the sample databases are Studio's own, whichever provider serves them",
  },
  {
    module: "src/lib/sql/fence-tags.ts",
    name: "ENGINE_FENCE_TAGS",
    destination:
      "engine declaration: id, every engine's id a fence tag naming it, with editor.fenceAliases naming its other tags",
  },
];
