/**
 * Removing one owner's providers of a connection in every copy of the provider factory this process loaded
 * (docs/GOVERNANCE.md#per-user-providers), for the governance loader, which tears down the providers of a grant a
 * reload took away or changed.
 *
 * Next.js bundles instrumentation, which runs the governance loads, apart from the route handlers that open providers,
 * and each bundle that loads `factory.ts` keeps provider caches of its own: measured on a production build of this
 * repository (Turbopack, Next.js 16), `src/lib/seed/sqlite-sample.ts`, which both instrumentation and the managed
 * connections route import, ran as two module instances. So the loader cannot reach the route handlers' providers by
 * importing `removeProvider`; it would reach the caches of its own bundle, which no route handler fills. Instead each
 * copy of the factory registers its owner-scoped removal here when it loads, in a global under a registered symbol,
 * one registry per process, and the loader asks every copy.
 *
 * Every copy is asked, the instrumentation bundle's own included when something there loaded the factory, and each
 * removes only what its own caches hold. The module imports nothing, so the governance runtime reaches the factories
 * without importing one, and the factory, which is part of the npm package, imports nothing of governance.
 */

/** The removal of one copy of the factory: its `removeProvider` with an owner scope. */
type OwnerRemoval = (connectionId: string, scope: { readonly owner: string }) => Promise<void>;

const REGISTRY_KEY = Symbol.for("libredb-studio.owner-removals");

type RegistryHolder = { [REGISTRY_KEY]?: Set<OwnerRemoval> };

function registry(): Set<OwnerRemoval> {
  const holder = globalThis as RegistryHolder;
  holder[REGISTRY_KEY] ??= new Set();
  return holder[REGISTRY_KEY];
}

/** Registers `remove`, the owner-scoped removal of one copy of the factory, and returns what unregisters it. */
export function registerOwnerRemoval(remove: OwnerRemoval): () => void {
  const removals = registry();
  removals.add(remove);
  return () => {
    removals.delete(remove);
  };
}

/**
 * Removes `owner`'s providers of `connectionId` in every copy of the factory this process loaded, and settles once
 * every copy has: it rejects with the first failure, and resolves at once when no copy is loaded, because a bundle that
 * never loaded the factory holds no provider.
 */
export async function removeOwnerProviders(connectionId: string, owner: string): Promise<void> {
  await Promise.all([...registry()].map((remove) => remove(connectionId, { owner })));
}
