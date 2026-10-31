/**
 * The language boundary of the agent core (issue #1821, PR 1): the core names no statement language a pack owns, and
 * the packs load in tiers that cannot form an import cycle.
 *
 * R1, R2, R5, R8 and R9 hold every `.ts` and `.tsx` file under `src/lib/agent/` except `src/lib/agent/languages/**`,
 * and every one under `src/lib/mcp/`, which reads a language's MCP facet through the shared registry and never a pack.
 * The pack ids R1 looks for are the keys of `AGENT_LANGUAGE_COPY` other than `sql`, whose rules are R5's, so a fourth
 * pack is covered the day it lands. Only AST nodes are visited, so a comment never counts, and the specifier of an
 * import or export is never a literal any rule reads.
 *
 * - R1a: a string literal, no-substitution template or literal type whose whole text is a pack id.
 * - R1b: a property named by a pack id: an assignment, a shorthand, a signature, a `.x` access or an `["x"]` access.
 * - R1c: any other identifier that contains a pack id, in any case, except an engine's own name (`mongodb` as a key of
 *   `AGENT_STATEMENT_LANGUAGE`): engine names are the `DatabaseType` rule's, which is PR 3's.
 * - R1d: a string or template part that names a MongoDB plan stage (`COLLSCAN`, `IXSCAN`).
 * - R1e: a string literal or literal type that starts with a pack id and a separator, or ends in `-<id>.<n>`: an
 *   operation id, a verifier id or a fingerprint prefix.
 * - R1g: a string literal, no-substitution template or literal type whose whole text is another name a pack owns: an
 *   evidence tool (`AGENT_EVIDENCE_TOOLS`), or a reading refusal code, a verdict shortfall or a workflow variant
 *   requirement a pack declares in its client facet. The core reads each through the registry that merges the packs'
 *   rows, so a language that brings its own adds them to its pack and edits no core file.
 * - R1f: under `src/lib/mcp/` only, a string literal or literal type whose whole text is a tool a language's MCP facet
 *   declares, `sql`'s too: the tool is the language's, so MCP reads it off an arm or the facet registry. The agent's
 *   own tools are its tool registry's, not a facet's, so the agent core is not held to it.
 * - R2: an import of a module under `languages/` other than the shared entries: `pack.ts`, `client.ts`, `server.ts`,
 *   `index.ts`, `verifiers.ts`, `refusals.ts`, `mcp.ts` and `engines/{client,server,index}.ts`, matched by full path.
 * - R5a: a string literal, no-substitution template or literal type whose whole text is `sql`, unless R5b reads it.
 * - R5b: `sql` read off a language-keyed table: a `.sql` or `["sql"]` access, or a binding-pattern key, whose receiver
 *   is such a table, a namespace member of that name, or a same-file alias of one (a `const`, or an import renamed). The
 *   tables are derived, not listed: every value export of `languages/{client,server,index,mcp}.ts` and
 *   `agent-manifest.ts` whose own keys are exactly the pack ids. A statement text's `.sql` field is never one.
 * - R5c: a reference to `DEFAULT_STATEMENT_LANGUAGE` or `CURATED_CALL_LANGUAGE`, so neither constant becomes a hidden
 *   `sql` branch.
 * - R5e: a string literal or literal type that starts with `sql` and a `.`, `:` or `-`: an operation, requirement or
 *   verifier id.
 * - R8a: a string literal or literal type whose whole text is an engine id, a key of `AGENT_STATEMENT_LANGUAGE`.
 * - R8b: a property named by an engine id, except the keys of `AGENT_STATEMENT_LANGUAGE` itself.
 * - R8c: any other identifier with a whole segment, or a run of adjacent segments, (split at `_` and at case changes,
 *   then lowercased) that is an engine id: `postgresThing` and `duckDbPlan` are, `redistribute` is not. An import or export specifier is no reference, as for
 *   R5c, so an imported name is read where the file uses it.
 * - R8d: a string literal or literal type that is an `ExplainFormat` id, or starts with an engine id and a `-`
 *   (`"postgres-json"`), and any identifier with a whole segment that is an engine's alias rather than its id (`PG_`):
 *   a plan format names its engine, so the core asks the format's explain strategy instead of matching the id.
 * - R9: a read of a server member an engine overlay may override (`ENGINE_OVERRIDABLE_SERVER_MEMBERS`) through a
 *   family resolver, so an engine's override is never bypassed: the receiver chain starts at a call to
 *   `agentLanguagePack`, `languageServerPack` or `languageServer`, under any import name or off a namespace, or at a
 *   name bound to such a chain, by a declarator or a binding pattern.
 *   An import of `WORKFLOW_TOOL_RULES`, a family projection of one, or a namespace member of that name, is R9 too.
 * - R3: the tiers, each finding the first forbidden module a chain meets, not every module past it. The server modules never reach the execution tier; the client packs never reach a server module, an
 *   execution module or a `node:`/`bun:` builtin; the language verifiers and `goal-claims.ts` never reach
 *   `goal-verifier.ts`; `goal-verifier.ts`, `goal-claims.ts` and every verifier module never reach `tools.ts` or a
 *   server, adapter or definitions module; the MCP facets, `languages/mcp.ts` and each pack's `mcp.ts`, never reach the
 *   execution tier or a module under `src/lib/mcp/`, which reads them; and no runtime cycle among the agent modules passes through `languages/` or
 *   a shared module. A dynamic `import("x")` or `require("x")` with a literal specifier counts as an import, for R2
 *   and R3 alike.
 * - R6: every `*_SERVER_OVERLAY` and `*_CLIENT_OVERLAY` an engine module under `languages/<family>/engines/` declares,
 *   exported or not, is declared `satisfies` its overlay type, `AgentEngineServerOverlay<...>`,
 *   `AgentEngineClientOverlay<...>` or `{ dialect: ClientDialectOf<...> }`, so the excess-property check holds every
 *   overlay to its family's dialect; an export list gives an overlay's name to nothing but such a declaration of the
 *   same file, whatever its local name, so a re-export from another module fails; no engine module writes `export *`;
 *   and no binding pattern binds an overlay's name.
 * - R7: no core file declares a name of a dialect table the engine overlays absorbed (`CATALOG_PLANS` and the rest of
 *   `ABSORBED`), at any depth, in a destructuring pattern too, and with no allowlist, so a table cannot come back
 *   beside the overlay that replaced it.
 * - R4: the allowlist is exact. A key found more often than it is listed fails, and so does a listed key found less
 *   often, so the list can only shrink.
 *
 * A finding is `${file}#${innermost named declaration}: ${rule} ${text}`, where the declaration is the innermost
 * function, method, class, variable, type alias or interface around the node, or `<module>` at the top level. Every
 * rule is proven both ways: the real sources pass, and a violation planted in a copy of a real file's text yields
 * exactly the findings it should.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import * as manifest from "@/lib/agent/agent-manifest";
import { AGENT_LANGUAGE_COPY, AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import * as languages from "@/lib/agent/languages";
import * as languageClients from "@/lib/agent/languages/client";
import * as languageMcpFacets from "@/lib/agent/languages/mcp";
import { ENGINE_OVERRIDABLE_SERVER_MEMBERS } from "@/lib/agent/languages/overlay";
import * as languageServers from "@/lib/agent/languages/server";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const AGENT = "src/lib/agent";
const LANGUAGES = `${AGENT}/languages`;
/** The MCP module, held to the same boundary as the agent core: it reads each language through the shared registry. */
const MCP = "src/lib/mcp";

const PACK_IDS = Object.keys(AGENT_LANGUAGE_COPY).filter((id) => id !== "sql");
const IDS = PACK_IDS.join("|");
const WHOLE_ID = new RegExp(`^(${IDS})$`);
const ANY_ID = new RegExp(IDS, "i");
/** The engine names, the keys of the one total `DatabaseType` map. */
const ENGINE_IDS = new Set(Object.keys(AGENT_STATEMENT_LANGUAGE));
const PLAN_STAGE = /COLLSCAN|IXSCAN/;
/** A literal that starts with an engine id and a `-`: a format, mode or variant id that names its engine (R8d). */
const ENGINE_PREFIXED = new RegExp(`^(${[...ENGINE_IDS].join("|")})-`);
/** The segments that name an engine without being its id, as `PG_INDEX_NODE` names PostgreSQL (R8d). */
const ENGINE_ALIASES: ReadonlySet<string> = new Set(["pg"]);
const COMPOUND_ID = [new RegExp(`^(${IDS})[.:-]`), new RegExp(`-(${IDS})\\.\\d+$`)];
/** The tools the languages' MCP facets declare: each is a language's, so a core file reads it off the registry. */
const FACET_TOOLS: ReadonlySet<string> = new Set(
  Object.values(languageMcpFacets.AGENT_LANGUAGE_MCP_FACETS).flatMap((facet) => (facet === null ? [] : [facet.tool])),
);

/** The names a pack owns beside its id (R1g): its evidence tools, refusal codes, shortfalls and requirements. */
const PACK_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(languages.AGENT_EVIDENCE_TOOLS),
  ...Object.keys(languageClients.AGENT_PACK_READING_REFUSAL_HEADLINES),
  ...Object.keys(languageClients.AGENT_PACK_SHORTFALL_SENTENCES),
  ...Object.keys(languageClients.AGENT_PACK_REQUIREMENTS),
]);

/** The id R1 leaves out: the default family's, whose literals and table reads are R5's. */
const SQL = "sql";
const SQL_COMPOUND = /^sql[.:-]/;
/** The two named readings of the default family (R5c). */
const DEFAULT_LANGUAGE_CONSTANTS = new Set(["DEFAULT_STATEMENT_LANGUAGE", "CURATED_CALL_LANGUAGE"]);

/** Every value export of the shared language entries and the manifest whose own keys are exactly the pack ids. */
const LANGUAGE_TABLES: ReadonlySet<string> = new Set(
  [languageClients, languageServers, languages, languageMcpFacets, manifest].flatMap((module) =>
    Object.entries(module)
      .filter(
        ([, value]) =>
          typeof value === "object" &&
          value !== null &&
          Object.keys(value).sort().join() === Object.keys(AGENT_LANGUAGE_COPY).sort().join(),
      )
      .map(([name]) => name),
  ),
);

/** The server members an engine overlay may override; every other member is read by family. */
const OVERRIDABLE_SERVER_MEMBERS = new Set<string>(ENGINE_OVERRIDABLE_SERVER_MEMBERS);
/** The resolvers that answer a family's pack, blind to the engine's overlay. */
const FAMILY_RESOLVERS = new Set(["agentLanguagePack", "languageServerPack", "languageServer"]);
const MANIFEST = `${AGENT}/agent-manifest.ts`;

/** The shared entries of `languages/` the core may import; every other module there belongs to one pack. */
const SHARED_ENTRIES = new Set(
  [
    "pack.ts",
    "client.ts",
    "server.ts",
    "index.ts",
    "verifiers.ts",
    "refusals.ts",
    "mcp.ts",
    "engines/client.ts",
    "engines/server.ts",
    "engines/index.ts",
  ].map((name) => `${LANGUAGES}/${name}`),
);

/**
 * The findings the core keeps on purpose, each an exact count. None is a pack id read as a branch or an engine branch:
 * - the spec's own map: the id union `AGENT_STATEMENT_LANGUAGE` maps onto, and that total map itself;
 * - `sql` as the name of the model's argument, and as a `ProviderCapabilities.queryLanguage` value;
 * - the reference variant record and the ledger's "the default language is not written" rule (R5c
 *   `DEFAULT_STATEMENT_LANGUAGE`), and a curated call, which is no statement in any language (R5c
 *   `CURATED_CALL_LANGUAGE`);
 * - persisted ids: the `sql-catalog` and `sql-composers` requirements, whose engines are derived from the overlays,
 *   and the operation ids of the SQL arm runtime, which stays in the core. The one in `describePriorProgress` is
 *   temporary: it marks B127, and the B127 fix removes it;
 * - the execution gate, which the spec keeps in `AGENT_EXECUTION_ENGINES`;
 * - `postgres` as the `@workflow` durable world, which is no `DatabaseType`;
 * - `libredb` as the MCP server's name in each client's configuration snippet, and as the first word of the MCP server's
 *   name, its token type and its VS Code input id, each of which names the product, not the engine.
 *
 * The operation and verifier ids a family owns are its rows in `AgentFamilyOperationIds` and `AgentFamilyVerifierIds`
 * in `languages/pack.ts`.
 */
const ALLOWLIST: Readonly<Record<string, number>> = Object.freeze({
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "kubectl"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "mongo"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "libredbkv"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "influxql"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "weaviateapi"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "qdrantapi"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "cypher"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "milvusrpc"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "rediscli"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "etcdctl"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "oxiacli"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "rabbitread"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "kafkaread"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "s3api"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "fsquery"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "snmpget"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R5a "sql"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "mongo"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "kubectl"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "libredbkv"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "influxql"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "weaviateapi"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "qdrantapi"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "cypher"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "milvusrpc"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "rediscli"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "etcdctl"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "oxiacli"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "rabbitread"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "kafkaread"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "s3api"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "fsquery"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "snmpget"`]: 1,
  // The provider capability `queryLanguage`, whose value "influxql" names the editor's language and is spelled as the
  // pack id; the inventory reads it to write an InfluxQL measurement as "db".."m", the spelling the server reads.
  [`${AGENT}/context-snapshot.ts#qualifiedName: R1a "influxql"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R5a "sql"`]: 15,
  [`${AGENT}/agent-manifest.ts#AgentStatementArgument: R5a "sql"`]: 1,
  [`${AGENT}/tools.ts#argument: R5a "sql"`]: 1,
  [`${AGENT}/investigation.ts#planningStatementContract: R5a "sql"`]: 2,
  [`${AGENT}/plan-statement.ts#validatePlanStatement: R5a "sql"`]: 1,
  [`${AGENT}/agent-manifest.ts#inherited: R5c DEFAULT_STATEMENT_LANGUAGE`]: 1,
  [`${AGENT}/agent-manifest.ts#planObjectiveOf: R5c DEFAULT_STATEMENT_LANGUAGE`]: 1,
  [`${AGENT}/agent-manifest.ts#sqlVerifier: R5c DEFAULT_STATEMENT_LANGUAGE`]: 1,
  [`${AGENT}/agent-manifest.ts#persistedRunFacts: R5c DEFAULT_STATEMENT_LANGUAGE`]: 1,
  [`${AGENT}/workflow-classifier.ts#lines: R5c DEFAULT_STATEMENT_LANGUAGE`]: 1,
  [`${AGENT}/workflow-classifier.ts#isWorkflowType: R5c DEFAULT_STATEMENT_LANGUAGE`]: 1,
  [`${AGENT}/tools.ts#fingerprint: R5c CURATED_CALL_LANGUAGE`]: 1,
  [`${AGENT}/tools.ts#advice: R5c CURATED_CALL_LANGUAGE`]: 1,
  [`${AGENT}/tools.ts#runAuditedAgentCall: R5c CURATED_CALL_LANGUAGE`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentVariantRequirement: R5e "sql-catalog"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_REQUIREMENT_ENGINES: R5e "sql-catalog"`]: 1,
  [`${AGENT}/agent-manifest.ts#REQUIREMENT_SENTENCES: R5e "sql-catalog"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentVariantRequirement: R5e "sql-composers"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_REQUIREMENT_ENGINES: R5e "sql-composers"`]: 1,
  [`${AGENT}/agent-manifest.ts#REQUIREMENT_SENTENCES: R5e "sql-composers"`]: 1,
  [`${AGENT}/tools.ts#readStatementForGrounding: R5e "sql.query.read"`]: 1,
  [`${AGENT}/tools.ts#request: R5e "sql.query.read"`]: 1,
  [`${AGENT}/tools.ts#inspectPlanTool: R5e "sql.explain.estimate"`]: 1,
  [`${AGENT}/tools.ts#outcome: R5e "sql.table.profile"`]: 1,
  [`${AGENT}/tools.ts#profileTableTool: R5e "sql.table.profile"`]: 2,
  [`${AGENT}/investigation.ts#describePriorProgress: R5e "sql.table.profile"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "postgres"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "sqlite"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "duckdb"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "mssql"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "mysql"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "kubernetes"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "mongodb"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "clickhouse"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "libsql"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "influxdb3"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "elasticsearch"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "opensearch"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "oracle"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "db2"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "cassandra"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "couchbase"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "druid"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "libredb"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "influxdb"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "weaviate"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "qdrant"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "neo4j"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "milvus"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "redis"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "etcd"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "oxia"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "rabbitmq"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "kafka"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "s3"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "firestore"`]: 1,
  [`${AGENT}/engine-support.ts#AGENT_EXECUTION_ENGINES: R8a "snmp"`]: 1,
  [`${AGENT}/config.ts#AgentDurableBackend: R8a "postgres"`]: 1,
  [`${AGENT}/config.ts#SANCTIONED_WORLD_TARGETS: R8a "postgres"`]: 1,
  [`${AGENT}/config.ts#resolveAgentAvailability: R8a "postgres"`]: 1,
  [`${MCP}/client-config.ts#mcpClientConfigs: R8b libredb`]: 5,
  [`${MCP}/client-config.ts#MCP_VSCODE_INPUT_ID: R8d "libredb-mcp-token"`]: 1,
  [`${MCP}/server.ts#MCP_SERVER_NAME: R8d "libredb-studio-mcp"`]: 1,
  [`${MCP}/token.ts#MCP_TOKEN_TYPE: R8d "libredb-mcp+jwt"`]: 1,
});

/** Declarations too wide to key an allowlist entry on: one entry would excuse a whole run loop or file. */
const TOO_WIDE = new Set(["runInvestigation", "<module>"]);

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");
const ROOT_PATH = canonical(ROOT);

let compilerOptions: ts.CompilerOptions | undefined;

/** A repository file a specifier names, as TypeScript resolves it, or `package:<name>` for anything else. */
function resolve(specifier: string, file: string): string {
  if (compilerOptions === undefined) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
    compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
  }
  const resolution = ts.resolveModuleName(specifier, join(ROOT, file), compilerOptions, ts.sys).resolvedModule;
  if (resolution !== undefined && resolution.isExternalLibraryImport !== true) {
    return canonical(resolution.resolvedFileName).slice(ROOT_PATH.length + 1);
  }
  return `package:${specifier}`;
}

const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : undefined);

/** Every `import("x")` and `require("x")` with a literal specifier, anywhere in the file, as written. */
function dynamicSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every static `import` and `export ... from` specifier, type-only ones included, and every dynamic one, as written. */
function importSpecifiers(source: ts.SourceFile): string[] {
  const found = dynamicSpecifiers(source);
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      found.push(statement.moduleSpecifier.text);
    }
  }
  return found;
}

/** The specifiers a file loads at run time: value imports, value re-exports, side-effect imports and dynamic loads. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const found = dynamicSpecifiers(source);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (!onlyTypes) found.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      found.push(statement.moduleSpecifier.text);
    }
  }
  return found;
}

function sourcesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = `${directory}/${entry}`;
    if (statSync(join(ROOT, path)).isDirectory()) files.push(...sourcesUnder(path));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}

type Planted = Readonly<Record<string, string>>;
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const textOf = (file: string, planted: Planted): string => planted[file] ?? read(file);

/** The `ExplainFormat` ids, read off the union in `src/lib/db/types.ts`, so a format added there is held the day it lands (R8d). */
const EXPLAIN_FORMATS: ReadonlySet<string> = (() => {
  const formats = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "ExplainFormat" && ts.isUnionTypeNode(node.type)) {
      for (const member of node.type.types) {
        if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) formats.add(member.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse("src/lib/db/types.ts", read("src/lib/db/types.ts")));
  return formats;
})();

/** The name of the innermost function, method, class, variable, type alias or interface around `node`. */
function declarationOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isClassDeclaration(at) ||
        ts.isVariableDeclaration(at) ||
        ts.isTypeAliasDeclaration(at) ||
        ts.isInterfaceDeclaration(at)) &&
      at.name !== undefined &&
      (ts.isIdentifier(at.name) || ts.isStringLiteral(at.name))
    ) {
      return at.name.text;
    }
  }
  return "<module>";
}

/** True when `node` is the name of a property: an assignment, a shorthand, a signature, or a `.x` / `["x"]` access. */
function isPropertyName(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent)) &&
      parent.name === node) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
  );
}

/** `expression` without the parentheses, assertions and non-null marks around it. */
function unwrap(expression: ts.Expression): ts.Expression {
  let at = expression;
  while (
    ts.isParenthesizedExpression(at) ||
    ts.isAsExpression(at) ||
    ts.isSatisfiesExpression(at) ||
    ts.isNonNullExpression(at)
  ) {
    at = at.expression;
  }
  return at;
}

/** The words of an identifier, split at `_` and at case changes and lowercased: `tallyPostgres` is `tally`, `postgres`. */
const segmentsOf = (name: string): string[] =>
  name
    .split("_")
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map((segment) => segment.toLowerCase());

/**
 * True when a run of adjacent segments of `name` is an engine id: `postgresThing` holds `postgres` as one segment, and
 * `duckDbPlan` holds `duckdb` across two, because an id is spelled in camel case across its own words too.
 */
const namesEngine = (name: string): boolean => {
  const segments = segmentsOf(name);
  return segments.some((_, start) =>
    segments.slice(start).some((_, length) => ENGINE_IDS.has(segments.slice(start, start + length + 1).join(""))),
  );
};

/** The key a binding element reads: `sql` in `{ sql }` and in `{ sql: x }`. */
function bindingKey(element: ts.BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
}

/** The declaration whose initializer a binding element destructures, through any nesting of patterns. */
function destructured(element: ts.BindingElement): ts.VariableDeclaration | undefined {
  let at: ts.Node = element.parent.parent;
  while (ts.isBindingElement(at)) at = at.parent.parent;
  return ts.isVariableDeclaration(at) ? at : undefined;
}

/** True when an import or export specifier names `node`, which then is no reference. */
const isSpecifierName = (node: ts.Node): boolean =>
  ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent);

/** R1, R2, R5, R8 and R9 over one core file: every finding, once per occurrence. */
function coreFileFindings(file: string, text: string, exemptEngineMap = true): string[] {
  const inMcp = file.startsWith(`${MCP}/`);
  const source = parse(file, text);
  const findings: string[] = [];
  const add = (node: ts.Node, rule: string, detail: string): void => {
    findings.push(`${file}#${declarationOf(node)}: ${rule} ${detail}`);
  };
  // The file's names for a language-keyed table (R5b) and for a family resolver's answer (R9), in source order.
  const tables = new Set(LANGUAGE_TABLES);
  const resolved = new Set<string>();
  // The file's names for a family resolver: its own, and any import that renames one.
  const resolvers = new Set(FAMILY_RESOLVERS);
  const isTable = (expression: ts.Expression): boolean => {
    const at = unwrap(expression);
    return (
      (ts.isIdentifier(at) && tables.has(at.text)) ||
      (ts.isPropertyAccessExpression(at) && LANGUAGE_TABLES.has(at.name.text))
    );
  };
  const isResolved = (expression: ts.Expression): boolean => {
    let at = unwrap(expression);
    while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) at = unwrap(at.expression);
    if (ts.isCallExpression(at)) {
      const callee = unwrap(at.expression);
      return (
        (ts.isIdentifier(callee) && resolvers.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && FAMILY_RESOLVERS.has(callee.name.text))
      );
    }
    return ts.isIdentifier(at) && resolved.has(at.text);
  };
  const bind = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && LANGUAGE_TABLES.has((node.propertyName ?? node.name).text))
      tables.add(node.name.text);
    if (ts.isImportSpecifier(node) && FAMILY_RESOLVERS.has((node.propertyName ?? node.name).text))
      resolvers.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      if (isTable(node.initializer)) tables.add(node.name.text);
      if (isResolved(node.initializer)) resolved.add(node.name.text);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      // `const { server } = agentLanguagePack(x)` names a resolver's answer; a key that is an overridable member is R9.
      const key = bindingKey(node);
      const initializer = destructured(node)?.initializer;
      if (
        key !== undefined &&
        !OVERRIDABLE_SERVER_MEMBERS.has(key) &&
        initializer !== undefined &&
        isResolved(initializer)
      )
        resolved.add(node.name.text);
    }
    ts.forEachChild(node, bind);
  };
  bind(source);
  const isEngineMapKey = (node: ts.Node): boolean =>
    exemptEngineMap &&
    file === MANIFEST &&
    ts.isPropertyAssignment(node.parent) &&
    declarationOf(node) === "AGENT_STATEMENT_LANGUAGE";
  const engineProperty = (node: ts.Node, name: string): void => {
    if (!isEngineMapKey(node)) add(node, "R8b", name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const literal = JSON.stringify(node.text);
      const isSpecifier = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent);
      if (!isSpecifier && WHOLE_ID.test(node.text)) add(node, isPropertyName(node) ? "R1b" : "R1a", literal);
      if (!isSpecifier && COMPOUND_ID.some((pattern) => pattern.test(node.text))) add(node, "R1e", literal);
      if (!isSpecifier && inMcp && FACET_TOOLS.has(node.text)) add(node, "R1f", literal);
      if (!isSpecifier && PACK_NAMES.has(node.text)) add(node, "R1g", literal);
      if (!isSpecifier && node.text === SQL) {
        const parent = node.parent;
        const tableRead =
          ts.isElementAccessExpression(parent) && parent.argumentExpression === node && isTable(parent.expression);
        add(node, tableRead ? "R5b" : "R5a", tableRead ? SQL : literal);
      }
      if (!isSpecifier && SQL_COMPOUND.test(node.text)) add(node, "R5e", literal);
      if (!isSpecifier && ENGINE_IDS.has(node.text)) {
        if (isPropertyName(node)) engineProperty(node, node.text);
        else add(node, "R8a", literal);
      }
      if (!isSpecifier && (EXPLAIN_FORMATS.has(node.text) || ENGINE_PREFIXED.test(node.text)))
        add(node, "R8d", literal);
    }
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      if (PLAN_STAGE.test(node.text)) add(node, "R1d", JSON.stringify(node.text));
    }
    if (ts.isIdentifier(node)) {
      if (WHOLE_ID.test(node.text) && isPropertyName(node)) add(node, "R1b", node.text);
      else if (ANY_ID.test(node.text) && !ENGINE_IDS.has(node.text)) add(node, "R1c", node.text);
      const parent = node.parent;
      if (
        node.text === SQL &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        isTable(parent.expression)
      ) {
        add(node, "R5b", SQL);
      }
      if (DEFAULT_LANGUAGE_CONSTANTS.has(node.text) && !isSpecifierName(node)) add(node, "R5c", node.text);
      if (ENGINE_IDS.has(node.text) && isPropertyName(node)) engineProperty(node, node.text);
      else if (!isSpecifierName(node) && namesEngine(node.text)) add(node, "R8c", node.text);
      if (!isSpecifierName(node) && segmentsOf(node.text).some((segment) => ENGINE_ALIASES.has(segment))) {
        add(node, "R8d", node.text);
      }
      if (
        OVERRIDABLE_SERVER_MEMBERS.has(node.text) &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        isResolved(parent.expression)
      ) {
        add(node, "R9", node.text);
      }
      if (
        node.text === "WORKFLOW_TOOL_RULES" &&
        ((ts.isImportSpecifier(parent) && (parent.propertyName ?? parent.name) === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node))
      ) {
        add(node, "R9", node.text);
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const member = node.argumentExpression.text;
      if (OVERRIDABLE_SERVER_MEMBERS.has(member) && isResolved(node.expression)) add(node, "R9", member);
    }
    if (ts.isBindingElement(node)) {
      const key = bindingKey(node);
      const initializer = destructured(node)?.initializer;
      if (key !== undefined && initializer !== undefined) {
        const direct = ts.isVariableDeclaration(node.parent.parent);
        if (key === SQL && direct && isTable(initializer)) add(node, "R5b", SQL);
        if (OVERRIDABLE_SERVER_MEMBERS.has(key) && isResolved(initializer)) add(node, "R9", key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const specifier of importSpecifiers(source)) {
    const target = resolve(specifier, file);
    if (target.startsWith(`${LANGUAGES}/`) && !SHARED_ENTRIES.has(target)) {
      findings.push(`${file}#<module>: R2 ${target}`);
    }
  }
  return findings;
}

/** The core files: every agent module outside `languages/`. */
const coreFiles = (): string[] => sourcesUnder(AGENT).filter((file) => !file.startsWith(`${LANGUAGES}/`));

/** The files R1, R2, R5, R8 and R9 hold: the core files and every MCP module. */
const boundaryFiles = (): string[] => [...coreFiles(), ...sourcesUnder(MCP)];

/** R1 and R2 checked against the allowlist (R4): every finding it does not excuse, and every stale entry. */
/**
 * Each core file's findings on its text as committed, scanned once. A plant changes one file, so every other file is
 * read from here instead of being parsed again; parsing the whole core per plant is what outran bun's five-second test
 * timeout on CI.
 */
const COMMITTED_FINDINGS = new Map<string, readonly string[]>();

function committedFindings(file: string): readonly string[] {
  const cached = COMMITTED_FINDINGS.get(file);
  if (cached !== undefined) return cached;
  const found = coreFileFindings(file, read(file));
  COMMITTED_FINDINGS.set(file, found);
  return found;
}

function boundaryFindings(planted: Planted = {}): string[] {
  const counts = new Map<string, number>();
  for (const file of boundaryFiles()) {
    const fileFindings = Object.hasOwn(planted, file) ? coreFileFindings(file, planted[file]) : committedFindings(file);
    for (const finding of fileFindings) {
      counts.set(finding, (counts.get(finding) ?? 0) + 1);
    }
  }
  const findings: string[] = [];
  for (const [finding, found] of counts) {
    const allowed = ALLOWLIST[finding] ?? 0;
    if (allowed === 0) for (let n = 0; n < found; n++) findings.push(finding);
    else if (found > allowed) findings.push(`R4 surplus: ${finding} (found ${found}, allowed ${allowed})`);
  }
  for (const [finding, allowed] of Object.entries(ALLOWLIST)) {
    const found = counts.get(finding) ?? 0;
    if (found < allowed) findings.push(`R4 stale: ${finding} (found ${found}, allowed ${allowed})`);
  }
  return findings.sort();
}

/** One file's runtime imports, resolved. */
function edges(file: string, planted: Planted): string[] {
  return runtimeSpecifiers(parse(file, textOf(file, planted))).map((specifier) => resolve(specifier, file));
}

/** What `start` reaches through runtime imports anywhere in the repository, each with the chain that reaches it. */
function reach(start: string, planted: Planted): Map<string, string[]> {
  const chains = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (file.startsWith("package:") || !/\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
    for (const target of edges(file, planted)) {
      if (chains.has(target)) continue;
      chains.set(target, [...(chains.get(file) as string[]), target]);
      queue.push(target);
    }
  }
  return chains;
}

/** An engine's server overlay: every module under a family's `engines/` but its client overlays. */
const isEngineServerModule = (file: string): boolean =>
  new RegExp(`^${LANGUAGES}/[^/]+/engines/(?!client\\.ts$)[^/]+\\.ts$`).test(file);
const SERVER_SIDE = [
  `${AGENT}/tools.ts`,
  `${AGENT}/goal-verifier.ts`,
  `${AGENT}/tool-contracts.ts`,
  `${AGENT}/goal-claims.ts`,
  `${AGENT}/composed-sql.ts`,
  `${AGENT}/table-profile.ts`,
  `${AGENT}/schema-stats.ts`,
  `${AGENT}/context-snapshot.ts`,
  `${LANGUAGES}/server.ts`,
  `${LANGUAGES}/verifiers.ts`,
  `${LANGUAGES}/engines/server.ts`,
];
const isExecution = (file: string): boolean =>
  file === `${LANGUAGES}/index.ts` || new RegExp(`^${LANGUAGES}/[^/]+/(index|tools)\\.ts$`).test(file);
/** What the verifiers never load: the server facet and the tool runtime, so verifying a goal loads no adapter. */
const isServerFacet = (file: string): boolean =>
  file === `${AGENT}/tools.ts` ||
  file === `${LANGUAGES}/server.ts` ||
  file === `${LANGUAGES}/engines/server.ts` ||
  isEngineServerModule(file) ||
  new RegExp(`^${LANGUAGES}/[^/]+/(adapter|server|definitions)\\.ts$`).test(file);
const CLIENT_FORBIDDEN = new Set([
  `${AGENT}/tools.ts`,
  `${AGENT}/investigation.ts`,
  `${AGENT}/goal-verifier.ts`,
  `${AGENT}/composed-sql.ts`,
  `${AGENT}/composed-sql-primitives.ts`,
  `${AGENT}/table-profile.ts`,
  `${AGENT}/schema-stats.ts`,
  `${AGENT}/context-snapshot.ts`,
  `${AGENT}/catalog-rows.ts`,
  `${LANGUAGES}/server.ts`,
  `${LANGUAGES}/index.ts`,
  `${LANGUAGES}/engines/server.ts`,
  `${LANGUAGES}/engines/index.ts`,
]);
const isClientForbidden = (file: string): boolean =>
  CLIENT_FORBIDDEN.has(file) ||
  isEngineServerModule(file) ||
  file.startsWith("package:node:") ||
  file.startsWith("package:bun:");
const SHARED_MODULES = new Set(
  [
    "tool-contracts.ts",
    "goal-claims.ts",
    "workflow-tool-sets.ts",
    "disjoint-merge.ts",
    "composed-sql-primitives.ts",
    "catalog-rows.ts",
  ].map((name) => `${AGENT}/${name}`),
);

/** The MCP facets: the shared registry and each pack's own facet, the language's words that `src/lib/mcp/` reads. */
const isMcpFacet = (file: string): boolean => new RegExp(`^${LANGUAGES}/([^/]+/)?mcp\\.ts$`).test(file);
/** What a facet never loads: the execution tier, and the MCP module that depends on it, never the reverse. */
const isMcpForbidden = (file: string): boolean => isExecution(file) || file.startsWith(`${MCP}/`);

/** The runtime import graph among the agent modules, `languages/**` included. */
function agentGraph(planted: Planted): Map<string, string[]> {
  const files = sourcesUnder(AGENT);
  const inside = new Set(files);
  return new Map(
    files.map((file) => [file, [...new Set(edges(file, planted))].filter((target) => inside.has(target))]),
  );
}

/** The shortest runtime cycle through `start`, or undefined. */
function shortestCycle(graph: Map<string, string[]>, start: string): string[] | undefined {
  const chains = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const target of graph.get(file) ?? []) {
      if (target === start) return chains.get(file) as string[];
      if (chains.has(target)) continue;
      chains.set(target, [...(chains.get(file) as string[]), target]);
      queue.push(target);
    }
  }
  return undefined;
}

/** A cycle written from its smallest module, so the same cycle found from any of its modules reads the same. */
function cycleText(cycle: readonly string[]): string {
  const first = cycle.indexOf([...cycle].sort()[0] as string);
  const rotated = [...cycle.slice(first), ...cycle.slice(0, first)];
  return [...rotated, rotated[0]].join(" -> ");
}

/** R3 over the agent modules. */
function layeringFindings(planted: Planted = {}): string[] {
  const findings = new Set<string>();
  const forbid = (from: string, forbidden: (file: string) => boolean, bullet: string): void => {
    for (const [target, chain] of reach(from, planted)) {
      if (forbidden(target) && !chain.slice(0, -1).some(forbidden))
        findings.add(`R3 ${bullet}: ${from} reaches ${target} through ${chain.join(" -> ")}`);
    }
  };
  const files = sourcesUnder(AGENT);
  for (const file of [...SERVER_SIDE, ...files.filter(isEngineServerModule)]) forbid(file, isExecution, "server");
  for (const file of files.filter((path) => new RegExp(`^${LANGUAGES}/(.+/)?client\\.ts$`).test(path))) {
    forbid(file, isClientForbidden, "client");
  }
  for (const file of [
    ...files.filter((path) => new RegExp(`^${LANGUAGES}/[^/]+/verifiers\\.ts$`).test(path)),
    `${AGENT}/goal-claims.ts`,
  ]) {
    forbid(file, (target) => target === `${AGENT}/goal-verifier.ts`, "verifier");
  }
  for (const file of [
    `${AGENT}/goal-verifier.ts`,
    `${AGENT}/goal-claims.ts`,
    ...files.filter((path) => new RegExp(`^${LANGUAGES}/([^/]+/)?verifiers\\.ts$`).test(path)),
  ]) {
    forbid(file, isServerFacet, "verifier");
  }
  for (const file of files.filter(isMcpFacet)) forbid(file, isMcpForbidden, "mcp");
  const graph = agentGraph(planted);
  for (const file of files.filter((path) => path.startsWith(`${LANGUAGES}/`) || SHARED_MODULES.has(path))) {
    const cycle = shortestCycle(graph, file);
    if (cycle !== undefined) findings.add(`R3 cycle: ${cycleText(cycle)}`);
  }
  return [...findings].sort();
}

/** `text` with `code` inserted at the top of the body of the function `name`. */
function plantInFunction(file: string, name: string, code: string): Planted {
  const text = read(file);
  let at: number | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      at = node.body.getStart() + 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  if (at === undefined) throw new Error(`no function ${name} in ${file}`);
  return { [file]: `${text.slice(0, at)}\n${code}\n${text.slice(at)}` };
}

/** `text` with `member` added to the union of the type alias `name`. */
function plantInTypeAlias(file: string, name: string, member: string): Planted {
  const text = read(file);
  const alias = parse(file, text).statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  if (alias === undefined) throw new Error(`no type ${name} in ${file}`);
  return { [file]: `${text.slice(0, alias.type.end)} | ${member}${text.slice(alias.type.end)}` };
}

const prepend = (file: string, code: string): Planted => ({ [file]: `${code}\n${read(file)}` });

/** The overlay types an engine overlay may be declared `satisfies`, as written. */
const OVERLAY_TYPE = /^(AgentEngine(Server|Client)Overlay<[\s\S]+>|\{\s*dialect: ClientDialectOf<[\s\S]+>;?\s*\})$/;

const OVERLAY_NAME = /_(SERVER|CLIENT)_OVERLAY$/;

/**
 * R6 over every engine module: each overlay declaration, exported or not, that is not declared `satisfies` its overlay
 * type; each name an export list gives an overlay's name whose local is not such a declaration of the same file, a
 * re-export from another module and a rename included; each `export *`; and each overlay name a binding pattern binds.
 */
function overlayShapeFindings(planted: Planted = {}): string[] {
  const findings: string[] = [];
  const modules = sourcesUnder(LANGUAGES).filter((file) => new RegExp(`^${LANGUAGES}/[^/]+/engines/`).test(file));
  for (const file of modules) {
    const source = parse(file, textOf(file, planted));
    const shapedNames = new Set<string>();
    // An unshaped declaration is reported where it is declared, not again where an export list names it.
    const unshapedNames = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        if (!OVERLAY_NAME.test(name)) continue;
        const initializer = declaration.initializer;
        const shaped =
          initializer !== undefined &&
          ts.isSatisfiesExpression(initializer) &&
          OVERLAY_TYPE.test(initializer.type.getText(source));
        if (shaped) shapedNames.add(name);
        else {
          unshapedNames.add(name);
          findings.push(`${file}#${name}: R6`);
        }
      }
    }
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) {
        findings.push(`${file}#<export *>: R6`);
        continue;
      }
      for (const specifier of statement.exportClause.elements) {
        const local = (specifier.propertyName ?? specifier.name).getText(source);
        const exported = specifier.name.getText(source);
        const declaredHere = statement.moduleSpecifier === undefined;
        if (OVERLAY_NAME.test(exported) && !(declaredHere && (shapedNames.has(local) || unshapedNames.has(local)))) {
          findings.push(`${file}#${exported}: R6`);
        }
      }
    }
    const bindings = (node: ts.Node): void => {
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && OVERLAY_NAME.test(node.name.text)) {
        findings.push(`${file}#${node.name.text}: R6`);
      }
      ts.forEachChild(node, bindings);
    };
    bindings(source);
  }
  return findings.sort();
}

/**
 * The module-private dialect tables PR 2 moved onto the engine overlays. `CATALOG_CAPTURE_ENGINES` is not here: posture
 * still declares it under that name, derived from the client dialects.
 */
const ABSORBED = new Set([
  "CATALOG_COMPOSERS",
  "ESTIMATING_EXPLAIN_PREFIX",
  "ESTIMATING_EXPLAIN_SESSION_MODE",
  "ProfileDialect",
  "INCOMPARABLE_TYPE",
  "UNCOUNTABLE_TYPE",
  "ESTIMATE_BUILDERS",
  "CATALOG_PLANS",
  "COMPOSED_KIND_WORDS",
  "normalizeDeclaredSchema",
  "isMissingExtensionCatalogError",
]);

/**
 * R7 over `files`: every variable, function, class, type alias, interface or enum declared under an absorbed name, and
 * every name a destructuring pattern binds. It is a name check: a table renamed past `ABSORBED` is PR 3's
 * `DatabaseType`-literal rule to catch.
 */
function absorbedFindings(files: readonly string[], planted: Planted = {}): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isBindingElement(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        ABSORBED.has(node.name.text)
      ) {
        findings.push(`${file}#${node.name.text}: R7`);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file, textOf(file, planted)));
  }
  return findings.sort();
}

describe("the agent core names no language a pack owns", () => {
  test("the pack ids come from the manifest", () => {
    expect(PACK_IDS).toEqual([
      "kubectl",
      "mongo",
      "libredbkv",
      "influxql",
      "weaviateapi",
      "qdrantapi",
      "cypher",
      "milvusrpc",
      "rediscli",
      "etcdctl",
      "oxiacli",
      "rabbitread",
      "kafkaread",
      "s3api",
      "fsquery",
      "snmpget",
    ]);
  });

  test("the real core sources yield exactly the allowlisted findings", () => {
    expect(boundaryFindings()).toEqual([]);
  });

  test("the scan reads real code: the core holds every allowlisted finding, and the packs hold many more", () => {
    const core = boundaryFiles().flatMap((file) => coreFileFindings(file, read(file)));
    const expanded = Object.entries(ALLOWLIST).flatMap(([finding, count]) => Array<string>(count).fill(finding));
    expect(core.sort()).toEqual(expanded.sort());
    const packs = sourcesUnder(LANGUAGES).flatMap((file) => coreFileFindings(file, read(file)));
    expect(packs.length).toBeGreaterThan(100);
  });

  test("no allowlist entry is keyed on a declaration too wide to excuse one finding", () => {
    const wide = Object.keys(ALLOWLIST).filter((key) =>
      TOO_WIDE.has(key.slice(key.indexOf("#") + 1, key.indexOf(":"))),
    );
    expect(wide).toEqual([]);
  });
});

// A test that walks the import graph of the whole repository (these two and the tier plants below) takes
// about a second alone under coverage and exceeded the default 5 s in a loaded coverage run, so each gets the
// seam guard's 60 s budget.
describe("the language modules load in tiers", () => {
  test("the real sources hold every tier, and no cycle passes through a pack or a shared module", () => {
    expect(layeringFindings()).toEqual([]);
  }, 60_000);

  test("the walk reads real code: the graph holds pack modules, and the execution tier reaches the core", () => {
    const graph = agentGraph({});
    expect([...graph.keys()].some((file) => new RegExp(`^${LANGUAGES}/[^/]+/`).test(file))).toBe(true);
    expect(reach(`${LANGUAGES}/index.ts`, {}).has(`${AGENT}/tools.ts`)).toBe(true);
    expect(reach(`${AGENT}/agent-manifest.ts`, {}).has(`${LANGUAGES}/kubectl/client.ts`)).toBe(true);
    // The pre-existing `tools.ts` <-> `context-snapshot.ts` cycle passes through no pack, so R3 does not report it.
    expect(cycleText(shortestCycle(graph, `${AGENT}/tools.ts`) as string[])).toBe(
      `${AGENT}/context-snapshot.ts -> ${AGENT}/tools.ts -> ${AGENT}/context-snapshot.ts`,
    );
  }, 60_000);
});

describe("every engine overlay is declared satisfies its overlay type", () => {
  test("the real engine modules hold R6, and the scan reads every overlay they export", () => {
    expect(overlayShapeFindings()).toEqual([]);
    const exported = sourcesUnder(LANGUAGES)
      .filter((file) => new RegExp(`^${LANGUAGES}/[^/]+/engines/`).test(file))
      .flatMap((file) => Array.from(read(file).matchAll(/^export const (\w+_(SERVER|CLIENT)_OVERLAY)\b/gm)));
    expect(exported).toHaveLength(62);
  });

  test("an overlay that drops its satisfies fails R6", () => {
    const duckdb = `${LANGUAGES}/sql/engines/duckdb.ts`;
    const text = read(duckdb);
    const planted = { [duckdb]: text.replace(' as const satisfies AgentEngineServerOverlay<"sql">', "") };
    expect(planted[duckdb]).not.toBe(text);
    expect(overlayShapeFindings(planted)).toEqual([`${duckdb}#DUCKDB_SERVER_OVERLAY: R6`]);
  });

  test("an overlay declared satisfies another type fails R6", () => {
    const client = `${LANGUAGES}/mongo/engines/client.ts`;
    const text = read(client);
    const planted = { [client]: text.replace('satisfies AgentEngineClientOverlay<"mongo">', "satisfies object") };
    expect(overlayShapeFindings(planted)).toEqual([`${client}#MONGODB_CLIENT_OVERLAY: R6`]);
  });

  test("an overlay declared without export and exported by name still fails R6", () => {
    const duckdb = `${LANGUAGES}/sql/engines/duckdb.ts`;
    const text = read(duckdb);
    const planted = {
      [duckdb]: `${text
        .replace("export const DUCKDB_SERVER_OVERLAY", "const DUCKDB_SERVER_OVERLAY")
        .replace(' as const satisfies AgentEngineServerOverlay<"sql">', "")}\nexport { DUCKDB_SERVER_OVERLAY };\n`,
    };
    expect(overlayShapeFindings(planted)).toEqual([`${duckdb}#DUCKDB_SERVER_OVERLAY: R6`]);
  });

  test("an overlay name an export list gives to another module's overlay, a rename, or a pattern fails R6", () => {
    const duckdb = `${LANGUAGES}/sql/engines/duckdb.ts`;
    const text = read(duckdb);
    const plant = (code: string): Planted => ({ [duckdb]: `${text}\n${code}\n` });
    expect(overlayShapeFindings(plant("export { POSTGRES_SERVER_OVERLAY as DUCKDB_SERVER_OVERLAY };"))).toEqual([
      `${duckdb}#DUCKDB_SERVER_OVERLAY: R6`,
    ]);
    expect(overlayShapeFindings(plant('export { MYSQL_SERVER_OVERLAY } from "./mysql";'))).toEqual([
      `${duckdb}#MYSQL_SERVER_OVERLAY: R6`,
    ]);
    expect(overlayShapeFindings(plant("const { X_SERVER_OVERLAY } = {};"))).toEqual([`${duckdb}#X_SERVER_OVERLAY: R6`]);
    // A shaped overlay of the same file exported by a second name is still that declaration.
    expect(overlayShapeFindings(plant("export { DUCKDB_SERVER_OVERLAY as COPY_SERVER_OVERLAY };"))).toEqual([]);
  });

  test("an engine module that re-exports everything from another fails R6", () => {
    const duckdb = `${LANGUAGES}/sql/engines/duckdb.ts`;
    const text = read(duckdb);
    expect(overlayShapeFindings({ [duckdb]: `${text}\nexport * from "./mysql";\n` })).toEqual([
      `${duckdb}#<export *>: R6`,
    ]);
    expect(overlayShapeFindings({ [duckdb]: `${text}\nexport * as mysql from "./mysql";\n` })).toEqual([
      `${duckdb}#<export *>: R6`,
    ]);
  });

  test("a name exported as an overlay that is no shaped overlay declaration fails R6", () => {
    const client = `${LANGUAGES}/mongo/engines/client.ts`;
    const planted = { [client]: `${read(client)}\nconst loose = {};\nexport { loose as LOOSE_CLIENT_OVERLAY };\n` };
    expect(overlayShapeFindings(planted)).toEqual([`${client}#LOOSE_CLIENT_OVERLAY: R6`]);
  });
});

describe("no core file declares a dialect table the engine overlays absorbed", () => {
  test("the real core sources hold R7, and the scan reads real declarations: the overlays hold one", () => {
    expect(absorbedFindings(coreFiles())).toEqual([]);
    expect(absorbedFindings(sourcesUnder(LANGUAGES))).toEqual([
      `${LANGUAGES}/sql/engines/postgres.ts#isMissingExtensionCatalogError: R7`,
    ]);
  });

  test("an absorbed table declared again in the core fails R7", () => {
    const posture = `${AGENT}/posture.ts`;
    expect(absorbedFindings(coreFiles(), prepend(posture, "const CATALOG_PLANS = {};"))).toEqual([
      `${posture}#CATALOG_PLANS: R7`,
    ]);
  });

  test("an absorbed name declared inside a function or as a type fails R7 too", () => {
    const tools = `${AGENT}/tools.ts`;
    const nested = plantInFunction(tools, "agentToolDefinition", "function normalizeDeclaredSchema() {}");
    expect(absorbedFindings(coreFiles(), nested)).toEqual([`${tools}#normalizeDeclaredSchema: R7`]);
    const alias = prepend(tools, 'type ProfileDialect = "x";');
    expect(absorbedFindings(coreFiles(), alias)).toEqual([`${tools}#ProfileDialect: R7`]);
  });

  test("an absorbed name bound by a destructuring pattern fails R7 too", () => {
    const posture = `${AGENT}/posture.ts`;
    const planted = prepend(
      posture,
      "const { CATALOG_PLANS, x: [ESTIMATE_BUILDERS] } = { CATALOG_PLANS: {}, x: [{}] };",
    );
    expect(absorbedFindings(coreFiles(), planted)).toEqual([
      `${posture}#CATALOG_PLANS: R7`,
      `${posture}#ESTIMATE_BUILDERS: R7`,
    ]);
  });
});

describe("planted violations yield exactly their findings", () => {
  const TOOLS = `${AGENT}/tools.ts`;
  const INVESTIGATION = `${AGENT}/investigation.ts`;
  const GOAL_VERIFIER = `${AGENT}/goal-verifier.ts`;

  test("a pack id compared as a string fails R1a", () => {
    expect(boundaryFindings(plantInFunction(TOOLS, "agentToolDefinition", 'if (language === "mongo") {}'))).toEqual([
      `${TOOLS}#agentToolDefinition: R1a "mongo"`,
    ]);
  });

  test("a pack id as a property name fails R1b", () => {
    expect(boundaryFindings(plantInFunction(INVESTIGATION, "workflowToolRules", "const x = { kubectl: 1 };"))).toEqual([
      `${INVESTIGATION}#x: R1b kubectl`,
    ]);
  });

  test("a pack's tool imported by a named binding fails R1c and R2", () => {
    const planted = prepend(INVESTIGATION, 'import { mongoInspectPlanTool } from "./languages/mongo/tools";');
    expect(boundaryFindings(planted)).toEqual([
      `${INVESTIGATION}#<module>: R1c mongoInspectPlanTool`,
      `${INVESTIGATION}#<module>: R2 ${LANGUAGES}/mongo/tools.ts`,
    ]);
  });

  test("a pack's server module imported under a neutral name fails R2 alone", () => {
    const planted = prepend(INVESTIGATION, 'import * as pack from "./languages/mongo/server";');
    expect(boundaryFindings(planted)).toEqual([`${INVESTIGATION}#<module>: R2 ${LANGUAGES}/mongo/server.ts`]);
  });

  test("a pack module loaded by a dynamic import or a require fails R2", () => {
    const dynamic = plantInFunction(INVESTIGATION, "workflowToolRules", 'void import("./languages/mongo/tools");');
    expect(boundaryFindings(dynamic)).toEqual([`${INVESTIGATION}#<module>: R2 ${LANGUAGES}/mongo/tools.ts`]);
    const required = plantInFunction(
      INVESTIGATION,
      "workflowToolRules",
      'void require("./languages/kubectl/adapter");',
    );
    expect(boundaryFindings(required)).toEqual([`${INVESTIGATION}#<module>: R2 ${LANGUAGES}/kubectl/adapter.ts`]);
  });

  test("a pack id compared as a string in the MCP module fails R1a, and its facet imported there fails R2", () => {
    const arms = `${MCP}/tools/statement-arms.ts`;
    expect(
      boundaryFindings(plantInFunction(arms, "servingStatementArms", 'if (String(arms) === "kubectl") {}')),
    ).toEqual([`${arms}#servingStatementArms: R1a "kubectl"`]);
    const facet = prepend(arms, 'import * as facet from "@/lib/agent/languages/mongo/mcp";');
    expect(boundaryFindings(facet)).toEqual([`${arms}#<module>: R2 ${LANGUAGES}/mongo/mcp.ts`]);
  });

  test("a statement tool written out by name in the MCP module fails R1f, whichever language declares it", () => {
    const arms = `${MCP}/tools/statement-arms.ts`;
    expect(
      boundaryFindings(plantInFunction(arms, "servingStatementArms", 'void mcpStatementArm("run_read_query");')),
    ).toEqual([`${arms}#servingStatementArms: R1f "run_read_query"`]);
    expect(
      boundaryFindings(plantInFunction(arms, "servingStatementArms", 'const tools: "run_kubectl_read"[] = [];')),
    ).toEqual([`${arms}#tools: R1f "run_kubectl_read"`]);
  });

  test("a name a pack owns, written in a core module or the MCP module, fails R1g", () => {
    expect(
      boundaryFindings({
        ...plantInFunction(TOOLS, "agentToolDefinition", 'if (name === "profile_workloads") {}'),
        ...plantInTypeAlias(`${AGENT}/types.ts`, "AgentReadingDenyCode", '"METRICS_UNAVAILABLE"'),
        ...plantInFunction(GOAL_VERIFIER, "verifyRunGoal", 'const shortfall = "no-usage-reading";'),
      }),
    ).toEqual([
      `${GOAL_VERIFIER}#shortfall: R1g "no-usage-reading"`,
      `${TOOLS}#agentToolDefinition: R1g "profile_workloads"`,
      `${AGENT}/types.ts#AgentReadingDenyCode: R1g "METRICS_UNAVAILABLE"`,
    ]);
    const arms = `${MCP}/tools/statement-arms.ts`;
    expect(
      boundaryFindings(plantInFunction(arms, "servingStatementArms", 'const requirement = "cluster-usage-reading";')),
    ).toEqual([`${arms}#requirement: R1g "cluster-usage-reading"`]);
    expect(PACK_NAMES.has("inspect_usage")).toBe(true);
    expect(PACK_NAMES.has("no-usage-metrics")).toBe(true);
    expect(PACK_NAMES.has("cluster-workload-reading")).toBe(true);
  });

  test("the default family's row read off the facet registry in the MCP module fails R5b", () => {
    const arms = `${MCP}/tools/statement-arms.ts`;
    expect(
      boundaryFindings(plantInFunction(arms, "servingStatementArms", "void AGENT_LANGUAGE_MCP_FACETS.sql;")),
    ).toEqual([`${arms}#servingStatementArms: R5b sql`]);
  });

  test("a MongoDB plan stage in a sentence fails R1d", () => {
    const planted = plantInFunction(GOAL_VERIFIER, "goalFor", 'void "the plan reads a COLLSCAN";');
    expect(boundaryFindings(planted)).toEqual([`${GOAL_VERIFIER}#goalFor: R1d "the plan reads a COLLSCAN"`]);
  });

  test("an operation id outside its union fails R1e", () => {
    const planted = plantInFunction(TOOLS, "runReadQueryTool", 'if (operation === "mongo.plan.estimate") {}');
    expect(boundaryFindings(planted)).toEqual([`${TOOLS}#runReadQueryTool: R1e "mongo.plan.estimate"`]);
  });

  test("a family's verifier id written back into the core union fails R1e", () => {
    const id = '"agent-query-optimization-kubectl.1"';
    expect(boundaryFindings(plantInTypeAlias(GOAL_VERIFIER, "AgentGoalVerifierId", id))).toEqual([
      `${GOAL_VERIFIER}#AgentGoalVerifierId: R1e ${id}`,
    ]);
  });

  test("the default family's id compared as a string fails R5a", () => {
    expect(boundaryFindings(plantInFunction(TOOLS, "agentToolDefinition", 'if (language === "sql") {}'))).toEqual([
      `${TOOLS}#agentToolDefinition: R5a "sql"`,
    ]);
  });

  test("the default family's row read off a language-keyed table, an alias or a pattern fails R5b", () => {
    const scan = (code: string): string[] => boundaryFindings(plantInFunction(TOOLS, "agentToolDefinition", code));
    expect(scan("void AGENT_WORKFLOW_VARIANTS.sql;")).toEqual([`${TOOLS}#agentToolDefinition: R5b sql`]);
    expect(scan('void AGENT_WORKFLOW_VARIANTS["sql"];')).toEqual([`${TOOLS}#agentToolDefinition: R5b sql`]);
    expect(scan("const v = AGENT_LANGUAGE_COPY; void v.sql;")).toEqual([`${TOOLS}#agentToolDefinition: R5b sql`]);
    expect(scan("const { sql } = AGENT_WORKFLOW_VARIANTS;")).toEqual([`${TOOLS}#agentToolDefinition: R5b sql`]);
    expect(scan("void manifest.AGENT_PLAN_ESTIMATE_OPERATION.sql;")).toEqual([`${TOOLS}#agentToolDefinition: R5b sql`]);
    const renamed = prepend(
      INVESTIGATION,
      'import { LANGUAGE_TOOL_ARMS as ARMS } from "./languages";\nconst arms = ARMS.sql;',
    );
    expect(boundaryFindings(renamed)).toEqual([`${INVESTIGATION}#arms: R5b sql`]);
    // A statement text's `.sql` field is no language-keyed table.
    expect(scan("const input = { sql: 1 }; void input.sql;")).toEqual([]);
  });

  test("the derived language-keyed tables are the ones the core reads by family", () => {
    expect([...LANGUAGE_TABLES].sort()).toEqual([
      "AGENT_LANGUAGE_COPY",
      "AGENT_LANGUAGE_MCP_FACETS",
      "AGENT_PLAN_ESTIMATE_OPERATION",
      "AGENT_WORKFLOW_VARIANTS",
      "LANGUAGE_TOOL_ARMS",
      "WORKFLOW_TOOL_RULES",
    ]);
  });

  test("a new reference to a default-language constant fails R5c", () => {
    const posture = `${AGENT}/posture.ts`;
    expect(boundaryFindings(prepend(posture, "if (x === DEFAULT_STATEMENT_LANGUAGE) {}"))).toEqual([
      `${posture}#<module>: R5c DEFAULT_STATEMENT_LANGUAGE`,
    ]);
  });

  test("an operation id of the default family fails R5e", () => {
    expect(boundaryFindings(plantInFunction(TOOLS, "readCatalog", 'void "sql.query.write";'))).toEqual([
      `${TOOLS}#readCatalog: R5e "sql.query.write"`,
    ]);
  });

  test("an engine id compared as a string fails R8a", () => {
    const planted = plantInFunction(TOOLS, "readCatalog", 'if (context.connection.type === "postgres") {}');
    expect(boundaryFindings(planted)).toEqual([`${TOOLS}#readCatalog: R8a "postgres"`]);
  });

  test("an engine id as a property name fails R8b, and only the total map's keys are exempt", () => {
    const posture = `${AGENT}/posture.ts`;
    expect(boundaryFindings(prepend(posture, "const T = { postgres: 1, sqlite: 2 };"))).toEqual([
      `${posture}#T: R8b postgres`,
      `${posture}#T: R8b sqlite`,
    ]);
    const unexempt = coreFileFindings(MANIFEST, read(MANIFEST), false).filter((finding) => finding.includes(": R8b "));
    expect(unexempt).toHaveLength(Object.keys(AGENT_STATEMENT_LANGUAGE).length);
    expect(unexempt.every((finding) => finding.startsWith(`${MANIFEST}#AGENT_STATEMENT_LANGUAGE: R8b `))).toBe(true);
  });

  test("an identifier with an engine id as a whole segment fails R8c, and one that only contains it does not", () => {
    const posture = `${AGENT}/posture.ts`;
    expect(boundaryFindings(prepend(posture, "function postgresThing() {}"))).toEqual([
      `${posture}#postgresThing: R8c postgresThing`,
    ]);
    expect(boundaryFindings(prepend(posture, "const redistribute = 1;"))).toEqual([]);
    // An engine id written in camel case across its own words is still that id: `duckDb` is `duckdb`.
    expect(boundaryFindings(prepend(posture, "function duckDbPlan() {}"))).toEqual([
      `${posture}#duckDbPlan: R8c duckDbPlan`,
    ]);
    expect(boundaryFindings(prepend(posture, "const MsSqlCap = 2;"))).toEqual([`${posture}#MsSqlCap: R8c MsSqlCap`]);
  });

  test("a plan format id, an engine-prefixed literal or an engine alias fails R8d", () => {
    const posture = `${AGENT}/posture.ts`;
    expect(boundaryFindings(plantInFunction(TOOLS, "readCatalog", 'if (format === "sqlite-queryplan") {}'))).toEqual([
      `${TOOLS}#readCatalog: R8d "sqlite-queryplan"`,
    ]);
    // A format id with no engine in its first word is still a format: the union is read, not guessed at.
    expect(boundaryFindings(prepend(posture, 'type F = "mysql-json" | "druid-native";'))).toEqual([
      `${posture}#F: R8d "druid-native"`,
      `${posture}#F: R8d "mysql-json"`,
    ]);
    expect(boundaryFindings(prepend(posture, 'const mode = "mssql-showplan";'))).toEqual([
      `${posture}#mode: R8d "mssql-showplan"`,
    ]);
    expect(boundaryFindings(prepend(posture, "const PG_SCAN_NODE = 1;"))).toEqual([
      `${posture}#PG_SCAN_NODE: R8d PG_SCAN_NODE`,
    ]);
    // An engine id spelled in an identifier stays R8c's, and a word that only contains an alias is no alias.
    expect(boundaryFindings(prepend(posture, "const SQLITE_SCAN_STEP = 1;"))).toEqual([
      `${posture}#SQLITE_SCAN_STEP: R8c SQLITE_SCAN_STEP`,
    ]);
    expect(boundaryFindings(prepend(posture, "const pgnLimit = 1; const upgrade = 2;"))).toEqual([]);
  });

  test("the plan format ids R8d holds are the whole ExplainFormat union", () => {
    expect(EXPLAIN_FORMATS.size).toBeGreaterThan(10);
    expect(EXPLAIN_FORMATS.has("postgres-json")).toBe(true);
    expect(EXPLAIN_FORMATS.has("druid-native")).toBe(true);
  });

  test("an overridable member read through a family resolver, an alias, a pattern or a projection fails R9", () => {
    const scan = (code: string): string[] =>
      boundaryFindings(plantInFunction(INVESTIGATION, "workflowToolRules", code));
    expect(scan("void agentLanguagePack(x).server.grounding;")).toEqual([
      `${INVESTIGATION}#workflowToolRules: R9 grounding`,
    ]);
    expect(scan("const p = languageServerPack(x); void p.workflowToolRules;")).toEqual([
      `${INVESTIGATION}#workflowToolRules: R9 workflowToolRules`,
    ]);
    expect(scan('void languageServerPack(x)["answerNotADataRead"];')).toEqual([
      `${INVESTIGATION}#workflowToolRules: R9 answerNotADataRead`,
    ]);
    expect(scan("const { grounding } = languageServerPack(x);")).toEqual([
      `${INVESTIGATION}#workflowToolRules: R9 grounding`,
    ]);
    expect(scan("const { server: { grounding } } = agentLanguagePack(x);")).toEqual([
      `${INVESTIGATION}#workflowToolRules: R9 grounding`,
    ]);
    // Names are read file-wide, and `planningEngine` binds a `server` of its own, so the planted one is renamed.
    expect(scan("const { server: family } = agentLanguagePack(x); void family.grounding;")).toEqual([
      `${INVESTIGATION}#workflowToolRules: R9 grounding`,
    ]);
    const projected = prepend(INVESTIGATION, 'import { WORKFLOW_TOOL_RULES } from "./languages/server";');
    expect(boundaryFindings(projected)).toEqual([`${INVESTIGATION}#<module>: R9 WORKFLOW_TOOL_RULES`]);
    const namespaced = prepend(
      INVESTIGATION,
      'import * as rules from "./languages/server"; void rules.WORKFLOW_TOOL_RULES;',
    );
    expect(boundaryFindings(namespaced)).toEqual([`${INVESTIGATION}#<module>: R9 WORKFLOW_TOOL_RULES`]);
    // A resolver imported under another name, or called off a namespace, is the same resolver.
    const renamed = prepend(
      INVESTIGATION,
      'import { languageServerPack as lsp } from "./languages/server"; void lsp(x).grounding;',
    );
    expect(boundaryFindings(renamed)).toEqual([`${INVESTIGATION}#<module>: R9 grounding`]);
    const called = prepend(
      INVESTIGATION,
      'import * as L from "./languages/server"; void L.languageServerPack(x).grounding;',
    );
    expect(boundaryFindings(called)).toEqual([`${INVESTIGATION}#<module>: R9 grounding`]);
    // A member no overlay may override is read by family.
    expect(scan("void languageServerPack(x).adapter;")).toEqual([]);
  });

  test("an execution engine written twice fails R4 as a surplus", () => {
    const support = `${AGENT}/engine-support.ts`;
    const planted = { [support]: read(support).replace('  "postgres",\n', '  "postgres",\n  "postgres",\n') };
    expect(boundaryFindings(planted)).toEqual([
      `R4 surplus: ${support}#AGENT_EXECUTION_ENGINES: R8a "postgres" (found 2, allowed 1)`,
    ]);
  });

  test("an allowlisted id written twice fails R4 as a surplus, and one removed fails it as stale", () => {
    const manifest = `${AGENT}/agent-manifest.ts`;
    const id = '"kubectl"';
    const key = `${manifest}#AgentStatementLanguageId: R1a ${id}`;
    expect(boundaryFindings(plantInTypeAlias(manifest, "AgentStatementLanguageId", id))).toEqual([
      `R4 surplus: ${key} (found 2, allowed 1)`,
    ]);
    const removed = { [manifest]: read(manifest).replace(` | ${id}`, "") };
    expect(boundaryFindings(removed)).toEqual([`R4 stale: ${key} (found 0, allowed 1)`]);
  });

  test("the execution tier imported by tools.ts fails the server tier and closes a cycle through every pack", () => {
    const planted = prepend(TOOLS, 'import { agentLanguagePack } from "./languages";');
    const index = `${LANGUAGES}/index.ts`;
    expect(layeringFindings(planted)).toEqual([
      `R3 cycle: ${index} -> ${LANGUAGES}/kubectl/index.ts -> ${LANGUAGES}/kubectl/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/mongo/index.ts -> ${LANGUAGES}/mongo/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/sql/index.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/context-snapshot.ts reaches ${index} through ${AGENT}/context-snapshot.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/schema-stats.ts reaches ${index} through ${AGENT}/schema-stats.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${TOOLS} reaches ${index} through ${TOOLS} -> ${index}`,
    ]);
  }, 60_000);

  test("the execution tier loaded by a dynamic import in tools.ts fails the server tier and closes the same cycles", () => {
    const planted = plantInFunction(TOOLS, "agentToolDefinition", 'void import("./languages/index");');
    const index = `${LANGUAGES}/index.ts`;
    expect(layeringFindings(planted)).toEqual([
      `R3 cycle: ${index} -> ${LANGUAGES}/kubectl/index.ts -> ${LANGUAGES}/kubectl/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/mongo/index.ts -> ${LANGUAGES}/mongo/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/sql/index.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/context-snapshot.ts reaches ${index} through ${AGENT}/context-snapshot.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/schema-stats.ts reaches ${index} through ${AGENT}/schema-stats.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${TOOLS} reaches ${index} through ${TOOLS} -> ${index}`,
    ]);
  }, 60_000);

  test("tools.ts imported by a client pack fails the client tier", () => {
    const client = `${LANGUAGES}/kubectl/client.ts`;
    const planted = prepend(client, 'import { executeAgentOperation } from "../../tools";');
    const clients = `${LANGUAGES}/client.ts`;
    const engines = `${LANGUAGES}/engines/client.ts`;
    const manifest = `${AGENT}/agent-manifest.ts`;
    const claims = `${AGENT}/goal-claims.ts`;
    const toTools = `${manifest} -> ${clients} -> ${client} -> ${TOOLS}`;
    // The manifest loads the client packs, and the verifiers load the manifest, so the verifier closure fails too.
    // `tools.ts` reads the engine server dialects, whose run resolver reads `statementFamilyOf`: a cycle closes there.
    // `tools.ts` reads `statementFamilyOf` itself too, so the shortest cycle through the client packs closes on it.
    // The SQL statement card reads the manifest's plan operations, so a cycle closes there from both of its importers.
    const toCard = `${manifest} -> ${clients} -> ${client} -> ${TOOLS} -> ${LANGUAGES}/server.ts`;
    expect(layeringFindings(planted)).toEqual([
      `R3 client: ${clients} reaches ${TOOLS} through ${clients} -> ${client} -> ${TOOLS}`,
      `R3 client: ${engines} reaches ${TOOLS} through ${engines} -> ${clients} -> ${client} -> ${TOOLS}`,
      `R3 client: ${client} reaches ${TOOLS} through ${client} -> ${TOOLS}`,
      `R3 cycle: ${toCard} -> ${LANGUAGES}/sql/recommendation.ts -> ${manifest}`,
      `R3 cycle: ${toCard} -> ${LANGUAGES}/sql/server.ts -> ${LANGUAGES}/sql/recommendation.ts -> ${manifest}`,
      `R3 cycle: ${manifest} -> ${engines} -> ${clients} -> ${client} -> ${TOOLS} -> ${manifest}`,
      `R3 cycle: ${clients} -> ${client} -> ${TOOLS} -> ${clients}`,
      `R3 cycle: ${clients} -> ${client} -> ${TOOLS} -> ${LANGUAGES}/engines/server.ts -> ${clients}`,
      `R3 verifier: ${claims} reaches ${TOOLS} through ${claims} -> ${toTools}`,
      `R3 verifier: ${GOAL_VERIFIER} reaches ${TOOLS} through ${GOAL_VERIFIER} -> ${toTools}`,
      `R3 verifier: ${LANGUAGES}/kubectl/verifiers.ts reaches ${TOOLS} through ${LANGUAGES}/kubectl/verifiers.ts -> ${claims} -> ${toTools}`,
      `R3 verifier: ${LANGUAGES}/mongo/verifiers.ts reaches ${TOOLS} through ${LANGUAGES}/mongo/verifiers.ts -> ${claims} -> ${toTools}`,
      `R3 verifier: ${LANGUAGES}/verifiers.ts reaches ${TOOLS} through ${LANGUAGES}/verifiers.ts -> ${LANGUAGES}/kubectl/verifiers.ts -> ${claims} -> ${toTools}`,
    ]);
  }, 60_000);

  test("a builtin imported by a client pack fails the client tier", () => {
    const client = `${LANGUAGES}/sql/client.ts`;
    const clients = `${LANGUAGES}/client.ts`;
    const engines = `${LANGUAGES}/engines/client.ts`;
    expect(layeringFindings(prepend(client, 'import "node:fs";'))).toEqual([
      `R3 client: ${clients} reaches package:node:fs through ${clients} -> ${client} -> package:node:fs`,
      `R3 client: ${engines} reaches package:node:fs through ${engines} -> ${clients} -> ${client} -> package:node:fs`,
      `R3 client: ${client} reaches package:node:fs through ${client} -> package:node:fs`,
    ]);
  }, 60_000);

  test("goal-verifier.ts imported at run time by a language verifier fails the verifier tier and closes a cycle", () => {
    const verifiers = `${LANGUAGES}/mongo/verifiers.ts`;
    const planted = prepend(verifiers, 'import "../../goal-verifier";');
    expect(layeringFindings(planted)).toEqual([
      `R3 cycle: ${GOAL_VERIFIER} -> ${LANGUAGES}/verifiers.ts -> ${verifiers} -> ${GOAL_VERIFIER}`,
      `R3 verifier: ${verifiers} reaches ${GOAL_VERIFIER} through ${verifiers} -> ${GOAL_VERIFIER}`,
    ]);
    // A type-only import loads nothing.
    expect(layeringFindings(prepend(verifiers, 'import type { AgentGoalRule } from "../pack";'))).toEqual([]);
  }, 60_000);

  test("tools.ts imported at run time by a language verifier fails the verifier closure", () => {
    const verifiers = `${LANGUAGES}/mongo/verifiers.ts`;
    const all = `${LANGUAGES}/verifiers.ts`;
    const planted = prepend(verifiers, 'import "../../tools";');
    expect(layeringFindings(planted)).toEqual([
      `R3 verifier: ${GOAL_VERIFIER} reaches ${TOOLS} through ${GOAL_VERIFIER} -> ${all} -> ${verifiers} -> ${TOOLS}`,
      `R3 verifier: ${verifiers} reaches ${TOOLS} through ${verifiers} -> ${TOOLS}`,
      `R3 verifier: ${all} reaches ${TOOLS} through ${all} -> ${verifiers} -> ${TOOLS}`,
    ]);
  }, 60_000);

  test("an engine module imported by the core fails R2", () => {
    const posture = `${AGENT}/posture.ts`;
    const planted = prepend(posture, 'import { POSTGRES_SERVER_OVERLAY } from "./languages/sql/engines/postgres";');
    // An import specifier is no reference, so R8c leaves the overlay's name to the reads of it.
    expect(boundaryFindings(planted)).toEqual([`${posture}#<module>: R2 ${LANGUAGES}/sql/engines/postgres.ts`]);
  });

  test("the engine server resolver imported by a client overlay fails the client tier", () => {
    const client = `${LANGUAGES}/sql/engines/client.ts`;
    const engines = `${LANGUAGES}/engines/client.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const claims = `${AGENT}/goal-claims.ts`;
    const toServer = `${AGENT}/agent-manifest.ts -> ${engines} -> ${client} -> ${server}`;
    // The manifest reads the engines' client dialects, and the verifiers load the manifest, so their closure fails too.
    // The run resolver reads each engine's family from `engines/client.ts`, so a cycle closes there.
    // The SQL statement card reads the manifest's plan operations, so a cycle closes there from both of its importers.
    const toCard = `${toServer} -> ${LANGUAGES}/server.ts`;
    expect(layeringFindings(prepend(client, 'import "../../engines/server";'))).toEqual([
      `R3 client: ${engines} reaches ${server} through ${engines} -> ${client} -> ${server}`,
      `R3 client: ${client} reaches ${server} through ${client} -> ${server}`,
      `R3 cycle: ${toCard} -> ${LANGUAGES}/sql/recommendation.ts -> ${AGENT}/agent-manifest.ts`,
      `R3 cycle: ${toCard} -> ${LANGUAGES}/sql/server.ts -> ${LANGUAGES}/sql/recommendation.ts -> ${AGENT}/agent-manifest.ts`,
      `R3 cycle: ${engines} -> ${client} -> ${server} -> ${engines}`,
      `R3 verifier: ${claims} reaches ${server} through ${claims} -> ${toServer}`,
      `R3 verifier: ${GOAL_VERIFIER} reaches ${server} through ${GOAL_VERIFIER} -> ${toServer}`,
      `R3 verifier: ${LANGUAGES}/kubectl/verifiers.ts reaches ${server} through ${LANGUAGES}/kubectl/verifiers.ts -> ${claims} -> ${toServer}`,
      `R3 verifier: ${LANGUAGES}/mongo/verifiers.ts reaches ${server} through ${LANGUAGES}/mongo/verifiers.ts -> ${claims} -> ${toServer}`,
      `R3 verifier: ${LANGUAGES}/verifiers.ts reaches ${server} through ${LANGUAGES}/verifiers.ts -> ${LANGUAGES}/kubectl/verifiers.ts -> ${claims} -> ${toServer}`,
    ]);
  }, 60_000);

  test("the execution tier imported by an engine server overlay fails the server tier and closes a cycle", () => {
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const index = `${LANGUAGES}/sql/index.ts`;
    const profile = `${AGENT}/table-profile.ts`;
    const composed = `${AGENT}/composed-sql.ts`;
    const toIndex = `${server} -> ${postgres} -> ${index}`;
    expect(layeringFindings(prepend(postgres, 'import "../index";'))).toEqual([
      `R3 cycle: ${server} -> ${postgres} -> ${index} -> ${TOOLS} -> ${server}`,
      `R3 server: ${composed} reaches ${index} through ${composed} -> ${toIndex}`,
      `R3 server: ${AGENT}/context-snapshot.ts reaches ${index} through ${AGENT}/context-snapshot.ts -> ${toIndex}`,
      `R3 server: ${server} reaches ${index} through ${toIndex}`,
      `R3 server: ${postgres} reaches ${index} through ${postgres} -> ${index}`,
      `R3 server: ${AGENT}/schema-stats.ts reaches ${index} through ${AGENT}/schema-stats.ts -> ${toIndex}`,
      `R3 server: ${profile} reaches ${index} through ${profile} -> ${toIndex}`,
      `R3 server: ${TOOLS} reaches ${index} through ${TOOLS} -> ${toIndex}`,
    ]);
  }, 60_000);

  test("a core reader of the resolver imported at run time by an engine overlay closes a cycle", () => {
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const profile = `${AGENT}/table-profile.ts`;
    expect(layeringFindings(prepend(postgres, 'import "../../../table-profile";'))).toEqual([
      `R3 cycle: ${server} -> ${postgres} -> ${profile} -> ${server}`,
    ]);
    // The overlays read the core through type-only imports, which load nothing.
    expect(read(postgres)).toContain('import type { AgentProfileComposition } from "../../../table-profile";');
  }, 60_000);

  test("the plan dispatcher imported at run time by an engine overlay closes a cycle", () => {
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const composed = `${AGENT}/composed-sql.ts`;
    expect(layeringFindings(prepend(postgres, 'import "../../../composed-sql";'))).toEqual([
      `R3 cycle: ${composed} -> ${server} -> ${postgres} -> ${composed}`,
    ]);
  }, 60_000);

  test("the statistics reader imported at run time by an engine overlay closes a cycle", () => {
    const sqlite = `${LANGUAGES}/sql/engines/sqlite.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const stats = `${AGENT}/schema-stats.ts`;
    expect(layeringFindings(prepend(sqlite, 'import "../../../schema-stats";'))).toEqual([
      `R3 cycle: ${server} -> ${sqlite} -> ${stats} -> ${server}`,
    ]);
    // The overlays read the reader's types through a type-only import, which loads nothing.
    expect(read(sqlite)).toContain(
      'import type { AgentStatisticsReading, AgentTableEstimate } from "../../../schema-stats";',
    );
  }, 60_000);

  test("the grounding capture imported at run time by an engine overlay closes a cycle", () => {
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const snapshot = `${AGENT}/context-snapshot.ts`;
    expect(layeringFindings(prepend(postgres, 'import "../../../context-snapshot";'))).toEqual([
      `R3 cycle: ${snapshot} -> ${server} -> ${postgres} -> ${snapshot}`,
    ]);
  }, 60_000);

  test("the MCP module or the execution tier imported by an MCP facet fails the mcp tier", () => {
    const facet = `${LANGUAGES}/kubectl/mcp.ts`;
    const registry = `${LANGUAGES}/mcp.ts`;
    const output = `${MCP}/output.ts`;
    expect(layeringFindings(prepend(facet, 'import "@/lib/mcp/output";'))).toEqual([
      `R3 mcp: ${facet} reaches ${output} through ${facet} -> ${output}`,
      `R3 mcp: ${registry} reaches ${output} through ${registry} -> ${facet} -> ${output}`,
    ]);
    const index = `${LANGUAGES}/index.ts`;
    expect(layeringFindings(prepend(registry, 'import "./index";'))).toEqual([
      `R3 mcp: ${registry} reaches ${index} through ${registry} -> ${index}`,
    ]);
  }, 60_000);

  test("an engine server overlay imported by a language verifier fails the verifier closure", () => {
    const verifiers = `${LANGUAGES}/mongo/verifiers.ts`;
    const all = `${LANGUAGES}/verifiers.ts`;
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    expect(layeringFindings(prepend(verifiers, 'import "../sql/engines/postgres";'))).toEqual([
      `R3 verifier: ${GOAL_VERIFIER} reaches ${postgres} through ${GOAL_VERIFIER} -> ${all} -> ${verifiers} -> ${postgres}`,
      `R3 verifier: ${verifiers} reaches ${postgres} through ${verifiers} -> ${postgres}`,
      `R3 verifier: ${all} reaches ${postgres} through ${all} -> ${verifiers} -> ${postgres}`,
    ]);
  }, 60_000);
});
