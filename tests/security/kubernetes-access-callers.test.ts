/**
 * Threat: a caller that lists or opens a Kubernetes-discovered database without the Kubernetes access review, or that
 * builds a provider for a connection neither the review nor a seed rule handed it (docs/SECURITY.md, control 3.28).
 *
 * While the review is on, a discovered connection carries a role the role filter never selects (src/lib/seed/roles.ts),
 * so only src/lib/governance/visible.ts, which hands it to the review, lists or opens one. That holds while every
 * caller of the functions in GATED_MODULES either goes through that dispatcher or has a stated reason it cannot reach a
 * reviewed connection. This census walks every TypeScript and JavaScript file under src, blanks its comments, reads its
 * imports, resolves `@/` and relative specifiers to repository paths, and records every file that imports a gated
 * function, whether it calls it or only passes it on. Each such file must be an entry of REVIEWED_CALLERS, under that
 * function, with its reason; an entry no file matches any more is stale and fails too. A module that re-exports a gated
 * function is gated for it as well, transitively, so importing it through a barrel is counted like importing it from
 * its own module.
 *
 * A namespace import, a default import, a dynamic import or `require` whose result is not destructured, or a re-export
 * of a gated module would hide its callers from the census, so each fails unless NAMESPACE_IMPORT_ALLOWED names the
 * file with its reason. A call inside a gated function's own module is that module's composition, pinned by the
 * module's own tests, and is not counted. Type-only imports bind no value and are not counted either.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

/** The gated functions, by the repository path of the module a caller imports them from. */
const GATED_MODULES: Readonly<Record<string, readonly string[]>> = {
  "src/lib/seed/index.ts": ["getManagedConnections", "getSeedListing", "getSeedConnectionByIdUnfiltered"],
  "src/lib/seed/kubernetes-discovery-loader.ts": ["getKubernetesDiscoveredConnections"],
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
      "the dispatcher, the listing's only reader: it hands pendingReview to the review and lists before and after as they are",
  },
  getManagedConnections: {
    "src/lib/mcp/context.ts":
      "MCP's list of the seeds that opted in: it never holds a reviewed connection, which only getSeedListing's pendingReview carries, and MCP is held while the review is on",
  },
  getSeedConnectionByIdUnfiltered: {
    "src/lib/seed/resolve-connection.ts":
      "the miss path that tells 403 from 404, run only with governance and the review off; it reads operator entries only, never a discovered connection",
  },
  getKubernetesDiscoveredConnections: {
    "src/lib/seed/index.ts":
      "getSeedListing, the export's only reader: with the review on every row is set apart under the reserved role, with it off listed under admin through the role filter",
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
  connectionsUnderAccessReview: ["src/lib/governance/visible.ts"],
  connectionUnderAccessReview: ["src/lib/governance/visible.ts"],
  accessReviewAllows: ["src/lib/kubernetes-access/gate.ts"],
  requestAccessReview: ["src/lib/kubernetes-access/decisions.ts"],
};

/** Blanks out comments the way tests/security/custom-connections.test.ts does, so a mention in prose is not an import. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:tsx?|[cm]?js)$/.test(entry.name) ? [path] : [];
  });
}

const repositoryPath = (path: string): string => relative(ROOT, path).split(sep).join("/");

/** The repository path a specifier names from `file`, or null for a package or a path that is not there. */
function resolveSpecifier(file: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(join(ROOT, file)), specifier);
  else return null;
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return repositoryPath(candidate);
  }
  return null;
}

/** A gated function a file binds: the module it imports it from, the function, and the local name it is bound to. */
interface Binding {
  readonly origin: string;
  readonly fn: string;
  readonly local: string;
}

/** The gated functions by module, each by the name the module exports it under. */
type Gated = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** An import or re-export of a gated module in a form that hides which of its functions are used. */
interface HiddenImport {
  readonly origin: string;
  readonly form: "namespace" | "default" | "dynamic" | "re-export" | "unreadable";
}

interface FileImports {
  readonly bindings: Binding[];
  readonly hidden: HiddenImport[];
}

/** `a`, `a as b`, `type T`: the values a named import or a named re-export lists, or null for one it cannot read. */
function namedList(list: string, separator: "as" | ":"): { imported: string; local: string }[] | null {
  const entries = list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !entry.startsWith("type "));
  const pattern =
    separator === "as" ? /^([\w$]+)(?:\s+as\s+([\w$]+))?$/ : /^([\w$]+)(?:\s*:\s*([\w$]+))?(?:\s*=[\s\S]*)?$/;
  const out: { imported: string; local: string }[] = [];
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match === null) return null;
    out.push({ imported: match[1], local: match[2] ?? match[1] });
  }
  return out;
}

const STATIC_IMPORT =
  /\bimport\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\*\s*as\s+([\w$]+)\s*)?(?:\{([^}]*)\}\s*)?from\s*["']([^"']+)["']/g;
const RE_EXPORT = /\bexport\s+(type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;
const DESTRUCTURED_DYNAMIC = /\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g;
const ANY_DYNAMIC = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;

/**
 * GATED_MODULES closed under re-export: a module that re-exports a gated function, by name or with `export *`, is gated
 * for it under the name it exports it as, until no module gains a function.
 */
function closeUnderReExport(texts: ReadonlyMap<string, string>): Gated {
  const gated = new Map(
    Object.entries(GATED_MODULES).map(([origin, fns]) => [origin, new Map(fns.map((fn) => [fn, fn]))]),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, text] of texts) {
      for (const [, typeOnly, what, specifier] of text.matchAll(RE_EXPORT)) {
        const from = typeOnly === undefined ? gated.get(resolveSpecifier(file, specifier) ?? "") : undefined;
        if (from === undefined) continue;
        const exported: [string, string][] =
          what === "*"
            ? [...from]
            : (namedList(what.slice(1, -1), "as") ?? []).flatMap(({ imported, local }) => {
                const fn = from.get(imported);
                return fn === undefined ? [] : [[local, fn] as [string, string]];
              });
        const into = gated.get(file) ?? new Map<string, string>();
        for (const [name, fn] of exported) {
          if (into.has(name)) continue;
          into.set(name, fn);
          grew = true;
        }
        if (into.size > 0) gated.set(file, into);
      }
    }
  }
  return gated;
}

/** What `source`, the text of the repository file `file`, imports from the modules of `gatedModules`. */
function importsOf(file: string, source: string, gatedModules: Gated): FileImports {
  const text = withoutComments(source);
  const bindings: Binding[] = [];
  const hidden: HiddenImport[] = [];
  const gated = (specifier: string): string | null => {
    const origin = resolveSpecifier(file, specifier);
    return origin !== null && gatedModules.has(origin) ? origin : null;
  };
  const bind = (origin: string, list: { imported: string; local: string }[]): void => {
    for (const { imported, local } of list) {
      const fn = gatedModules.get(origin)?.get(imported);
      if (fn !== undefined) bindings.push({ origin, fn, local });
    }
  };

  for (const [, typeOnly, defaultName, namespaceName, named, specifier] of text.matchAll(STATIC_IMPORT)) {
    const origin = gated(specifier);
    if (origin === null || typeOnly !== undefined) continue;
    if (namespaceName !== undefined) hidden.push({ origin, form: "namespace" });
    if (defaultName !== undefined) hidden.push({ origin, form: "default" });
    if (named === undefined) continue;
    const list = namedList(named, "as");
    if (list === null) hidden.push({ origin, form: "unreadable" });
    else bind(origin, list);
  }

  for (const [, typeOnly, what, specifier] of text.matchAll(RE_EXPORT)) {
    const origin = gated(specifier);
    if (origin === null || typeOnly !== undefined) continue;
    const list = what.startsWith("*") ? null : namedList(what.slice(1, -1), "as");
    if (list === null || list.some((entry) => gatedModules.get(origin)?.has(entry.imported))) {
      hidden.push({ origin, form: "re-export" });
    }
  }

  const destructured = new Set<number>();
  for (const match of text.matchAll(DESTRUCTURED_DYNAMIC)) {
    const origin = gated(match[2]);
    destructured.add((match.index ?? 0) + match[0].lastIndexOf("import("));
    if (origin === null) continue;
    const list = namedList(match[1], ":");
    if (list === null) hidden.push({ origin, form: "unreadable" });
    else bind(origin, list);
  }
  for (const match of text.matchAll(ANY_DYNAMIC)) {
    const origin = gated(match[1]);
    if (origin !== null && !destructured.has(match.index ?? 0)) hidden.push({ origin, form: "dynamic" });
  }

  return { bindings, hidden };
}

/** Whether the comment-free `source` calls the local name `local`. */
function calls(source: string, local: string): boolean {
  return new RegExp(`(?<![\\w$.])${local.replace(/\$/g, "\\$")}\\s*\\(`).test(withoutComments(source));
}

interface Census {
  /** function -> importing file -> whether the file calls it */
  readonly importers: Map<string, Map<string, boolean>>;
  /** file -> the hidden imports it holds */
  readonly hidden: Map<string, HiddenImport[]>;
}

/** Every source file under src, by repository path, with its text. */
const SOURCES: ReadonlyMap<string, string> = new Map(
  sourceFiles(SRC).map((path) => [repositoryPath(path), readFileSync(path, "utf8")]),
);

const GATED = closeUnderReExport(new Map([...SOURCES].map(([file, source]) => [file, withoutComments(source)])));

function takeCensus(): Census {
  const importers = new Map<string, Map<string, boolean>>();
  const hidden = new Map<string, HiddenImport[]>();
  for (const [file, source] of SOURCES) {
    const found = importsOf(file, source, GATED);
    if (found.hidden.length > 0) hidden.set(file, found.hidden);
    for (const { fn, local } of found.bindings) {
      const files = importers.get(fn) ?? new Map<string, boolean>();
      files.set(file, (files.get(file) ?? false) || calls(source, local));
      importers.set(fn, files);
    }
  }
  return { importers, hidden };
}

const census = takeCensus();

const pairs = (map: ReadonlyMap<string, ReadonlyMap<string, unknown>>): string[] =>
  [...map].flatMap(([fn, files]) => [...files.keys()].map((file) => `${fn} <- ${file}`)).sort();

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
      { origin: "src/lib/db/index.ts", fn: "getOrCreateProvider", local: "build" },
      { origin: "src/lib/governance/visible.ts", fn: "visibleConnectionById", local: "byId" },
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
      { origin: "src/lib/db/factory.ts", form: "re-export" },
      { origin: "src/lib/kubernetes-access/review.ts", form: "re-export" },
      { origin: "src/lib/db/factory.ts", form: "dynamic" },
      { origin: "src/lib/api/object-route.ts", form: "dynamic" },
      { origin: "src/lib/api/test-connection.ts", form: "dynamic" },
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

  test("a call is told from a value passed on, and a property of the same name is not a call", () => {
    expect(calls("await resolveConnection(body, session);", "resolveConnection")).toBe(true);
    expect(calls("const open = resolveConnection;", "resolveConnection")).toBe(false);
    expect(calls("tools.resolveConnection(body);", "resolveConnection")).toBe(false);
    expect(calls("// resolveConnection(body)", "resolveConnection")).toBe(false);
  });
});

describe("the caller census of the seed lookups, the access review and the provider builders", () => {
  test("every gated function is exported by the origin it is listed under", () => {
    for (const [origin, functions] of Object.entries(GATED_MODULES)) {
      const text = withoutComments(readFileSync(join(ROOT, origin), "utf8"));
      for (const fn of functions) {
        const exported =
          new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${fn}\\b`).test(text) ||
          new RegExp(`\\bexport\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from`).test(text);
        expect({ origin, fn, exported }).toEqual({ origin, fn, exported: true });
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
