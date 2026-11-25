/**
 * The composition of the server's engine catalog (./server-catalog; docs/providers/CONTRACT.md, clause C-106) from the
 * provider packages boot admitted and the ones it refused. Only the boot (src/lib/provider-host/boot.ts) and tests
 * import it, so the published library and the VS Code backend carry none of it.
 *
 * `catalogConflicts(admitted)` reads the rules across the whole set that admitting each package on its own cannot see,
 * over Studio's bundled catalog and every admitted declaration at once, and answers every admitted claimant of each
 * rule, so the answer is the same for every order of the packages:
 * - `engine-id`: an engine id the bundled catalog serves or states as a fence alias, or another admitted package serves;
 * - `fence-alias`: a fence alias that is a bundled alias or engine id, another admitted package's alias, or another
 *   admitted package's engine id, the package serving that engine a claimant too;
 * - `query-dialect`, `tab-type` and `editor-language`: a query dialect row, a tab type's editor language or an editor
 *   language's accent and console stated otherwise than Studio's bundled catalog states it; a key the bundled catalog
 *   does not state refuses every admitted claimant of it unless they all state it alike.
 * A conflict carries the package's name, version and rule, never an alias, dialect, language or id.
 *
 * `composeServerCatalog(admitted, refused)` projects the admitted declarations with the same projections Studio's
 * generator projects its own declarations with (./engine-catalog/projection), composes each engine's field rules
 * (`packageFieldRules` in ./connection-form), grants each claim through Studio's grant reader against Studio's record
 * (`grantPackageClaims` in ./claim-grants), which holds no row for an engine Studio does not ship, so each claim is granted
 * at its restrictive value, and maps each engine a refused package's lock entry names, but a bundled one, to the codes
 * it was refused with. Every table keyed by engine id is transposed into each engine's own frozen record and the
 * engines are kept in Maps, so no engine-keyed plain object is read by a client's value.
 */
import type { EngineDeclaration, ProviderManifest } from "@libredb/provider-sdk/manifest";
import { grantPackageClaims } from "./claim-grants";
import { packageFieldRules } from "./connection-form";
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
import {
  CATALOG_CONFLICT_RULES,
  type CatalogConflictRule,
  type PackageEngine,
  type PackageEngineId,
  type PackageGrants,
  type ServerCatalog,
  type ServingPackage,
} from "./server-catalog";
import { isDatabaseType } from "./type-id";

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
    const bundledId = isDatabaseType(engine.id) || Object.hasOwn(BUNDLED_FENCE_ALIASES, engine.id);
    if (bundledId || another(ids.get(engine.id), pkg)) refuse(pkg, "engine-id");
    for (const alias of engine.editor.fenceAliases) {
      const bundled = Object.hasOwn(BUNDLED_FENCE_ALIASES, alias) || isDatabaseType(alias);
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
 * The server's engine catalog of the admitted packages `admitted` and the refused packages `refused`.
 *
 * @throws {Error} A host defect: when `admitted` still holds a conflict `catalogConflicts` answers, since boot refuses
 * every claimant before it composes, or when an engine an admitted package serves is also named by a refused
 * package's lock entry, which the lock's own collision rules refuse.
 */
export function composeServerCatalog(
  admitted: readonly AdmittedForCatalog[],
  refused: readonly RefusedForCatalog[],
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
  const grants = grantPackageClaims(projectClaimRequests(declarations), tables.seedOnly);
  const members = Object.keys(grants) as (keyof PackageGrants)[];
  const packages = new Map<string, PackageEngine>();
  for (const { pkg, engine } of claims) {
    const { id } = engine;
    const fields = tables.fields[id];
    packages.set(
      id,
      Object.freeze({
        id: id as PackageEngineId,
        package: Object.freeze({
          name: pkg.name,
          version: pkg.version,
          directory: pkg.directory,
          manifest: pkg.manifest as ProviderManifest,
          record: pkg.record,
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
        grants: Object.freeze(Object.fromEntries(members.map((member) => [member, grants[member][id]]))),
        // What the host core checks each call of the engine's sessions against (src/lib/db/package-sessions.ts).
        session: Object.freeze({
          calls: pkg.manifest.calls,
          maintenance: Object.freeze({
            maintenance: engine.facets.maintenance,
            maintenanceSpecs: engine.facets.maintenanceSpecs,
          }),
          panels: engine.facets.monitoring,
        }),
      }) as PackageEngine,
    );
  }
  const unavailable = new Map<string, Set<string>>();
  for (const pkg of refused) {
    for (const id of pkg.engines) {
      if (isDatabaseType(id)) continue;
      if (packages.has(id)) {
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
    packages,
    unavailable: new Map([...unavailable].map(([id, codes]) => [id, Object.freeze([...codes].sort(byText))])),
  });
}
