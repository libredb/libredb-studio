/**
 * The built-in modules a provider package may import (docs/providers/CONTRACT.md, clause C-102): Node.js's list, as
 * Studio commits it, less the names a later Node.js release Studio runs on no longer serves, so every admitted name is
 * a built-in of every Node.js release Studio runs on: the engines floor, 24, and the images' release.
 *
 * `NODE_BUILTIN_MODULES` is `builtinModules` of `node:module` on Node.js 24.0.0, the release package.json
 * `engines.node` names as its floor, read with `node -p 'JSON.stringify(require("node:module").builtinModules)'`
 * and kept in the order it sorts to. Every name of it that does not start with `node:` is also a built-in in its
 * `node:` form; the four names that start with `node:` have no bare form.
 *
 * `NODE_BUILTINS_DROPPED_LATER` names the floor's names a later release Studio runs on no longer serves, and
 * `isNodeBuiltin` refuses each in every form, bare and `node:`. Node.js resolves a bare name it does not serve as a
 * package, by walking node_modules directories up from the importing file and out of the package's directory, and
 * fails at a `node:` name it does not serve, so admitting either form would make one admitted package load on one
 * release and not on another. node-builtins-runtimes.test.ts holds every admitted name, in each form, to each Node.js
 * release it is given, the images' release among them in CI, so a release that drops one more fails there by the name.
 *
 * Admission (`./provider-closure`) judges an import record by this list and never by the running runtime's own
 * built-in check, so one record answers the same under Node.js, where Studio's server runs, and under Bun, where its
 * tests run. Bun's own modules (`bun`, `bun:*`) and the `ws` and `undici` Bun serves as built-ins are refused, and so
 * is a name a later Node.js adds, until the floor moves. node-builtins.test.ts holds the list to a spawned Node.js 24
 * and fails when the floor in package.json moves, which is the only change to that list; `NODE_BUILTINS_DROPPED_LATER`
 * changes only when Studio's images move to a release that drops a name.
 */

/** Node.js 24.0.0's `builtinModules`, sorted. */
export const NODE_BUILTIN_MODULES: readonly string[] = Object.freeze([
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "node:sea",
  "node:sqlite",
  "node:test",
  "node:test/reporters",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** The names of the list that Node.js 26, the images' release, no longer serves, refused bare and as `node:`. */
export const NODE_BUILTINS_DROPPED_LATER: readonly string[] = Object.freeze([
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
]);

/** The prefix Node.js serves every built-in under. */
const NODE_PREFIX = "node:";

/** The list less `NODE_BUILTINS_DROPPED_LATER`: the names every Node.js release Studio runs on serves. */
const SERVED = NODE_BUILTIN_MODULES.filter((name) => !NODE_BUILTINS_DROPPED_LATER.includes(name));

/** Every admitted name: each name of `SERVED`, and the `node:` form of each name of it with no prefix. */
const ADMITTED: ReadonlySet<string> = new Set([
  ...SERVED,
  ...SERVED.filter((name) => !name.startsWith(NODE_PREFIX)).map((name) => `${NODE_PREFIX}${name}`),
]);

/** Whether `specifier` names a built-in of Node.js's list as Studio commits it, in a form Studio admits. */
export function isNodeBuiltin(specifier: string): boolean {
  return ADMITTED.has(specifier);
}
