/**
 * The Cassandra driver adapter's own vocabulary (issue #424, Phase 4)
 *
 * Everything asserted below was captured on 2026-08-20 from a live Apache
 * Cassandra 5.0.9 (`system.local.release_version`) through `cassandra-driver`
 * 4.9.0, and the values are built here with the DRIVER'S OWN classes rather than
 * with stand-ins: the whole point of this file is that `Long`, `BigDecimal`,
 * `Duration` and `Vector` reach the grid as something a reader can use, and a
 * hand-made look-alike could not prove that.
 *
 * The three traps this pins, each measured:
 *
 * 1. A `blob` arrives as a Buffer, and `JSON.stringify` turns it into
 *    `{"type":"Buffer","data":[76,105,…]}` - a shape nobody can read and nobody can
 *    paste back into CQL.
 * 2. `duration` AND `vector<float,3>` both arrive with `type.code === 0` (custom)
 *    and a Java class name in `type.info`, so a type map keyed on the code alone
 *    labels two different types the same word ("custom", which is what the driver's
 *    own `getDataTypeNameByCode` answers for both).
 * 3. Every actionable connect-time failure arrives as `NoHostAvailableError` with
 *    `code === undefined` and the real fault inside `innerErrors`, keyed by host.
 *    A classifier keyed on `err.code` puts authentication, a refused socket and a
 *    wrong data centre all in one bucket.
 */
import { describe, expect, test } from "bun:test";
import { types } from "cassandra-driver";
import type { CassandraFaultCategory } from "@/lib/db/providers/sql/cassandra/transport";
import {
  cassandraClientOptions,
  CassandraDriverTransport,
  classifyCassandraError,
  describeColumnType,
  normalizeCassandraValue,
  toCassandraResult,
} from "@/lib/db/providers/sql/cassandra/driver-transport";
import { CassandraTransportError } from "@/lib/db/providers/sql/cassandra/transport";
import type { DatabaseConnection } from "@/lib/types";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "cassandra-1",
    name: "Probe ring",
    type: "cassandra",
    host: "cassandra.test",
    port: 9042,
    database: "probe",
    localDataCenter: "datacenter1",
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("normalizeCassandraValue", () => {
  test("a blob becomes the CQL hex literal, not a Buffer document", () => {
    // The exact bytes of `probe.type_matrix.c_blob`, whose JSON.stringify was
    // captured as {"type":"Buffer","data":[76,105,98,114,101,68,66,0,195,191,…]}.
    const blob = Buffer.from("4c69627265444200c3bf6279746573", "hex");

    expect(normalizeCassandraValue(blob)).toBe("0x4c69627265444200c3bf6279746573");
  });

  test("an empty blob is still a hex literal rather than an empty string", () => {
    expect(normalizeCassandraValue(Buffer.alloc(0))).toBe("0x");
  });

  test.each([
    ["bigint", types.Long.fromString("9223372036854775807"), "9223372036854775807"],
    ["decimal", types.BigDecimal.fromString("12345.6789012345678901"), "12345.6789012345678901"],
    ["varint", types.Integer.fromString("123456789012345678901234567890"), "123456789012345678901234567890"],
  ])("a %s keeps every digit as a string", (_label, value, expected) => {
    // Measured: Number(bigint max) is 9223372036854776000 and
    // BigDecimal.toNumber() is 12345.678901234567 - both silently wrong.
    expect(normalizeCassandraValue(value)).toBe(expected);
  });

  test("a duration becomes its own CQL literal", () => {
    const duration = new types.Duration(1, 2, types.Long.fromString("10800000000000"));

    expect(normalizeCassandraValue(duration)).toBe("1mo2d3h");
  });

  test("a vector becomes an array of numbers", () => {
    // JSON.stringify of the driver's Vector is {"0":1.5,"1":2.5,"2":3.5} - an
    // object with numeric keys, which no chart and no CSV export can read.
    const vector = new types.Vector(Float32Array.of(1.5, 2.5, 3.5), "float");

    expect(normalizeCassandraValue(vector)).toEqual([1.5, 2.5, 3.5]);
  });

  test.each([
    ["date", types.LocalDate.fromString("2026-08-20"), "2026-08-20"],
    // A `time` keeps nanoseconds, which a JS Date cannot hold at all.
    ["time", types.LocalTime.fromString("18:30:45.123456789"), "18:30:45.123456789"],
    ["inet", types.InetAddress.fromString("2001:db8::1"), "2001:db8::1"],
    ["uuid", types.Uuid.fromString("6f9619ff-8b86-d011-b42d-00c04fc964ff"), "6f9619ff-8b86-d011-b42d-00c04fc964ff"],
  ])("a %s is rendered the way the engine spells it", (_label, value, expected) => {
    expect(normalizeCassandraValue(value)).toBe(expected);
  });

  test("a timeuuid is rendered like any other uuid", () => {
    const timeuuid = types.TimeUuid.fromString("817082f0-9cc9-11f1-80a2-e645751c1d65");

    expect(normalizeCassandraValue(timeuuid)).toBe("817082f0-9cc9-11f1-80a2-e645751c1d65");
  });

  test("a timestamp stays a Date, because the grid formats those itself", () => {
    const timestamp = new Date("2026-08-20T18:30:45.123Z");

    expect(normalizeCassandraValue(timestamp)).toBe(timestamp);
  });

  test("a tuple becomes its elements", () => {
    expect(normalizeCassandraValue(types.Tuple.fromArray([7, "seven", false]))).toEqual([7, "seven", false]);
  });

  test("a collection is walked, so a Long inside one is not lost either", () => {
    // `set` arrives as an Array and `map` as a plain object (measured), and a
    // map<text, bigint> therefore hides Longs one level down.
    expect(normalizeCassandraValue([types.Long.fromString("1"), types.Long.fromString("2")])).toEqual(["1", "2"]);
    expect(normalizeCassandraValue({ k1: types.Long.fromString("7") })).toEqual({ k1: "7" });
  });

  test("a UDT is walked as the plain object it arrives as", () => {
    expect(normalizeCassandraValue({ street: "Main St", zip: 34000 })).toEqual({ street: "Main St", zip: 34000 });
  });

  test.each([
    ["a string", "Türkçe ünlü ıİşğ"],
    ["a number", 2147483647],
    ["a boolean", true],
    ["null", null],
  ])("%s is passed through untouched", (_label, value) => {
    expect(normalizeCassandraValue(value)).toBe(value);
  });

  test("an absent value reads as null rather than undefined", () => {
    // A column the row does not carry - which is what a `SELECT` of a column
    // added after the row was written answers.
    expect(normalizeCassandraValue(undefined)).toBeNull();
  });
});

describe("describeColumnType", () => {
  test.each([
    ["int", { code: 9, info: null }, "int"],
    ["a text column, which the wire declares as varchar", { code: 13, info: null }, "varchar"],
    ["list<int>", { code: 32, info: { code: 9, type: null } }, "list<int>"],
    [
      "map<text, int>",
      {
        code: 33,
        info: [
          { code: 13, type: null },
          { code: 9, type: null },
        ],
      },
      "map<varchar, int>",
    ],
    ["set<text>", { code: 34, info: { code: 13, type: null } }, "set<varchar>"],
  ])("names %s from the wire declaration", (_label, type, expected) => {
    expect(describeColumnType(type)).toBe(expected);
  });

  test("a duration is named from its Java class, not from its type code", () => {
    // Measured: the code is 0 (custom) and the driver's own
    // getDataTypeNameByCode answers the literal string "custom".
    expect(describeColumnType({ code: 0, info: "org.apache.cassandra.db.marshal.DurationType" })).toBe("duration");
  });

  test("a vector carries its element type and its dimension", () => {
    const info = "org.apache.cassandra.db.marshal.VectorType(org.apache.cassandra.db.marshal.FloatType , 3)";

    expect(describeColumnType({ code: 0, info })).toBe("vector<float, 3>");
  });

  test("an unmeasured custom type is reported as the server spelled it", () => {
    // Never guessed into a CQL word: the class name is what the server said, and
    // a reader can look it up. Inventing a name would be the wrong kind of tidy.
    expect(describeColumnType({ code: 0, info: "com.example.OrbitType" })).toBe("com.example.OrbitType");
  });

  test("a custom type with no class name at all is reported as custom", () => {
    expect(describeColumnType({ code: 0, info: null })).toBe("custom");
  });
});

describe("toCassandraResult", () => {
  test("declared columns drive the row shape and the type map", () => {
    const result = toCassandraResult({
      columns: [
        { name: "id", type: { code: 9, info: null } },
        { name: "amount", type: { code: 6, info: null } },
      ],
      rows: [{ id: 1584, amount: types.BigDecimal.fromString("2170.08") }],
      pageState: null,
    });

    expect(result.rows).toEqual([{ id: 1584, amount: "2170.08" }]);
    expect(result.fieldNames).toEqual(["id", "amount"]);
    expect(result.columnTypes).toEqual({ id: "int", amount: "decimal" });
    expect(result.pageState).toBeNull();
  });

  test("a void result declares no columns at all", () => {
    // Measured: an INSERT, an ALTER and a `USE` all answer a ResultSet whose
    // `columns` is null - not an empty array - and whose rows are empty.
    const result = toCassandraResult({ columns: null, rows: [], pageState: null });

    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toBeNull();
    expect(result.columnTypes).toBeNull();
  });

  test("a page state is carried as the string the server gave", () => {
    const result = toCassandraResult({
      columns: [{ name: "id", type: { code: 9, info: null } }],
      rows: [{ id: 1 }],
      pageState: "04000000fd00f07fffff9b00",
    });

    expect(result.pageState).toBe("04000000fd00f07fffff9b00");
  });

  test("rows the server sent without declaring them are not invented", () => {
    // `rows` is undefined on a void ResultSet in some driver paths; the neutral
    // result says "no rows" rather than throwing on the way past.
    expect(toCassandraResult({ columns: null, rows: undefined, pageState: undefined }).rows).toEqual([]);
  });
});

describe("classifyCassandraError", () => {
  /** A ResponseError as the driver builds one: a name, a numeric code, a message. */
  function responseError(code: number, message: string): Error & { code: number } {
    const error = new Error(message) as Error & { code: number };
    error.name = "ResponseError";
    error.code = code;
    return error;
  }

  /** The envelope the driver wraps every per-host failure in. */
  function noHostAvailable(inner: Record<string, unknown>, message = "All host(s) tried for query failed."): Error {
    const error = new Error(message);
    error.name = "NoHostAvailableError";
    Object.assign(error, { innerErrors: inner });
    return error;
  }

  test.each<[number, CassandraFaultCategory, string]>([
    [8192, "syntax", "line 1:0 no viable alternative at input 'SELEC' ([SELEC]...)"],
    [8704, "invalid", "table nosuchtable does not exist"],
    [8448, "permission", "User lowpriv has no SELECT permission on <table probe.orders> or any of its parents"],
    [
      4608,
      "server-timeout",
      "Server timeout during read query at consistency LOCAL_ONE (0 replica(s) responded over 1 required)",
    ],
    [
      4352,
      "server-timeout",
      "Server timeout during batchlog write at consistency ONE (0 peer(s) acknowledged the write over 1 required)",
    ],
    [4096, "unavailable", "Not enough replicas available for query at consistency TWO (2 required but only 1 alive)"],
    [256, "auth", "Bad credentials"],
    [0, "engine", "java.lang.IllegalArgumentException: Unsupported target type: time"],
  ])("a ResponseError with code %i is a %s failure", (code, category, message) => {
    const failure = classifyCassandraError(responseError(code, message));

    expect(failure).toBeInstanceOf(CassandraTransportError);
    expect(failure.category).toBe(category);
    expect(failure.code).toBe(code);
    expect(failure.message).toBe(message);
  });

  test("an authentication failure is read out of innerErrors, where the driver puts it", () => {
    const failure = classifyCassandraError(
      noHostAvailable({
        "127.0.0.1:19043": {
          name: "AuthenticationError",
          message: "Provided username cassandra and/or password are incorrect",
        },
      }),
    );

    expect(failure.category).toBe("auth");
    expect(failure.message).toBe("Provided username cassandra and/or password are incorrect");
  });

  test("a server that requires credentials the connection has none for is also an auth failure", () => {
    const failure = classifyCassandraError(
      noHostAvailable({
        "127.0.0.1:19043": {
          name: "AuthenticationError",
          message: "Host 127.0.0.1:19043 requires authentication, but no authenticator found in the options",
        },
      }),
    );

    expect(failure.category).toBe("auth");
  });

  test("a refused socket is unreachable, and says which address refused", () => {
    const failure = classifyCassandraError(
      noHostAvailable({
        "127.0.0.1:19999": { name: "Error", code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:19999" },
      }),
    );

    expect(failure.category).toBe("unreachable");
    expect(failure.message).toBe("connect ECONNREFUSED 127.0.0.1:19999");
    // A string errno is not a protocol code, so nothing numeric is claimed.
    expect(failure.code).toBeNull();
  });

  test("a host that never answers is unreachable", () => {
    const failure = classifyCassandraError(
      noHostAvailable({ "192.0.2.1:9042": { name: "DriverError", message: "Connection timeout" } }),
    );

    expect(failure.category).toBe("unreachable");
  });

  test("a name that resolves to nothing is unreachable, with no inner error to read", () => {
    const failure = classifyCassandraError(noHostAvailable({}, "No host could be resolved"));

    expect(failure.category).toBe("unreachable");
    expect(failure.message).toBe("No host could be resolved");
  });

  test("a wrong data centre is a configuration fault, not a connectivity one", () => {
    const failure = classifyCassandraError(
      noHostAvailable({
        "127.0.0.1:19042": {
          name: "ArgumentError",
          message:
            "localDataCenter was configured as 'dc-does-not-exist', but only found hosts in data centers: [datacenter1]",
        },
      }),
    );

    expect(failure.category).toBe("config");
    // The server's own list of the data centres it HAS is the useful half.
    expect(failure.message).toContain("[datacenter1]");
  });

  test("an unavailable replica set stays unavailable through the envelope", () => {
    const failure = classifyCassandraError(
      noHostAvailable({
        "127.0.0.1:19042": {
          name: "ResponseError",
          code: 4096,
          message: "Not enough replicas available for query at consistency TWO (2 required but only 1 alive)",
        },
      }),
    );

    expect(failure.category).toBe("unavailable");
    expect(failure.code).toBe(4096);
  });

  test("a missing localDataCenter is a configuration fault before any host is tried", () => {
    const error = new Error(
      "'localDataCenter' is not defined in Client options and also was not specified in constructor. At least one is required. Available DCs are: [datacenter1]",
    );
    error.name = "ArgumentError";

    expect(classifyCassandraError(error).category).toBe("config");
  });

  test("the client's own deadline is a client timeout, distinct from the server's", () => {
    const error = new Error("The host 127.0.0.1:19042 did not reply before timeout 1 ms");
    error.name = "OperationTimedOutError";

    const failure = classifyCassandraError(error);

    expect(failure.category).toBe("client-timeout");
    expect(failure.code).toBeNull();
  });

  test("anything else keeps its message and is left as an engine failure", () => {
    const failure = classifyCassandraError(new Error("socket hang up"));

    expect(failure.category).toBe("engine");
    expect(failure.message).toBe("socket hang up");
  });

  test("a thrown non-error is described rather than dropped", () => {
    expect(classifyCassandraError("boom").message).toBe("boom");
  });

  test("a transport error is not re-wrapped", () => {
    const original = new CassandraTransportError("already classified", "syntax", 8192);

    expect(classifyCassandraError(original)).toBe(original);
  });
});

describe("CassandraTransportError", () => {
  test("only a refused grant means a monitoring surface is unavailable here", () => {
    // Measured with a least-privilege role: `system_views.clients` answers 8448
    // while `system_schema` answers normally, so a denial is the ordinary case for
    // a restricted user and must not break the connection. Every other category
    // keeps propagating - an empty panel that hides a real fault hides it forever.
    expect(new CassandraTransportError("denied", "permission", 8448).isMonitoringUnavailable()).toBe(true);
    expect(new CassandraTransportError("nope", "invalid", 8704).isMonitoringUnavailable()).toBe(false);
  });

  test("it survives an instanceof check across the seam", () => {
    const error: unknown = new CassandraTransportError("x", "engine", null);

    expect(error instanceof CassandraTransportError).toBe(true);
    expect((error as Error).name).toBe("CassandraTransportError");
  });
});

describe("cassandraClientOptions", () => {
  test("one contact point, the keyspace, and the data centre the driver demands", () => {
    // The driver discovers the rest of the ring itself, which is why one address is
    // enough - and why a wrong PORT fails with ECONNREFUSED from that address alone.
    const options = cassandraClientOptions(makeConnection(), 60_000);

    expect(options.contactPoints).toEqual(["cassandra.test:9042"]);
    expect(options.localDataCenter).toBe("datacenter1");
    expect(options.keyspace).toBe("probe");
    // The only per-statement deadline available: `USING TIMEOUT` is not in 5.0's
    // grammar (measured, syntax error), so the client's own is it.
    expect(options.socketOptions).toEqual({ readTimeout: 60_000 });
  });

  test("the native protocol's port is the default", () => {
    expect(cassandraClientOptions(makeConnection({ port: undefined }), 1000).contactPoints).toEqual([
      "cassandra.test:9042",
    ]);
  });

  test("a connection with no keyspace pins none, rather than pinning an empty one", () => {
    // Measured: a client whose keyspace is a name that does not exist fails the
    // CONNECT, so an empty string would be worse than the absence it stands for.
    expect(cassandraClientOptions(makeConnection({ database: undefined }), 1000).keyspace).toBeUndefined();
  });

  test("credentials are sent only when a user is named", () => {
    // A stock install runs AllowAllAuthenticator and ignores them entirely (measured:
    // supplying credentials to an open server connects fine), but sending an empty
    // username to a server that DOES authenticate would fail differently and more
    // confusingly than sending none.
    expect(cassandraClientOptions(makeConnection(), 1000).credentials).toBeUndefined();
    expect(
      cassandraClientOptions(makeConnection({ user: "cassandra", password: "cassandra" }), 1000).credentials,
    ).toEqual({ username: "cassandra", password: "cassandra" });
  });

  test("a user with no password still authenticates as that user", () => {
    expect(cassandraClientOptions(makeConnection({ user: "cassandra" }), 1000).credentials).toEqual({
      username: "cassandra",
      password: "",
    });
  });

  test.each([
    ["disable", undefined],
    ["require", { rejectUnauthorized: false }],
    ["verify-ca", { rejectUnauthorized: true }],
    ["verify-full", { rejectUnauthorized: true }],
  ] as const)("TLS mode %s produces %o", (mode, expected) => {
    // NOT exercised against a TLS cluster - the probe instances speak plaintext - so
    // this pins the mapping of the form's own field onto the driver's option, and
    // claims nothing about a verified handshake. `require` means encrypt without
    // checking the chain; the two `verify-*` modes mean check it.
    const options = cassandraClientOptions(makeConnection({ ssl: { mode } }), 1000);

    expect(options.sslOptions).toEqual(expected);
  });

  test("a CA certificate is passed through as the driver's own option shape", () => {
    const options = cassandraClientOptions(
      makeConnection({ ssl: { mode: "verify-full", caCert: "-----BEGIN CERTIFICATE-----" } }),
      1000,
    );

    expect(options.sslOptions).toEqual({ rejectUnauthorized: true, ca: ["-----BEGIN CERTIFICATE-----"] });
  });

  test("a client certificate and its key reach the driver as Node's own cert and key", () => {
    // Mutual TLS: the shared SSL form collects both, and the driver hands its
    // `sslOptions` straight to `tls.connect`, so they map onto the same names the
    // PostgreSQL, MySQL and Couchbase adapters use. NOT exercised against a TLS
    // cluster - the probe node speaks plaintext - so this pins the mapping only.
    //
    // The key fixture is deliberately NOT a PEM header. `-----BEGIN PRIVATE KEY-----`
    // on its own, with no material after it, is enough for gitleaks' `private-key`
    // rule, so writing the realistic string here fails the Secret Scan gate for a
    // secret that does not exist. What these assertions are about is which option
    // name carries the value, not what the value looks like.
    const options = cassandraClientOptions(
      makeConnection({
        ssl: {
          mode: "verify-full",
          caCert: "-----BEGIN CERTIFICATE-----",
          clientCert: "-----BEGIN CERTIFICATE----- client",
          clientKey: "client-key-pem",
        },
      }),
      1000,
    );

    expect(options.sslOptions).toEqual({
      rejectUnauthorized: true,
      ca: ["-----BEGIN CERTIFICATE-----"],
      cert: "-----BEGIN CERTIFICATE----- client",
      key: "client-key-pem",
    });
  });

  test("client material travels under `require` too, where the chain is not checked", () => {
    // A cluster can demand a client certificate while presenting a self-signed one
    // of its own, so the material must not be tied to the verifying modes.
    const options = cassandraClientOptions(
      makeConnection({ ssl: { mode: "require", clientCert: "cert-pem", clientKey: "key-pem" } }),
      1000,
    );

    expect(options.sslOptions).toEqual({ rejectUnauthorized: false, cert: "cert-pem", key: "key-pem" });
  });

  test("half a keypair passes only the half that was supplied", () => {
    // Each field is carried on its own, exactly as the other adapters do: a
    // certificate with no key is a user mistake for the server to reject, not
    // something to silently drop here.
    expect(
      cassandraClientOptions(makeConnection({ ssl: { mode: "require", clientCert: "cert-pem" } }), 1000).sslOptions,
    ).toEqual({
      rejectUnauthorized: false,
      cert: "cert-pem",
    });
    expect(
      cassandraClientOptions(makeConnection({ ssl: { mode: "require", clientKey: "key-pem" } }), 1000).sslOptions,
    ).toEqual({
      rejectUnauthorized: false,
      key: "key-pem",
    });
  });
});

describe("CassandraDriverTransport", () => {
  /** The three methods this adapter drives, and nothing else. */
  function stubSession(overrides: Record<string, unknown> = {}) {
    return {
      connect: async () => {},
      execute: async () => ({ columns: [{ name: "id", type: { code: 9, info: null } }], rows: [{ id: 1 }] }),
      shutdown: async () => {},
      ...overrides,
    };
  }

  test("it declares itself native, so the seam can widen later", () => {
    expect(new CassandraDriverTransport(makeConnection(), 1000, stubSession()).kind).toBe("native");
  });

  test("a statement goes out unprepared and comes back as the neutral result", async () => {
    const asked: unknown[] = [];
    const transport = new CassandraDriverTransport(
      makeConnection(),
      1000,
      stubSession({
        execute: async (cql: string, params: unknown, options: unknown) => {
          asked.push({ cql, params, options });
          return { columns: [{ name: "id", type: { code: 9, info: null } }], rows: [{ id: 1 }], pageState: null };
        },
      }),
    );
    await transport.connect();

    const result = await transport.execute("SELECT id FROM probe.customers WHERE id = 1");

    expect(result.rows).toEqual([{ id: 1 }]);
    // `prepare: false`: preparing a one-shot statement costs a round trip and an entry
    // in the server's prepared-statement cache (system_views.cql_metrics counts them).
    expect(asked).toEqual([
      { cql: "SELECT id FROM probe.customers WHERE id = 1", params: undefined, options: { prepare: false } },
    ]);
  });

  test("per-statement options reach the driver beside the statement", async () => {
    let seen: unknown = null;
    const transport = new CassandraDriverTransport(
      makeConnection(),
      1000,
      stubSession({
        execute: async (_cql: string, _params: unknown, options: unknown) => {
          seen = options;
          return { columns: null, rows: [] };
        },
      }),
    );
    await transport.connect();

    await transport.execute("SELECT * FROM probe.orders", { fetchSize: 100, pageState: "04000000fd" });

    expect(seen).toEqual({ prepare: false, fetchSize: 100, pageState: "04000000fd" });
  });

  test("a connect failure is classified before it leaves the adapter", async () => {
    const failure = new Error("All host(s) tried for query failed.");
    failure.name = "NoHostAvailableError";
    Object.assign(failure, {
      innerErrors: { "127.0.0.1:9042": { name: "Error", code: "ECONNREFUSED", message: "connect ECONNREFUSED" } },
    });
    const transport = new CassandraDriverTransport(
      makeConnection(),
      1000,
      stubSession({
        connect: async () => {
          throw failure;
        },
      }),
    );

    await expect(transport.connect()).rejects.toThrow(CassandraTransportError);
  });

  test("a statement failure is classified too", async () => {
    const failure = new Error("table nosuchtable does not exist") as Error & { code: number };
    failure.name = "ResponseError";
    failure.code = 8704;
    const transport = new CassandraDriverTransport(
      makeConnection(),
      1000,
      stubSession({
        execute: async () => {
          throw failure;
        },
      }),
    );
    await transport.connect();

    await expect(transport.execute("SELECT * FROM probe.nosuchtable")).rejects.toThrow(
      "table nosuchtable does not exist",
    );
  });

  test("closing shuts the session down once, and a second close is a no-op", async () => {
    let shutdowns = 0;
    const transport = new CassandraDriverTransport(
      makeConnection(),
      1000,
      stubSession({
        shutdown: async () => {
          shutdowns += 1;
        },
      }),
    );
    await transport.connect();

    await transport.close();
    await transport.close();

    expect(shutdowns).toBe(1);
  });

  test("a statement after close is refused rather than reopening a session", async () => {
    const transport = new CassandraDriverTransport(makeConnection(), 1000, stubSession());
    await transport.connect();
    await transport.close();

    await expect(transport.execute("SELECT 1")).rejects.toThrow(/closed/);
  });

  test("with no session injected it builds the real driver client, and the driver refuses a dead port", async () => {
    // The one line in this file that only the real driver can execute. Port 1 on
    // loopback refuses immediately, so this exercises construction + connect +
    // classification without a server and without a delay.
    const transport = new CassandraDriverTransport(makeConnection({ host: "127.0.0.1", port: 1 }), 1000);

    await expect(transport.connect()).rejects.toThrow(CassandraTransportError);
  });
});
