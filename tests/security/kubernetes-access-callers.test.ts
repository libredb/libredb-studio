/**
 * Threat: a caller that lists or opens a Kubernetes-discovered database without the Kubernetes access review, or that
 * builds a provider for a connection neither the review nor a seed rule handed it (docs/SECURITY.md, control 3.28).
 *
 * While the review is on, a discovered connection carries a role the role filter never selects (src/lib/seed/roles.ts),
 * so only src/lib/governance/visible.ts, which hands it to the review, lists or opens one. That holds while every
 * caller of the functions in GATED_MODULES either goes through that dispatcher or has a stated reason it cannot reach a
 * reviewed connection. This census parses every TypeScript and JavaScript file under src with the TypeScript compiler,
 * so a comment is never read as code and a string never hides any, reads its imports and exports from the syntax tree,
 * resolves `@/` and relative specifiers to repository paths, and records every file that imports a gated function,
 * whether it calls it or only passes it on. Each such file must be an entry of REVIEWED_CALLERS, under that function,
 * with its reason; an entry no file matches any more is stale and fails too. A module that gives a gated function on,
 * by `export ... from` or by exporting a name it imported, is gated for it as well, under the name it gives, so
 * importing it through a barrel is counted like importing it from its own module.
 *
 * A form that would hide a caller from the census fails unless NAMESPACE_IMPORT_ALLOWED names the file with its reason:
 * a namespace or default import of a gated module; an `import()` or `require()` of one, with a string or a template
 * without substitutions, whose result is not destructured; an `import()` or `require()` whose specifier is not such a
 * literal, since it could name any module, a gated one included; a re-export of a gated function; and, in a gated
 * function's own module, an export of it under another name or any other use of it as a value than a call. A call
 * inside a gated function's own module is that module's composition, pinned by the module's own tests, and is not
 * counted. Type-only imports bind no value and are not counted either.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

/** The gated functions, by the repository path of the module a caller imports them from. */
const GATED_MODULES: Readonly<Record<string, readonly string[]>> = {
  "src/lib/seed/index.ts": ["getManagedConnections", "getSeedListing", "getSeedConnectionByIdUnfiltered"],
  "src/lib/seed/kubernetes-discovery-loader.ts": ["getKubernetesDiscoveredConnections"],
  "src/lib/seed/kubernetes-discovery-export.ts": ["parseKubernetesDiscoveryExport"],
  "src/lib/seed/kubernetes-discovery-contract.ts": ["mapKubernetesDatabase"],
  "src/lib/governance/visible.ts": ["visibleConnections", "visibleConnectionById"],
  "src/lib/seed/resolve-connection.ts": ["resolveConnection"],
  "src/lib/kubernetes-access/gate.ts": [
    "connectionsUnderAccessReview",
    "connectionUnderAccessReview",
    "accessReviewSignInRole",
  ],
  "src/lib/kubernetes-access/review.ts": ["requestAccessReview"],
  "src/lib/kubernetes-access/decisions.ts": ["accessReviewAllows"],
  "src/lib/db/factory.ts": [
    "createDatabaseProvider",
    "getOrCreateProvider",
    "acquireExecutionProfileProvider",
    "withOneShotTunnel",
    "findCachedProvider",
  ],
  "src/lib/api/editor-provider.ts": ["editorProvider", "cachedEditorProvider"],
  "src/lib/api/object-route.ts": ["handleObjectRequest"],
  "src/lib/api/test-connection.ts": ["testConnection"],
};

/** A route that opens the request's connection through the dispatcher before anything else. */
const RESOLVED_BY_THE_ROUTE =
  "resolves the request's connection through resolveConnection, which opens a seed id only through visibleConnectionById and so through the review, and answers every miss with the uniform 404 (tests/security/kubernetes-access-review.test.ts)";

/** An agent route: resolved through the dispatcher, and held while the review is on. */
const RESOLVED_BY_THE_AGENT_ROUTE =
  "resolves the request's connection through resolveConnection under the signed-in session, so a reviewed id passes the review first, and agent mode is held while the review is on (src/lib/agent/config.ts)";

/** A route that builds only for the connection it resolved through the dispatcher. */
const BUILDS_WHAT_THE_ROUTE_RESOLVED =
  "builds only for the connection this route resolved through resolveConnection before, so a reviewed connection reaches it only after the review allowed it";

/** A db/objects route or db/keys/scan: handleObjectRequest is its whole body. */
const OBJECT_ROUTE =
  "hands its request to handleObjectRequest, which resolves the connection through resolveConnection before it builds anything";

/** The agent runtime: its principal carries no identity provider subject. */
const AGENT_RUNTIME =
  "drives a run on the connection its recorded connectionId resolves to through resolveConnection, with a principal that carries no identity provider subject or issuer, so the review denies every reviewed connection; agent mode is held while the review is on";

/** Every file that imports a gated function, under that function, with the reason it may. */
const REVIEWED_CALLERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  getSeedListing: {
    "src/lib/governance/visible.ts":
      "the dispatcher, the listing's only reader outside its module: it hands the review pendingReview and, while the review is on, every other row that names a Kubernetes Secret",
  },
  getManagedConnections: {
    "src/lib/mcp/context.ts":
      "MCP's list of the seeds that opted in: it never holds a reviewed connection, which only getSeedListing's pendingReview carries, and MCP is held while the review is on",
  },
  getSeedConnectionByIdUnfiltered: {
    "src/lib/seed/resolve-connection.ts":
      "the miss path that tells 403 from 404, run only while governance and the review are both off; it reads operator entries only, never a discovered connection",
  },
  getKubernetesDiscoveredConnections: {
    "src/lib/seed/index.ts":
      "getSeedListing, the export's only reader: with the review on every row is set apart under the reserved role, with it off listed under admin through the role filter",
  },
  parseKubernetesDiscoveryExport: {
    "src/lib/seed/kubernetes-discovery-loader.ts":
      "the Kubernetes discovery source parses the export file it reads, and what it maps from it leaves only through getKubernetesDiscoveredConnections",
  },
  mapKubernetesDatabase: {
    "src/lib/seed/kubernetes-discovery-loader.ts":
      "the Kubernetes discovery source maps each parsed database to a connection, which leaves only through getKubernetesDiscoveredConnections",
  },
  visibleConnections: {
    "src/app/api/connections/managed/route.ts":
      "the managed list: it lists what the dispatcher answers, and strips the server-only markers and the reserved role before a row reaches the browser",
  },
  visibleConnectionById: {
    "src/lib/seed/resolve-connection.ts":
      "resolveConnection's only lookup of a seed id: the dispatcher answers with the review applied, and while the review is on every miss is the uniform 404",
  },
  resolveConnection: {
    "src/app/api/admin/fleet-health/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/cancel/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/disconnect/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/health/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/maintenance/preview/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/maintenance/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/monitoring/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/multi-query/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/pool-stats/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/profile/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/provider-meta/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/query/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/test-connection/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/db/transaction/route.ts": RESOLVED_BY_THE_ROUTE,
    "src/app/api/agent/classify/route.ts": RESOLVED_BY_THE_AGENT_ROUTE,
    "src/app/api/agent/runs/[runId]/handover/route.ts": RESOLVED_BY_THE_AGENT_ROUTE,
    "src/app/api/agent/runs/route.ts": RESOLVED_BY_THE_AGENT_ROUTE,
    "src/lib/agent/runtime.ts": AGENT_RUNTIME,
    "src/lib/api/object-route.ts":
      "handleObjectRequest, the shared body of every db/objects route and db/keys/scan, resolves the request's connection here before it builds",
  },
  connectionsUnderAccessReview: {
    "src/lib/governance/visible.ts":
      "the dispatcher's list: it hands the review exactly the rows getSeedListing set apart",
  },
  connectionUnderAccessReview: {
    "src/lib/governance/visible.ts": "the dispatcher's open: it hands the review only the set-apart row the id names",
  },
  accessReviewSignInRole: {
    "src/app/api/auth/oidc/callback/route.ts":
      "the OIDC callback's role while the review is on: a fresh review of the sign-in attributes, then of update on Studio's Deployment, decided once at sign-in",
  },
  requestAccessReview: {
    "src/lib/kubernetes-access/decisions.ts":
      "the decision cache, the only sender of a review: one request in flight per key, and failures never cached",
  },
  accessReviewAllows: {
    "src/lib/kubernetes-access/gate.ts":
      "the gate's per-connection and sign-in decisions, the only reader of the decision cache",
  },
  createDatabaseProvider: {
    "src/app/api/admin/fleet-health/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/agent/runs/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/provider-meta/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/query/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/lib/agent/runtime.ts": AGENT_RUNTIME,
    "src/lib/api/test-connection.ts":
      "testConnection builds for the connection its caller hands it, and its one caller, POST /api/db/test-connection, resolved it through resolveConnection first",
  },
  getOrCreateProvider: {
    "src/app/api/admin/fleet-health/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/agent/runs/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/cancel/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/health/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/maintenance/preview/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/maintenance/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/monitoring/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/multi-query/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/query/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/transaction/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/lib/api/editor-provider.ts":
      "editorProvider builds for the connection its caller hands it, and every caller is a route listed under editorProvider here, which resolved it through resolveConnection first",
    "src/lib/api/object-route.ts":
      "handleObjectRequest builds only after resolving the request's connection through resolveConnection",
  },
  acquireExecutionProfileProvider: {
    "src/app/api/agent/runs/[runId]/handover/route.ts":
      "opens the run's recorded connectionId only after resolving it through resolveConnection under the run's actor, and agent mode is held while the review is on",
    "src/lib/agent/runtime.ts": AGENT_RUNTIME,
    "src/lib/mcp/context.ts":
      "opens only a seed MCP found in its own getManagedConnections list, which never holds a reviewed connection; MCP is held while the review is on",
  },
  withOneShotTunnel: {
    "src/lib/api/test-connection.ts":
      "testConnection opens the tunnel of the connection its caller hands it, and its one caller, POST /api/db/test-connection, resolved it through resolveConnection first",
  },
  findCachedProvider: {
    "src/lib/api/editor-provider.ts":
      "cachedEditorProvider's lookup of a provider editorProvider already built; it builds nothing",
  },
  editorProvider: {
    "src/app/api/agent/runs/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/health/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/maintenance/preview/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/maintenance/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/monitoring/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/multi-query/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/pool-stats/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/profile/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/query/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
    "src/app/api/db/transaction/route.ts": BUILDS_WHAT_THE_ROUTE_RESOLVED,
  },
  cachedEditorProvider: {
    "src/app/api/db/transaction/route.ts":
      "opens no connection: it finds the provider an earlier request of the same transaction built through editorProvider for a connection resolveConnection resolved, or nothing",
  },
  handleObjectRequest: {
    "src/app/api/db/keys/scan/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/containers/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/counts/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/describe/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/edit-apply/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/edit-plan/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/inventory/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/list/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/search/route.ts": OBJECT_ROUTE,
    "src/app/api/db/objects/source/route.ts": OBJECT_ROUTE,
  },
  testConnection: {
    "src/app/api/db/test-connection/route.ts":
      "the Test Connection route resolves its body through resolveConnection before it hands the connection to testConnection",
  },
};

/** Files that import a gated module in a form that hides its callers, each with the reason it may. */
const NAMESPACE_IMPORT_ALLOWED: Readonly<Record<string, string>> = {
  "src/lib/db/index.ts":
    "the provider barrel re-exports getOrCreateProvider and createDatabaseProvider from the factory; the census gates the barrel for both, so every importer through it is a reviewed caller above",
  "src/exports/providers.ts":
    "the npm package surface re-exports the factory for embedders, who build providers for connections of their own with no Studio session, listing or review; nothing in the app imports it",
  "src/exports/index.ts":
    "the npm package entry re-exports the package surface, ./providers included; nothing in the app imports it",
  "src/exports/index.js":
    "the CommonJS package entry for bundlers that cannot read TypeScript requires ./index.ts as a whole; nothing in the app requires it",
};

/**
 * The functions whose callers are pinned exactly, beside the map: the chain that sets reviewed connections apart,
 * reviews them and hands them out. A new caller of one of these changes this list as well as the map.
 */
const PINNED_EXACTLY: Readonly<Record<string, readonly string[]>> = {
  getSeedListing: ["src/lib/governance/visible.ts"],
  getKubernetesDiscoveredConnections: ["src/lib/seed/index.ts"],
  parseKubernetesDiscoveryExport: ["src/lib/seed/kubernetes-discovery-loader.ts"],
  mapKubernetesDatabase: ["src/lib/seed/kubernetes-discovery-loader.ts"],
  connectionsUnderAccessReview: ["src/lib/governance/visible.ts"],
  connectionUnderAccessReview: ["src/lib/governance/visible.ts"],
  accessReviewAllows: ["src/lib/kubernetes-access/gate.ts"],
  requestAccessReview: ["src/lib/kubernetes-access/decisions.ts"],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:tsx?|[cm]?js)$/.test(entry.name) ? [path] : [];
  });
}

const repositoryPath = (path: string): string => relative(ROOT, path).split(sep).join("/");

/** Every source file under src, by repository path, with its text. */
const SOURCES: ReadonlyMap<string, string> = new Map(
  sourceFiles(SRC).map((path) => [repositoryPath(path), readFileSync(path, "utf8")]),
);

const KNOWN: ReadonlySet<string> = new Set(SOURCES.keys());

/** The repository path a specifier names from `file` among `known`, or null for a package or a path not there. */
function resolveSpecifier(file: string, specifier: string, known: ReadonlySet<string>): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = repositoryPath(join(SRC, specifier.slice(2)));
  else if (specifier.startsWith(".")) base = repositoryPath(resolve(dirname(join(ROOT, file)), specifier));
  else return null;
  const stem = base.replace(/\.js$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** A name given or taken under another: imported `from` as local `to`, or local `from` exported as `to`. */
interface Rename {
  readonly from: string;
  readonly to: string;
}

/** What one file's syntax tree says about the values it takes from other modules and gives on. */
interface FileFacts {
  /** `import { a as b }` and `const { a: b } = await import()` or `= require()`, by specifier. */
  readonly named: readonly { readonly specifier: string; readonly names: readonly Rename[] }[];
  /** A whole module bound to one name: namespace, default, `import x = require()`, or an undestructured load. */
  readonly whole: readonly { readonly specifier: string; readonly form: "namespace" | "default" | "dynamic" }[];
  /** How many `import()` and `require()` calls name their module with anything but a literal. */
  readonly computed: number;
  /** `export ... from`: the names given on, `*` for `export *`, and a `from` of `*` for `export * as x`. */
  readonly reExports: readonly { readonly specifier: string; readonly names: readonly Rename[] | "*" }[];
  /** `export { a as b }`, `export default a` and `export const b = a`: a local name given on. */
  readonly localExports: readonly Rename[];
  /** Every name the file exports. */
  readonly exported: ReadonlySet<string>;
  /** Each use of one of the file's own gated functions as a value: not a call, its declaration or `export { f }`. */
  readonly aliases: readonly string[];
}

/** The text of a string literal or of a template without substitutions, or null for anything else. */
function literal(node: ts.Node | undefined): string | null {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/** An `import()` call or a call of `require`. */
function isModuleLoad(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  );
}

/** The expression inside parentheses, `await`, `as`, `satisfies` and `!`. */
function unwrapped(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAwaitExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** The names an object pattern takes, or null when one is computed, nested or a rest, which hides what it takes. */
function patternNames(pattern: ts.ObjectBindingPattern): Rename[] | null {
  const names: Rename[] = [];
  for (const element of pattern.elements) {
    const key = element.propertyName ?? element.name;
    if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) return null;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return null;
    names.push({ from: key.text, to: element.name.text });
  }
  return names;
}

/** Whether a statement carries `export`. */
const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

/** Whether the identifier `node` uses its value: it is not a callee, nor a name a declaration, property or key gives. */
function usesValue(node: ts.Identifier, parent: ts.Node): boolean {
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return (parent as { readonly name?: ts.Node }).name !== node;
}

/** Facts already read, by file, with the text they were read from, so a probe that changes one file parses only it. */
const FACTS = new Map<string, { readonly text: string; readonly facts: FileFacts }>();

function factsOf(file: string, text: string): FileFacts {
  const cached = FACTS.get(file);
  if (cached?.text === text) return cached.facts;
  const own = new Set(GATED_MODULES[file] ?? []);
  const named: { specifier: string; names: Rename[] }[] = [];
  const whole: { specifier: string; form: "namespace" | "default" | "dynamic" }[] = [];
  const reExports: { specifier: string; names: Rename[] | "*" }[] = [];
  const localExports: Rename[] = [];
  const exported = new Set<string>();
  const aliases: string[] = [];
  const destructured = new Set<ts.Node>();
  let computed = 0;

  const readImport = (node: ts.ImportDeclaration): void => {
    const specifier = literal(node.moduleSpecifier);
    const clause = node.importClause;
    if (specifier === null || clause === undefined || clause.isTypeOnly) return;
    if (clause.name !== undefined) whole.push({ specifier, form: "default" });
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      whole.push({ specifier, form: "namespace" });
      return;
    }
    const names = bindings.elements.filter((element) => !element.isTypeOnly);
    named.push({ specifier, names: names.map((e) => ({ from: (e.propertyName ?? e.name).text, to: e.name.text })) });
  };

  const readExport = (node: ts.ExportDeclaration): void => {
    if (node.isTypeOnly) return;
    const clause = node.exportClause;
    const specifier = node.moduleSpecifier === undefined ? undefined : literal(node.moduleSpecifier);
    if (clause !== undefined && ts.isNamespaceExport(clause)) {
      exported.add(clause.name.text);
      if (typeof specifier === "string") reExports.push({ specifier, names: [{ from: "*", to: clause.name.text }] });
      return;
    }
    const names = (clause?.elements ?? [])
      .filter((element) => !element.isTypeOnly)
      .map((e) => ({ from: (e.propertyName ?? e.name).text, to: e.name.text }));
    for (const { to } of names) exported.add(to);
    if (typeof specifier === "string") reExports.push({ specifier, names: clause === undefined ? "*" : names });
    if (specifier !== undefined) return;
    for (const rename of names) {
      localExports.push(rename);
      if (own.has(rename.from) && rename.from !== rename.to) aliases.push(rename.from);
    }
  };

  const visit = (node: ts.Node, parent: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return readImport(node);
    if (ts.isExportDeclaration(node)) return readExport(node);
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      const specifier = ts.isExternalModuleReference(reference) ? literal(reference.expression) : null;
      if (!node.isTypeOnly && specifier !== null) whole.push({ specifier, form: "namespace" });
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const load = unwrapped(node.initializer);
      const specifier = isModuleLoad(load) ? literal(load.arguments[0]) : null;
      const names = specifier === null ? null : patternNames(node.name);
      if (specifier !== null && names !== null) {
        named.push({ specifier, names });
        destructured.add(load);
      }
    }
    if (isModuleLoad(node) && !destructured.has(node)) {
      const specifier = literal(node.arguments[0]);
      if (specifier === null) computed += 1;
      else whole.push({ specifier, form: "dynamic" });
    }
    if (ts.isExportAssignment(node)) {
      const value = unwrapped(node.expression);
      exported.add("default");
      if (ts.isIdentifier(value)) localExports.push({ from: value.text, to: "default" });
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        exported.add(declaration.name.text);
        const value = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
        if (value !== undefined && ts.isIdentifier(value))
          localExports.push({ from: value.text, to: declaration.name.text });
      }
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      isExported(node)
    ) {
      exported.add(node.name.text);
    }
    if (ts.isIdentifier(node) && own.has(node.text) && usesValue(node, parent)) aliases.push(node.text);
    ts.forEachChild(node, (child) => visit(child, node));
  };

  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  ts.forEachChild(sourceFile, (child) => visit(child, sourceFile));
  const facts: FileFacts = { named, whole, computed, reExports, localExports, exported, aliases };
  FACTS.set(file, { text, facts });
  return facts;
}

/** A gated function a file binds: the module it imports it from, the function, and the local name it is bound to. */
interface Binding {
  readonly origin: string;
  readonly fn: string;
  readonly local: string;
}

/** The gated functions by module, each by the name the module exports it under. */
type Gated = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** A form that hides which gated function a file uses, with the gated module it hides, or null when it may be any. */
interface HiddenImport {
  readonly origin: string | null;
  readonly form: "namespace" | "default" | "dynamic" | "computed" | "re-export" | "alias";
}

interface FileImports {
  readonly bindings: Binding[];
  readonly hidden: HiddenImport[];
}

/** The gated functions `file` imports by name, each under its local name. */
function bindingsOf(file: string, facts: FileFacts, gated: Gated, known: ReadonlySet<string>): Binding[] {
  return facts.named.flatMap(({ specifier, names }) => {
    const origin = resolveSpecifier(file, specifier, known);
    const functions = origin === null ? undefined : gated.get(origin);
    if (origin === null || functions === undefined) return [];
    return names.flatMap(({ from, to }) => {
      const fn = functions.get(from);
      return fn === undefined ? [] : [{ origin, fn, local: to }];
    });
  });
}

/**
 * GATED_MODULES closed under giving on: a module that re-exports a gated function, by name or with `export *`, or
 * exports under any name a gated function it imported or declares, is gated for it under that name, until no module
 * gains a function.
 */
function closeUnderReExport(sources: ReadonlyMap<string, string>): Gated {
  const known = new Set(sources.keys());
  const facts = [...sources].map(([file, text]) => [file, factsOf(file, text)] as const);
  const gated = new Map(
    Object.entries(GATED_MODULES).map(([origin, fns]) => [origin, new Map(fns.map((fn) => [fn, fn]))]),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, fact] of facts) {
      const given: [string, string][] = [];
      for (const { specifier, names } of fact.reExports) {
        const from = gated.get(resolveSpecifier(file, specifier, known) ?? "");
        if (from === undefined) continue;
        if (names === "*") given.push(...from);
        else
          given.push(
            ...names.flatMap(({ from: name, to }): [string, string][] => {
              const fn = from.get(name);
              return fn === undefined ? [] : [[to, fn]];
            }),
          );
      }
      const bound = new Map([
        ...(GATED_MODULES[file] ?? []).map((fn): [string, string] => [fn, fn]),
        ...bindingsOf(file, fact, gated, known).map(({ fn, local }): [string, string] => [local, fn]),
      ]);
      for (const { from, to } of fact.localExports) {
        const fn = bound.get(from);
        if (fn !== undefined) given.push([to, fn]);
      }
      const into = gated.get(file) ?? new Map<string, string>();
      for (const [name, fn] of given) {
        if (into.has(name)) continue;
        into.set(name, fn);
        grew = true;
      }
      if (into.size > 0) gated.set(file, into);
    }
  }
  return gated;
}

/** What `source`, the text of the repository file `file`, imports from the modules of `gated`, and what it hides. */
function importsOf(file: string, source: string, gated: Gated, known: ReadonlySet<string> = KNOWN): FileImports {
  const facts = factsOf(file, source);
  const gatedOrigin = (specifier: string): string | null => {
    const origin = resolveSpecifier(file, specifier, known);
    return origin !== null && gated.has(origin) ? origin : null;
  };
  const bindings = bindingsOf(file, facts, gated, known);
  const hidden: HiddenImport[] = [];
  for (const { specifier, form } of facts.whole) {
    const origin = gatedOrigin(specifier);
    if (origin !== null) hidden.push({ origin, form });
  }
  for (const { specifier, names } of facts.reExports) {
    const origin = gatedOrigin(specifier);
    const givesGated = (name: string): boolean => name === "*" || (gated.get(origin ?? "")?.has(name) ?? false);
    if (origin !== null && (names === "*" || names.some(({ from }) => givesGated(from)))) {
      hidden.push({ origin, form: "re-export" });
    }
  }
  const importedFrom = new Map(bindings.map(({ local, origin }) => [local, origin]));
  for (const { from } of facts.localExports) {
    const origin = importedFrom.get(from);
    if (origin !== undefined) hidden.push({ origin, form: "re-export" });
  }
  hidden.push(...Array.from({ length: facts.computed }, (): HiddenImport => ({ origin: null, form: "computed" })));
  hidden.push(...facts.aliases.map((): HiddenImport => ({ origin: file, form: "alias" })));
  return { bindings, hidden };
}

interface Census {
  readonly gated: Gated;
  /** function -> the files that import it */
  readonly importers: ReadonlyMap<string, ReadonlySet<string>>;
  /** file -> the hidden imports it holds */
  readonly hidden: ReadonlyMap<string, readonly HiddenImport[]>;
}

function takeCensus(sources: ReadonlyMap<string, string>): Census {
  const known = new Set(sources.keys());
  const gated = closeUnderReExport(sources);
  const importers = new Map<string, Set<string>>();
  const hidden = new Map<string, HiddenImport[]>();
  for (const [file, source] of sources) {
    const found = importsOf(file, source, gated, known);
    if (found.hidden.length > 0) hidden.set(file, found.hidden);
    for (const { fn } of found.bindings) importers.set(fn, (importers.get(fn) ?? new Set<string>()).add(file));
  }
  return { gated, importers, hidden };
}

const census = takeCensus(SOURCES);
const GATED = census.gated;

const pairs = (importers: ReadonlyMap<string, ReadonlySet<string>>): string[] =>
  [...importers].flatMap(([fn, files]) => [...files].map((file) => `${fn} <- ${file}`)).sort();

const reviewedPairs = (): string[] =>
  Object.entries(REVIEWED_CALLERS)
    .flatMap(([fn, files]) => Object.keys(files).map((file) => `${fn} <- ${file}`))
    .sort();

describe("the census reads every import form", () => {
  const FILE = "src/lib/census-probe/caller.ts";

  test("named, aliased and destructured imports bind the gated function under their local names", () => {
    const { bindings, hidden } = importsOf(
      FILE,
      [
        'import { getManagedConnections, seedRolesOf as roles } from "@/lib/seed";',
        'import {\n  resolveConnection as open,\n  type SeedConnectionError,\n} from "../seed/resolve-connection";',
        'const { visibleConnectionById: byId } = await import("@/lib/governance/visible");',
        'import { getOrCreateProvider as build } from "@/lib/db";',
      ].join("\n"),
      GATED,
    );
    expect(bindings).toEqual([
      { origin: "src/lib/seed/index.ts", fn: "getManagedConnections", local: "getManagedConnections" },
      { origin: "src/lib/seed/resolve-connection.ts", fn: "resolveConnection", local: "open" },
      { origin: "src/lib/governance/visible.ts", fn: "visibleConnectionById", local: "byId" },
      { origin: "src/lib/db/index.ts", fn: "getOrCreateProvider", local: "build" },
    ]);
    expect(hidden).toEqual([]);
  });

  test("a namespace, default or non-destructured dynamic import and a re-export are hidden imports", () => {
    const { hidden } = importsOf(
      FILE,
      [
        'import * as seed from "@/lib/seed";',
        'import gate from "@/lib/kubernetes-access/gate";',
        'const factory = await import("@/lib/db/factory");',
        'const lazy = () => import("@/lib/api/object-route").then((m) => m.handleObjectRequest);',
        'const required = require("@/lib/api/test-connection");',
        'export { getOrCreateProvider } from "@/lib/db/factory";',
        'export * from "@/lib/kubernetes-access/review";',
      ].join("\n"),
      GATED,
    );
    expect(hidden).toEqual([
      { origin: "src/lib/seed/index.ts", form: "namespace" },
      { origin: "src/lib/kubernetes-access/gate.ts", form: "default" },
      { origin: "src/lib/db/factory.ts", form: "dynamic" },
      { origin: "src/lib/api/object-route.ts", form: "dynamic" },
      { origin: "src/lib/api/test-connection.ts", form: "dynamic" },
      { origin: "src/lib/db/factory.ts", form: "re-export" },
      { origin: "src/lib/kubernetes-access/review.ts", form: "re-export" },
    ]);
  });

  test("a module that exports a gated function it imported gives it on, and is gated for it under that name", () => {
    const BARREL = "src/lib/census-probe/barrel.ts";
    const barrel = [
      'import { getSeedListing, seedRolesOf } from "@/lib/seed";',
      "export { getSeedListing as listSeeds, seedRolesOf };",
      "export const listing = getSeedListing;",
    ].join("\n");
    const importer = 'import { listSeeds, listing, seedRolesOf } from "./barrel";';
    const gated = closeUnderReExport(new Map([...SOURCES, [BARREL, barrel], [FILE, importer]]));
    expect(importsOf(BARREL, barrel, gated).hidden).toEqual([
      { origin: "src/lib/seed/index.ts", form: "re-export" },
      { origin: "src/lib/seed/index.ts", form: "re-export" },
    ]);
    const known = new Set([...KNOWN, BARREL]);
    expect(importsOf(FILE, importer, gated, known).bindings).toEqual([
      { origin: BARREL, fn: "getSeedListing", local: "listSeeds" },
      { origin: BARREL, fn: "getSeedListing", local: "listing" },
    ]);
  });

  test("type-only imports, a re-export of ungated names and a mention in a comment are not counted", () => {
    const found = importsOf(
      FILE,
      [
        'import type { ManagedConnection } from "@/lib/seed";',
        'export { seedRolesOf } from "@/lib/seed";',
        'export type { SeedListing } from "@/lib/seed";',
        '// import { getManagedConnections } from "@/lib/seed";',
        '/* const { resolveConnection } = await import("@/lib/seed/resolve-connection"); */',
      ].join("\n"),
      GATED,
    );
    expect(found).toEqual({ bindings: [], hidden: [] });
  });

  test("a module that re-exports a gated function is gated for it, through every barrel above it", () => {
    expect([...(GATED.get("src/lib/db/index.ts") ?? [])].sort()).toEqual([
      ["createDatabaseProvider", "createDatabaseProvider"],
      ["getOrCreateProvider", "getOrCreateProvider"],
    ]);
    for (const barrel of ["src/exports/providers.ts", "src/exports/index.ts"]) {
      expect([...(GATED.get(barrel)?.keys() ?? [])].sort()).toEqual([
        "createDatabaseProvider",
        "getOrCreateProvider",
        "withOneShotTunnel",
      ]);
    }
  });

  test("(a) a template-literal import binds like a quoted one, and a computed specifier is a hidden import", () => {
    const found = importsOf(
      FILE,
      [
        "const { getSeedListing: list } = await import(`@/lib/seed`);",
        "const seed = await import(`@/lib/seed`);",
        "const someModule = await import(`@/lib/${name}`);",
        "const required = require(name);",
      ].join("\n"),
      GATED,
    );
    expect(found.bindings).toEqual([{ origin: "src/lib/seed/index.ts", fn: "getSeedListing", local: "list" }]);
    expect(found.hidden).toEqual([
      { origin: "src/lib/seed/index.ts", form: "dynamic" },
      { origin: null, form: "computed" },
      { origin: null, form: "computed" },
    ]);
  });

  test("(b) a gated module that exports a gated function under another name is reported, and the alias is gated", () => {
    const INDEX = "src/lib/seed/index.ts";
    const aliasing = [
      SOURCES.get(INDEX),
      "export { getSeedListing as listSeeds };",
      "export const listing = getSeedListing;",
      "export default getSeedListing;",
    ].join("\n");
    const importer = 'import { listSeeds, listing } from "@/lib/seed";';
    const gated = closeUnderReExport(new Map([...SOURCES, [INDEX, aliasing], [FILE, importer]]));
    expect(importsOf(INDEX, aliasing, gated).hidden).toEqual([
      { origin: INDEX, form: "alias" },
      { origin: INDEX, form: "alias" },
      { origin: INDEX, form: "alias" },
    ]);
    expect(importsOf(FILE, importer, gated).bindings).toEqual([
      { origin: INDEX, fn: "getSeedListing", local: "listSeeds" },
      { origin: INDEX, fn: "getSeedListing", local: "listing" },
    ]);
  });

  test("(c) a comment marker inside a string hides no code that follows it", () => {
    const found = importsOf(
      FILE,
      [
        'const glob = "src/**/*.ts";',
        'import { getSeedListing } from "@/lib/seed";',
        'const url = "https://example.com//path"; import { visibleConnections } from "@/lib/governance/visible";',
        'const close = "*/";',
      ].join("\n"),
      GATED,
    );
    expect(found).toEqual({
      bindings: [
        { origin: "src/lib/seed/index.ts", fn: "getSeedListing", local: "getSeedListing" },
        { origin: "src/lib/governance/visible.ts", fn: "visibleConnections", local: "visibleConnections" },
      ],
      hidden: [],
    });
  });
});

describe("the caller census of the seed lookups, the access review and the provider builders", () => {
  test("every gated function is exported by the origin it is listed under", () => {
    for (const [origin, functions] of Object.entries(GATED_MODULES)) {
      const { exported } = factsOf(origin, SOURCES.get(origin) ?? "");
      for (const fn of functions) {
        expect({ origin, fn, exported: exported.has(fn) }).toEqual({ origin, fn, exported: true });
      }
    }
  });

  // A reader that found nothing would make every test below pass vacuously.
  test("finds the importers it is meant to find", () => {
    expect(census.importers.get("resolveConnection")?.size ?? 0).toBeGreaterThanOrEqual(17);
    expect(pairs(census.importers).length).toBeGreaterThanOrEqual(40);
  });

  test("every file that imports a gated function is a reviewed caller of it", () => {
    const reviewed = new Set(reviewedPairs());
    expect(pairs(census.importers).filter((pair) => !reviewed.has(pair))).toEqual([]);
  });

  test("no reviewed caller is stale", () => {
    const found = new Set(pairs(census.importers));
    expect(reviewedPairs().filter((pair) => !found.has(pair))).toEqual([]);
  });

  test("every reviewed caller and every allowance says why, in at least 20 characters", () => {
    const reasons = [
      ...Object.values(REVIEWED_CALLERS).flatMap((files) => Object.entries(files)),
      ...Object.entries(NAMESPACE_IMPORT_ALLOWED),
    ];
    expect(reasons.filter(([, reason]) => reason.trim().length < 20)).toEqual([]);
  });

  test("no file hides a gated module behind a namespace, default or dynamic import or a re-export, unless allowed", () => {
    const hidden = [...census.hidden]
      .filter(([file]) => !(file in NAMESPACE_IMPORT_ALLOWED))
      .map(([file, imports]) => ({ file, imports }));
    expect(hidden).toEqual([]);
  });

  test("no allowance is stale", () => {
    expect(Object.keys(NAMESPACE_IMPORT_ALLOWED).filter((file) => !census.hidden.has(file))).toEqual([]);
  });

  test("the chain that sets reviewed connections apart, reviews them and hands them out has exactly its callers", () => {
    for (const [fn, files] of Object.entries(PINNED_EXACTLY)) {
      expect({ fn, files: [...(census.importers.get(fn)?.keys() ?? [])].sort() }).toEqual({ fn, files: [...files] });
    }
  });
});
