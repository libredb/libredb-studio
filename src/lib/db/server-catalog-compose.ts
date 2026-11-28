/**
 * The composition of the server's engine catalog (./server-catalog; docs/providers/CONTRACT.md, clause C-106) from the
 * provider packages boot admitted and the ones it refused. Only the boot (src/lib/provider-host/boot.ts) and tests
 * import it, so the published library and the VS Code backend carry none of it.
 *
 * `catalogConflicts(admitted, register)` reads the rules across the whole set that admitting each package on its own
 * cannot see, over Studio's bundled catalog, every admitted declaration and each one's row of Studio's grant register at
 * once, and answers every admitted claimant of each rule, so the answer is the same for every order of the packages:
 * - `engine-id`: an engine id the legacy adapter serves (`LEGACY_ENGINES`) or the bundled catalog states as a fence
 *   alias, or another admitted package serves;
 * - `fence-alias`: a fence alias that is a bundled alias or engine id, another admitted package's alias, or another
 *   admitted package's engine id, the package serving that engine a claimant too;
 * - `query-dialect`, `tab-type` and `editor-language`: a query dialect row, a tab type's editor language or an editor
 *   language's accent and console stated otherwise than Studio's bundled catalog states it; a key the bundled catalog
 *   does not state refuses every admitted claimant of it unless they all state it alike;
 * - `statement-language`: a statement language an admitted engine is granted as its own data's name (its register row
 *   reviewing that data) that a legacy engine of Studio's bundled catalog is granted or states as data, the module
 *   languages agent mode holds among them, or that another admitted engine is granted; a name no row grants is not
 *   read, since no registry composes it;
 * - `mcp-tool`: the MCP statement tool of a statement language an admitted engine is granted as its own data's name
 *   that a bundled declared language states or another admitted engine's granted language states; the module
 *   languages' tools, which only the agent holds, are read by `moduleMcpToolConflicts` from the list boot's caller
 *   hands it.
 * A conflict carries the package's name, version and rule, never an alias, dialect, language, tool or id.
 *
 * `moduleMcpToolConflicts(admitted, register, moduleMcpTools)` reads the `mcp-tool` rule against the module languages'
 * MCP statement tools, the agent's facets (`MODULE_MCP_TOOLS` in src/lib/agent/languages/mcp.ts), which src/lib/db does
 * not import, so boot's caller hands them (src/instrumentation.ts, through `admitProvidersAtBoot`).
 * `composeServerCatalog`'s re-check reads `catalogConflicts` only: a catalog composed past the boot with such a package
 * fails MCP's composition by name (`declaredMcpFacets` in src/lib/agent/languages/declared-mcp.ts), the host defect it
 * always was.
 *
 * `composeServerCatalog(admitted, refused, register)` starts from the legacy adapter's records
 * (src/lib/provider-host/legacy-adapter/records.ts), every one by identity, and adds one record per admitted engine
 * (`EngineRecord` in ./server-catalog): it projects the admitted declarations with the same projections Studio's
 * generator projects its own declarations with (./engine-catalog/projection), composes each engine's field rules
 * (`packageFieldRules` in ./connection-form), grants each engine's claims through Studio's grant reader
 * (`grantEngineClaims` in ./claim-grants, read through `packageEngineGrants`, the set rules' reading too) with its row
 * of `register`, the row keyed by its package's name, version and
 * digest, or with none where the register holds none, so each claim is granted at its restrictive value, its SQL text
 * claims with the digest of the grammar it declares (`declaredSqlTextRequest`), so a row grants them only for the
 * grammar it reviewed, or, for an engine whose `sqlText` is null, with the restrictive request, which holds no digest,
 * so no row reviews a grammar for it and its record holds no statement grammar (a row reviewing no grammar may still
 * grant it `readsSqlText: false` and `decidesAlone` under its language data), and its statement language and the
 * claims that loosen the confirmation gate with the digest of the statement language data it declares
 * (`declaredLanguageDataRequest`), so a row grants them only for the data it reviewed, compiles its statement language
 * row from that data (`statementLanguageRow` in ./statement-language-row; none where it declares none) and holds the
 * data itself by reference, reads its
 * grammar's explain claim under either value, and gives each the package's source, its digest and the session its
 * declaration states, and the offers of an engine served through the provider contract (`PACKAGE_OFFERS`). The boot
 * hands it Studio's register, `STUDIO_GRANT_REGISTER`; a test may hand it a register of its own. It maps each engine a
 * refused package's lock entry names, but a legacy one, to the codes it was refused with. Every table keyed by engine
 * id is transposed into each engine's own frozen record and the engines are kept in Maps, so no engine-keyed plain
 * object is read by a client's value.
 */
import type { GrantRegister } from "@libredb/grant-register";
import type { EngineDeclaration, ProviderManifest } from "@libredb/provider-sdk/manifest";
import { CATALOG_CONFLICT_RULES, type CatalogConflictRule } from "@/lib/provider-host/provider-refusals";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
import { type EngineGrants, grantEngineClaims, type LanguageDataRequest, type SqlTextRequest } from "./claim-grants";
import { packageFieldRules } from "./connection-form";
import { grammarSha256 } from "./grammar-digest";
import { languageDataSha256 } from "./language-digest";
import { grammarFromFacts } from "./sql-grammar";
import { statementLanguageRow } from "./statement-language-row";
import { BUNDLED_FENCE_ALIASES } from "./engine-catalog/editor.generated";
import {
  projectCatalog,
  projectClaimRequests,
  projectConnectionForms,
  projectConnectionTables,
  projectQueryEditorFacts,
} from "./engine-catalog/projection";
import {
  BUNDLED_DIALECT_EDITORS,
  BUNDLED_EDITOR_LANGUAGES,
  BUNDLED_QUERY_DIALECTS,
} from "./engine-catalog/query-editor.generated";
import type { EngineId, EngineOffers, EngineRecord, ServerCatalog, ServingPackage } from "./server-catalog";

/** What every engine an admitted package serves offers: nothing beyond the provider contract's own calls. */
const PACKAGE_OFFERS: EngineOffers = Object.freeze({
  legacyProvider: false,
  explain: false,
  database: false,
  catalog: false,
  unboundedPage: false,
  sshTunnel: false,
  hostFiles: false,
  testCautions: false,
  columnProfile: false,
  executionProfiles: false,
  objectEdit: false,
  keyScan: false,
  connectionDeclarations: false,
});

/** An admitted package as boot hands it to the composer. */
export type AdmittedForCatalog = ServingPackage;

/** A package boot refused, by its lock entry's name, version and engine ids, and the code it was refused with. */
export interface RefusedForCatalog {
  readonly name: string;
  readonly version: string;
  /** The engine ids its lock entry names, which the operator wrote, not the package. */
  readonly engines: readonly string[];
  readonly code: string;
}

/** An admitted package a set rule refuses. */
export interface CatalogConflict {
  readonly name: string;
  readonly version: string;
  readonly rule: CatalogConflictRule;
}

/** One engine declaration of an admitted package. */
interface Claim {
  readonly pkg: AdmittedForCatalog;
  readonly engine: EngineDeclaration;
}

/** Each engine declaration of `admitted`, with its package. */
function claimsOf(admitted: readonly AdmittedForCatalog[]): Claim[] {
  return admitted.flatMap((pkg) => pkg.manifest.engines.map((engine) => ({ pkg, engine })));
}

/** Code-unit order. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The packages each engine id and each fence alias of `claims` is stated by. */
function statedBy(claims: readonly Claim[], read: (engine: EngineDeclaration) => readonly string[]) {
  const stated = new Map<string, Set<AdmittedForCatalog>>();
  for (const { pkg, engine } of claims) {
    for (const key of read(engine)) {
      const packages = stated.get(key) ?? new Set();
      packages.add(pkg);
      stated.set(key, packages);
    }
  }
  return stated;
}

/** Whether `packages` holds a package other than `pkg`. */
function another(packages: ReadonlySet<AdmittedForCatalog> | undefined, pkg: AdmittedForCatalog): boolean {
  return packages !== undefined && [...packages].some((other) => other !== pkg);
}

/**
 * The editor facts `claims` state under each key, read by `read` from each engine's own projection, with the bundled
 * record `bundled` as the reference: each claimant whose fact differs from the reference, or, for a key the reference
 * does not state, each claimant of a key not every claimant states alike.
 */
function editorFactClaimants(
  claims: readonly Claim[],
  read: (facts: ReturnType<typeof projectQueryEditorFacts>) => Readonly<Record<string, unknown>>,
  bundled: Readonly<Record<string, unknown>>,
): AdmittedForCatalog[] {
  const stated = new Map<string, { pkg: AdmittedForCatalog; text: string }[]>();
  for (const { pkg, engine } of claims) {
    for (const [key, value] of Object.entries(read(projectQueryEditorFacts([engine])))) {
      stated.set(key, [...(stated.get(key) ?? []), { pkg, text: JSON.stringify(value) }]);
    }
  }
  const refused: AdmittedForCatalog[] = [];
  for (const [key, claimants] of stated) {
    const reference = Object.hasOwn(bundled, key) ? JSON.stringify(bundled[key]) : undefined;
    const texts = new Set(claimants.map(({ text }) => text));
    for (const { pkg, text } of claimants) {
      if (reference === undefined ? texts.size > 1 : text !== reference) refused.push(pkg);
    }
  }
  return refused;
}

/**
 * The grants of admitted engine `engine` of package `pkg`: its row of `register`, keyed by its package's name, version
 * and digest, read by Studio's grant reader. The one reading of an admitted engine's grants, at the set rules and at
 * composition. Each projection reads the engine's own declaration alone, so a set still holding a repeated engine id is
 * read (the projections refuse a repeated id), and `grantEngine` reads only the engine's own seed-only row, so it grants
 * exactly what a projection over the whole set grants.
 */
function packageEngineGrants({ pkg, engine }: Claim, register: GrantRegister): EngineGrants {
  return grantEngineClaims(
    engine.id,
    projectClaimRequests([engine])[engine.id],
    declaredSqlTextRequest(engine),
    declaredLanguageDataRequest(engine),
    register.rowFor({ package: { name: pkg.name, version: pkg.version, digest: pkg.digest }, engine: engine.id }),
    projectConnectionTables([engine]).seedOnly,
  );
}

/**
 * The statement language names Studio's bundled catalog holds: each legacy engine's granted statement language, which
 * is its request, so the module languages agent mode holds and the bundled declared ones are all here, and the name of
 * the statement language data it states, which the browser's composition holds whatever its grant.
 */
function bundledLanguageNames(): Set<string> {
  const names = new Set<string>();
  for (const record of LEGACY_ENGINES.values()) {
    if (record.grants.statementLanguage !== null) names.add(record.grants.statementLanguage);
    if (record.statementLanguageData !== null) names.add(record.statementLanguageData.name);
  }
  return names;
}

/**
 * The MCP statement tools Studio's bundled catalog holds as data: each legacy engine's statement language data's tool,
 * read whatever its grant, as `bundledLanguageNames` reads the data's name. The module languages' tools are not here:
 * only the agent holds them (`moduleMcpToolConflicts`).
 */
function bundledMcpTools(): Set<string> {
  const tools = new Set<string>();
  for (const record of LEGACY_ENGINES.values()) {
    const tool = record.statementLanguageData?.agent?.mcp?.tool;
    if (tool !== undefined) tools.add(tool);
  }
  return tools;
}

/** An admitted engine granted its own data's statement language: the language's name and its MCP tool, or null. */
interface GrantedLanguage {
  readonly claim: Claim;
  readonly name: string;
  readonly tool: string | null;
}

/**
 * Each engine of `claims` granted, by its row of `register`, the statement language its own data names. Only an engine
 * stating data is read: a package's own name is granted only as its data's name, the selection the agent's registries
 * compose by (`servedLanguageData` in ./operations/served-language-data).
 */
function grantedLanguages(claims: readonly Claim[], register: GrantRegister): GrantedLanguage[] {
  const granted: GrantedLanguage[] = [];
  for (const claim of claims) {
    const data = claim.engine.statementLanguageData;
    if (data !== null && packageEngineGrants(claim, register).statementLanguage === data.name) {
      granted.push({ claim, name: data.name, tool: data.agent?.mcp?.tool ?? null });
    }
  }
  return granted;
}

/**
 * `conflicts` sorted by name and then rule, frozen: the one order every set rule answers in, which boot reads too
 * when it merges the rules' answers.
 */
export function sortedConflicts(conflicts: Iterable<CatalogConflict>): readonly CatalogConflict[] {
  return Object.freeze(
    [...conflicts].sort(
      (a, b) =>
        byText(a.name, b.name) || CATALOG_CONFLICT_RULES.indexOf(a.rule) - CATALOG_CONFLICT_RULES.indexOf(b.rule),
    ),
  );
}

/** A refusal of `pkg` by `rule` into `found`, keyed so each package and rule is held once. */
function refuseInto(found: Map<string, CatalogConflict>, pkg: AdmittedForCatalog, rule: CatalogConflictRule): void {
  found.set(`${pkg.name}\u0000${rule}`, Object.freeze({ name: pkg.name, version: pkg.version, rule }));
}

/**
 * Every admitted package a set rule refuses, by each rule it breaks, sorted by name and then rule, each once. Pure: it
 * reads `admitted`, `register`, the grant register each admitted engine's statement language grant is read from, and
 * Studio's bundled catalog only.
 */
export function catalogConflicts(
  admitted: readonly AdmittedForCatalog[],
  register: GrantRegister,
): readonly CatalogConflict[] {
  const claims = claimsOf(admitted);
  const ids = statedBy(claims, (engine) => [engine.id]);
  const aliases = statedBy(claims, (engine) => engine.editor.fenceAliases);
  const found = new Map<string, CatalogConflict>();
  const refuse = (pkg: AdmittedForCatalog, rule: CatalogConflictRule) => refuseInto(found, pkg, rule);
  for (const { pkg, engine } of claims) {
    // A bundled fence alias is refused as an engine id too, so no fence tag names a bundled engine and a package's.
    const bundledId = LEGACY_ENGINES.has(engine.id) || Object.hasOwn(BUNDLED_FENCE_ALIASES, engine.id);
    if (bundledId || another(ids.get(engine.id), pkg)) refuse(pkg, "engine-id");
    for (const alias of engine.editor.fenceAliases) {
      const bundled = Object.hasOwn(BUNDLED_FENCE_ALIASES, alias) || LEGACY_ENGINES.has(alias);
      const servedElsewhere = ids.get(alias);
      if (bundled || another(aliases.get(alias), pkg) || another(servedElsewhere, pkg)) refuse(pkg, "fence-alias");
      for (const other of servedElsewhere ?? []) if (other !== pkg) refuse(other, "fence-alias");
    }
  }
  const editorRules = [
    ["query-dialect", (facts) => facts.queryDialects, BUNDLED_QUERY_DIALECTS],
    ["tab-type", (facts) => facts.dialectEditors, BUNDLED_DIALECT_EDITORS],
    ["editor-language", (facts) => facts.editorLanguages, BUNDLED_EDITOR_LANGUAGES],
  ] as const satisfies readonly (readonly [
    CatalogConflictRule,
    (facts: ReturnType<typeof projectQueryEditorFacts>) => Readonly<Record<string, unknown>>,
    Readonly<Record<string, unknown>>,
  ])[];
  for (const [rule, read, bundled] of editorRules) {
    for (const pkg of editorFactClaimants(claims, read, bundled)) refuse(pkg, rule);
  }
  const granted = grantedLanguages(claims, register);
  const bundledLanguages = bundledLanguageNames();
  const bundledTools = bundledMcpTools();
  for (const { claim, name, tool } of granted) {
    const grantedElsewhere = granted.some((other) => other.claim !== claim && other.name === name);
    if (bundledLanguages.has(name) || grantedElsewhere) refuse(claim.pkg, "statement-language");
    if (tool === null) continue;
    const statedElsewhere = granted.some((other) => other.claim !== claim && other.tool === tool);
    if (bundledTools.has(tool) || statedElsewhere) refuse(claim.pkg, "mcp-tool");
  }
  return sortedConflicts(found.values());
}

/**
 * Every admitted package one of whose engines is granted a statement language whose MCP statement tool is one of
 * `moduleMcpTools`, the module languages' tools boot's caller hands, as `mcp-tool`, sorted as `catalogConflicts` sorts,
 * each once. Pure: it reads `admitted`, `register` and `moduleMcpTools` only; see the module's docblock.
 */
export function moduleMcpToolConflicts(
  admitted: readonly AdmittedForCatalog[],
  register: GrantRegister,
  moduleMcpTools: readonly string[],
): readonly CatalogConflict[] {
  const found = new Map<string, CatalogConflict>();
  for (const { claim, tool } of grantedLanguages(claimsOf(admitted), register)) {
    if (tool !== null && moduleMcpTools.includes(tool)) refuseInto(found, claim.pkg, "mcp-tool");
  }
  return sortedConflicts(found.values());
}

/**
 * The SQL text request of an engine whose `sqlText` is null: the restrictive value of every SQL text claim and no
 * grammar digest, so no register row reviews a grammar of it and the grant reader grants the redaction and the exempt
 * forms at their restrictive values whatever the row holds; `readsSqlText` and `decidesAlone` it grants as a row that
 * reviews no grammar grants them, under the statement language data the engine states and the row reviewed alone, and
 * at their restrictive values otherwise (`grantSqlText` in ./claim-grants).
 */
const NO_SQL_TEXT_REQUEST: SqlTextRequest = Object.freeze({
  readsSqlText: true,
  confirmExemptForms: Object.freeze([]),
  redaction: Object.freeze({ kind: "none" }),
  grammarSha256: null,
});

/**
 * The SQL text request of admitted declaration `engine` as the grant reader reads it: its `readsSqlText`, exempt forms
 * and redaction as declared, and the digest of the grammar it declares, computed here on the server
 * (./grammar-digest), so no module the browser loads hashes a grammar; or `NO_SQL_TEXT_REQUEST` where its `sqlText` is
 * null.
 */
export function declaredSqlTextRequest(engine: EngineDeclaration): SqlTextRequest {
  if (engine.sqlText === null) return NO_SQL_TEXT_REQUEST;
  return {
    readsSqlText: engine.sqlText.readsSqlText,
    confirmExemptForms: engine.sqlText.grammar.confirmExemptForms,
    redaction: engine.sqlText.redaction,
    grammarSha256: grammarSha256(engine.sqlText.grammar),
  };
}

/**
 * The statement language data request of admitted declaration `engine` as the grant reader reads it: the digest of the
 * data it declares, computed here on the server (./language-digest), so no module the browser loads hashes it, or null
 * where it declares none.
 */
export function declaredLanguageDataRequest(engine: EngineDeclaration): LanguageDataRequest {
  return {
    languageSha256: engine.statementLanguageData === null ? null : languageDataSha256(engine.statementLanguageData),
  };
}

/**
 * The server's engine catalog of the admitted packages `admitted` and the refused packages `refused`, each admitted
 * engine granted its row of `register`.
 *
 * @throws {Error} A host defect: when `admitted` still holds a conflict `catalogConflicts` answers, since boot refuses
 * every claimant before it composes, or when an engine an admitted package serves is also named by a refused
 * package's lock entry, which the lock's own collision rules refuse. Naming the engine and the field, for a row of
 * `register` whose superseding field is not a text field a connection form draws, a defect of Studio's register.
 */
export function composeServerCatalog(
  admitted: readonly AdmittedForCatalog[],
  refused: readonly RefusedForCatalog[],
  register: GrantRegister,
): ServerCatalog {
  const conflicts = catalogConflicts(admitted, register);
  if (conflicts.length > 0) {
    const named = conflicts.map(({ name, version, rule }) => `${name} ${version} ${rule}`).join(", ");
    throw new Error(
      `composeServerCatalog: the admitted packages still conflict (${named}): boot refuses every claimant before it composes`,
    );
  }
  const claims = claimsOf(admitted);
  const declarations = claims.map(({ engine }) => engine);
  const catalog = projectCatalog(declarations);
  const tables = projectConnectionTables(declarations);
  const forms = projectConnectionForms(declarations);
  const engines = new Map<string, EngineRecord>(LEGACY_ENGINES);
  for (const claim of claims) {
    const { pkg, engine } = claim;
    const { id } = engine;
    const fields = tables.fields[id];
    engines.set(
      id,
      Object.freeze({
        id: id as EngineId,
        displayName: engine.displayName,
        source: Object.freeze({
          name: pkg.name,
          version: pkg.version,
          digest: pkg.digest,
          package: Object.freeze({
            name: pkg.name,
            version: pkg.version,
            digest: pkg.digest,
            directory: pkg.directory,
            manifest: pkg.manifest as ProviderManifest,
            record: pkg.record,
            // What the host core checks each call of the engine's sessions against
            // (src/lib/provider-host/core/contract-session.ts).
            session: Object.freeze({
              calls: pkg.manifest.calls,
              maintenance: Object.freeze({
                maintenance: engine.facets.maintenance,
                maintenanceSpecs: engine.facets.maintenanceSpecs,
              }),
              panels: engine.facets.monitoring,
              ...(engine.objects === undefined ? {} : { objectModel: engine.objects }),
            }),
          }),
        }),
        catalog: catalog[id],
        connection: Object.freeze({
          fields,
          seedOnly: tables.seedOnly[id],
          refused: tables.refused[id],
          // The projection holds a row only for an engine that declares a warning.
          credentialWarnings: tables.credentialWarnings[id] ?? Object.freeze([]),
          tlsModes: Object.freeze([...engine.connection.tls.modes]),
          readsTrustMaterial: tables.readsTrustMaterial[id],
          connectionStringAccepted: tables.connectionStringAccepted[id],
          dialogOffersUri: tables.dialogOffersUri[id],
        }),
        fieldRules: packageFieldRules(id, forms[id], fields),
        grants: packageEngineGrants(claim, register),
        // The grammar the query route's confirmation gate and the query event log read the engine's statements under,
        // compiled once here; the gate counts only the exempt forms its record grants (docs/providers/CONTRACT.md,
        // clause S-8). An engine that states no SQL text has none (clause S-3).
        statementGrammar: engine.sqlText === null ? null : grammarFromFacts(engine.sqlText.grammar),
        // The row compiled from the statement language data the declaration states, which the gate counts only as the
        // grants above grant it; Studio holds no code row of a package's engine, whose id is never a legacy id.
        statementLanguageRow: statementLanguageRow(id, engine.statementLanguageData, null),
        // The data itself, by reference, which the agent's registries compose only where the grants above name it.
        statementLanguageData: engine.statementLanguageData,
        // Neither explain value is the restrictive one, so the gate reads a package's statements under both (S-8).
        explainReading: "either",
        // The frozen manifest's list, the one the session's declared maintenance above holds by reference.
        maintenance: engine.facets.maintenance,
        offers: PACKAGE_OFFERS,
      }) as EngineRecord,
    );
  }
  const unavailable = new Map<string, Set<string>>();
  for (const pkg of refused) {
    for (const id of pkg.engines) {
      if (LEGACY_ENGINES.has(id)) continue;
      if (engines.has(id)) {
        throw new Error(
          "composeServerCatalog: an engine of an admitted package is also named by a refused package's lock entry, which the lock refuses as a shared engine",
        );
      }
      const codes = unavailable.get(id) ?? new Set();
      codes.add(pkg.code);
      unavailable.set(id, codes);
    }
  }
  return Object.freeze({
    engines,
    unavailable: new Map([...unavailable].map(([id, codes]) => [id, Object.freeze([...codes].sort(byText))])),
  });
}
