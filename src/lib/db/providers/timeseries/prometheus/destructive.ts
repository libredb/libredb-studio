import type { DestructiveVocabulary, OperationReader } from "@/lib/db/destructive-vocabulary";

/**
 * PromQL operations that destroy or change anything: none, so the set is empty.
 *
 * Not an omission. The language has no statement that writes, and the provider sends
 * editor text to one place, `POST /api/v1/query`, which evaluates an expression and
 * does nothing else. Every path the provider can call is a read, and all of them are
 * listed in `PATHS` in `src/lib/db/providers/timeseries/prometheus/http-transport.ts`
 * (#1085 S9). Series deletion and snapshots, which are the admin API, and the
 * lifecycle endpoints are calls this product never makes (#1085, section 2).
 */
const PROMETHEUS_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/**
 * What a PromQL buffer would run: never an operation this gate asks about.
 *
 * The MongoDB and Redis readers turn text they cannot resolve into a prompt. This one
 * has nothing to resolve: whatever the text says, the one request it becomes is an
 * evaluation, and text the server cannot parse is refused there with nothing changed.
 */
const readPrometheusOperations: OperationReader = () => [];

/** Prometheus's row of the confirmation gate's vocabulary. */
export const PROMETHEUS_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: PROMETHEUS_DESTRUCTIVE_OPERATIONS,
  read: readPrometheusOperations,
  decidesAlone: true,
};
