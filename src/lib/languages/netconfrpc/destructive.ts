import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/**
 * NETCONF's row of the confirmation gate's vocabulary (#1724).
 *
 * The console reads one JSON read request naming a datastore, a path and a bound, so there is no destructive verb to
 * find. The operations list is empty BY CONSTRUCTION rather than by this version's scope: `requests.ts` builds four
 * read operations and a close, and no function in the provider can build an `<edit-config>`, a `<commit>` or a
 * `<lock>`. Naming an operation here would claim this provider can send one.
 */
export const NETCONF_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
