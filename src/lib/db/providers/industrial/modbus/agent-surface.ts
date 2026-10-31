/**
 * What a Modbus handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * The object surface (`listContainers`, `countObjects`, `listObjects`, `describeObject`, `describeObjects`) is the
 * connection's own register map on every handle: it sends nothing, its point names reach the run as object names, and
 * with no map `countObjects` answers `unavailable` rather than a zero, since an absent map is not an empty device. The
 * dial `connect` makes and health's one-point read reach the device, so on an agent-mode handle they take their turn
 * on the device's lane like an agent read (`agent-pacing.ts`). Every other reading would answer with a figure the
 * provider fills in without asking the device (the overview's one connection and its point count, an empty list), so
 * on an agent-mode handle each answers its reason instead, and the console is refused. The editor's handles keep
 * every surface.
 */

/**
 * How long the dial of `connect` and the read of a health reading on an agent-mode handle may wait for their turn on
 * the device and run, in milliseconds. Neither carries a statement budget of its own; this is the request timer's
 * 3000 ms three times over, room for one agent read ahead of it, the gap after it and the reading itself.
 */
export const MODBUS_AGENT_SURFACE_WAIT_MS = 9000;

const AGENT_READS =
  "Agent mode on Modbus reads the device through queryReadOnly, one paced read at a time, and the object tree from the connection's register map, which sends nothing.";

/** Each reading an agent-mode handle does not take, with its reason. No sentence names a value the device holds. */
export const MODBUS_AGENT_WITHHELD = {
  query: `${AGENT_READS} The console is not paced against other agent reads of the device and not counted against a run, so it is refused on an agent-mode handle; agent reads go through queryReadOnly.`,
  overview: `${AGENT_READS} A Modbus device reports no version, uptime, connection limit or size, and the overview's figures would be Studio's own (one connection, the map's point count), so no overview is taken; this is not a reading of none.`,
  performance: `${AGENT_READS} A Modbus device publishes no performance reading, so none is taken; this is not a reading of none.`,
  slowQueries: `${AGENT_READS} A Modbus device keeps no statement history, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${AGENT_READS} A Modbus device reports none of its connections, so no session reading is taken; this is not a reading of none.`,
  tableStats: `${AGENT_READS} A Modbus table is an address space of 65536 items, not a stored table with statistics, so no table reading is taken; read a block of it with run_read_query.`,
  indexStats: `${AGENT_READS} A Modbus device has no index, so no index reading is taken; this is not a reading of none.`,
  storage: `${AGENT_READS} A Modbus device reports no storage, so no storage reading is taken; this is not a reading of none.`,
  /** The dial or the health read could not take its turn on the device in time. */
  waited: `${AGENT_READS} This reading waited for its turn on the device, behind another agent read of it and the gap Studio keeps after one, longer than ${MODBUS_AGENT_SURFACE_WAIT_MS}ms, so it was refused before anything was sent. This is Studio's refusal, not the device's answer.`,
} as const;
