/**
 * The Neo4j error table (Neo4j provider spec 5.6).
 *
 * The Bolt client has already classified every failure (`GraphClientError.category`, decided by the
 * server's status code where there is one); this table turns each category into the repository's error
 * class, so each answers the HTTP status and `retryable` that `createErrorResponse` gives its class. The
 * server's own words follow the provider's, and its status code travels as the `QueryError` detail.
 *
 * A write refused by the READ session is never the server's sentence alone: "Writing in read access mode
 * not allowed" reads as a fault, and the fact the user needs is that the connection is read-only.
 */
import { AuthenticationError, ConnectionError, QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { GraphClientError } from "@/lib/db/graph/bolt/client";
import type { DatabaseType } from "@/lib/db/types";

export const PROVIDER: DatabaseType = "neo4j";

/** A transport failure to the repository's error class (see the file comment). */
export function mapNeo4jError(error: GraphClientError): Error {
  const message = error.message.trim();
  switch (error.category) {
    case "auth":
      return new AuthenticationError(`Neo4j refused the sign-in: ${message}`, PROVIDER);
    case "connection":
      return new ConnectionError(`Neo4j could not be reached: ${message}`, PROVIDER);
    case "tls":
      return new ConnectionError(`The TLS connection to Neo4j failed: ${message}`, PROVIDER);
    case "timeout":
      return new TimeoutError(`The query did not finish in time: ${message}`, PROVIDER);
    case "cancelled":
      return new QueryCancelledError("The query was cancelled.", PROVIDER);
    case "access-mode":
      return new QueryError(
        "The server refused a write: Neo4j connections are read-only in this version.",
        PROVIDER,
        undefined,
        undefined,
        error.code === undefined ? message : `${error.code}: ${message}`,
      );
    case "syntax":
    case "query":
      return new QueryError(error.message, PROVIDER, undefined, undefined, error.code);
  }
}
