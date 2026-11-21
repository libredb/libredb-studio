/**
 * The egress decisions a test hands a provider or the guard in place of the one core takes from
 * DB_HTTP_BLOCK_PRIVATE_HOSTS (`src/lib/db/egress-decision.ts`).
 *
 * Since FND-2 slice 2b the guard decides by the decision it is handed and the factory hands each provider core's, so a
 * test of a path that takes the decision as an argument hands one of these and never writes the variable to reach it:
 * a write reaches only the factory and the interim readers. The variable is still written only through
 * `./egress-flag`, by a test of core's own reading or of an interim reader, or to show a handed decision wins over it.
 */
import type { EgressDecision } from "@/lib/db/types";

/** A decision that blocks loopback, private and the other non-public destinations, as an operator's `true` does. */
export const BLOCKS_PRIVATE_HOSTS: EgressDecision = Object.freeze({ blocksPrivateHosts: true, source: "set" });

/** A decision that keeps them reachable, as an operator's `false` does. */
export const ALLOWS_PRIVATE_HOSTS: EgressDecision = Object.freeze({ blocksPrivateHosts: false, source: "set" });
