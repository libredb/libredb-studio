/**
 * The rabbitread language's MCP facet: `run_rabbitmq_read`, one stream read request read and admitted by the agent's
 * own RabbitMQ adapter, answered metadata only.
 *
 * The MCP module reads it with the agent's own reader, admission and `queryReadOnly`, so every answer is the agent's
 * projection: each message's offset and body size, never its body, headers, properties or routing key. No `database`
 * key: a request names its virtual host in its own `vhost` key, and the broker's permissions decide which virtual hosts
 * and streams the connection may read. A read is never paged by offset, so the next read starts at an offset the
 * request names.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const RABBITREAD_MCP_FACET = Object.freeze({
  tool: "run_rabbitmq_read",
  title: "Run a read-only RabbitMQ stream read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  // A stream is a relation, so inspect_schema lists the streams, each with the agent read's two columns.
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only read of one RabbitMQ stream on a connection: one JSON object with the keys vhost, stream, from and limit and no other, such as {"vhost": "/", "stream": "orders", "from": "first", "limit": 50}. from is "first", "last" (the broker's last stored chunk), "next", {"offset": n}, {"timestamp": "<ISO-8601 with a zone>"} or {"age": "<n><unit>"}, and limit is 1 to 500, default 50. Each message answers one row, its offset and its body size, and nothing else: a message's body, headers, properties and routing key are withheld. Only a stream is read: a classic or quorum queue is refused before the broker is asked for a message, since reading it would remove its messages. A request with any other key, or a read that stops before its limit for any reason but the stream's end, is refused rather than answered in part. A read that stops before its limit because no message arrived for 1 s answers the messages it read, and that stop is not proof of the stream's end. "next" answers only messages published after the read starts, so a read from "next" that nothing is published to during the read answers no rows. The broker's own permissions decide which virtual hosts and streams the connection may read. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so read on with "from": {"offset": n}, n the last offset read plus one.`,
  words: {
    fewerFields:
      'A row is only an offset and a body size and cannot be made smaller, so read on in later reads, from {"offset": n} or a later start,',
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, start the next read at {"offset": n}, where n is the last offset returned plus one.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit, though a row holds only an offset and a body size. Run the read again.",
    reached: "the broker",
  },
} as const satisfies AgentLanguageMcpFacet);
