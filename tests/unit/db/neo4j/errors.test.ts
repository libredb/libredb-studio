/**
 * The Neo4j error table (spec 5.6): one row per transport category, each from the error the evidence harness
 * captured on 5.26.31 where the server can produce it.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import { GraphClientError } from "@/lib/db/graph/bolt/client";
import { mapNeo4jError } from "@/lib/db/providers/graph/neo4j/errors";
import { capturedErrorOf } from "../../../helpers/neo4j-fixtures";

describe("mapNeo4jError", () => {
  test("auth: an AuthenticationError with the server's message", () => {
    const source = capturedErrorOf("transport/error-auth");
    expect(source.category).toBe("auth");
    const mapped = mapNeo4jError(source);
    expect(mapped).toBeInstanceOf(AuthenticationError);
    expect(mapped.message).toBe("Neo4j refused the sign-in: The client is unauthorized due to authentication failure.");
    expect((mapped as AuthenticationError).provider).toBe("neo4j" as never);
  });

  test("connection: a ConnectionError with the driver's message", () => {
    const source = capturedErrorOf("transport/error-connection");
    expect(source.category).toBe("connection");
    const mapped = mapNeo4jError(source);
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe(`Neo4j could not be reached: ${source.message}`);
  });

  test("tls: a ConnectionError naming the TLS failure", () => {
    const source = new GraphClientError(
      "tls",
      "self-signed certificate in certificate chain",
      "SELF_SIGNED_CERT_IN_CHAIN",
    );
    const mapped = mapNeo4jError(source);
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe("The TLS connection to Neo4j failed: self-signed certificate in certificate chain");
  });

  test("timeout: a TimeoutError with the server's message", () => {
    const source = capturedErrorOf("error-timeout");
    expect(source.category).toBe("timeout");
    const mapped = mapNeo4jError(source);
    expect(mapped).toBeInstanceOf(TimeoutError);
    expect(mapped.message).toBe(`The query did not finish in time: ${source.message.trim()}`);
  });

  test("cancelled: the QueryCancelledError the query route reads as the caller's own cancel", () => {
    const mapped = mapNeo4jError(new GraphClientError("cancelled", "The query was cancelled"));
    expect(mapped).toBeInstanceOf(QueryCancelledError);
    expect(mapped.message).toBe("The query was cancelled.");
  });

  test("access-mode: a QueryError saying the connection is read-only, the server's answer as detail", () => {
    // The refusal the harness measured for CREATE (n) in a READ session (fixture README).
    const source = new GraphClientError(
      "access-mode",
      "Writing in read access mode not allowed. Attempted write to neo4j",
      "Neo.ClientError.Statement.AccessMode",
    );
    const mapped = mapNeo4jError(source) as QueryError;
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe("The server refused a write: Neo4j connections are read-only in this version.");
    expect(mapped.detail).toBe(
      "Neo.ClientError.Statement.AccessMode: Writing in read access mode not allowed. Attempted write to neo4j",
    );
  });

  test("syntax: a QueryError with the server's message and code", () => {
    const source = capturedErrorOf("error-syntax");
    expect(source.category).toBe("syntax");
    const mapped = mapNeo4jError(source) as QueryError;
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe(source.message);
    expect(mapped.detail).toBe("Neo.ClientError.Statement.SyntaxError");
  });

  test("query: a QueryError with the server's message and code", () => {
    const source = capturedErrorOf("error-query");
    expect(source.category).toBe("query");
    const mapped = mapNeo4jError(source) as QueryError;
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe("/ by zero");
    expect(mapped.detail).toBe("Neo.ClientError.Statement.ArithmeticError");
  });

  test("a failure without a code keeps no detail", () => {
    const mapped = mapNeo4jError(new GraphClientError("query", "The result stream failed")) as QueryError;
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.detail).toBeUndefined();
  });
});
