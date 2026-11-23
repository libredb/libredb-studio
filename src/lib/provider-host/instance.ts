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
 * A call made before the install fails with `HostCoreBootOrderError`, by name: a missing core is a deployment defect,
 * and a core created on demand would be a second core beside the installed one. A second install is refused the same
 * way and the first core stays. `register()` runs once per server process, `next dev` included, which reloads neither
 * instrumentation nor the core when either is edited (measured on Next.js 16.4.6), so a second install never happens
 * in a dev reload: a change under src/lib/provider-host/core needs a restart of the dev server.
 *
 * The module imports only the core's types, so the calling bundle holds no copy of the core's calls. No module the
 * library entries (src/exports) reach imports it, so an embedder of the npm package composes nothing: the factory never
 * reads the slot.
 */
import type { HostCore } from "@/lib/provider-host/core/host-core";

/** The registered symbol the process's host core is installed under. */
export const HOST_CORE_KEY = Symbol.for("libredb-studio.provider-host-core");

type HostCoreHolder = { [HOST_CORE_KEY]?: HostCore };

/** A host core read before its install, or installed twice: a defect of how the process was composed. */
export class HostCoreBootOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostCoreBootOrderError";
  }
}

const NOT_INSTALLED =
  "The provider host core is not installed in this process, so Studio cannot make this call. A composition root installs it once when the process starts: src/instrumentation.ts for the server, the VS Code backend's entry for its child, and a test that runs the editor query installs it in its own setup.";
const ALREADY_INSTALLED =
  "The provider host core is already installed in this process: one composition root installs it once.";

/** Installs `core` as the process's host core; a core already installed is refused by name and stays. */
export function installHostCore(core: HostCore): void {
  const holder = globalThis as HostCoreHolder;
  if (holder[HOST_CORE_KEY] !== undefined) throw new HostCoreBootOrderError(ALREADY_INSTALLED);
  holder[HOST_CORE_KEY] = core;
}

/** The process's host core; none installed is refused by name. */
export function hostCore(): HostCore {
  const core = (globalThis as HostCoreHolder)[HOST_CORE_KEY];
  if (core === undefined) throw new HostCoreBootOrderError(NOT_INSTALLED);
  return core;
}

/** Removes the installed host core, so a test composes its own; a process never calls it. */
export function forgetHostCore(): void {
  delete (globalThis as HostCoreHolder)[HOST_CORE_KEY];
}
