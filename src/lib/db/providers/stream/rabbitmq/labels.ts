/**
 * The RabbitMQ provider's labels: the words the shared panels use for this engine.
 *
 * Pure, and shipped to the browser: `getLabels()` answers before connect, through `POST /api/db/provider-meta`.
 * `statementLanguage` is what plan mode states verbatim after "Write it in" (`src/lib/agent/investigation.ts`), the one
 * fact about how a request is written that its prompt carries per engine: the request schema is this product's own,
 * so the sentence carries the schema, the defaults and the start forms.
 */
import type { ProviderLabels } from "@/lib/db/types";
import { RABBITMQ_LAST_HINT_BACKSTEP, RABBITMQ_READ_DEFAULT_ROWS, RABBITMQ_READ_MAX_ROWS } from "./limits";

/** Two requests the sentence gives as examples: the click's read, and a numeric start written as a digit string. */
export const RABBITMQ_STATEMENT_EXAMPLES: readonly [string, string] = Object.freeze([
  `{"vhost": "/", "stream": "orders", "from": "last", "limit": ${RABBITMQ_READ_DEFAULT_ROWS}}`,
  `{"vhost": "/", "stream": "orders", "from": {"offset": "120"}, "limit": 10}`,
]) as readonly [string, string];

/** The sentence plan mode states: the schema, the defaults, every start form and what a request cannot read. */
export function rabbitmqStatementLanguage(): string {
  return [
    `the JSON read request this editor executes - one object, {"vhost": "<virtual host>", "stream": "<stream name>", "from": <start>, "limit": <1 to ${RABBITMQ_READ_MAX_ROWS}>}, with no other key`,
    `"vhost" and "stream" are required; "from" defaults to "last" and "limit" to ${RABBITMQ_READ_DEFAULT_ROWS}`,
    // The shared inventory joins an object's path with a dot, and "/" followed by a dot does not read as a vhost.
    `an inventory entry is named by its virtual host, a dot and its own name, and a plan run reads only the virtual host "/", so the entry "/.orders" is the stream "orders", written {"vhost": "/", "stream": "orders"}; "stream" never carries the "/." prefix or any part of it`,
    `a request reads a stream's messages only: the queue and exchange names in the inventory are not readable, because reading a classic or quorum queue removes its messages`,
    `<start> is "first", "last", "next", {"offset": <n>} (a whole number, or a digit string above 9007199254740991), {"timestamp": "<ISO-8601 with a zone>"} or {"age": "<n><unit>"} with unit Y, M (months), D, h, m (minutes) or s`,
    `the timestamp column is the message's timestamp property, set by the publisher (or by the broker's timestamp interceptor), in seconds. A timestamp or age start uses the time the broker stored the messages; the timestamp column is the publisher's own property, which can be empty or differ`,
    `"last" starts at the broker's last stored chunk, which can hold fewer messages than the limit; for older messages read from an offset ${RABBITMQ_LAST_HINT_BACKSTEP} before the first one shown`,
    `for example ${RABBITMQ_STATEMENT_EXAMPLES[0]} or ${RABBITMQ_STATEMENT_EXAMPLES[1]}`,
  ].join("; ");
}

export const RABBITMQ_LABELS: ProviderLabels = Object.freeze({
  // The noun plan mode's inventory and the object search use: only a stream is read.
  entityName: "Stream",
  entityNamePlural: "Streams",
  rowName: "Message",
  rowNamePlural: "Messages",
  selectAction: "Read Last Chunk",
  generateAction: "Generate Read Request",
  searchPlaceholder: "Search streams, queues and exchanges...",
  statementLanguage: rabbitmqStatementLanguage(),
  slowQueriesEmptyState: "RabbitMQ has no query log",
  // True for every account, an administrator included: Studio never lists broker connections.
  sessionsEmptyState: "Studio does not list broker connections, because they name other users and client addresses.",
  // Never rendered: maintenanceControl() gates every placement on supportsMaintenance first (src/lib/db/types.ts).
  analyzeAction: "Analyze Stream",
  vacuumAction: "Compact Stream",
  analyzeGlobalLabel: "Analyze",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "RabbitMQ has no statistics to update.",
  vacuumGlobalLabel: "Compact",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Stream retention is a policy the broker applies on its own schedule; Studio does not trigger it.",
});
