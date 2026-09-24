/**
 * The one table from Kafka's domain failures to the product's error classes (spec 5.6).
 *
 * Classified by the `KafkaError` category alone, never by message text: `platformatic-client.ts`
 * decides the category from the client's codes, and every message was written there, or in the
 * module that raised it, never to hold a credential or a typed host or port (spec K1, K3).
 * A network or TLS failure carries the bootstrap address on the `ConnectionError`'s fields,
 * which the API response does not serialise; an unreachable advertised broker carries the
 * address the broker advertised instead (spec K2).
 * A `DatabaseConfigError` from the shared validators arrives with no provider and is stamped
 * `kafka`; anything else that is not a `KafkaError` is returned untouched, so an internal
 * defect surfaces as itself and is never dressed up as the broker's answer.
 */
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import { KafkaError } from "./client";

const PROVIDER = "kafka";

export function toDatabaseError(error: unknown, bootstrap: { host: string; port: number }, timeoutMs: number): Error {
  if (error instanceof DatabaseConfigError && error.provider === undefined) {
    return new DatabaseConfigError(error.message, PROVIDER);
  }
  if (!(error instanceof KafkaError)) return error as Error;
  switch (error.category) {
    case "invalid-request":
    case "invalid-config":
      return new DatabaseConfigError(error.message, PROVIDER);
    case "unknown-topic":
    case "unknown-object":
    case "unreadable-topic":
    case "offset-out-of-range":
    case "unsupported-broker":
    case "protocol":
      return new QueryError(error.message, PROVIDER);
    case "authorization":
    case "authentication":
      return new AuthenticationError(error.message, PROVIDER);
    case "tls":
    case "network":
      return new ConnectionError(error.message, PROVIDER, bootstrap.host, bootstrap.port);
    case "advertised-unreachable":
      return new ConnectionError(error.message, PROVIDER, error.detail.host, error.detail.port);
    case "timeout":
      return new TimeoutError(error.message, PROVIDER, timeoutMs);
  }
}
