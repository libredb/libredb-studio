/**
 * What an OPC UA handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * Every reading below would answer, on an agent-mode handle, either with a figure the provider fills in without asking
 * the server (an empty session list, a size of "unknown", a zero table count) or through the connection's one held
 * session, which reads any node beyond the connection's read roots. So each answers its reason instead, and the model is told
 * what it was not shown rather than reading an absence as the server's own answer. The console and the Keys panel,
 * which read any node, are refused. The editor's handles keep every surface.
 */

const AGENT_READS =
  'Agent mode on OPC UA reads the server through run_read_query alone, one session per read: {"read": [...]} for current values with their engineering units, {"history": "..."} for one node\'s raw history, and {"browse": "<node id>"} for one level beneath the read roots, which {"browse": "i=85"} lists.';

/** Each reading an agent-mode handle does not take, with its reason. No sentence names a value the server holds. */
export const OPCUA_AGENT_WITHHELD = {
  query: `${AGENT_READS} The console reads beyond this connection's read roots, and holds the connection's session open, so it is refused on an agent-mode handle.`,
  keys: `${AGENT_READS} The Keys panel's level reads browse beyond this connection's read roots, so they are refused on an agent-mode handle; browse a level with run_read_query.`,
  objects: `${AGENT_READS} An OPC UA server's nodes are not listed as objects: browse them with run_read_query, starting from the read roots, {"browse": "i=85"}.`,
  overview: `${AGENT_READS} An OPC UA server reports no size, table count or index count, so no overview is taken; its product, version, state and start time are Server.ServerStatus (i=2256), read with run_read_query where an operator declared it a read root.`,
  health: `${AGENT_READS} An OPC UA server reports no database size, cache ratio or query log, and its session list is never read by agent mode, so no health reading is taken; this is not a reading of none.`,
  performance: `${AGENT_READS} An OPC UA server publishes no performance reading in a form Studio reads, so none is taken; this is not a reading of none.`,
  slowQueries: `${AGENT_READS} An OPC UA server answers services rather than queries and keeps no query log, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${AGENT_READS} An OPC UA server's sessions are listed in its session diagnostics, which agent mode never reads because they carry each client's name, user identity and endpoint, so no session reading is taken; this is not a reading of none.`,
  tableStats: `${AGENT_READS} An OPC UA server holds an address space of nodes rather than tables, so no table reading is taken; this is not a reading of none.`,
  indexStats: `${AGENT_READS} An OPC UA server has no index, so no index reading is taken; this is not a reading of none.`,
  storage: `${AGENT_READS} An OPC UA server publishes no storage or size figure, so no storage reading is taken; this is not a reading of none.`,
} as const;
