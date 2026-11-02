/**
 * The kafkaread language's MCP facet: `run_kafka_read`, one JSON read request read and admitted by the agent's own
 * Kafka adapter, answered metadata-only.
 *
 * The MCP module reads it with the agent's own reader, admission and `queryReadOnly`, so every answer is the agent's
 * metadata projection: topic names, partition and replica counts, leader and replica node ids, broker node ids and
 * racks, the cluster id and each partition's earliest and end offsets, never a record's key, value, headers or
 * timestamp, a broker's host and port, a config, a log directory or a consumer group, and a platform's own topics are
 * withheld. A read pages with its own "limit" and "after", which the description and the cut-result words name; the
 * description also says that a full page may have more after it, since the provider's "more follow" warning is not
 * part of an MCP answer.
 *
 * No `database` key: a Kafka connection has no catalog level and declares no `catalogSessions`, so `providerInDatabase`
 * would refuse every call that named one, as the agent's own Kafka tool leaves it out.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const KAFKAREAD_MCP_FACET = Object.freeze({
  tool: "run_kafka_read",
  title: "Run a read-only Kafka metadata read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  // A topic is a relation kind, so inspect_schema lists Kafka's topics and brokers rather than refusing it.
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only Kafka metadata read on a connection: one JSON object as text, {"read": "topics"} for the topics with their partition and replica counts, {"read": "brokers"} for broker node ids and racks, {"read": "partitions", "topic": "orders"} for one topic's partitions with their leader and replicas, or {"read": "offsets", "topic": "orders"} for each partition's earliest and end offsets; each also takes "limit" (1 to 500, default 50) and "after", the last topic name, node id or partition id read, to read on. Metadata only: no record's key, value, headers or timestamp is ever fetched, a broker's host and port, configs, log directories and consumer groups are not read, Kafka's internal topics and a platform's own topics (a leading underscore, or connect-) are withheld, and an offset span is not a message count. Any other request is refused before the broker is reached. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so page inside the request with "limit" and "after": an answer that holds as many rows as its "limit" may have more after it, so read on with "after" until an answer holds fewer.`,
  words: {
    // A Kafka read answers fixed columns, so a byte cut is read on with "after", never narrowed by field.
    fewerFields: "A Kafka read's columns are fixed, so none can be left out",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, set "after" to the last topic name, node id or partition id among them.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read a narrower listing, one topic's partitions or offsets, and run it again.",
    reached: "the broker",
  },
} as const satisfies AgentLanguageMcpFacet);
