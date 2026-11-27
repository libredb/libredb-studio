/**
 * The composition of the server's engine catalog (./server-catalog; docs/providers/CONTRACT.md, clause C-106) from the
 * provider packages boot admitted and the ones it refused. Only the boot (src/lib/provider-host/boot.ts) and tests
 * import it, so the published library and the VS Code backend carry none of it.
 *
 * `catalogConflicts(admitted)` reads the rules across the whole set that admitting each package on its own cannot see,
 * over Studio's bundled catalog and every admitted declaration at once, and answers every admitted claimant of each
 * rule, so the answer is the same for every order of the packages:
 * - `engine-id`: an engine id the legacy adapter serves (`LEGACY_ENGINES`) or the bundled catalog states as a fence
 *   alias, or another admitted package serves;
 * - `fence-alias`: a fence alias that is a bundled alias or engine id, another admitted package's alias, or another
 *   admitted package's engine id, the package serving that engine a claimant too;
 * - `query-dialect`, `tab-type` and `editor-language`: a query dialect row, a tab type's editor language or an editor
 *   language's accent and console stated otherwise than Studio's bundled catalog states it; a key the bundled catalog
 *   does not state refuses every admitted claimant of it unless they all state it alike.
 * A conflict carries the package's name, version and rule, never an alias, dialect, language or id.
 *
 * `composeServerCatalog(admitted, refused, register)` starts from the legacy adapter's records
 * (src/lib/provider-host/legacy-adapter/records.ts), every one by identity, and adds one record per admitted engine
 * (`EngineRecord` in ./server-catalog): it projects the admitted declarations with the same projections Studio's
 * generator projects its own declarations with (./engine-catalog/projection), composes each engine's field rules
 * (`packageFieldRules` in ./connection-form), grants each engine's claims through Studio's grant reader
 * (`grantEngineClaims` in ./claim-grants) with its row of `register`, the row keyed by its package's name, version and
 * digest, or with none where the register holds none, so each claim is granted at its restrictive value, its SQL text
 * claims with the digest of the grammar it declares (`declaredSqlTextRequest`), so a row grants them only for the
 * grammar it reviewed, or, for an engine whose `sqlText` is null, with the restrictive request, which holds no digest,
 * so no row reviews a grammar for it and its record holds no statement grammar (a row reviewing no grammar may still
 * grant it `readsSqlText: false` and `decidesAlone` under its language data), and its statement language and the
 * claims that loosen the confirmation gate with the digest of the statement language data it declares
 * (`declaredLanguageDataRequest`), so a row grants them only for the data it reviewed, compiles its statement language
 * row from that data (`statementLanguageRow` in ./statement-language-row; none where it declares none), reads its
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
import { grantEngineClaims, type LanguageDataRequest, type SqlTextRequest } from "./claim-grants";
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
  executionProfiles: false,
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
 * Every admitted package a set rule refuses, by each rule it breaks, sorted by name and then rule, each once. Pure: it
 * reads `admitted` and Studio's bundled catalog only.
 */
export function catalogConflicts(admitted: readonly AdmittedForCatalog[]): readonly CatalogConflict[] {
  const claims = claimsOf(admitted);
  const ids = statedBy(claims, (engine) => [engine.id]);
  const aliases = statedBy(claims, (engine) => engine.editor.fenceAliases);
  const found = new Map<string, CatalogConflict>();
  const refuse = (pkg: AdmittedForCatalog, rule: CatalogConflictRule) => {
    found.set(`${pkg.name}\u0000${rule}`, Object.freeze({ name: pkg.name, version: pkg.version, rule }));
  };
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
  return Object.freeze(
    [...found.values()].sort(
      (a, b) =>
        byText(a.name, b.name) || CATALOG_CONFLICT_RULES.indexOf(a.rule) - CATALOG_CONFLICT_RULES.indexOf(b.rule),
    ),
  );
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
  const conflicts = catalogConflicts(admitted);
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
  const requests = projectClaimRequests(declarations);
  const engines = new Map<string, EngineRecord>(LEGACY_ENGINES);
  for (const { pkg, engine } of claims) {
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
        grants: grantEngineClaims(
          id,
          requests[id],
          declaredSqlTextRequest(engine),
          declaredLanguageDataRequest(engine),
          register.rowFor({ package: { name: pkg.name, version: pkg.version, digest: pkg.digest }, engine: id }),
          tables.seedOnly,
        ),
        // The grammar the query route's confirmation gate and the query event log read the engine's statements under,
        // compiled once here; the gate counts only the exempt forms its record grants (docs/providers/CONTRACT.md,
        // clause S-8). An engine that states no SQL text has none (clause S-3).
        statementGrammar: engine.sqlText === null ? null : grammarFromFacts(engine.sqlText.grammar),
        // The row compiled from the statement language data the declaration states, which the gate counts only as the
        // grants above grant it; Studio holds no code row of a package's engine, whose id is never a legacy id.
        statementLanguageRow: statementLanguageRow(id, engine.statementLanguageData, null),
        // Neither explain value is the restrictive one, so the gate reads a package's statements under both (S-8).
        explainReading: "either",
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
