/**
 * The agent's reader of one RabbitMQ read request: what the agent read-only profile sends, read before anything is
 * sent.
 *
 * Pure. It reads the text with the editor's own request parser (`request.ts`), so a request is read by one grammar
 * wherever it is written: one JSON object with the keys `vhost`, `stream`, `from` and `limit` and no other, each
 * written once. A request the parser refuses is refused with the parser's sentence followed by the agent's read, and
 * the parser's sentences quote no broker value: at most they name a key the request wrote. The request has no field
 * outside that shape, so no filter by a property, a header or a body and no count keyed by a value can be written.
 *
 * Metadata only. A message's body, headers, every property and its routing key are stored values, so the answer of an
 * admitted read is each delivered message's offset and body size alone (`agent-metadata-read.ts`); virtual host and
 * stream names are object names, which the request names itself.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the AMQP client encodes no take, publish,
 * purge or declare, a read asks the management API for the object's type before any frame and refuses anything but a
 * stream, and the consume always carries `x-stream-offset`, which the broker refuses with 406 on a classic or quorum
 * queue. Read permission in RabbitMQ also grants a take and a purge, so no credential can be the boundary. This is what
 * lets the model read why it was refused, before anything is sent.
 */
import { QueryError } from "@/lib/db/errors";
import { parseReadRequest, type ReadRequest } from "./request";

export type RabbitMQAgentRefusalCode = "request";

/** The one metadata operation: one row per delivered message, its offset and body size. */
export type RabbitMQAgentOperation = "stream messages";

export type RabbitMQAgentReading =
  | { readonly ok: true; readonly plan: ReadRequest }
  | { readonly ok: false; readonly code: RabbitMQAgentRefusalCode; readonly message: string };

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READ =
  'Agent mode on RabbitMQ reads one stream at a time, written as the editor\'s read request, one JSON object such as {"vhost": "/", "stream": "orders", "from": "first", "limit": 50}, and answers each message\'s offset and body size alone: a message\'s body, headers, properties and routing key are withheld.';

export const RABBITMQ_AGENT_SENTENCES = {
  empty: `The request holds no read. ${AGENT_READ} ${NOTHING_SENT}`,
  /** `message` is the editor parser's refusal, which quotes no broker value; the agent's read follows it. */
  request: (message: string): string => `${message} ${AGENT_READ} ${NOTHING_SENT}`,
} as const;

function refuse(code: RabbitMQAgentRefusalCode, message: string): RabbitMQAgentReading {
  return { ok: false, code, message };
}

/** One agent read request read to the read the provider sends, or to why it sends nothing. Never sends anything. */
export function readRabbitMQAgentStatement(text: string): RabbitMQAgentReading {
  if (text.trim() === "") return refuse("request", RABBITMQ_AGENT_SENTENCES.empty);
  try {
    return { ok: true, plan: parseReadRequest(text) };
  } catch (error) {
    // The parser throws only its own QueryError; anything else is a defect of ours and leaves as itself.
    if (!(error instanceof QueryError)) throw error;
    return refuse("request", RABBITMQ_AGENT_SENTENCES.request(error.message));
  }
}
