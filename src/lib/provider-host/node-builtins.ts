/**
 * The built-in modules a provider package may import (docs/providers/CONTRACT.md, clause C-102): Node.js's list, as
 * Studio commits it, for the oldest Node.js release Studio supports.
 *
 * `NODE_BUILTIN_MODULES` is `builtinModules` of `node:module` on Node.js 24.0.0, the release package.json
 * `engines.node` names as its floor, read with `node -p 'JSON.stringify(require("node:module").builtinModules)'`
 * and kept in the order it sorts to. Every name of it that does not start with `node:` is also a built-in in its
 * `node:` form; the four names that start with `node:` have no bare form.
 *
 * Admission (`./provider-closure`) judges an import record by this list and never by the running runtime's own
 * built-in check, so one record answers the same under Node.js, where Studio's server runs, and under Bun, where its
 * tests run. Bun's own modules (`bun`, `bun:*`) and the `ws` and `undici` Bun serves as built-ins are refused, and so
 * is a name a later Node.js adds, until the floor moves. node-builtins.test.ts holds the list to a spawned Node.js 24
 * and fails when the floor in package.json moves, which is the only change to the list.
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

/** The prefix Node.js serves every built-in under. */
const NODE_PREFIX = "node:";

/** Every admitted name: the list, and the `node:` form of each name of it without the prefix. */
const ADMITTED: ReadonlySet<string> = new Set([
  ...NODE_BUILTIN_MODULES,
  ...NODE_BUILTIN_MODULES.filter((name) => !name.startsWith(NODE_PREFIX)).map((name) => `${NODE_PREFIX}${name}`),
]);

/** Whether `specifier` names a built-in of Node.js's list as Studio commits it. */
export function isNodeBuiltin(specifier: string): boolean {
  return ADMITTED.has(specifier);
}
