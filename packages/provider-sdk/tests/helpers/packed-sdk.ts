/**
 * The machinery of the pack test (packages/provider-sdk/tests/pack.test.ts): the npm it runs, the environment its
 * children get, the check of the directory it installs into, the closure of packages it installs beside the SDK, and a
 * bounded child process.
 *
 * The test installs the SDK tarball into an empty directory with npm, offline, so it proves what a developer outside
 * the repository gets and never reaches a registry. npm needs every dependency of the tarball as a tarball too, so the
 * test packs the packed manifest's `dependencies` and `@types/node`, each with the packages it depends on, from the
 * repository's own install: `dependencyClosure` finds each package directory as Node finds one, walking up
 * `node_modules` from the directory of the package that depends on it.
 *
 * `childEnvironment` and `ancestorNodeModules` repeat the two of the same name in scripts/check-lib-load.mjs, because a
 * workspace package imports nothing from outside its directory (packages/README.md, "Imports"). This copy also drops
 * every `npm_config_*` variable, which `bun run` and `npm run` set and npm reads as configuration.
 *
 * npm on POSIX is the `npm` on PATH, a link to npm-cli.js that runs under the node on PATH. On Windows the PATH entry
 * is the batch shim npm.cmd, which runs only through cmd.exe and its argument parsing, and a spawn without a shell does
 * not find it by name; so the test runs the node on PATH with the npm-cli.js beside the shim, the file the shim runs.
 */
import path from "node:path";

/** What `npmCommand` looks up: the platform, a PATH lookup and a file check, injected so both branches run anywhere. */
export interface NpmLookup {
  readonly platform: NodeJS.Platform;
  readonly which: (name: string) => string | null;
  readonly exists: (file: string) => boolean;
}

/** The command words that run npm, before its arguments; a missing npm, node or npm-cli.js is refused by name. */
export function npmCommand(lookup: NpmLookup): string[] {
  if (lookup.platform !== "win32") {
    const npm = lookup.which("npm");
    if (npm === null) throw new Error("No npm on PATH: the pack test installs the SDK tarball with npm");
    return [npm];
  }
  const shim = lookup.which("npm.cmd");
  if (shim === null) throw new Error("No npm.cmd on PATH: the pack test installs the SDK tarball with npm");
  const cli = path.join(path.dirname(shim), "node_modules", "npm", "bin", "npm-cli.js");
  if (!lookup.exists(cli)) throw new Error(`No ${cli} beside ${shim}: the pack test runs npm's npm-cli.js under node`);
  const node = lookup.which("node");
  if (node === null) throw new Error("No node on PATH: the pack test runs npm's npm-cli.js under node");
  return [node, cli];
}

/**
 * The child's environment: the parent's without NODE_OPTIONS, NODE_PATH and any `npm_config_*` variable (in any case),
 * with HOME and USERPROFILE at `home`.
 */
export function childEnvironment(
  parentEnv: Readonly<Record<string, string | undefined>>,
  home: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith("NPM_CONFIG_")) continue;
    if (upper === "NODE_PATH" || upper === "NODE_OPTIONS" || upper === "HOME" || upper === "USERPROFILE") continue;
    env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home };
}

/** The nearest directory above `directory` that holds a `node_modules`, or null when none does. */
export function ancestorNodeModules(directory: string, exists: (candidate: string) => boolean): string | null {
  let current = path.resolve(directory);
  const top = path.parse(current).root;
  while (current !== top) {
    current = path.dirname(current);
    if (exists(path.join(current, "node_modules"))) return current;
  }
  return null;
}

/** The fields of a package manifest the closure reads. */
export interface ClosureManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** The directory of package `name` as Node finds it from `from`: the nearest `node_modules/<name>` with a manifest. */
function packageDirectory(name: string, from: string, exists: (file: string) => boolean): string | null {
  let current = path.resolve(from);
  for (;;) {
    const candidate = path.join(current, "node_modules", name);
    if (exists(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The directories of `names`, found from `from`, and of every package they depend on (`dependencies` only), each found
 * from the directory of the package that depends on it; sorted, each once. A package not found is refused by name.
 */
export function dependencyClosure(
  names: readonly string[],
  from: string,
  exists: (file: string) => boolean,
  readManifest: (directory: string) => ClosureManifest,
): string[] {
  const found = new Set<string>();
  const pending = names.map((name) => ({ name, from, by: from }));
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const directory = packageDirectory(next.name, next.from, exists);
    if (directory === null) {
      throw new Error(
        `${next.name}, needed by ${next.by}, is not installed in any node_modules above it: run bun install`,
      );
    }
    if (found.has(directory)) continue;
    found.add(directory);
    for (const name of Object.keys(readManifest(directory).dependencies ?? {})) {
      pending.push({ name, from: directory, by: directory });
    }
  }
  return [...found].sort();
}

/** What a finished child printed and how it ended. */
export interface ChildResult {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `command` in `cwd` with `env`, killed after `timeoutMs`, and answers what it printed and how it ended. */
export async function runChild(
  command: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly timeoutMs: number },
): Promise<ChildResult> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, signalCode: child.signalCode, stdout, stderr };
}

/** The result of a child that must succeed; any other end fails, naming the step, its exit and its standard error. */
export function succeeded(step: string, result: ChildResult): ChildResult {
  if (result.exitCode === 0 && result.signalCode === null) return result;
  throw new Error(
    `${step} exited ${result.exitCode} (signal ${result.signalCode}): ${result.stderr.trim().split("\n").slice(0, 8).join("\n")}`,
  );
}
