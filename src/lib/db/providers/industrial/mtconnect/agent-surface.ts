/**
 * What an MTConnect handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * The object surface (`listContainers`, `countObjects`, `listObjects`, `describeObject`, `describeObjects`) is the
 * agent's device model, read with one GET of `/probe` when the handle opens and held for the handle, with the agent's
 * adapter connections withheld (`agent-withheld.ts`): the devices, their data items and conditions reach the run as
 * object names. Assets are not listed: the model does not hold them, and the editor's count of none is Studio's figure,
 * not the agent's, so the asset count answers its reason. Every other reading would answer with a figure the provider
 * fills in without asking the agent (an "unknown" size, a connection limit of 0, an empty list), so on an agent-mode
 * handle each answers its reason instead, and the console, which reads observations through the editor's own window
 * and row cap, is refused. The editor's handles keep every surface.
 */
import { MTCONNECT_WITHHELD_SENTENCE } from "./agent-withheld";

const AGENT_READS =
  "Agent mode on MTConnect reads the agent through run_read_query alone, one request line per read, and the device tree from the agent's device model, read with GET /probe when the connection opens.";

/** Each reading an agent-mode handle does not take, with its reason. No sentence names a value the agent holds. */
export const MTCONNECT_AGENT_WITHHELD = {
  query: `${AGENT_READS} The console reads with the editor's own row cap and cuts a long read where agent mode refuses it, so it is refused on an agent-mode handle; agent reads go through queryReadOnly.`,
  assets: `${AGENT_READS} An agent's device model does not hold its assets, so they are not listed as objects and no count of them is taken; this is not a count of none. Read them with run_read_query: /assets, /{device}/assets or /asset/{assetIds}.`,
  withheldItem: `${AGENT_READS} ${MTCONNECT_WITHHELD_SENTENCE}`,
  overview: `${AGENT_READS} An MTConnect agent reports no uptime, connection limit or size, and the overview's figures would be Studio's own, so no overview is taken; this is not a reading of none. Its devices and data items are the object tree, and /probe reads its model.`,
  health: `${AGENT_READS} An MTConnect agent reports no database size, cache ratio, query log or session list, so no health reading is taken; this is not a reading of none.`,
  performance: `${AGENT_READS} An MTConnect agent publishes no performance reading, so none is taken; this is not a reading of none.`,
  slowQueries: `${AGENT_READS} An MTConnect agent answers requests rather than queries and keeps no query log, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${AGENT_READS} An MTConnect agent publishes no client list, so no session reading is taken; this is not a reading of none.`,
  tableStats: `${AGENT_READS} An MTConnect data item is a stream of observations in the agent's buffer, not a stored table with statistics, so no table reading is taken; read its observations with run_read_query.`,
  indexStats: `${AGENT_READS} An MTConnect agent has no index, so no index reading is taken; this is not a reading of none.`,
  storage: `${AGENT_READS} An MTConnect agent reports its buffer as a count of observations rather than storage, so no storage reading is taken; this is not a reading of none.`,
} as const;
