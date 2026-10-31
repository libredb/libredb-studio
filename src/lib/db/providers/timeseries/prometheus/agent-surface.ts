/**
 * What a Prometheus handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * The object surface (metrics with their label names, rule groups and rules, scrape pools and targets) and the health,
 * storage and table readings are the server's own answers on every handle, read through the same transport, with the
 * agent-mode projection of `agent-projection.ts` applied: every URL a target, a rule or an alert carries kept to its
 * scheme, host, port and path, and the flags withheld. Every other reading would answer with something the agent must
 * not read or a figure the provider fills in without asking the server, so on an agent-mode handle each answers its
 * reason instead, and the console, which is not held to an agent read's budgets, is refused. The editor's handles keep
 * every surface.
 */
import { PROMETHEUS_AGENT_PROJECTION } from "./agent-projection";

const AGENT_READS =
  "Agent mode on Prometheus reads PromQL through queryReadOnly, and the object tree, health, storage and table readings from the server's own read endpoints.";

/** Each reading an agent-mode handle does not take, with its reason. No sentence names a value the server holds. */
export const PROMETHEUS_AGENT_WITHHELD = {
  query: `${AGENT_READS} The console is not held to an agent read's row, byte and time budgets, so it is refused on an agent-mode handle; agent reads go through queryReadOnly.`,
  overview: `${AGENT_READS} The overview's connection ceiling is read from the server's command-line flags. ${PROMETHEUS_AGENT_PROJECTION.flags} So no overview is taken; the version and the uptime are in the health reading and in PromQL (prometheus_build_info, process_start_time_seconds).`,
  performance: `${AGENT_READS} The server publishes no hit ratio or throughput as a figure its API measures, so no performance reading is taken; this is not a reading of none. Its own metrics are read with PromQL.`,
  slowQueries: `${AGENT_READS} The server's API returns no query log, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${AGENT_READS} The server's API publishes no session list, every request being a separate stateless call, so no session reading is taken; this is not a reading of none.`,
  indexStats: `${AGENT_READS} A Prometheus TSDB has no secondary index object to describe, so no index reading is taken; this is not a reading of none.`,
  /**
   * Not a withheld reading but the text beside the storage and table readings' byte figures: the server publishes no
   * byte count, and those readings' shape requires a number, so the 0 there is said not to be one.
   */
  byteCount:
    "N/A: the server publishes no byte count of what it stores, so the byte figure beside this, 0, is a placeholder the reading's shape requires, not a measurement.",
} as const;
