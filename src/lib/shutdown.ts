/**
 * Shutdown hooks: what a module must close before the process exits, beside the database providers.
 *
 * A module registers its close with `onShutdown(name, hook)`, as the governance refresher registers the close of its
 * listener and its pool. On SIGTERM or SIGINT, `registerShutdownHandlers()` in `src/lib/db/factory.ts` runs every hook
 * at once and waits for them at most `SHUTDOWN_HOOKS_DEADLINE_MS`, then closes the providers and exits, so a hook that
 * hangs, such as a close on a half-open connection, never holds the exit.
 *
 * The hooks live in a global under a registered symbol, one set per process. Next.js bundles instrumentation, which
 * registers the governance hook, apart from the route handlers that load the factory, and each bundle that loads the
 * factory registers signal handlers of its own, so the hooks run once whichever handler runs them first. The module
 * imports nothing but the logger, because the factory is part of the npm package.
 */
import { logger } from "@/lib/logger";

/** How long the hooks may take, together, before the shutdown goes on without them. */
const SHUTDOWN_HOOKS_DEADLINE_MS = 5000;

type ShutdownHook = () => Promise<void>;

interface ShutdownRegistry {
  readonly hooks: Map<string, ShutdownHook>;
  /** The run of the hooks, once one has started. */
  run?: Promise<void>;
}

const REGISTRY_KEY = Symbol.for("libredb-studio.shutdown-hooks");

type RegistryHolder = { [REGISTRY_KEY]?: ShutdownRegistry };

function registry(): ShutdownRegistry {
  const holder = globalThis as RegistryHolder;
  holder[REGISTRY_KEY] ??= { hooks: new Map() };
  return holder[REGISTRY_KEY];
}

/** Registers `hook` to run at shutdown under `name`, in place of a hook registered under that name before. */
export function onShutdown(name: string, hook: ShutdownHook): void {
  registry().hooks.set(name, hook);
}

async function runHooks(hooks: ReadonlyMap<string, ShutdownHook>): Promise<void> {
  const pending = new Set(hooks.keys());
  const runs = [...hooks].map(async ([name, hook]) => {
    try {
      await hook();
    } catch (error) {
      logger.error("Shutdown hook failed", error, { route: "shutdown", hook: name });
    }
    pending.delete(name);
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(runs),
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, SHUTDOWN_HOOKS_DEADLINE_MS);
    }),
  ]);
  clearTimeout(deadline);
  if (pending.size > 0) logger.warn("Shutdown hooks cut at the deadline", { route: "shutdown", pending: [...pending] });
}

/**
 * Runs every registered hook at once, and settles when all of them have ended or after `SHUTDOWN_HOOKS_DEADLINE_MS`,
 * whichever comes first, naming in a warning each hook still running. A hook that fails is logged. It never rejects,
 * and the hooks run once per process: a later call joins the first run.
 */
export function runShutdownHooks(): Promise<void> {
  const state = registry();
  state.run ??= runHooks(new Map(state.hooks));
  return state.run;
}

/** Test seam: forgets every hook and every run, as a new process would. */
export function resetShutdownHooks(): void {
  delete (globalThis as RegistryHolder)[REGISTRY_KEY];
}
