/**
 * What a Sparkplug handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * Metadata only, as the agent's reads are: group, edge node, device and host application ids are stored values, so no
 * surface of an agent-mode handle names one, and metric names, values, properties and the stored certificates are
 * values, so none reads one. The tree, an object's listing and description, its birth certificate and the console are
 * refused with their reason. A broker publishes no size, statistics, query log or session list a subscriber can read,
 * and the editor's figures for them are Studio's own (an "unknown" size, a connection limit of 0, an empty list) or
 * counts of the last read's tree, so on an agent-mode handle each reading answers its reason instead. The editor's
 * handles keep every surface.
 */
import { SPARKPLUG_AGENT_READS } from "./agent-statement";

/** Why ids never reach agent mode, in the words the grounding and the refusals share. */
export const SPARKPLUG_IDS_WITHHELD_SENTENCE =
  "Group, edge node, device and host application ids are withheld from agent mode, because they name the plants, machines and people behind them, and so are metric names, metric values, properties, datasets, templates, aliases and the birth certificates a broker stores: no id is listed or named to agent mode, and a read answers counts and flags only.";

/** Each surface or reading an agent-mode handle does not take, with its reason. No sentence names a broker value. */
export const SPARKPLUG_AGENT_WITHHELD = {
  query: `${SPARKPLUG_AGENT_READS} ${SPARKPLUG_IDS_WITHHELD_SENTENCE} The console's request reads metric values, so it is refused on an agent-mode handle, and agent reads go through queryReadOnly.`,
  tree: `${SPARKPLUG_IDS_WITHHELD_SENTENCE} The tree lists groups, edge nodes, devices and metrics by id and name, so it is refused on an agent-mode handle. ${SPARKPLUG_AGENT_READS}`,
  source: `${SPARKPLUG_IDS_WITHHELD_SENTENCE} An object's birth certificate holds its metric names and values, which agent mode never reads. ${SPARKPLUG_AGENT_READS}`,
  health: `${SPARKPLUG_AGENT_READS} A broker publishes no size, cache ratio, query log or session list a subscriber can read, so no health reading is taken; this is not a reading of none.`,
  overview: `${SPARKPLUG_AGENT_READS} A broker publishes no version, uptime, connection limit or size a subscriber can read, so no overview is taken; this is not a reading of none.`,
  performance: `${SPARKPLUG_AGENT_READS} A broker publishes no performance reading a subscriber can read, so none is taken; this is not a reading of none.`,
  slowQueries: `${SPARKPLUG_AGENT_READS} A broker answers subscriptions rather than queries and keeps no query log, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${SPARKPLUG_AGENT_READS} A broker publishes no client list to a subscriber, and host application state is never read in agent mode, so no session reading is taken; this is not a reading of none.`,
  tableStats: `${SPARKPLUG_AGENT_READS} A group, an edge node or a device is not a stored table with statistics, so no table reading is taken; count a window's messages with run_read_query.`,
  indexStats: `${SPARKPLUG_AGENT_READS} A broker has no index, so no index reading is taken; this is not a reading of none.`,
  storage: `${SPARKPLUG_AGENT_READS} A broker publishes no storage reading a subscriber can read, so none is taken; this is not a reading of none.`,
} as const;
