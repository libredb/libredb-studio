/**
 * What a tree click and "Generate Read Request" write for a RabbitMQ stream, read through
 * `DIALECT_GENERATORS.rabbitmq` in `src/lib/query-generators.ts`.
 *
 * Pure, and shipped to the browser, so it imports only `limits.ts`. The path is `[vhost, stream]`. Each name is
 * written with `JSON.stringify` alone, so the request parser reads back exactly the clicked vhost and stream, and
 * neither function throws: a click has no error to show.
 */
import { RABBITMQ_READ_DEFAULT_ROWS } from "./limits";

/** One read request for the stream at `path`, starting at `from`. */
function readRequest(path: readonly string[], from: "first" | "last"): string {
  const vhost = JSON.stringify(path[0] ?? "");
  const stream = JSON.stringify(path[1] ?? "");
  return `{"vhost": ${vhost}, "stream": ${stream}, "from": "${from}", "limit": ${RABBITMQ_READ_DEFAULT_ROWS}}`;
}

/** The click, "Read Last Chunk": the broker's last stored chunk, never another start. */
export function rabbitmqTableQuery(path: readonly string[]): string {
  return readRequest(path, "last");
}

/** "Generate Read Request": the same read from the stream's first retained message, written and not run. */
export function rabbitmqSelectQuery(path: readonly string[]): string {
  return readRequest(path, "first");
}
