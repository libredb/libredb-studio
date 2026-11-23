import { defineConfig } from "tsup";
import path from "path";
import ts from "typescript";
import { workspacePackageNames, workspacePackageSourcePaths } from "./scripts/workspace-packages.mjs";

/**
 * Every bun workspace package under packages/, by manifest name. `@libredb/studio` on npm cannot depend on an
 * unpublished package, so until a package is published on its own the library build bundles it: its code through
 * `noExternal` and its declarations through `DECLARATION_PATHS`.
 * The packages' own dependencies stay external because they are the root's dependencies too, and
 * scripts/check-lib-load.mjs fails by name on a dist or a packed manifest that names a workspace package.
 */
const WORKSPACE_PACKAGES = workspacePackageNames(__dirname);

/**
 * The TypeScript `paths` the declaration build resolves with: the root tsconfig's own (`@/*`, read from the file so it
 * is stated once) and one per `exports` entry of each workspace package, to its source under `packages/`
 * (packages/README.md, "Library"). rollup-plugin-dts keeps a module TypeScript found through `node_modules` as an
 * external import and inlines any other, so a package resolved through these paths, to a file outside `node_modules`,
 * is inlined with its own relative imports, at its root and at every subpath. tsup's `dts.compilerOptions` replace the
 * tsconfig's `paths` rather than merge into them, which is why the root's are spread in.
 */
const ROOT_TSCONFIG = ts.readConfigFile(path.join(__dirname, "tsconfig.json"), ts.sys.readFile);
if (ROOT_TSCONFIG.error !== undefined) {
  throw new Error(
    `tsconfig.json cannot be read: ${ts.flattenDiagnosticMessageText(ROOT_TSCONFIG.error.messageText, "\n")}`,
  );
}
const DECLARATION_PATHS = {
  ...ROOT_TSCONFIG.config.compilerOptions.paths,
  ...workspacePackageSourcePaths(__dirname),
};

export default defineConfig({
  entry: {
    index: "src/exports/index.ts",
    providers: "src/exports/providers.ts",
    types: "src/exports/types.ts",
    components: "src/exports/components.ts",
    workspace: "src/exports/workspace.ts",
    security: "src/exports/security.ts",
  },
  format: ["esm", "cjs"],
  dts: { compilerOptions: { paths: DECLARATION_PATHS } },
  splitting: true,
  sourcemap: true,
  clean: true,
  tsconfig: "tsconfig.lib.json",
  treeshake: true,
  // Keep `node:`-prefixed builtin imports intact: tsup strips the prefix by
  // default (import("node:sqlite") -> import("sqlite")), which breaks
  // node:sqlite — that builtin exists only WITH the prefix. The package
  // targets Node >= 24 + modern bundlers, which all understand `node:`.
  removeNodeProtocol: false,
  // The published JavaScript imports no stylesheet: Node cannot load a `.css` import, so a host importing the
  // package under Node would fail on the ER diagram's `@xyflow/react/dist/style.css`. Bundling every `.css` import
  // (`noExternal`, since tsup would otherwise mark a dependency's stylesheet external by its package name) and
  // loading it with esbuild's documented `empty` loader drops the import. The ER diagram's base styles reach a host
  // through `dist/styles.css` instead, which scripts/copy-theme.mjs starts with an `@import` of that stylesheet.
  noExternal: [...WORKSPACE_PACKAGES, /\.css$/],
  loader: { ".css": "empty" },
  external: [
    "react",
    "react-dom",
    "next",
    // Database drivers — consumers install what they need
    "pg",
    "mysql2",
    "better-sqlite3",
    "bun:sqlite", // Bun-runtime builtin (SQLite DB provider driver under Bun)
    "node:sqlite", // Node-runtime builtin (SQLite DB provider driver under Node)
    "oracledb",
    "mssql",
    // The DuckDB driver ends in a native `require('.../duckdb.node')`; both the
    // API package and its binding loader stay external so nothing resolves an
    // addon into the published ESM/CJS bundles.
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    // The Db2 driver's loader ends in a native `require('./db2-node.<triple>.node')`.
    "db2-node",
    // Pure JS, but external for the same reason it is in `serverExternalPackages`:
    // its optional `require('kerberos')` is unresolvable at build time.
    "cassandra-driver",
    "mongodb",
    "ioredis",
    "@platformatic/kafka",
    // The etcd provider's gRPC client and the loader that reads its generated descriptor.
    "@grpc/grpc-js",
    "@grpc/proto-loader",
    // The neo4j provider's Bolt driver; consumers install it like the other drivers.
    "neo4j-driver-lite",
    "@libredb/libredb",
    // SSH and crypto
    "ssh2",
    // Monaco editor
    "monaco-editor",
    "@monaco-editor/react",
    // LLM SDKs
    "@google/generative-ai",
    // UI libs that consumers provide
    "elkjs",
    "recharts",
    "framer-motion",
    // Exact-pinned image-capture engine (html-to-image variants choke on
    // Tailwind 4 computed styles); external like every other UI lib - it is
    // a regular dependency, so consumers resolve it via npm.
    "@zumer/snapdom",
    // The Graph tab's canvas and layout, loaded by a dynamic import in
    // cytoscape-host.ts; both are regular dependencies, exact-pinned.
    "cytoscape",
    "cytoscape-fcose",
    // The S3 object preview's Parquet reader, loaded by a dynamic import in preview-parquet.ts; ESM only, resolved by the host.
    "hyparquet",
    "hyparquet-compressors",
    "@tanstack/react-table",
    "@tanstack/react-virtual",
    "react-resizable-panels",
    "react-hook-form",
    "embla-carousel-react",
    "input-otp",
    "sonner",
    "vaul",
    "cmdk",
    "next-themes",
    // Radix primitives
    /^@radix-ui\//,
    // Utilities
    "class-variance-authority",
    "clsx",
    "tailwind-merge",
    "sql-formatter",
    "date-fns",
    "zod",
    "yaml",
    "jose",
    "openid-client",
    "lucide-react",
    // The Spark provider's Arrow decoder: a regular dependency, exact-pinned; external so a consumer resolves the one
    // copy its lockfile holds.
    "apache-arrow",
  ],
  esbuildPlugins: [
    {
      name: "resolve-at-alias",
      setup(build) {
        // Rewrite @/ → ./  and let esbuild resolve from src/
        build.onResolve({ filter: /^@\// }, async (args) => {
          return build.resolve("./" + args.path.slice(2), {
            resolveDir: path.resolve(__dirname, "src"),
            kind: args.kind,
          });
        });
      },
    },
  ],
});
