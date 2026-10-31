/**
 * What an SNMP handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * The object surface (`countObjects`, `listObjects`, `describeObject`, `describeObjects`) is the bundled catalog on
 * every handle: it sends nothing, and none of the withheld subtrees is in it, since the bundled modules define none
 * of them. Health is the console's own Get of `sysDescr.0` and `sysUpTime.0`, the same read an agent may send. Every
 * other reading an agent-mode handle would answer with a figure the provider filled in without asking the agent (a
 * zero, an empty list) answers its reason instead, so the model is told what it was not shown rather than reading an
 * absence as the device's own answer; the console, which reads any subtree, is refused. The editor's handles keep
 * every surface.
 */

const AGENT_READS =
  "Agent mode on SNMP reads the agent with get, next, walk and table, and the object tree from the bundled MIB modules, which send nothing.";

/** Each reading an agent-mode handle does not take, with its reason. No sentence names a value the agent holds. */
export const SNMP_AGENT_WITHHELD = {
  query: `${AGENT_READS} The console reads any subtree, the withheld security modules included, so it is refused on an agent-mode handle; agent reads go through queryReadOnly.`,
  overview: `${AGENT_READS} The overview's connection and size figures are not figures an SNMP agent reports, so no overview is taken; the health reading carries the agent's own sysDescr.0 and sysUpTime.0.`,
  performance: `${AGENT_READS} An SNMP agent publishes no performance reading in a form Studio reads, so none is taken; this is not a reading of none.`,
  slowQueries: `${AGENT_READS} An SNMP agent keeps no statement history, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${AGENT_READS} SNMP over UDP has no session to be active, so no session reading is taken; this is not a reading of none.`,
  tableStats: `${AGENT_READS} A conceptual table is a shape the MIB declares, not a stored object with statistics, so no table reading is taken; read a table's rows with run_read_query.`,
  indexStats: `${AGENT_READS} An INDEX clause names a row's key, not an index with a size, so no index reading is taken; this is not a reading of none.`,
  storage: `${AGENT_READS} An agent reports no storage of its own; the device's storage is a MIB to read with run_read_query (hrStorageTable), so no storage reading is taken here.`,
} as const;
