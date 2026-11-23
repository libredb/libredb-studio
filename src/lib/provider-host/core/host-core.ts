/**
 * The host core instance (docs/providers/CONTRACT.md, clause C-52), part of the provider host core.
 *
 * `createHostCore` answers what a composition root installs once per process (src/lib/provider-host/instance.ts): the
 * core's console calls, `executeCall` and `cancelCall`, by identity, in a frozen object, and nothing else.
 *
 * Next.js bundles instrumentation apart from every route handler, and each bundle holds its own copy of Studio's error
 * classes (docs/ARCHITECTURE.md, "The provider host core"). The core answers records and constructs no class, so the
 * functions installed by the instrumentation bundle serve a route bundle as well as its own copy would. What a caller
 * tests with `instanceof`, the error classes and the ports that read them (`HostCallPorts`), stays the caller's and is
 * built by the caller per call, so the instance holds no port and no logger. The open tables and the teardown stay the
 * factory's, per bundle, since the factory is part of the npm package and needs no core.
 */
import { cancelCall, executeCall } from "./console";

/** The host core one process holds: the core's console calls, by identity. */
export interface HostCore {
  readonly executeCall: typeof executeCall;
  readonly cancelCall: typeof cancelCall;
}

/** A new host core instance, frozen, for a composition root to install. */
export function createHostCore(): HostCore {
  return Object.freeze({ executeCall, cancelCall });
}
