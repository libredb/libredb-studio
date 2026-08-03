/**
 * Couchbase HTTP transport (issue #262, decisions 1, 3 and 5)
 *
 * globalThis.fetch is replaced per test and restored in afterEach. mock.module()
 * is deliberately not used: it is process-wide in bun and would poison sibling
 * test files, so the DNS resolver and the TLS request function are injected
 * through the transport's dependency seam instead.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";
import type { SSLConfig } from "@/lib/types";
import { CouchbaseError } from "@/lib/db/providers/document/couchbase/transport";
import {
  CouchbaseHttpTransport,
  nodeRequestJson,
  type CouchbaseHttpTransportDeps,
  type CouchbaseTlsMaterial,
  type JsonRequestInit,
} from "@/lib/db/providers/document/couchbase/http-transport";

// ============================================================================
// Helpers
// ============================================================================

// The DatabaseType union gains "couchbase" in the registration commit; the
// double assertion keeps this file compiling on either side of that change.
const COUCHBASE: DatabaseType = "couchbase" as unknown as DatabaseType;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, httpCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: httpCode,
    headers: { "content-type": "application/json" },
  });
}

const NODE_SERVICES = {
  nodesExt: [{ hostname: "node1.local", services: { mgmt: 8091, n1ql: 8093, n1qlSSL: 18093 } }],
};

/** Route the management discovery call, send everything else to the query handler. */
function routeQuery(payload: unknown, httpCode = 200, nodeServices: unknown = NODE_SERVICES) {
  return (url: string): Response => {
    if (url.includes("/pools/default/nodeServices")) return jsonResponse(nodeServices);
    return jsonResponse(payload, httpCode);
  };
}

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "cb-1",
    name: "Couchbase",
    type: COUCHBASE,
    host: "127.0.0.1",
    port: 8091,
    user: "Administrator",
    password: "password123",
    database: "travel",
    createdAt: new Date(),
    ...overrides,
  };
}

function makeTransport(overrides: Partial<DatabaseConnection> = {}, deps: CouchbaseHttpTransportDeps = {}) {
  return new CouchbaseHttpTransport(makeConnection(overrides), deps);
}

function successPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestID: "0e0e0e",
    signature: { id: "string", city: "string" },
    results: [{ id: "hotel::1", city: "Bursa" }],
    status: "success",
    metrics: { elapsedTime: "2.5ms", executionTime: "1.234ms", resultCount: 1, mutationCount: 0 },
    ...overrides,
  };
}

function queryCalls(): FetchCall[] {
  return calls.filter((call) => call.url.includes("/query/service"));
}

function lastQueryBody(): Record<string, unknown> {
  const body = queryCalls().at(-1)?.init?.body;
  return JSON.parse(String(body ?? "{}")) as Record<string, unknown>;
}

function headerOf(call: FetchCall | undefined, name: string): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.[name];
}

async function startServer(listener: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const NO_TLS: CouchbaseTlsMaterial = { rejectUnauthorized: false };
const GET_INIT: JsonRequestInit = { method: "GET", headers: { accept: "application/json" } };

beforeEach(() => {
  calls = [];
  handler = routeQuery(successPayload());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Query execution
// ============================================================================

describe("CouchbaseHttpTransport.query", () => {
  test("throws when a 200 response reports a failed statement (decision 5)", async () => {
    handler = routeQuery({
      requestID: "1",
      signature: null,
      results: [],
      status: "errors",
      errors: [{ code: 3000, msg: "syntax error - line 1, column 8, near 'SELCT'" }],
    });

    const transport = makeTransport();
    const error = (await transport.query("SELCT 1").catch((e: unknown) => e)) as CouchbaseError;

    expect(error).toBeInstanceOf(CouchbaseError);
    expect(error.code).toBe(3000);
    expect(error.message).toContain("syntax error");
    expect(error.retriable).toBe(false);
  });

  test("throws a generic failure when the failed statement carries no error detail", async () => {
    handler = routeQuery({ requestID: "1", results: [], status: "errors", errors: [] });

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error).toBeInstanceOf(CouchbaseError);
    expect(error.code).toBe(0);
    expect(error.retriable).toBe(false);
  });

  test("marks a transient statement failure as retriable", async () => {
    handler = routeQuery({
      results: [],
      status: "errors",
      errors: [{ code: 1080, msg: "Timeout 30s exceeded" }],
    });

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error.code).toBe(1080);
    expect(error.retriable).toBe(true);
  });

  test("reads an error message from the message field and defaults a missing code", async () => {
    handler = routeQuery({ results: [], status: "errors", errors: [{ message: "alternate wording" }] });

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error.code).toBe(0);
    expect(error.message).toBe("alternate wording");
  });

  test("falls back to a default message when the failure carries neither msg nor message", async () => {
    handler = routeQuery({ results: [], status: "errors", errors: [{ code: 5000 }] });

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error.code).toBe(5000);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("maps rows, field names, execution time, mutations and warnings", async () => {
    handler = routeQuery(
      successPayload({
        results: [
          { id: "hotel::1", city: "Bursa" },
          { id: "hotel::2", city: "Istanbul" },
        ],
        metrics: { executionTime: "12.5ms", mutationCount: 2 },
        warnings: [{ code: 3239, msg: "advisor is unavailable" }],
      }),
    );

    const result = await makeTransport().query("SELECT id, city FROM hotel");

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ id: "hotel::1", city: "Bursa" });
    expect(result.fieldNames).toEqual(["id", "city"]);
    expect(result.executionTimeMs).toBe(12.5);
    expect(result.mutationCount).toBe(2);
    expect(result.warnings).toEqual([{ code: 3239, message: "advisor is unavailable" }]);
  });

  test("normalizes warnings that are not objects or carry no code", async () => {
    handler = routeQuery(successPayload({ warnings: [null, { message: "no code here" }] }));

    const result = await makeTransport().query("SELECT 1");

    expect(result.warnings).toEqual([
      { code: 0, message: "" },
      { code: 0, message: "no code here" },
    ]);
  });

  test("returns an empty warning list when the cluster sends none", async () => {
    const result = await makeTransport().query("SELECT 1");
    expect(result.warnings).toEqual([]);
  });

  test("returns null field names for the SELECT * wildcard", async () => {
    handler = routeQuery(successPayload({ signature: { "*": "*" }, results: [{ hotel: { city: "Bursa" } }] }));

    const result = await makeTransport().query("SELECT * FROM hotel");

    expect(result.fieldNames).toBeNull();
    expect(result.rows).toEqual([{ hotel: { city: "Bursa" } }]);
  });

  test("returns null field names when a wildcard is mixed with named projections", async () => {
    // Verified live: `SELECT META(u).id AS __id, u.* FROM ks AS u` signs as
    // { id: "json", "*": "*" }. Taking the signature keys verbatim would name the
    // columns __id and "*", so the grid would render an empty "*" column and hide
    // every field the wildcard actually expanded to. Any wildcard key means the
    // signature cannot describe the rows; the caller derives fields from them instead.
    handler = routeQuery(
      successPayload({
        signature: { id: "json", "*": "*" },
        results: [{ __id: "u::1", n: 1, note: "no index here" }],
      }),
    );

    const result = await makeTransport().query("SELECT META(u).id AS __id, u.* FROM ks AS u");

    expect(result.fieldNames).toBeNull();
    expect(result.rows).toEqual([{ __id: "u::1", n: 1, note: "no index here" }]);
  });

  test("returns null field names when the signature is not an object", async () => {
    handler = routeQuery(successPayload({ signature: "json" }));
    expect((await makeTransport().query("INFER hotel")).fieldNames).toBeNull();
  });

  test("returns null field names when the response carries no signature", async () => {
    handler = routeQuery({ requestID: "1", results: [], status: "success", metrics: {} });
    expect((await makeTransport().query("SELECT 1")).fieldNames).toBeNull();
  });

  test("returns no rows when the response carries no row array", async () => {
    handler = routeQuery({ requestID: "1", status: "success", metrics: {} });

    const result = await makeTransport().query("UPDATE hotel SET x = 1");

    expect(result.rows).toEqual([]);
    expect(result.mutationCount).toBe(0);
    expect(result.executionTimeMs).toBe(0);
  });

  test("returns zeroed metrics when the response carries no metrics object", async () => {
    handler = routeQuery({ requestID: "1", results: [], status: "success" });

    const result = await makeTransport().query("SELECT 1");

    expect(result.executionTimeMs).toBe(0);
    expect(result.mutationCount).toBe(0);
  });

  test("parses every duration format the cluster emits", async () => {
    const cases: Array<[string, number]> = [
      ["1.234ms", 1.234],
      ["1.5s", 1500],
      ["2m30s", 150000],
      ["1h2m3.5s", 3723500],
      ["750µs", 0.75],
      ["750us", 0.75],
      ["900ns", 0.0009],
      ["not-a-duration", 0],
    ];

    // The statement doubles as the duration the mocked cluster reports back, so
    // every case can run against one transport.
    handler = (url: string, init?: RequestInit) => {
      if (url.includes("/pools/default/nodeServices")) return jsonResponse(NODE_SERVICES);
      const { statement } = JSON.parse(String(init?.body ?? "{}")) as { statement: string };
      return jsonResponse(successPayload({ metrics: { executionTime: statement } }));
    };

    const transport = makeTransport();
    const results = await Promise.all(cases.map(([duration]) => transport.query(duration)));

    results.forEach((result, index) => {
      expect(result.executionTimeMs).toBeCloseTo(cases[index][1], 6);
    });
  });

  test("falls back to the elapsed duration when no execution duration is reported", async () => {
    handler = routeQuery(successPayload({ metrics: { elapsedTime: "3.5ms" } }));
    expect((await makeTransport().query("SELECT 1")).executionTimeMs).toBe(3.5);
  });

  test("sends request_plus scan consistency by default so a user sees their own writes", async () => {
    await makeTransport().query("SELECT city FROM hotel");

    const body = lastQueryBody();
    expect(body.statement).toBe("SELECT city FROM hotel");
    expect(body.scan_consistency).toBe("request_plus");
    expect(body.timeout).toBe("30000ms");
    expect(body.metrics).toBe(true);
    expect(body.args).toBeUndefined();

    const call = queryCalls().at(-1);
    expect(call?.init?.method).toBe("POST");
    expect(headerOf(call, "content-type")).toBe("application/json");
    expect(headerOf(call, "authorization")).toBe(
      `Basic ${Buffer.from("Administrator:password123").toString("base64")}`,
    );
  });

  test("pins the query context to the connection's bucket so scope.collection resolves", async () => {
    // The schema explorer shows a collection as `scope.collection` (the bucket is
    // pinned by the connection), and the generated statement uses that same name.
    // SQL++ reads a bare two-part name as bucket.collection, so without a query
    // context `inventory.hotel` is looked up as a BUCKET called inventory and the
    // statement dies with "Ambiguous reference to field 'inventory'". Verified live:
    // sending query_context resolves both the two-part name and a fully qualified
    // three-part path, so what the sidebar displays is what the user can run.
    await makeTransport().query("SELECT d.* FROM `inventory`.`hotel` AS d");

    expect(lastQueryBody().query_context).toBe("default:`travel`");
  });

  test("omits the query context when the connection pins no bucket", async () => {
    await makeTransport({ database: undefined }).query("SELECT 1");
    expect(lastQueryBody().query_context).toBeUndefined();
  });

  test("honours scan consistency, args, timeout, readonly and profile overrides", async () => {
    await makeTransport().query("SELECT city FROM hotel WHERE country = $1", {
      args: ["Turkey"],
      timeoutMs: 5000,
      readonly: true,
      profile: "timings",
      scanConsistency: "not_bounded",
    });

    const body = lastQueryBody();
    expect(body.scan_consistency).toBe("not_bounded");
    expect(body.args).toEqual(["Turkey"]);
    expect(body.timeout).toBe("5000ms");
    expect(body.readonly).toBe(true);
    expect(body.profile).toBe("timings");
  });

  test("omits an empty argument list", async () => {
    await makeTransport().query("SELECT 1", { args: [] });
    expect(lastQueryBody().args).toBeUndefined();
  });
});

// ============================================================================
// Query port discovery (decision 3)
// ============================================================================

describe("CouchbaseHttpTransport query endpoint discovery", () => {
  test("resolves the query port from nodeServices and caches it", async () => {
    const transport = makeTransport();
    await transport.query("SELECT 1");
    await transport.query("SELECT 2");

    expect(calls.filter((call) => call.url.includes("/pools/default/nodeServices"))).toHaveLength(1);
    expect(queryCalls()).toHaveLength(2);
    expect(queryCalls()[0].url).toBe("http://node1.local:8093/query/service");
    expect(calls[0].url).toBe("http://127.0.0.1:8091/pools/default/nodeServices");
  });

  test("prefers an advertised alternate address", async () => {
    handler = routeQuery(successPayload(), 200, {
      nodesExt: [
        {
          hostname: "node1.local",
          services: { n1ql: 8093 },
          alternateAddresses: { external: { hostname: "cb.example.com", ports: { n1ql: 30093 } } },
        },
      ],
    });

    await makeTransport().query("SELECT 1");

    expect(queryCalls()[0].url).toBe("http://cb.example.com:30093/query/service");
  });

  test("falls back to the node's own hostname when the alternate address has no query port", async () => {
    handler = routeQuery(successPayload(), 200, {
      nodesExt: [
        {
          hostname: "node1.local",
          services: { n1ql: 8093 },
          alternateAddresses: { external: { hostname: "cb.example.com", ports: { mgmt: 30001 } } },
        },
      ],
    });

    await makeTransport().query("SELECT 1");

    expect(queryCalls()[0].url).toBe("http://node1.local:8093/query/service");
  });

  test("falls back to the request host when a node advertises no hostname", async () => {
    handler = routeQuery(successPayload(), 200, { nodesExt: [{ services: { n1ql: 8093 } }] });

    await makeTransport().query("SELECT 1");

    expect(queryCalls()[0].url).toBe("http://127.0.0.1:8093/query/service");
  });

  test("falls back to the default query port when no node runs the query service", async () => {
    handler = routeQuery(successPayload(), 200, { nodesExt: [{ hostname: "node1.local", services: { mgmt: 8091 } }] });

    await makeTransport().query("SELECT 1");

    expect(queryCalls()[0].url).toBe("http://127.0.0.1:8093/query/service");
  });

  test("falls back to the default query port when the cluster reports no nodes at all", async () => {
    handler = routeQuery(successPayload(), 200, {});

    await makeTransport().query("SELECT 1");

    expect(queryCalls()[0].url).toBe("http://127.0.0.1:8093/query/service");
  });

  test("brackets an IPv6 host", async () => {
    handler = routeQuery(successPayload(), 200, { nodesExt: [{ hostname: "fd00::1", services: { n1ql: 8093 } }] });

    await makeTransport({ host: "::1" }).query("SELECT 1");

    expect(calls[0].url).toBe("http://[::1]:8091/pools/default/nodeServices");
    expect(queryCalls()[0].url).toBe("http://[fd00::1]:8093/query/service");
  });

  test("discovers once for concurrent queries", async () => {
    const transport = makeTransport();
    await Promise.all([transport.query("SELECT 1"), transport.query("SELECT 2"), transport.query("SELECT 3")]);

    expect(calls.filter((call) => call.url.includes("/pools/default/nodeServices"))).toHaveLength(1);
    expect(queryCalls()).toHaveLength(3);
  });

  test("does not cache a failed discovery", async () => {
    handler = () => jsonResponse({}, 503);

    await expect(makeTransport().query("SELECT 1")).rejects.toBeInstanceOf(CouchbaseError);

    const transport = makeTransport();
    await expect(transport.query("SELECT 1")).rejects.toBeInstanceOf(CouchbaseError);

    handler = routeQuery(successPayload());
    const result = await transport.query("SELECT 1");

    expect(result.rows).toHaveLength(1);
  });

  test("re-discovers the endpoint after close()", async () => {
    const transport = makeTransport();
    await transport.query("SELECT 1");
    await transport.close();
    await transport.query("SELECT 2");

    expect(calls.filter((call) => call.url.includes("/pools/default/nodeServices"))).toHaveLength(2);
  });
});

// ============================================================================
// Capella SRV resolution (decision 3)
// ============================================================================

describe("CouchbaseHttpTransport SRV resolution", () => {
  test("resolves the SRV record when the connection carries no explicit port", async () => {
    const seen: string[] = [];
    const deps: CouchbaseHttpTransportDeps = {
      resolveSrv: async (name: string) => {
        seen.push(name);
        return [{ name: "node-1.cb.example.com", port: 11207, priority: 0, weight: 0 }];
      },
    };

    await makeTransport({ host: "cb.example.com", port: undefined }, deps).query("SELECT 1");

    expect(seen).toEqual(["_couchbases._tcp.cb.example.com"]);
    expect(calls[0].url).toBe("http://node-1.cb.example.com:8091/pools/default/nodeServices");
  });

  test("treats the host as a direct A record when the SRV lookup returns nothing", async () => {
    const deps: CouchbaseHttpTransportDeps = { resolveSrv: async () => [] };

    await makeTransport({ host: "cb.example.com", port: undefined }, deps).query("SELECT 1");

    expect(calls[0].url).toBe("http://cb.example.com:8091/pools/default/nodeServices");
  });

  test("never lets a DNS failure be fatal", async () => {
    const deps: CouchbaseHttpTransportDeps = {
      resolveSrv: async () => {
        throw new Error("ENOTFOUND");
      },
    };

    const result = await makeTransport({ host: "cb.example.com", port: undefined }, deps).query("SELECT 1");

    expect(result.rows).toHaveLength(1);
    expect(calls[0].url).toBe("http://cb.example.com:8091/pools/default/nodeServices");
  });

  test("skips the SRV lookup when the connection carries an explicit port", async () => {
    let called = false;
    const deps: CouchbaseHttpTransportDeps = {
      resolveSrv: async () => {
        called = true;
        return [];
      },
    };

    await makeTransport({ port: 9000 }, deps).query("SELECT 1");

    expect(called).toBe(false);
    expect(calls[0].url).toBe("http://127.0.0.1:9000/pools/default/nodeServices");
  });

  test("resolves the SRV record again after close()", async () => {
    let lookups = 0;
    const deps: CouchbaseHttpTransportDeps = {
      resolveSrv: async () => {
        lookups += 1;
        return [];
      },
    };

    const transport = makeTransport({ host: "cb.example.com", port: undefined }, deps);
    await transport.query("SELECT 1");
    await transport.close();
    await transport.query("SELECT 2");

    expect(lookups).toBe(2);
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe("CouchbaseHttpTransport error mapping", () => {
  const httpCases: Array<[number, boolean, string]> = [
    [401, false, "credentials"],
    [403, false, "permission"],
    [503, true, "unavailable"],
  ];

  for (const [httpCode, retriable, fragment] of httpCases) {
    test(`maps HTTP ${httpCode}`, async () => {
      handler = routeQuery({}, httpCode);

      const error = (await makeTransport()
        .query("SELECT 1")
        .catch((e: unknown) => e)) as CouchbaseError;

      expect(error).toBeInstanceOf(CouchbaseError);
      expect(error.code).toBe(httpCode);
      expect(error.retriable).toBe(retriable);
      expect(error.message.toLowerCase()).toContain(fragment);
    });
  }

  test("treats any other server error as retriable", async () => {
    handler = routeQuery({}, 500);

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error.code).toBe(500);
    expect(error.retriable).toBe(true);
  });

  test("treats a non-JSON client error as a non-retriable failure", async () => {
    handler = (url: string) => {
      if (url.includes("/pools/default/nodeServices")) return jsonResponse(NODE_SERVICES);
      return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
    };

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error.code).toBe(404);
    expect(error.retriable).toBe(false);
  });

  test("wraps a transport-level network failure as retriable", async () => {
    handler = () => {
      throw new TypeError("fetch failed");
    };

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error).toBeInstanceOf(CouchbaseError);
    expect(error.code).toBe(0);
    expect(error.retriable).toBe(true);
    expect(error.message).toContain("fetch failed");
  });

  test("wraps a non-Error network rejection", async () => {
    handler = () => Promise.reject("socket closed");

    const error = (await makeTransport()
      .query("SELECT 1")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error.message).toContain("socket closed");
  });
});

// ============================================================================
// Management REST
// ============================================================================

describe("CouchbaseHttpTransport.manage", () => {
  test("returns the parsed management payload", async () => {
    handler = (url: string) => {
      if (url.includes("/pools/default/buckets/travel")) return jsonResponse({ basicStats: { diskUsed: 1024 } });
      return jsonResponse(NODE_SERVICES);
    };

    const stats = await makeTransport().manage<{ basicStats: { diskUsed: number } }>("/pools/default/buckets/travel");

    expect(stats.basicStats.diskUsed).toBe(1024);
    expect(calls[0].url).toBe("http://127.0.0.1:8091/pools/default/buckets/travel");
    expect(calls[0].init?.method).toBe("GET");
    expect(headerOf(calls[0], "authorization")).toBe(
      `Basic ${Buffer.from("Administrator:password123").toString("base64")}`,
    );
  });

  test("maps a management failure the same way as a query failure", async () => {
    handler = () => jsonResponse({}, 403);

    const error = (await makeTransport()
      .manage("/pools/default")
      .catch((e: unknown) => e)) as CouchbaseError;

    expect(error).toBeInstanceOf(CouchbaseError);
    expect(error.code).toBe(403);
  });

  test("uses an empty credential pair when the connection carries none", async () => {
    handler = () => jsonResponse({});

    await makeTransport({ user: undefined, password: undefined }).manage("/pools/default");

    expect(headerOf(calls[0], "authorization")).toBe(`Basic ${Buffer.from(":").toString("base64")}`);
  });

  test("defaults the host when the connection carries none", async () => {
    handler = () => jsonResponse({});

    await makeTransport({ host: undefined }).manage("/pools/default");

    expect(calls[0].url).toBe("http://localhost:8091/pools/default");
  });
});

// ============================================================================
// TLS (SSLConfig on DatabaseConnection)
// ============================================================================

describe("CouchbaseHttpTransport TLS", () => {
  interface RecordedRequest {
    url: string;
    init: JsonRequestInit;
    tls: CouchbaseTlsMaterial;
  }

  function tlsDeps(recorded: RecordedRequest[]): CouchbaseHttpTransportDeps {
    return {
      // Injected so a portless connection never triggers a real DNS lookup.
      resolveSrv: async () => [],
      requestJson: async (url, init, tls) => {
        recorded.push({ url, init, tls });
        if (url.includes("/pools/default/nodeServices")) return { httpCode: 200, payload: NODE_SERVICES };
        return { httpCode: 200, payload: successPayload() };
      },
    };
  }

  test("routes a TLS connection through the node request path with the secure ports", async () => {
    const recorded: RecordedRequest[] = [];
    const ssl: SSLConfig = {
      mode: "verify-full",
      caCert: "ca-pem",
      clientCert: "cert-pem",
      clientKey: "key-pem",
    };

    const result = await makeTransport({ ssl, port: undefined }, tlsDeps(recorded)).query("SELECT 1");

    expect(result.rows).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(recorded[0].url).toBe("https://127.0.0.1:18091/pools/default/nodeServices");
    expect(recorded[1].url).toBe("https://node1.local:18093/query/service");
    expect(recorded[1].init.method).toBe("POST");
    expect(recorded[0].tls).toEqual({
      ca: "ca-pem",
      cert: "cert-pem",
      key: "key-pem",
      rejectUnauthorized: true,
    });
  });

  test("accepts a self-signed cluster in require mode", async () => {
    const recorded: RecordedRequest[] = [];

    await makeTransport({ ssl: { mode: "require" } }, tlsDeps(recorded)).query("SELECT 1");

    expect(recorded[0].tls).toEqual({ rejectUnauthorized: false });
  });

  test("honours an explicit rejectUnauthorized override", async () => {
    const recorded: RecordedRequest[] = [];

    await makeTransport({ ssl: { mode: "require", rejectUnauthorized: true } }, tlsDeps(recorded)).query("SELECT 1");

    expect(recorded[0].tls.rejectUnauthorized).toBe(true);

    const relaxed: RecordedRequest[] = [];
    await makeTransport({ ssl: { mode: "verify-ca", rejectUnauthorized: false } }, tlsDeps(relaxed)).query("SELECT 1");

    expect(relaxed[0].tls.rejectUnauthorized).toBe(false);
  });

  test("keeps a disabled SSL config on the plain fetch path", async () => {
    await makeTransport({ ssl: { mode: "disable" } }).query("SELECT 1");

    expect(calls[0].url).toBe("http://127.0.0.1:8091/pools/default/nodeServices");
  });
});

// ============================================================================
// node:http / node:https request helper
// ============================================================================

describe("nodeRequestJson", () => {
  test("performs a GET and parses the JSON body", async () => {
    const seen: Array<{ method?: string; url?: string; accept?: string }> = [];
    const server = await startServer((req, res) => {
      seen.push({ method: req.method, url: req.url, accept: req.headers.accept });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const response = await nodeRequestJson(`${server.url}/pools/default?x=1`, GET_INIT, NO_TLS);

      expect(response.httpCode).toBe(200);
      expect(response.payload).toEqual({ ok: true });
      expect(seen[0]).toEqual({ method: "GET", url: "/pools/default?x=1", accept: "application/json" });
    } finally {
      await server.close();
    }
  });

  test("writes the request body on POST", async () => {
    let received = "";
    const server = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = Buffer.concat(chunks).toString("utf8");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ created: true }));
      });
    });

    try {
      const response = await nodeRequestJson(
        `${server.url}/query/service`,
        { method: "POST", headers: { "content-type": "application/json" }, body: '{"statement":"SELECT 1"}' },
        NO_TLS,
      );

      expect(response.httpCode).toBe(201);
      expect(response.payload).toEqual({ created: true });
      expect(received).toBe('{"statement":"SELECT 1"}');
    } finally {
      await server.close();
    }
  });

  test("returns a null payload when the body is not JSON", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });

    try {
      const response = await nodeRequestJson(server.url, GET_INIT, NO_TLS);

      expect(response.httpCode).toBe(500);
      expect(response.payload).toBeNull();
    } finally {
      await server.close();
    }
  });

  test("rejects with a retriable error when the connection fails", async () => {
    const server = await startServer((_req, res) => res.end("{}"));
    const deadUrl = server.url;
    await server.close();

    const error = (await nodeRequestJson(deadUrl, GET_INIT, NO_TLS).catch((e: unknown) => e)) as CouchbaseError;

    expect(error).toBeInstanceOf(CouchbaseError);
    expect(error.code).toBe(0);
    expect(error.retriable).toBe(true);
  });
});
