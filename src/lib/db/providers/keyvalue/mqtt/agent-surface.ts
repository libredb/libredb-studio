/**
 * What an MQTT handle opened for an agent-mode profile answers outside `queryReadOnly`.
 *
 * Metadata only, as the agent's reads are: topic names are stored values, so no surface of an agent-mode handle names a
 * topic, and payloads are values, so none reads one. The Keys panel's page, a topic's listing and description and its
 * Source tab are refused with their reason. A broker publishes no size, statistics, query log or session list a
 * subscriber can read, and the editor's figures for them are Studio's own (an "unknown" size, a connection limit of 0,
 * an empty list), so on an agent-mode handle each reading answers its reason instead of a figure the provider fills in
 * without asking the broker. The editor's handles keep every surface.
 */
import { MQTT_AGENT_READS } from "./agent-statement";

/** Why topic names never reach agent mode, in the words the grounding and the refusals share. */
export const MQTT_TOPICS_WITHHELD_SENTENCE =
  "Topic names are withheld from agent mode, because a topic path names the people and devices behind it, and so are payloads, user properties, correlation data, response topics and content types: no topic is listed or named to agent mode, and a read answers counts and flags only.";

/** Each surface or reading an agent-mode handle does not take, with its reason. No sentence names a broker value. */
export const MQTT_AGENT_WITHHELD = {
  query: `${MQTT_AGENT_READS} ${MQTT_TOPICS_WITHHELD_SENTENCE} An MQTT connection has no query console, and agent reads go through queryReadOnly.`,
  topics: `${MQTT_TOPICS_WITHHELD_SENTENCE} ${MQTT_AGENT_READS}`,
  source: `${MQTT_TOPICS_WITHHELD_SENTENCE} A topic's Source tab reads its payload, which agent mode never reads. ${MQTT_AGENT_READS}`,
  keys: `${MQTT_TOPICS_WITHHELD_SENTENCE} The Keys panel lists topic names, so it is refused on an agent-mode handle. ${MQTT_AGENT_READS}`,
  health: `${MQTT_AGENT_READS} An MQTT broker publishes no size, cache ratio, query log or session list a subscriber can read, so no health reading is taken; this is not a reading of none.`,
  overview: `${MQTT_AGENT_READS} An MQTT broker publishes no version, uptime, connection limit or size a subscriber can read, so no overview is taken; this is not a reading of none.`,
  performance: `${MQTT_AGENT_READS} An MQTT broker publishes no performance reading a subscriber can read, so none is taken; this is not a reading of none.`,
  slowQueries: `${MQTT_AGENT_READS} An MQTT broker answers subscriptions rather than queries and keeps no query log, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${MQTT_AGENT_READS} An MQTT broker publishes no client list to a subscriber, and the broker's own $SYS tree is never read in agent mode, so no session reading is taken; this is not a reading of none.`,
  tableStats: `${MQTT_AGENT_READS} A topic is not a stored table with statistics, so no table reading is taken; count a window's messages with run_read_query.`,
  indexStats: `${MQTT_AGENT_READS} An MQTT broker has no index, so no index reading is taken; this is not a reading of none.`,
  storage: `${MQTT_AGENT_READS} An MQTT broker publishes no storage reading a subscriber can read, so none is taken; this is not a reading of none.`,
} as const;
