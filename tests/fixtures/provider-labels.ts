/**
 * Provider vocabularies, for the tests that build an `AgentToolContext` by hand.
 *
 * The agent layer takes `ProviderLabels` beside `ProviderCapabilities` since #414, so
 * every hand-built context needs one. Only `entityName` and `entityNamePlural` reach a
 * prompt — the rest of the interface is button text the browser reads — so those two
 * carry the real providers' values here and the others are filler, named so a reader
 * cannot mistake them for something an assertion depends on.
 *
 * That the two real values are the real ones is pinned where they are declared:
 * `tests/unit/db/base-provider.test.ts` for "Table", and
 * `tests/integration/db/redis-provider.test.ts` for "Key Pattern".
 */

import type { ProviderLabels } from "@/lib/db/types";

const UNREAD_BY_THE_AGENT_LAYER = {
  rowName: "row",
  rowNamePlural: "rows",
  selectAction: "unused in these tests",
  generateAction: "unused in these tests",
  analyzeAction: "unused in these tests",
  vacuumAction: "unused in these tests",
  searchPlaceholder: "unused in these tests",
  analyzeGlobalLabel: "unused in these tests",
  analyzeGlobalTitle: "unused in these tests",
  analyzeGlobalDesc: "unused in these tests",
  vacuumGlobalLabel: "unused in these tests",
  vacuumGlobalTitle: "unused in these tests",
  vacuumGlobalDesc: "unused in these tests",
};

/** What every SQL engine inherits from the base provider. */
export const TABLE_LABELS: ProviderLabels = {
  ...UNREAD_BY_THE_AGENT_LAYER,
  entityName: "Table",
  entityNamePlural: "Tables",
};

/**
 * A search cluster, which is the one family that also declares what its statements are
 * WRITTEN IN — see `ProviderLabels.statementLanguage`. Pinned against the real
 * declaration in `tests/integration/db/elasticsearch-provider.test.ts`.
 */
export const SEARCH_INDEX_LABELS: ProviderLabels = {
  ...UNREAD_BY_THE_AGENT_LAYER,
  entityName: "Index",
  entityNamePlural: "Indices",
  statementLanguage: "Elasticsearch SQL, the product's own SQL endpoint - NOT the JSON query DSL",
};

/** Redis, whose inventory rows are prefixes this server grouped, not objects. */
export const KEY_PATTERN_LABELS: ProviderLabels = {
  ...UNREAD_BY_THE_AGENT_LAYER,
  entityName: "Key Pattern",
  entityNamePlural: "Key Patterns",
};
