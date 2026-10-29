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
 * importing it through a barrel is counted like importing it from its own module; a namespace of a gated module given
 * on, by `export * as` or by exporting the name a namespace import bound, gives every gated function of that module.
 *
 * A form that would hide a caller from the census fails unless HIDDEN_FORMS_ALLOWED lists it, by the gated module it
 * names and the form, under the file that holds it, with its reason; a file is allowed only the forms listed under it:
 * a namespace or default import of a gated module; an `import()` or `require()` of one, with a string or a template
 * without substitutions, whose result is not destructured; an `import()` or `require()` whose specifier is not such a
 * literal, since it could name any module, a gated one included; a re-export of a gated function, `export const { f }
 * = await import()` included; in a gated function's own module, an export of it under another name or any other use of
 * it as a value than a call; and, in any file, a use of an imported gated function as a value rather than a call, in an
 * object or array literal, through `.bind` or as an argument, which an allowance names by the text around it. A call
 * through `.call` or `.apply` is a call. A call inside a gated function's own module is that module's composition,
 * pinned by the module's own tests, and is not counted. Type-only imports bind no value and are not counted either.
 *
 * Every failure names the file and line, the gated function and the specifier it came through, and says which map to
 * edit and what to add or remove there.
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
    "selfReviewSignInRole",
    "reviewedSessionRole",
  ],
  "src/lib/kubernetes-access/review.ts": ["requestAccessReview", "serviceAccountCall"],
  "src/lib/kubernetes-access/platform-check.ts": ["clusterPlatform"],
  "src/lib/kubernetes-access/decisions.ts": ["accessReviewAllows", "accessReviewVerdict"],
  "src/lib/openshift-auth/token-store.ts": ["openShiftBearerToken", "endOpenShiftSession"],
  "src/lib/openshift-auth/http.ts": ["openShiftApiCall"],
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
      "getSeedListing, the only reader of the discovered connections themselves: with the review on every one is set apart in pendingReview under the reserved role, with it off listed in before under admin through the role filter; getKubernetesDiscoveryStatus reads only their names, types and namespaces",
  },
  parseKubernetesDiscoveryExport: {
    "src/lib/seed/kubernetes-discovery-loader.ts":
      "the Kubernetes discovery source parses the export file it reads, and what it parses leaves only through getKubernetesDiscoveredConnections and, as names, types and namespaces, getKubernetesDiscoveryStatus",
  },
  mapKubernetesDatabase: {
    "src/lib/seed/kubernetes-discovery-loader.ts":
      "the Kubernetes discovery source maps each parsed database to a connection, which leaves only through getKubernetesDiscoveredConnections and, as its name and type, getKubernetesDiscoveryStatus",
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
      "the dispatcher's list: it hands the review the rows getSeedListing set apart in pendingReview and, while the review is on, any other row that names a Kubernetes Secret, and keeps a row only where the review returns that very object",
  },
  connectionUnderAccessReview: {
    "src/lib/governance/visible.ts":
      "the dispatcher's open: it hands the review only the row the id names, when getSeedListing set it apart or, while the review is on, it names a Kubernetes Secret",
  },
  accessReviewSignInRole: {
    "src/app/api/auth/oidc/callback/route.ts":
      "the OIDC callback's role while the review is on: a fresh review of the sign-in attributes, then of update on Studio's Deployment, decided once at sign-in",
  },
  selfReviewSignInRole: {
    "src/lib/openshift-auth/role.ts":
      "the openshift sign-in role seam: the callback asks it once per sign-in with the new access token, and its null refuses the sign-in with openshift_no_access before any record is written",
  },
  reviewedSessionRole: {
    "src/lib/auth.ts":
      "readSession's openshift branch, once the token record answers live: every route reads the role a request runs with from here, and its expired answer signs the session out",
  },
  requestAccessReview: {
    "src/lib/kubernetes-access/decisions.ts":
      "the decision cache, the only sender of a review: one request in flight per key, and failures never cached",
  },
  serviceAccountCall: {
    "src/lib/kubernetes-access/platform-check.ts":
      "the platform check's GET of config.openshift.io/v1 with the pod token, through the ServiceAccount review's own transport: its answer is only a 200 or 404 verdict and never names a person, a Secret or a connection",
  },
  clusterPlatform: {
    "src/lib/kubernetes-access/review.ts":
      "the ServiceAccount review asks it before each review it would send and refuses with platform on a cluster that serves config.openshift.io/v1: the verdict can only stop a review, never answer one",
  },
  accessReviewVerdict: {
    "src/lib/kubernetes-access/gate.ts":
      "the gate's self reviews, of each reviewed row and of the openshift sign-in and admin checks, the only reader of the decision cache that needs the expired verdict",
  },
  openShiftBearerToken: {
    "src/lib/openshift-auth/session.ts":
      "readSession's record check: it asks only whether the session's record is live and bound to its uid, name and issuer, and drops the token",
    "src/lib/kubernetes-access/gate.ts":
      "the gate reads the session's live token before every self review, cached or not, so no decision outlives its record, and hands it only to the review",
  },
  endOpenShiftSession: {
    "src/lib/kubernetes-access/gate.ts":
      "the gate ends a session's record when the API server answers its self review with 401, so the session signs in again from its next request",
    "src/app/api/auth/openshift/callback/route.ts":
      "the OpenShift callback ends the record of a verified cookie it replaces, and the one it wrote when minting the session fails, so no record outlives its cookie",
    "src/app/api/auth/logout/route.ts":
      "sign-out deletes the session's token record at once, so a replayed cookie reads as signed out; it reads no token",
  },
  openShiftApiCall: {
    "src/lib/openshift-auth/metadata.ts":
      "the OAuth metadata fetch from the API server at sign-in: it sends no bearer, and its answer names only the OAuth endpoints",
    "src/lib/openshift-auth/identity.ts":
      "users/~ at sign-in with the new access token: its answer names the user, never a connection, and the token goes only to the API URL",
    "src/lib/kubernetes-access/review.ts":
      "the self review's only sender: one SelfSubjectAccessReview with the user's own token, judged here, so the CA file as the only trust, the deadline and no proxy stay one implementation",
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

/** A form a file may hold that hides a gated function from the census: the gated module it names, and the form. */
interface Allowance {
  readonly origin: string | null;
  readonly form: HiddenForm;
  /** For a value use, the text around it, as the failure prints it. */
  readonly use?: string;
  readonly reason: string;
}

/**
 * Every hidden import, computed or dynamic load and alias the census allows, by file, each with the reason it may. A
 * file is allowed exactly the entries listed under it, one hidden import each: any other it holds fails.
 */
const HIDDEN_FORMS_ALLOWED: Readonly<Record<string, readonly Allowance[]>> = {
  "src/lib/db/index.ts": [
    {
      origin: "src/lib/db/factory.ts",
      form: "re-export",
      reason:
        "the provider barrel re-exports getOrCreateProvider and createDatabaseProvider from the factory; the census gates the barrel for both, so every importer through it is a reviewed caller above",
    },
  ],
  "src/exports/providers.ts": [
    {
      origin: "src/lib/db/factory.ts",
      form: "re-export",
      reason:
        "the npm package surface re-exports the factory for embedders, who build providers for connections of their own with no Studio session, listing or review; nothing in the app imports it",
    },
  ],
  "src/exports/index.ts": [
    {
      origin: "src/exports/providers.ts",
      form: "re-export",
      reason:
        "the npm package entry re-exports the package surface, ./providers included; nothing in the app imports it",
    },
  ],
  "src/lib/seed/kubernetes-discovery-loader.ts": [
    {
      origin: "src/lib/seed/kubernetes-discovery-export.ts",
      form: "value",
      use: "parse: parseKubernetesDiscoveryExport",
      reason:
        "the Kubernetes discovery source hands its export parser to createDiscoverySource (src/lib/seed/discovery-source.ts), which calls it only on the export file it reads; what it parses leaves only through getKubernetesDiscoveredConnections and, as names, types and namespaces, getKubernetesDiscoveryStatus",
    },
  ],
  "src/exports/index.js": [
    {
      origin: "src/exports/index.ts",
      form: "re-export",
      reason:
        "the CommonJS package entry for bundlers that cannot read TypeScript gives ./index.ts on as a whole; nothing in the app requires it",
    },
  ],
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
  accessReviewVerdict: ["src/lib/kubernetes-access/gate.ts"],
  selfReviewSignInRole: ["src/lib/openshift-auth/role.ts"],
  reviewedSessionRole: ["src/lib/auth.ts"],
  openShiftBearerToken: ["src/lib/kubernetes-access/gate.ts", "src/lib/openshift-auth/session.ts"],
  endOpenShiftSession: [
    "src/app/api/auth/logout/route.ts",
    "src/app/api/auth/openshift/callback/route.ts",
    "src/lib/kubernetes-access/gate.ts",
  ],
  openShiftApiCall: [
    "src/lib/kubernetes-access/review.ts",
    "src/lib/openshift-auth/identity.ts",
    "src/lib/openshift-auth/metadata.ts",
  ],
  serviceAccountCall: ["src/lib/kubernetes-access/platform-check.ts"],
  clusterPlatform: ["src/lib/kubernetes-access/review.ts"],
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

/**
 * The repository path a specifier names from `file` among `known`, or null for a package or a path not there. A `.js`
 * specifier names the TypeScript module beside it first, as the TypeScript resolver reads it, so `@/exports/index.js`
 * is the package entry, not the CommonJS file of the same name.
 */
function resolveSpecifier(file: string, specifier: string, known: ReadonlySet<string>): string | null {
  const candidates = candidatesOf(file, specifier);
  return candidates?.find((candidate) => known.has(candidate)) ?? null;
}

/** The paths a specifier may name from `file`, in the order tried, by file and specifier: the closure asks often. */
const CANDIDATES = new Map<string, readonly string[] | null>();

function candidatesOf(file: string, specifier: string): readonly string[] | null {
  const key = `${file}\0${specifier}`;
  const cached = CANDIDATES.get(key);
  if (cached !== undefined) return cached;
  let base: string | null = null;
  if (specifier.startsWith("@/")) base = repositoryPath(join(SRC, specifier.slice(2)));
  else if (specifier.startsWith(".")) base = repositoryPath(resolve(dirname(join(ROOT, file)), specifier));
  const stem = base?.replace(/\.js$/, "");
  const candidates =
    base === null ? null : [`${stem}.ts`, `${stem}.tsx`, base, `${base}/index.ts`, `${base}/index.tsx`];
  CANDIDATES.set(key, candidates);
  return candidates;
}

/** A name given or taken under another: imported `from` as local `to`, or local `from` exported as `to`. */
interface Rename {
  readonly from: string;
  readonly to: string;
}

/** What one file's syntax tree says about the values it takes from other modules and gives on. */
interface FileFacts {
  /** `import { a as b }` and `const { a: b } = await import()` or `= require()`, by specifier. */
  readonly named: readonly { readonly specifier: string; readonly names: readonly Rename[]; readonly line: number }[];
  /** A whole module bound to one name: namespace, default, `import x = require()`, or an undestructured load. */
  readonly whole: readonly {
    readonly specifier: string;
    readonly form: "namespace" | "default" | "dynamic";
    /** The name the module is bound to, or null for a load whose result is used in place. */
    readonly local: string | null;
    readonly line: number;
  }[];
  /** How many `import()` and `require()` calls name their module with anything but a literal. */
  readonly computed: readonly { readonly specifier: string; readonly line: number }[];
  /**
   * `export ... from`: the names given on, `*` for `export *` and for `module.exports = require()`, and a `from` of `*`
   * for `export * as x`.
   */
  readonly reExports: readonly {
    readonly specifier: string;
    readonly names: readonly Rename[] | "*";
    readonly line: number;
  }[];
  /** `export { a as b }`, `export default a` and `export const b = a`: a local name given on. */
  readonly localExports: readonly (Rename & { readonly line: number })[];
  /** Every name the file exports. */
  readonly exported: ReadonlySet<string>;
  /** Each use of one of the file's own gated functions as a value: not a call, its declaration or `export { f }`. */
  readonly aliases: readonly { readonly name: string; readonly line: number }[];
  /**
   * Each use of a name the file imports as a value, not a call nor a give-on `localExports` holds, with where the text
   * around it starts and ends, read only for a gated name.
   */
  readonly uses: readonly {
    readonly name: string;
    readonly start: number;
    readonly end: number;
    readonly line: number;
  }[];
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

/** `module.exports = require(x)`: a CommonJS module that gives all of another on, like `export * from x`. */
function isWholeCommonJsExport(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    ts.isIdentifier(node.left.expression) &&
    node.left.expression.text === "module" &&
    node.left.name.text === "exports" &&
    isModuleLoad(unwrapped(node.right))
  );
}

/** Whether a statement carries `export`. */
const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

/** Whether `node`, under `parent`, is `f.call(...)` or `f.apply(...)`: a call of `f`. */
const callsThrough = (node: ts.Node, parent: ts.Node, grand: ts.Node | undefined): boolean =>
  ts.isPropertyAccessExpression(parent) &&
  parent.expression === node &&
  (parent.name.text === "call" || parent.name.text === "apply") &&
  grand !== undefined &&
  ts.isCallExpression(grand) &&
  grand.expression === parent;

/**
 * Whether the identifier `node` uses its value: it is not a callee, also through `.call` or `.apply`, nor a name a
 * declaration, property or key gives.
 */
function usesValue(node: ts.Identifier, parent: ts.Node, grand?: ts.Node): boolean {
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return false;
  if (callsThrough(node, parent, grand)) return false;
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
  const named: FileFacts["named"][number][] = [];
  const whole: FileFacts["whole"][number][] = [];
  const reExports: FileFacts["reExports"][number][] = [];
  const localExports: FileFacts["localExports"][number][] = [];
  const exported = new Set<string>();
  const aliases: FileFacts["aliases"][number][] = [];
  const uses: FileFacts["uses"][number][] = [];
  const destructured = new Set<ts.Node>();
  /** The identifiers a give-on `localExports` holds already reads, so they are not value uses as well. */
  const givenOn = new Set<ts.Node>();
  const computed: FileFacts["computed"][number][] = [];
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const imported = new Set(
    sourceFile.statements.flatMap((statement) => {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
      return bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.map((e) => e.name.text) : [];
    }),
  );

  const readImport = (node: ts.ImportDeclaration): void => {
    const specifier = literal(node.moduleSpecifier);
    const clause = node.importClause;
    if (specifier === null || clause === undefined || clause.isTypeOnly) return;
    const line = lineOf(node);
    if (clause.name !== undefined) whole.push({ specifier, form: "default", local: clause.name.text, line });
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      whole.push({ specifier, form: "namespace", local: bindings.name.text, line });
      return;
    }
    const names = bindings.elements.filter((element) => !element.isTypeOnly);
    named.push({
      specifier,
      names: names.map((e) => ({ from: (e.propertyName ?? e.name).text, to: e.name.text })),
      line,
    });
  };

  const readExport = (node: ts.ExportDeclaration): void => {
    if (node.isTypeOnly) return;
    const clause = node.exportClause;
    const specifier = node.moduleSpecifier === undefined ? undefined : literal(node.moduleSpecifier);
    const line = lineOf(node);
    if (clause !== undefined && ts.isNamespaceExport(clause)) {
      exported.add(clause.name.text);
      if (typeof specifier === "string") {
        reExports.push({ specifier, names: [{ from: "*", to: clause.name.text }], line });
      }
      return;
    }
    const names = (clause?.elements ?? [])
      .filter((element) => !element.isTypeOnly)
      .map((e) => ({ from: (e.propertyName ?? e.name).text, to: e.name.text }));
    for (const { to } of names) exported.add(to);
    if (typeof specifier === "string") reExports.push({ specifier, names: clause === undefined ? "*" : names, line });
    if (specifier !== undefined) return;
    for (const rename of names) {
      localExports.push({ ...rename, line });
      if (own.has(rename.from) && rename.from !== rename.to) aliases.push({ name: rename.from, line });
    }
  };

  const visit = (node: ts.Node, parent: ts.Node, grand?: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return readImport(node);
    if (ts.isExportDeclaration(node)) return readExport(node);
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      const specifier = ts.isExternalModuleReference(reference) ? literal(reference.expression) : null;
      if (!node.isTypeOnly && specifier !== null) {
        whole.push({ specifier, form: "namespace", local: node.name.text, line: lineOf(node) });
      }
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const load = unwrapped(node.initializer);
      const specifier = isModuleLoad(load) ? literal(load.arguments[0]) : null;
      const names = specifier === null ? null : patternNames(node.name);
      if (specifier !== null && names !== null) {
        named.push({ specifier, names, line: lineOf(node) });
        destructured.add(load);
        for (const { to } of names) imported.add(to);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const load = unwrapped(node.initializer);
      const specifier = isModuleLoad(load) ? literal(load.arguments[0]) : null;
      if (specifier !== null) {
        whole.push({ specifier, form: "dynamic", local: node.name.text, line: lineOf(node) });
        destructured.add(load);
      }
    }
    if (isModuleLoad(node) && !destructured.has(node)) {
      const specifier = literal(node.arguments[0]);
      const argument = node.arguments[0];
      if (specifier === null) computed.push({ specifier: argument?.getText(sourceFile) ?? "", line: lineOf(node) });
      else whole.push({ specifier, form: "dynamic", local: null, line: lineOf(node) });
    }
    if (isWholeCommonJsExport(node)) {
      const load = unwrapped(node.right) as ts.CallExpression;
      const specifier = literal(load.arguments[0]);
      if (specifier !== null) {
        reExports.push({ specifier, names: "*", line: lineOf(node) });
        destructured.add(load);
      }
    }
    if (ts.isExportAssignment(node)) {
      const value = unwrapped(node.expression);
      exported.add("default");
      if (ts.isIdentifier(value)) {
        localExports.push({ from: value.text, to: "default", line: lineOf(node) });
        givenOn.add(value);
      }
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            exported.add(element.name.text);
            localExports.push({ from: element.name.text, to: element.name.text, line: lineOf(element) });
          }
          continue;
        }
        if (!ts.isIdentifier(declaration.name)) continue;
        exported.add(declaration.name.text);
        const value = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
        if (value !== undefined && ts.isIdentifier(value)) {
          localExports.push({ from: value.text, to: declaration.name.text, line: lineOf(declaration) });
          givenOn.add(value);
        }
      }
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      isExported(node)
    ) {
      exported.add(node.name.text);
    }
    if (ts.isIdentifier(node) && (own.has(node.text) || imported.has(node.text)) && usesValue(node, parent, grand)) {
      if (own.has(node.text)) aliases.push({ name: node.text, line: lineOf(node) });
      else if (!givenOn.has(node)) {
        uses.push({ name: node.text, start: parent.getStart(sourceFile), end: parent.end, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, (child) => visit(child, node, parent));
  };

  ts.forEachChild(sourceFile, (child) => visit(child, sourceFile));
  const facts: FileFacts = { named, whole, computed, reExports, localExports, exported, aliases, uses };
  FACTS.set(file, { text, facts });
  return facts;
}

/** A gated function a file binds: the module it imports it from, the function, and the local name it is bound to. */
interface Binding {
  readonly origin: string;
  readonly fn: string;
  readonly local: string;
  /** Where: the line of the import and the specifier it names the module with. */
  readonly line: number;
  readonly specifier: string;
}

/**
 * The gated functions by module, by the name the module exports: one function for a function, every gated function of
 * a module for a namespace of it.
 */
type Gated = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

type HiddenForm = "namespace" | "default" | "dynamic" | "computed" | "re-export" | "alias" | "value";

/** A form that hides which gated function a file uses, with the gated module it hides, or null when it may be any. */
interface HiddenImport {
  readonly origin: string | null;
  readonly form: HiddenForm;
  /** For a value use, the text around it. */
  readonly use?: string;
  /** The gated functions it hides, by name, or null when it may hide any. */
  readonly fn: string | null;
  readonly line: number;
  /** The specifier as written, or null for a use of the module's own function. */
  readonly specifier: string | null;
}

interface FileImports {
  readonly bindings: Binding[];
  readonly hidden: HiddenImport[];
}

/** The gated functions `file` imports by name, each under its local name. */
function bindingsOf(file: string, facts: FileFacts, gated: Gated, known: ReadonlySet<string>): Binding[] {
  return facts.named.flatMap(({ specifier, names, line }) => {
    const origin = resolveSpecifier(file, specifier, known);
    const functions = origin === null ? undefined : gated.get(origin);
    if (origin === null || functions === undefined) return [];
    return names.flatMap(({ from, to }) =>
      (functions.get(from) ?? []).map((fn) => ({ origin, fn, local: to, line, specifier })),
    );
  });
}

/** Every gated function a module gives on, once each: what a namespace of it carries. */
const allOf = (functions: ReadonlyMap<string, readonly string[]> | undefined): string[] => [
  ...new Set([...(functions?.values() ?? [])].flat()),
];

/** The gated functions each name `file` binds a gated module's value to: named imports and whole modules. */
function boundIn(file: string, facts: FileFacts, gated: Gated, known: ReadonlySet<string>): Map<string, string[]> {
  const bound = new Map<string, string[]>();
  const bind = (local: string, fns: readonly string[]): void => {
    if (fns.length > 0) bound.set(local, [...new Set([...(bound.get(local) ?? []), ...fns])]);
  };
  for (const fn of GATED_MODULES[file] ?? []) bind(fn, [fn]);
  for (const { fn, local } of bindingsOf(file, facts, gated, known)) bind(local, [fn]);
  for (const { specifier, form, local } of facts.whole) {
    const functions = gated.get(resolveSpecifier(file, specifier, known) ?? "");
    if (local === null || functions === undefined) continue;
    bind(local, form === "default" ? (functions.get("default") ?? []) : allOf(functions));
  }
  return bound;
}

/**
 * GATED_MODULES closed under giving on: a module that re-exports a gated function, by name or with `export *`, or
 * exports under any name a gated function it imported or declares, is gated for it under that name, until no module
 * gains a function. A namespace of a gated module given on, by `export * as` or by exporting the name a namespace
 * import or a whole load bound, gives every gated function of that module under that name.
 */
function closeUnderReExport(sources: ReadonlyMap<string, string>): Gated {
  const known = new Set(sources.keys());
  const facts = [...sources].map(([file, text]) => [file, factsOf(file, text)] as const);
  const gated = new Map(
    Object.entries(GATED_MODULES).map(([origin, fns]) => [
      origin,
      new Map<string, readonly string[]>(fns.map((fn) => [fn, [fn]])),
    ]),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, fact] of facts) {
      const given: [string, readonly string[]][] = [];
      for (const { specifier, names } of fact.reExports) {
        const from = gated.get(resolveSpecifier(file, specifier, known) ?? "");
        if (from === undefined) continue;
        if (names === "*") given.push(...from);
        else
          given.push(
            ...names.map(({ from: name, to }): [string, readonly string[]] => [
              to,
              name === "*" ? allOf(from) : (from.get(name) ?? []),
            ]),
          );
      }
      const bound = boundIn(file, fact, gated, known);
      for (const { from, to } of fact.localExports) given.push([to, bound.get(from) ?? []]);
      const into = gated.get(file) ?? new Map<string, readonly string[]>();
      for (const [name, fns] of given) {
        if (fns.length === 0 || into.has(name)) continue;
        into.set(name, fns);
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
  const named = (fns: readonly string[]): string | null => (fns.length === 0 ? null : [...new Set(fns)].join(", "));
  /** Each local name bound to a gated module's value: the module, the specifier and the functions it carries. */
  const importedFrom = new Map<string, { origin: string; specifier: string; fns: string[] }>();
  for (const { local, origin, specifier, fn } of bindings) {
    importedFrom.set(local, { origin, specifier, fns: [...(importedFrom.get(local)?.fns ?? []), fn] });
  }
  const namedFrom = new Map(importedFrom);
  for (const { specifier, form, local, line } of facts.whole) {
    const origin = gatedOrigin(specifier);
    if (origin === null) continue;
    const functions = gated.get(origin);
    const fns = form === "default" ? [...(functions?.get("default") ?? [])] : allOf(functions);
    hidden.push({ origin, form, fn: named(fns), line, specifier });
    if (local !== null) importedFrom.set(local, { origin, specifier, fns });
  }
  for (const { specifier, names, line } of facts.reExports) {
    const origin = gatedOrigin(specifier);
    const from = gated.get(origin ?? "");
    if (origin === null || from === undefined) continue;
    const fns =
      names === "*"
        ? allOf(from)
        : names.flatMap(({ from: name }) => (name === "*" ? allOf(from) : (from.get(name) ?? [])));
    if (fns.length > 0) hidden.push({ origin, form: "re-export", fn: named(fns), line, specifier });
  }
  for (const { from, line } of facts.localExports) {
    const imported = importedFrom.get(from);
    if (imported !== undefined) {
      const { origin, specifier, fns } = imported;
      hidden.push({ origin, form: "re-export", fn: named(fns), line, specifier });
    }
  }
  for (const { specifier, line } of facts.computed) {
    hidden.push({ origin: null, form: "computed", fn: null, line, specifier });
  }
  for (const { name, line } of facts.aliases) {
    hidden.push({ origin: file, form: "alias", fn: name, line, specifier: null });
  }
  for (const { name, start, end, line } of facts.uses) {
    const imported = namedFrom.get(name);
    if (imported === undefined) continue;
    const { origin, specifier, fns } = imported;
    const use = source.slice(start, end).replace(/\s+/g, " ").slice(0, 120);
    hidden.push({ origin, form: "value", use, fn: named(fns), line, specifier });
  }
  return { bindings, hidden };
}

interface Census {
  readonly gated: Gated;
  /** function -> the files that import it, each with its first import of it */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, Binding>>;
  /** file -> the hidden imports it holds */
  readonly hidden: ReadonlyMap<string, readonly HiddenImport[]>;
}

function takeCensus(sources: ReadonlyMap<string, string>): Census {
  const known = new Set(sources.keys());
  const gated = closeUnderReExport(sources);
  const importers = new Map<string, Map<string, Binding>>();
  const hidden = new Map<string, HiddenImport[]>();
  for (const [file, source] of sources) {
    const found = importsOf(file, source, gated, known);
    if (found.hidden.length > 0) hidden.set(file, found.hidden);
    for (const binding of found.bindings) {
      const files = importers.get(binding.fn) ?? new Map<string, Binding>();
      if (!files.has(file)) files.set(file, binding);
      importers.set(binding.fn, files);
    }
  }
  return { gated, importers, hidden };
}

const census = takeCensus(SOURCES);
const GATED = census.gated;

/** What a hidden import hides, as a failure says it. */
function hiddenForm({ origin, form, fn, specifier, use }: HiddenImport): string {
  const from = `"${specifier}" (${origin})`;
  if (form === "computed") {
    return `import() or require() of ${specifier} names its module with an expression, which may be any gated module`;
  }
  if (form === "re-export") return `gives ${fn} on from ${from}`;
  if (form === "alias") return `uses its own gated function ${fn} as a value, not a call`;
  if (form === "value") return `uses ${fn}, imported from ${from}, as a value, not a call: \`${use}\``;
  return `${form} import of ${from} hides which of ${fn ?? "its exports"} it uses`;
}

/** An allowance as HIDDEN_FORMS_ALLOWED spells it, without its reason. */
const allowanceOf = ({ origin, form, use }: HiddenImport | Allowance): string =>
  `{ origin: ${JSON.stringify(origin)}, form: "${form}"${use === undefined ? "" : `, use: ${JSON.stringify(use)}`} }`;

/** How to allow `hidden` in `file`, for a failure to say. */
const toAllow = (file: string, hidden: HiddenImport): string =>
  `Import the function by name and call it, or add ${allowanceOf(hidden).replace(/ }$/, ', reason: "<why it hides no caller>" }')} under "${file}" in HIDDEN_FORMS_ALLOWED`;

/** The files that import a gated function REVIEWED_CALLERS does not list under it, with how to list them. */
function unreviewed(found: Census): string[] {
  return [...found.importers].flatMap(([fn, files]) =>
    [...files]
      .filter(([file]) => !(file in (REVIEWED_CALLERS[fn] ?? {})))
      .map(([file, { line, specifier, origin }]) => {
        const pinned = fn in PINNED_EXACTLY ? `, and "${file}" to PINNED_EXACTLY.${fn}` : "";
        return `${file}:${line} imports ${fn} from "${specifier}" (${origin}), and REVIEWED_CALLERS does not list it under ${fn}: reach the connection through a reviewed caller instead, or add "${file}": "<why it cannot reach a reviewed connection>" under ${fn} in REVIEWED_CALLERS${pinned}`;
      }),
  );
}

/** The entries of REVIEWED_CALLERS whose file no longer imports their function. */
function staleCallers(found: Census): string[] {
  return Object.entries(REVIEWED_CALLERS).flatMap(([fn, files]) =>
    Object.keys(files)
      .filter((file) => !found.importers.get(fn)?.has(file))
      .map((file) => {
        const pinned = fn in PINNED_EXACTLY ? ` and from PINNED_EXACTLY.${fn}` : "";
        return `REVIEWED_CALLERS.${fn} lists "${file}", which imports ${fn} no more: remove that entry${pinned}`;
      }),
  );
}

const sameForm = (a: HiddenImport, b: HiddenImport | Allowance): boolean =>
  a.origin === b.origin && a.form === b.form && a.use === b.use;

/** The hidden imports of `found` no allowance of its file covers, each allowance covering one. */
function unallowed(found: Census): string[] {
  return [...found.hidden].flatMap(([file, imports]) => {
    const left = [...(HIDDEN_FORMS_ALLOWED[file] ?? [])];
    return imports.flatMap((hidden) => {
      const index = left.findIndex((allowance) => sameForm(hidden, allowance));
      if (index >= 0) {
        left.splice(index, 1);
        return [];
      }
      return [`${file}:${hidden.line} ${hiddenForm(hidden)}. ${toAllow(file, hidden)}`];
    });
  });
}

/** The allowances of HIDDEN_FORMS_ALLOWED no hidden import of their file uses, each hidden import using one. */
function staleAllowances(found: Census): string[] {
  return Object.entries(HIDDEN_FORMS_ALLOWED).flatMap(([file, allowances]) => {
    const left = [...(found.hidden.get(file) ?? [])];
    return allowances.flatMap((allowance) => {
      const index = left.findIndex((hidden) => sameForm(hidden, allowance));
      if (index >= 0) {
        left.splice(index, 1);
        return [];
      }
      return [
        `HIDDEN_FORMS_ALLOWED["${file}"] lists ${allowanceOf(allowance)}, which no hidden import of that file matches any more: remove that entry`,
      ];
    });
  });
}

const pairs = (importers: Census["importers"]): string[] =>
  [...importers].flatMap(([fn, files]) => [...files.keys()].map((file) => `${fn} <- ${file}`)).sort();

/** A hidden import as the tests below read it: what it hides, without where. */
const shapeOf = ({ origin, form, use }: HiddenImport): object => ({
  origin,
  form,
  ...(use === undefined ? {} : { use }),
});

/** A binding as the tests below read it: what it binds, without where. */
const boundAs = ({ origin, fn, local }: Binding): object => ({ origin, fn, local });

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
    expect(bindings.map(boundAs)).toEqual([
      { origin: "src/lib/seed/index.ts", fn: "getManagedConnections", local: "getManagedConnections" },
      { origin: "src/lib/seed/resolve-connection.ts", fn: "resolveConnection", local: "open" },
      { origin: "src/lib/governance/visible.ts", fn: "visibleConnectionById", local: "byId" },
      { origin: "src/lib/db/index.ts", fn: "getOrCreateProvider", local: "build" },
    ]);
    expect(hidden.map(shapeOf)).toEqual([]);
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
    expect(hidden.map(shapeOf)).toEqual([
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
    expect(importsOf(BARREL, barrel, gated).hidden.map(shapeOf)).toEqual([
      { origin: "src/lib/seed/index.ts", form: "re-export" },
      { origin: "src/lib/seed/index.ts", form: "re-export" },
    ]);
    const known = new Set([...KNOWN, BARREL]);
    expect(importsOf(FILE, importer, gated, known).bindings.map(boundAs)).toEqual([
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
      ["createDatabaseProvider", ["createDatabaseProvider"]],
      ["getOrCreateProvider", ["getOrCreateProvider"]],
    ]);
    for (const barrel of ["src/exports/providers.ts", "src/exports/index.ts", "src/exports/index.js"]) {
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
    expect(found.bindings.map(boundAs)).toEqual([
      { origin: "src/lib/seed/index.ts", fn: "getSeedListing", local: "list" },
    ]);
    expect(found.hidden.map(shapeOf)).toEqual([
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
    expect(importsOf(INDEX, aliasing, gated).hidden.map(shapeOf)).toEqual([
      { origin: INDEX, form: "alias" },
      { origin: INDEX, form: "alias" },
      { origin: INDEX, form: "alias" },
    ]);
    expect(importsOf(FILE, importer, gated).bindings.map(boundAs)).toEqual([
      { origin: INDEX, fn: "getSeedListing", local: "listSeeds" },
      { origin: INDEX, fn: "getSeedListing", local: "listing" },
    ]);
  });

  test("(d) a specifier ending in .js names the TypeScript module beside it before the JavaScript file", () => {
    expect(resolveSpecifier(FILE, "@/exports/index.js", KNOWN)).toBe("src/exports/index.ts");
    expect(resolveSpecifier(FILE, "../../exports/index.js", KNOWN)).toBe("src/exports/index.ts");
    expect(resolveSpecifier(FILE, "@/lib/seed/index.js", KNOWN)).toBe("src/lib/seed/index.ts");
    const found = importsOf(
      FILE,
      [
        'import { createDatabaseProvider } from "@/exports/index.js";',
        'import { getOrCreateProvider } from "../../exports/index.js";',
      ].join("\n"),
      GATED,
    );
    expect(found.bindings.map(boundAs)).toEqual([
      { origin: "src/exports/index.ts", fn: "createDatabaseProvider", local: "createDatabaseProvider" },
      { origin: "src/exports/index.ts", fn: "getOrCreateProvider", local: "getOrCreateProvider" },
    ]);
  });

  test("(e) a CommonJS whole re-export gives every gated function of the module it requires on, like export *", () => {
    expect([...(GATED.get("src/exports/index.js")?.keys() ?? [])].sort()).toEqual([
      "createDatabaseProvider",
      "getOrCreateProvider",
      "withOneShotTunnel",
    ]);
    const CJS = "src/lib/census-probe/whole.js";
    const whole = 'module.exports = require("@/lib/seed");';
    const importer = 'import { getSeedListing } from "./whole.js";';
    const gated = closeUnderReExport(new Map([...SOURCES, [CJS, whole], [FILE, importer]]));
    expect(importsOf(CJS, whole, gated).hidden.map(shapeOf)).toEqual([
      { origin: "src/lib/seed/index.ts", form: "re-export" },
    ]);
    expect(importsOf(FILE, importer, gated, new Set([...KNOWN, CJS])).bindings.map(boundAs)).toEqual([
      { origin: CJS, fn: "getSeedListing", local: "getSeedListing" },
    ]);
  });

  test("(f) a namespace import or `export * as` of a gated module, given on, gives every gated function of it", () => {
    const BARREL = "src/lib/census-probe/barrel.ts";
    const SEED = "src/lib/seed/index.ts";
    const barrel = [
      'import * as seedNs from "@/lib/seed";',
      "export { seedNs };",
      'export * as seedNs2 from "@/lib/seed";',
    ].join("\n");
    const importer = 'import { seedNs, seedNs2 } from "./barrel";';
    const gated = closeUnderReExport(new Map([...SOURCES, [BARREL, barrel], [FILE, importer]]));
    const seedFns = [...GATED_MODULES[SEED]];
    expect([...(gated.get(BARREL) ?? [])]).toEqual([
      ["seedNs2", seedFns],
      ["seedNs", seedFns],
    ]);
    expect(importsOf(FILE, importer, gated, new Set([...KNOWN, BARREL])).bindings.map(boundAs)).toEqual([
      ...seedFns.map((fn) => ({ origin: BARREL, fn, local: "seedNs" })),
      ...seedFns.map((fn) => ({ origin: BARREL, fn, local: "seedNs2" })),
    ]);
  });

  test("(g) an allowed file is allowed only its own hidden imports, each by origin and form", () => {
    const DB = "src/lib/db/index.ts";
    const at = (SOURCES.get(DB) ?? "").split("\n").length + 1;
    const withExtra = (extra: string): string[] =>
      unallowed(takeCensus(new Map([...SOURCES, [DB, `${SOURCES.get(DB)}\n${extra}\n`]])));
    const seedFns = GATED_MODULES["src/lib/seed/index.ts"].join(", ");
    const allow = (origin: string, form: string): string =>
      `Import the function by name and call it, or add { origin: "${origin}", form: "${form}", reason: "<why it hides no caller>" } under "${DB}" in HIDDEN_FORMS_ALLOWED`;
    expect(unallowed(census)).toEqual([]);
    expect(withExtra('import * as seedNs from "@/lib/seed";\nexport { seedNs };')).toEqual([
      `${DB}:${at} namespace import of "@/lib/seed" (src/lib/seed/index.ts) hides which of ${seedFns} it uses. ${allow("src/lib/seed/index.ts", "namespace")}`,
      `${DB}:${at + 1} gives ${seedFns} on from "@/lib/seed" (src/lib/seed/index.ts). ${allow("src/lib/seed/index.ts", "re-export")}`,
    ]);
    expect(withExtra('export * as seedNs from "@/lib/seed";')).toEqual([
      `${DB}:${at} gives ${seedFns} on from "@/lib/seed" (src/lib/seed/index.ts). ${allow("src/lib/seed/index.ts", "re-export")}`,
    ]);
    expect(withExtra('export { withOneShotTunnel } from "./factory";')).toEqual([
      `${DB}:${at} gives withOneShotTunnel on from "./factory" (src/lib/db/factory.ts). ${allow("src/lib/db/factory.ts", "re-export")}`,
    ]);
  });

  test("(k) every failure names the function, the file, the line and the specifier, and the map to edit", () => {
    const PROBE = "src/lib/census-probe/caller.ts";
    const VISIBLE = "src/lib/governance/visible.ts";
    const at = (SOURCES.get(VISIBLE) ?? "").split("\n").length + 1;
    const found = takeCensus(
      new Map([
        ...SOURCES,
        [PROBE, 'import { getSeedListing } from "@/lib/seed";\nconst load = (name: string) => import(name);'],
        [VISIBLE, `${SOURCES.get(VISIBLE)}\nexport const lookups = [connectionsUnderAccessReview];\n`],
      ]),
    );
    expect(unreviewed(found)).toEqual([
      `${PROBE}:1 imports getSeedListing from "@/lib/seed" (src/lib/seed/index.ts), and REVIEWED_CALLERS does not list it under getSeedListing: reach the connection through a reviewed caller instead, or add "${PROBE}": "<why it cannot reach a reviewed connection>" under getSeedListing in REVIEWED_CALLERS, and "${PROBE}" to PINNED_EXACTLY.getSeedListing`,
    ]);
    expect(unallowed(found)).toEqual([
      `${VISIBLE}:${at} uses connectionsUnderAccessReview, imported from "@/lib/kubernetes-access/gate" (src/lib/kubernetes-access/gate.ts), as a value, not a call: \`[connectionsUnderAccessReview]\`. Import the function by name and call it, or add { origin: "src/lib/kubernetes-access/gate.ts", form: "value", use: "[connectionsUnderAccessReview]", reason: "<why it hides no caller>" } under "${VISIBLE}" in HIDDEN_FORMS_ALLOWED`,
      `${PROBE}:2 import() or require() of name names its module with an expression, which may be any gated module. Import the function by name and call it, or add { origin: null, form: "computed", reason: "<why it hides no caller>" } under "${PROBE}" in HIDDEN_FORMS_ALLOWED`,
    ]);
    const without = takeCensus(new Map([...SOURCES].filter(([file]) => file !== "src/lib/mcp/context.ts")));
    expect(staleCallers(without)).toEqual([
      'REVIEWED_CALLERS.getManagedConnections lists "src/lib/mcp/context.ts", which imports getManagedConnections no more: remove that entry',
      'REVIEWED_CALLERS.acquireExecutionProfileProvider lists "src/lib/mcp/context.ts", which imports acquireExecutionProfileProvider no more: remove that entry',
    ]);
    const LOADER = "src/lib/seed/kubernetes-discovery-loader.ts";
    const unparsed = (SOURCES.get(LOADER) ?? "").replace(
      "parse: parseKubernetesDiscoveryExport,",
      "parse: (text) => parseKubernetesDiscoveryExport(text),",
    );
    expect(staleAllowances(takeCensus(new Map([...SOURCES, [LOADER, unparsed]])))).toEqual([
      `HIDDEN_FORMS_ALLOWED["${LOADER}"] lists { origin: "src/lib/seed/kubernetes-discovery-export.ts", form: "value", use: "parse: parseKubernetesDiscoveryExport" }, which no hidden import of that file matches any more: remove that entry`,
    ]);
  });

  test("(h) a non-call value use of an imported gated function is a hidden import, a call is not", () => {
    const SEED = "src/lib/seed/index.ts";
    const GATE = "src/lib/kubernetes-access/gate.ts";
    const found = importsOf(
      FILE,
      [
        'import { getSeedListing, getManagedConnections as managed } from "@/lib/seed";',
        'import { connectionsUnderAccessReview } from "@/lib/kubernetes-access/gate";',
        "export const seedApi = { getSeedListing, review: connectionsUnderAccessReview };",
        "export const lookups = [managed];",
        "export const bound = getSeedListing.bind(null);",
        "register(managed);",
        'await getSeedListing(["admin"]);',
        'await managed.call(null, ["admin"]);',
        'await getSeedListing.apply(null, [["admin"]]);',
      ].join("\n"),
      GATED,
    );
    expect(found.hidden.map(shapeOf)).toEqual([
      { origin: SEED, form: "value", use: "getSeedListing" },
      { origin: GATE, form: "value", use: "review: connectionsUnderAccessReview" },
      { origin: SEED, form: "value", use: "[managed]" },
      { origin: SEED, form: "value", use: "getSeedListing.bind" },
      { origin: SEED, form: "value", use: "register(managed)" },
    ]);
  });

  test("(i) a binding pattern that exports a dynamic import's gated function gives it on", () => {
    const VISIBLE = "src/lib/governance/visible.ts";
    const text = `${SOURCES.get(VISIBLE)}\nexport const { getSeedListing: listing2 } = await import("@/lib/seed");\n`;
    const importer = 'import { listing2 } from "@/lib/governance/visible";';
    const gated = closeUnderReExport(new Map([...SOURCES, [VISIBLE, text], [FILE, importer]]));
    expect(gated.get(VISIBLE)?.get("listing2")).toEqual(["getSeedListing"]);
    expect(importsOf(VISIBLE, text, gated).hidden.map(shapeOf)).toEqual([
      { origin: "src/lib/seed/index.ts", form: "re-export" },
    ]);
    expect(importsOf(FILE, importer, gated).bindings.map(boundAs)).toEqual([
      { origin: VISIBLE, fn: "getSeedListing", local: "listing2" },
    ]);
  });

  test("(j) a reviewed caller that hands a gated function on as a value fails the census, and .call is a call", () => {
    const withExtra = (file: string, extra: string): number =>
      unallowed(takeCensus(new Map([...SOURCES, [file, `${SOURCES.get(file)}\n${extra}\n`]]))).length;
    const VISIBLE = "src/lib/governance/visible.ts";
    expect(withExtra(VISIBLE, "export const seedApi = { getSeedListing, review: connectionsUnderAccessReview };")).toBe(
      2,
    );
    expect(withExtra("src/lib/seed/resolve-connection.ts", "export const lookups = [visibleConnectionById];")).toBe(1);
    expect(withExtra(VISIBLE, "export const bound = getSeedListing.bind(null);")).toBe(1);
    expect(withExtra(VISIBLE, 'export const { getSeedListing: listing2 } = await import("@/lib/seed");')).toBe(1);
    expect(
      withExtra(
        "src/lib/seed/index.ts",
        "export async function viaCall() { return getManagedConnections.call(null, []); }",
      ),
    ).toBe(0);
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
    expect({ bindings: found.bindings.map(boundAs), hidden: found.hidden }).toEqual({
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
    expect(unreviewed(census)).toEqual([]);
  });

  test("no reviewed caller is stale", () => {
    expect(staleCallers(census)).toEqual([]);
  });

  test("every reviewed caller and every allowance says why, in at least 20 characters", () => {
    const reasons = [
      ...Object.values(REVIEWED_CALLERS).flatMap((files) => Object.entries(files)),
      ...Object.entries(HIDDEN_FORMS_ALLOWED).flatMap(([file, allowances]) =>
        allowances.map(({ reason }) => [file, reason] as const),
      ),
    ];
    expect(reasons.filter(([, reason]) => reason.trim().length < 20)).toEqual([]);
  });

  test("no file hides a gated module behind a namespace, default or dynamic import or a re-export, unless allowed", () => {
    expect(unallowed(census)).toEqual([]);
  });

  test("no allowance is stale", () => {
    expect(staleAllowances(census)).toEqual([]);
  });

  test("the chain that sets reviewed connections apart, reviews them and hands them out has exactly its callers", () => {
    for (const [fn, files] of Object.entries(PINNED_EXACTLY)) {
      expect({ fn, files: [...(census.importers.get(fn)?.keys() ?? [])].sort() }).toEqual({ fn, files: [...files] });
    }
  });

  test("the openshift HTTPS client sends only through openShiftApiCall and openShiftTokenFetch, and exports nothing else that sends", () => {
    const file = "src/lib/openshift-auth/http.ts";
    const source = ts.createSourceFile(file, SOURCES.get(file) ?? "", ts.ScriptTarget.Latest, true);
    const exportedFunctions = new Map<string, string>();
    let callIsExported = true;
    for (const statement of source.statements) {
      const exported = ts.canHaveModifiers(statement)
        ? (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        : false;
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        if (statement.name.text === "openShiftHttpsCall") callIsExported = exported;
        else if (exported) exportedFunctions.set(statement.name.text, statement.getText(source));
      }
      if (ts.isExportDeclaration(statement)) exportedFunctions.set("export declaration", statement.getText(source));
    }
    const senders = [...exportedFunctions]
      .filter(([, text]) => /\bopenShiftHttpsCall\s*\(|\bhttps\.request\s*\(|\brequest\s*\(/.test(text))
      .map(([name]) => name)
      .sort();
    expect(callIsExported).toBe(false);
    expect(senders).toEqual(["openShiftApiCall", "openShiftTokenFetch"]);
    expect(exportedFunctions.has("export declaration")).toBe(false);
  });
});
