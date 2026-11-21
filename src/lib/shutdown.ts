/**
 * The shutdown registry: what a module must close before the process exits, and the provider caches.
 *
 * - Hooks. A module registers its close with `onShutdown(name, hook)`, as the governance refresher registers the close
 *   of its listener and its pool. `runShutdownHooks()` runs every hook at once and waits for them at most
 *   `SHUTDOWN_HOOKS_DEADLINE_MS`, so a hook that hangs, such as a close on a half-open connection, never holds the exit.
 * - Provider cache closes. Each copy of the provider factory registers the close of its own caches with
 *   `onProviderCacheClose(close)` when it loads, and `closeProviderCaches()` runs every registered close at once and
 *   waits for them at most `PROVIDER_CACHE_CLOSE_DEADLINE_MS`.
 *
 * Nothing here listens to a signal: the one shutdown handler (src/lib/shutdown-handler.ts), which `register()` installs
 * at boot, runs the hooks and then, where it owns the exit, the cache closes (docs/DISTRIBUTION.md#stopping-the-server).
 *
 * Both registries live in a global under a registered symbol, one per process. Next.js bundles instrumentation, which
 * registers the governance hook and installs the handler, apart from the route handlers that load the factory, and
 * each bundle that loads the factory has its own copy of it with its own caches, so the handler reaches every copy
 * through this registry and never imports the factory. Each run happens once per process. The module imports nothing
 * but the logger, because the factory is part of the npm package.
 */
import { logger } from "@/lib/logger";

/** How long the hooks may take, together, before the shutdown goes on without them. */
export const SHUTDOWN_HOOKS_DEADLINE_MS = 5000;

/**
 * How long the provider cache closes may take, together, before the shutdown goes on without them: the longest an
 * owned provider's teardown takes by its own deadlines, 5 s for the rollback and 10 s for the disconnect, so it never
 * cuts a teardown those deadlines would let finish. It bounds a shared provider whose `disconnect()` never settles.
 */
export const PROVIDER_CACHE_CLOSE_DEADLINE_MS = 15_000;

type ShutdownHook = () => Promise<void>;

/** The close of one factory copy's provider caches. */
export type ProviderCacheClose = () => Promise<void>;

/** How a run of the hooks ended: the names of the hooks still running at the deadline, and of those that failed. */
export interface ShutdownHooksOutcome {
  readonly cut: readonly string[];
  readonly failed: readonly string[];
}

/** How a run of the provider cache closes ended: how many were still running at the deadline, and how many failed. */
export interface ProviderCacheClosesOutcome {
  readonly cut: number;
  readonly failed: number;
}

interface ShutdownRegistry {
  readonly hooks: Map<string, ShutdownHook>;
  readonly cacheCloses: Set<ProviderCacheClose>;
  /** The run of the hooks, once one has started. */
  run?: Promise<ShutdownHooksOutcome>;
  /** The names of the hooks of that run that have not ended yet. */
  running?: ReadonlySet<string>;
  /** The run of the provider cache closes, once one has started. */
  cacheCloseRun?: Promise<ProviderCacheClosesOutcome>;
}

const REGISTRY_KEY = Symbol.for("libredb-studio.shutdown-hooks");

type RegistryHolder = { [REGISTRY_KEY]?: ShutdownRegistry };

function registry(): ShutdownRegistry {
  const holder = globalThis as RegistryHolder;
  holder[REGISTRY_KEY] ??= { hooks: new Map(), cacheCloses: new Set() };
  return holder[REGISTRY_KEY];
}

/** Registers `hook` to run at shutdown under `name`, in place of a hook registered under that name before. */
export function onShutdown(name: string, hook: ShutdownHook): void {
  registry().hooks.set(name, hook);
}

/** Registers the close of one factory copy's provider caches; the function returned removes it again. */
export function onProviderCacheClose(close: ProviderCacheClose): () => void {
  const closes = registry().cacheCloses;
  closes.add(close);
  return () => {
    closes.delete(close);
  };
}

/** Waits for `work` at most `ms`; the timer is cleared either way. */
async function withinDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(deadline);
}

async function runHooks(
  state: ShutdownRegistry,
  hooks: ReadonlyMap<string, ShutdownHook>,
): Promise<ShutdownHooksOutcome> {
  const pending = new Set(hooks.keys());
  state.running = pending;
  const failed: string[] = [];
  const runs = [...hooks].map(async ([name, hook]) => {
    try {
      await hook();
    } catch (error) {
      failed.push(name);
      logger.error("Shutdown hook failed", error, { route: "shutdown", hook: name });
    }
    pending.delete(name);
  });
  await withinDeadline(Promise.all(runs), SHUTDOWN_HOOKS_DEADLINE_MS);
  const cut = [...pending];
  if (cut.length > 0) logger.warn("Shutdown hooks cut at the deadline", { route: "shutdown", pending: cut });
  return { cut, failed: [...failed] };
}

/**
 * Runs every registered hook at once, and settles when all of them have ended or after `SHUTDOWN_HOOKS_DEADLINE_MS`,
 * whichever comes first, naming in a warning each hook still running. A hook that fails is logged. It never rejects,
 * answers the hooks it cut and the hooks that failed, and the hooks run once per process: a later call joins the
 * first run.
 */
export function runShutdownHooks(): Promise<ShutdownHooksOutcome> {
  const state = registry();
  state.run ??= runHooks(state, new Map(state.hooks));
  return state.run;
}

/**
 * The names of the hooks of the run that have not ended, read synchronously, so a line written as the process exits
 * names the hooks the exit cuts; none before a run.
 */
export function shutdownHooksRunning(): readonly string[] {
  return [...(registry().running ?? [])];
}

async function runCacheCloses(closes: readonly ProviderCacheClose[]): Promise<ProviderCacheClosesOutcome> {
  let pending = closes.length;
  let failed = 0;
  const runs = closes.map(async (close) => {
    try {
      await close();
    } catch (error) {
      failed += 1;
      logger.error("Provider cache close failed", error, { route: "shutdown" });
    }
    pending -= 1;
  });
  await withinDeadline(Promise.all(runs), PROVIDER_CACHE_CLOSE_DEADLINE_MS);
  const cut = pending;
  if (cut > 0) logger.warn("Provider cache closes cut at the deadline", { route: "shutdown", pending: cut });
  return { cut, failed };
}

/**
 * Runs every registered provider cache close at once, and settles when all of them have ended or after
 * `PROVIDER_CACHE_CLOSE_DEADLINE_MS`, whichever comes first, counting in a warning the closes still running. A close
 * that rejects or throws is logged. It never rejects, answers how many closes it cut and how many failed, and the
 * closes run once per process: a later call joins the first run.
 */
export function closeProviderCaches(): Promise<ProviderCacheClosesOutcome> {
  const state = registry();
  state.cacheCloseRun ??= runCacheCloses([...state.cacheCloses]);
  return state.cacheCloseRun;
}

/**
 * Test seam: forgets every hook and both runs, as a new process would, and keeps the registered provider cache
 * closes: those mirror module loads, which a test process cannot undo, so dropping them would leave a loaded factory's
 * close unregistered for every later test. A test that registers a close of its own removes it with the function
 * `onProviderCacheClose` returned.
 */
export function resetShutdownHooks(): void {
  const holder = globalThis as RegistryHolder;
  const cacheCloses = holder[REGISTRY_KEY]?.cacheCloses ?? new Set<ProviderCacheClose>();
  holder[REGISTRY_KEY] = { hooks: new Map(), cacheCloses };
}
