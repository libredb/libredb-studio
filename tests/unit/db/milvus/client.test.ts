/**
 * The Milvus seam (vector-family spec 5.1, E3, E15, E19): the method list is E15's allowlist in its order, with no
 * Connect and no telemetry method, and `MilvusError` keeps a server's text out of its message, so an error that
 * escapes the table unmapped still shows no server text.
 */
import { describe, expect, test } from "bun:test";
import { MILVUS_CLIENT_METHODS, MilvusError } from "@/lib/db/providers/vector/milvus/client";

describe("MILVUS_CLIENT_METHODS", () => {
  test("is E15's allowlist in its order, then close()", () => {
    expect([...MILVUS_CLIENT_METHODS]).toEqual([
      "getVersion",
      "checkHealth",
      "getMetricsSystemInfo",
      "listDatabases",
      "describeDatabase",
      "showCollections",
      "describeCollection",
      "batchDescribeCollection",
      "describeIndex",
      "getLoadState",
      "getLoadingProgress",
      "getCollectionStatistics",
      "showPartitions",
      "listAliases",
      "describeAlias",
      "query",
      "search",
      "hybridSearch",
      "loadCollection",
      "releaseCollection",
      "close",
    ]);
  });

  test("names no Connect and no ClientTelemetryService method (E3)", () => {
    const names: readonly string[] = MILVUS_CLIENT_METHODS;
    for (const forbidden of [
      "connect",
      "clientHeartbeat",
      "getClientTelemetry",
      "pushClientCommand",
      "deleteClientCommand",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("MilvusError", () => {
  test("keeps the category, the raw detail, the gRPC code and the common.Status apart from its message", () => {
    const error = new MilvusError("status", "collection not found[database=default][collection=x]", {
      status: { code: 100, errorCode: "CollectionNotExists" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MilvusError");
    expect(error.category).toBe("status");
    expect(error.detail).toBe("collection not found[database=default][collection=x]");
    expect(error.status).toEqual({ code: 100, errorCode: "CollectionNotExists" });
    expect(error.message).toBe("The Milvus client failed (status)");
    expect(error.message).not.toContain("collection not found");
  });

  test("leaves an absent code, status or TLS failure absent, not undefined-valued", () => {
    const error = new MilvusError("unknown", "x");
    expect(Object.hasOwn(error, "grpcCode")).toBe(false);
    expect(Object.hasOwn(error, "status")).toBe(false);
    expect(Object.hasOwn(error, "tlsFailure")).toBe(false);
    expect(new MilvusError("unauthenticated", "x", { grpcCode: 16 }).grpcCode).toBe(16);
  });

  test("carries a TLS failure only on the tls category", () => {
    expect(new MilvusError("tls", "alert", { tlsFailure: "client-certificate-expired" }).tlsFailure).toBe(
      "client-certificate-expired",
    );
    expect(() => new MilvusError("unknown", "alert", { tlsFailure: "chain" })).toThrow(
      "A MilvusError of category unknown cannot carry a TLS failure",
    );
  });
});
