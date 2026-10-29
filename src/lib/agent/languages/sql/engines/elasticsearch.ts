/**
 * Elasticsearch's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * Elasticsearch. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * Every member is unsupported, each for a measured reason. Elasticsearch SQL reads its catalog through `SHOW` and
 * `DESCRIBE` statements and `SYS` commands, none of which answers the column, relation, index and statistics rows a
 * catalog read composes, and the engine has no foreign key, no secondary index object and no row estimate to put in
 * them. Its `EXPLAIN` answers the engine's own plan text, which no explain strategy reads (the provider declares
 * `supportsExplain: false`), so no estimating plan is composed. A table profile would be an aggregate over a whole
 * index, never measured here, and the statistics reading and grounding capture have nothing to read. So the workflows
 * that need a composed catalog read refuse on Elasticsearch, and the operations workflow and plan mode run.
 */
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

export const ELASTICSEARCH_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "unsupported",
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
