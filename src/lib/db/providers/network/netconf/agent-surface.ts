/**
 * What a NETCONF handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * The object surface (`listContainers`, `countObjects`, `listObjects`, `describeObject`, `describeObjects`) answers
 * names on every handle and never a value, and the Keys panel's levels are element names too, so both stay. The
 * metric, session, table, index and storage readings already answer their reason on every handle. What an agent-mode
 * handle refuses with its reason are the three surfaces that would pass a device's answer, or a figure the provider
 * filled in without asking, past the withheld-node check: the console, a key's raw XML and the overview's zeros. The
 * editor's handles keep every surface.
 */
import { NETCONF_WITHHELD_TEXT } from "./agent-withheld";

const AGENT_READS =
  "Agent mode on NETCONF reads through queryReadOnly, which reads the device's YANG modules before every read and withholds what they mark.";

/** Each surface an agent-mode handle does not answer, with its reason. No sentence names a value the device holds. */
export const NETCONF_AGENT_WITHHELD = {
  query: `${AGENT_READS} The console reads any path and answers every value, the withheld nodes included, so it is refused on an agent-mode handle. ${NETCONF_WITHHELD_TEXT}`,
  source: `${AGENT_READS} A node's source and a key's raw XML are answered as the device sent them, past that check, so neither is read on an agent-mode handle.`,
  overview: `${AGENT_READS} The overview's connection, table and index figures are not figures a NETCONF device reports, so no overview is taken; this is not a reading of none.`,
} as const;
