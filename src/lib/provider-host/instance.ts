/**
 * The process's one host core (docs/providers/CONTRACT.md, clause C-52), in a global under a registered symbol.
 *
 * A composition root creates the core (`createHostCore`, src/lib/provider-host/core/host-core.ts) and installs it once
 * when its process starts: `register()` in src/instrumentation.ts for the server, the VS Code backend child's entry
 * (vscode-extension/src/backend/main.ts) for its child, the host page benchmark's child entry for each case, and a test
 * that runs the editor query in its own setup. The caller facade (src/lib/api/editor-query.ts) reads it at the start of
 * every call. Next.js loads instrumentation and every route handler as separate module instances, so the slot is a
 * global under `Symbol.for`, which every bundle of the process resolves to one key, as src/lib/db/owner-removal.ts
 * keeps its registry.
 *
 * Each install names its composition root, one of `HostCoreRoot`. A call made before the install fails with
 * `HostCoreBootOrderError`, by name: a missing core is a deployment defect, and a core created on demand would be a
 * second core beside the installed one, with a page budget of its own (clause C-53). A second install from the same
 * root keeps the first core and changes nothing: the first core keeps its page budget and every page it holds, and the
 * second core is never used, so it holds no page. That is what lets `register()` run again in one
 * process, as the uncaught-exception exit and the shutdown handler it installs beside the core already allow. A second
 * install from another root is a process composed twice, refused by `HostCoreBootOrderError` naming both roots, and the
 * first core stays. So no second core is ever used. `register()` was measured to run once per server process under
 * `next dev` and the standalone server (Next.js 16.4.6), and a dev server reloads neither instrumentation nor the core
 * when either is edited, so a change under src/lib/provider-host/core needs a restart of the dev server.
 *
 * The module imports only the core's types, so the calling bundle holds no copy of the core's calls. No module the
 * library entries (src/exports) reach imports it, so an embedder of the npm package composes nothing: the factory never
 * reads the slot.
 */
import type { HostCore } from "@/lib/provider-host/core/host-core";

/** The registered symbol the process's host core is installed under. */
export const HOST_CORE_KEY = Symbol.for("libredb-studio.provider-host-core");

/**
 * The composition roots that install the host core: the server's `register()` (src/instrumentation.ts), the VS Code
 * backend child's entry, the host page benchmark's case child, and a test's own setup or child process.
 */
export type HostCoreRoot = "server" | "vscode-backend" | "benchmark-case" | "test";

/** The installed core and the composition root that installed it. */
type InstalledHostCore = Readonly<{ root: HostCoreRoot; core: HostCore }>;

type HostCoreHolder = { [HOST_CORE_KEY]?: InstalledHostCore };

/** A host core read before its install, or installed from a second composition root: a composition defect. */
export class HostCoreBootOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostCoreBootOrderError";
  }
}

const NOT_INSTALLED =
  "The provider host core is not installed in this process, so Studio cannot make this call. A composition root installs it once when the process starts: src/instrumentation.ts for the server, the VS Code backend's entry for its child, and a test that runs the editor query installs it in its own setup.";

/** The refusal of an install from `second` when `first` installed the core. */
function installedByAnotherRoot(first: HostCoreRoot, second: HostCoreRoot): string {
  return `The provider host core is already installed in this process by the ${first} composition root, so the ${second} composition root cannot install another: one composition root installs it once.`;
}

/**
 * Installs `core` from the composition root `root` as the process's host core. A core already installed from the same
 * root stays and `core` is not used; one installed from another root is refused by name and stays.
 */
export function installHostCore(core: HostCore, root: HostCoreRoot): void {
  const holder = globalThis as HostCoreHolder;
  const installed = holder[HOST_CORE_KEY];
  if (installed === undefined) {
    holder[HOST_CORE_KEY] = Object.freeze({ root, core });
    return;
  }
  if (installed.root !== root) throw new HostCoreBootOrderError(installedByAnotherRoot(installed.root, root));
}

/** The process's host core; none installed is refused by name. */
export function hostCore(): HostCore {
  const installed = (globalThis as HostCoreHolder)[HOST_CORE_KEY];
  if (installed === undefined) throw new HostCoreBootOrderError(NOT_INSTALLED);
  return installed.core;
}

/** Removes the installed host core, so a test composes its own; a process never calls it. */
export function forgetHostCore(): void {
  delete (globalThis as HostCoreHolder)[HOST_CORE_KEY];
}
