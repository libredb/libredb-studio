/**
 * The InfluxDB connection (InfluxDB spec 6.2) for both type-ids: the endpoint, the one Authorization header of I6
 * (E14), the plaintext rule with its consent (I7, E15), the TLS mapping, the database field, the seed stage (R23,
 * E12), the query timeout and the bounds of 5.5. Every refusal is a DatabaseConfigError raised before any client
 * exists, and none repeats the value it refuses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  AUTHORIZATION_BY_TYPE,
  buildInfluxConnectionOptions,
  INFLUX_CELL_BUDGET,
  INFLUX_CONNECTION_SENTENCES,
  INFLUX_LIMITER_OPTIONS,
  INFLUX_LIST_CAP,
  INFLUX_MAX_IN_FLIGHT,
  INFLUX_RESPONSE_CAP_BYTES,
  INFLUX_ROW_CUT,
  INFLUX_SURFACE_TIMEOUT_MS,
  INFLUXDB_DEFAULT_PORT,
  INFLUXDB3_DEFAULT_PORT,
  type InfluxType,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { secretForms } from "@/lib/db/utils/server-text";
import { type DatabaseConnection, TUNNEL_FAR_END } from "@/lib/types";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_USER = "reader";
const TEST_PASSWORD = "password";
const QUERY_TIMEOUT = 30_000;
const TYPES: InfluxType[] = ["influxdb", "influxdb3"];
const SECRET_FIELD = { influxdb: "Password or token", influxdb3: "Token" } as const;
const SCHEME = { influxdb: "Token", influxdb3: "Bearer" } as const;
const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalFlag = process.env[FLAG];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

const PLAINTEXT =
  "This connection would send its password or token to InfluxDB without TLS, to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS (docs/providers/influxdb.md has a TLS recipe for each version), connect through an SSH tunnel, or tick Send the password without TLS to accept that risk for this connection. Inside a container, localhost is the container itself, not the host. Nothing was sent.";

function connection(type: InfluxType, overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "c1",
    name: "InfluxDB",
    type,
    host: "influx.test",
    createdAt: new Date(0),
    ...overrides,
  } as unknown as DatabaseConnection;
}

const build = (type: InfluxType, overrides: Record<string, unknown> = {}, queryTimeout = QUERY_TIMEOUT) =>
  buildInfluxConnectionOptions(connection(type, overrides), { type, queryTimeout });

function tunnelled(type: InfluxType, overrides: Record<string, unknown>, farEnd: { host: string; port: number }) {
  return buildInfluxConnectionOptions(
    {
      ...connection(type, { host: "127.0.0.1", port: 41_001, sshTunnel: { enabled: true }, ...overrides }),
      [TUNNEL_FAR_END]: farEnd,
    },
    { type, queryTimeout: QUERY_TIMEOUT },
  );
}

/** The DatabaseConfigError a call must raise, held to carry the type-id it was raised for. */
function refused(type: InfluxType, call: () => unknown): DatabaseConfigError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(String((error as DatabaseConfigError).provider)).toBe(type);
    return error as DatabaseConfigError;
  }
  throw new Error("the call answered, though this case must be refused");
}

const refusal = (type: InfluxType, overrides: Record<string, unknown>, queryTimeout = QUERY_TIMEOUT) =>
  refused(type, () => build(type, overrides, queryTimeout));

const LOCAL = { host: "127.0.0.1" };
const REMOTE = { host: "influx.example.com" };
const TLS_FULL = { ssl: { mode: "verify-full" } };

describe("the endpoint is exactly what it claims", () => {
  test("the origin is the validated host over http, on 8086 and 8181 by default", () => {
    expect(INFLUXDB_DEFAULT_PORT).toBe(8086);
    expect(INFLUXDB3_DEFAULT_PORT).toBe(8181);
    expect(build("influxdb").origin).toEqual({ scheme: "http", host: "influx.test", port: 8086 });
    expect(build("influxdb3").origin).toEqual({ scheme: "http", host: "influx.test", port: 8181 });
    expect(build("influxdb").endpoint).toEqual({ host: "influx.test", port: 8086 });
    expect(build("influxdb3", { port: "8182" }).origin.port).toBe(8182);
    expect(build("influxdb", { port: 8087 }).type).toBe("influxdb");
    expect(build("influxdb3").type).toBe("influxdb3");
  });

  test.each(TYPES)("TLS makes the %s origin https on the same port", (type) => {
    expect(build(type, { ...TLS_FULL, port: 9000 }).origin).toEqual({
      scheme: "https",
      host: "influx.test",
      port: 9000,
    });
  });

  test("an IPv6 literal is bracketed in the origin and bare in the endpoint, written either way", () => {
    for (const host of ["::1", "[::1]"]) {
      const options = build("influxdb", { host });
      expect(options.origin.host).toBe("[::1]");
      expect(options.endpoint.host).toBe("::1");
    }
  });

  test.each(["http://localhost:8086", "influx.test:8086", "influx.test/query", "user@influx.test", "", 7, null])(
    "the host %j is refused in the shared validator's words, as InfluxDB's, and never repeated",
    (host) => {
      for (const type of TYPES) {
        expect(refusal(type, { host }).message).toBe(
          "Invalid host: expected a hostname, an IPv4 address or an IPv6 address",
        );
      }
    },
  );

  test.each([0, 65_536, 1.5, "8086a", -1])("the port %j is refused", (port) => {
    expect(refusal("influxdb", { port }).message).toBe("Invalid port: expected an integer from 1 to 65535");
  });

  test("with the egress guard on, a private literal host is refused before anything else is read", () => {
    process.env[FLAG] = "true";
    expect(refusal("influxdb3", { host: "10.0.0.5", user: TEST_USER }).message).toBe(
      "Invalid host: this HTTP database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS",
    );
    expect(build("influxdb3", REMOTE).origin.host).toBe("influx.example.com");
  });

  test("through a tunnel the origin is the local forward and the endpoint the far end", () => {
    const options = tunnelled("influxdb", {}, { host: "[fd00::7]", port: 8086 });
    expect(options.origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 41_001 });
    expect(options.endpoint).toEqual({ host: "fd00::7", port: 8086 });
  });

  test("a far end that is no host or port is refused like the connection's own", () => {
    expect(refused("influxdb", () => tunnelled("influxdb", {}, { host: "a/b", port: 8086 })).message).toStartWith(
      "Invalid host",
    );
    expect(
      refused("influxdb3", () => tunnelled("influxdb3", {}, { host: "influx.internal", port: 0 })).message,
    ).toStartWith("Invalid port");
  });

  test("a tunnel that is on but arrived with no far end is refused, so InfluxDB is never dialled past it", () => {
    for (const type of TYPES) {
      expect(refusal(type, { sshTunnel: { enabled: true } }).message).toBe(
        "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so InfluxDB was not dialled directly: the tunnel opens only when both Host and Port are set.",
      );
    }
    expect(build("influxdb", { sshTunnel: { enabled: false } }).origin.host).toBe("influx.test");
    expect(build("influxdb", { sshTunnel: null }).origin.host).toBe("influx.test");
    expect(build("influxdb", { sshTunnel: {} }).origin.host).toBe("influx.test");
    const notAnObject = "The connection's sshTunnel must be an object; nothing was sent.";
    expect(refusal("influxdb", { sshTunnel: "on" }).message).toBe(notAnObject);
    expect(refusal("influxdb", { sshTunnel: [] }).message).toBe(notAnObject);
    expect(refusal("influxdb", { sshTunnel: { enabled: "yes" } }).message).toBe(
      "The connection's sshTunnel.enabled must be true or false; nothing was sent.",
    );
  });
});

describe("I6: AUTHORIZATION_BY_TYPE, one Authorization header or none", () => {
  const basic = `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("base64")}`;

  test("the table holds exactly the two type-ids and is frozen", () => {
    expect(Object.keys(AUTHORIZATION_BY_TYPE)).toEqual(["influxdb", "influxdb3"]);
    expect(Object.isFrozen(AUTHORIZATION_BY_TYPE)).toBe(true);
  });

  test("influxdb: Basic with a user and a password, Token with a password alone, none with neither", () => {
    const row = AUTHORIZATION_BY_TYPE.influxdb;
    expect(row({ user: TEST_USER, password: TEST_PASSWORD })).toBe(basic);
    expect(row({ password: TEST_PASSWORD })).toBe(`Token ${TEST_PASSWORD}`);
    expect(row({ user: "", password: TEST_PASSWORD })).toBe(`Token ${TEST_PASSWORD}`);
    expect(row({})).toBeUndefined();
    expect(row({ user: "", password: "" })).toBeUndefined();
  });

  test("influxdb: a user with no password is refused, and Bearer is never sent", () => {
    expect(refused("influxdb", () => AUTHORIZATION_BY_TYPE.influxdb({ user: TEST_USER })).message).toBe(
      "A user without a password sends nothing InfluxDB reads; fill Password or token, or clear User.",
    );
    expect(refusal("influxdb", { ...LOCAL, user: TEST_USER, password: "" }).message).toBe(
      INFLUX_CONNECTION_SENTENCES.userWithoutPassword,
    );
    for (const credential of [{ user: TEST_USER, password: TEST_PASSWORD }, { password: TEST_PASSWORD }]) {
      expect(AUTHORIZATION_BY_TYPE.influxdb(credential)).not.toContain("Bearer");
    }
  });

  test("influxdb3: Bearer with a token, none with nothing, and a user refused whatever the password", () => {
    const row = AUTHORIZATION_BY_TYPE.influxdb3;
    expect(row({ password: TEST_PASSWORD })).toBe(`Bearer ${TEST_PASSWORD}`);
    expect(row({ user: "", password: TEST_PASSWORD })).toBe(`Bearer ${TEST_PASSWORD}`);
    expect(row({})).toBeUndefined();
    for (const credential of [{ user: TEST_USER }, { user: TEST_USER, password: TEST_PASSWORD }]) {
      const error = refused("influxdb3", () => row(credential));
      expect(error.message).toBe("InfluxDB 3 has no user name: clear User and put the token in Token.");
      expect(error.message).toBe(INFLUX_CONNECTION_SENTENCES.influxdb3User);
      expect(error.message).not.toContain(TEST_USER);
    }
  });

  test("the built options carry exactly one lower-case authorization header, or none", () => {
    expect(build("influxdb", { ...LOCAL, user: TEST_USER, password: TEST_PASSWORD }).headers).toEqual({
      authorization: basic,
    });
    expect(build("influxdb", { ...LOCAL, password: TEST_PASSWORD }).headers).toEqual({
      authorization: `Token ${TEST_PASSWORD}`,
    });
    expect(build("influxdb3", { ...LOCAL, password: TEST_PASSWORD }).headers).toEqual({
      authorization: `Bearer ${TEST_PASSWORD}`,
    });
    for (const type of TYPES) {
      expect(build(type).headers).toEqual({});
      expect(build(type, { user: null, password: null }).headers).toEqual({});
      expect(build(type, { user: "", password: "" }).headers).toEqual({});
    }
    expect(refusal("influxdb3", { ...LOCAL, user: TEST_USER, password: TEST_PASSWORD }).message).toBe(
      INFLUX_CONNECTION_SENTENCES.influxdb3User,
    );
  });

  test("hasUser and hasSecret say what is configured", () => {
    expect(build("influxdb", { ...LOCAL, user: TEST_USER, password: TEST_PASSWORD })).toMatchObject({
      hasUser: true,
      hasSecret: true,
    });
    expect(build("influxdb", { ...LOCAL, password: TEST_PASSWORD })).toMatchObject({ hasUser: false, hasSecret: true });
    expect(build("influxdb3", { ...LOCAL, password: TEST_PASSWORD })).toMatchObject({
      hasUser: false,
      hasSecret: true,
    });
    for (const type of TYPES) expect(build(type)).toMatchObject({ hasUser: false, hasSecret: false });
  });
});

describe("C13 and E14: a credential an HTTP header cannot carry is refused naming the field, never the value", () => {
  const MALFORMED: [string, string][] = [
    ["a line feed", "abc\n"],
    ["a carriage return", "a\rb"],
    ["a NUL", "abc\u0000"],
    ["a tab", "a\tb"],
    ["a DEL", "abc\u007f"],
    ["a non-breaking space", "abc "],
    ["a curly quote", "“abc”"],
    ["a character outside Latin-1", "abc中"],
  ];

  test("the sentence names the field it is given", () => {
    expect(INFLUX_CONNECTION_SENTENCES.malformed("User")).toBe(
      "User holds a character outside printable ASCII, which an HTTP header cannot carry; re-enter it.",
    );
    expect(INFLUX_CONNECTION_SENTENCES.malformed("Password or token")).toStartWith("Password or token holds");
    expect(INFLUX_CONNECTION_SENTENCES.malformed("Token")).toStartWith("Token holds");
  });

  test.each(MALFORMED)("a password holding %s is refused on each type", (_what, password) => {
    for (const type of TYPES) {
      const error = refusal(type, { ...LOCAL, password });
      expect(error.message).toBe(INFLUX_CONNECTION_SENTENCES.malformed(SECRET_FIELD[type]));
      expect(error.message).not.toContain(password);
    }
    const direct = refused("influxdb3", () => AUTHORIZATION_BY_TYPE.influxdb3({ password }));
    expect(direct.message).toBe(INFLUX_CONNECTION_SENTENCES.malformed("Token"));
  });

  test.each(MALFORMED)("a user holding %s is refused naming User", (_what, user) => {
    const error = refusal("influxdb", { ...LOCAL, user, password: TEST_PASSWORD });
    expect(error.message).toBe(INFLUX_CONNECTION_SENTENCES.malformed("User"));
    expect(error.message).not.toContain(user);
    // Also with no password: the malformed value is what the user must fix first.
    expect(refusal("influxdb", { ...LOCAL, user }).message).toBe(INFLUX_CONNECTION_SENTENCES.malformed("User"));
  });

  test("a Basic user holding a colon is refused naming User, because the colon ends the user in the header", () => {
    const user = "reader:second";
    const error = refusal("influxdb", { ...LOCAL, user, password: TEST_PASSWORD });
    expect(error.message).toBe("User holds a colon, which Basic authentication cannot carry; check the user name.");
    expect(error.message).toBe(INFLUX_CONNECTION_SENTENCES.userColon);
    expect(error.message).not.toContain(user);
    // A colon in the password is carried: only the first colon of the pair separates.
    const options = build("influxdb", { ...LOCAL, user: TEST_USER, password: "pass:word" });
    expect(Buffer.from(options.headers.authorization.slice("Basic ".length), "base64").toString()).toBe(
      `${TEST_USER}:pass:word`,
    );
  });

  test("a space and every other printable ASCII character are carried", () => {
    const printable = " !\"#$%&'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~";
    for (const type of TYPES) {
      expect(build(type, { ...LOCAL, password: printable }).headers.authorization).toBe(`${SCHEME[type]} ${printable}`);
    }
  });

  test("a user or password that is not a string is refused naming the field", () => {
    for (const type of TYPES) {
      for (const password of [12_345, true, { key: TEST_PASSWORD }, [TEST_PASSWORD]]) {
        expect(refusal(type, { ...LOCAL, password }).message).toBe(
          "The connection's password must be a string; nothing was sent.",
        );
      }
      expect(refusal(type, { ...LOCAL, user: 7 }).message).toBe(
        "The connection's user must be a string; nothing was sent.",
      );
    }
  });
});

describe("R28 SR1 F7: the secret forms the error mapping withholds", () => {
  test("the password's forms on both types, and none without a password", () => {
    for (const type of TYPES) {
      expect(build(type, { ...LOCAL, password: TEST_PASSWORD }).secretForms).toEqual(secretForms([TEST_PASSWORD]));
      expect(build(type).secretForms).toEqual([]);
      expect(build(type, { password: "" }).secretForms).toEqual([]);
    }
  });

  test("on influxdb with a user, also the forms of user:password, the value the Basic header encodes", () => {
    const options = build("influxdb", { ...LOCAL, user: TEST_USER, password: TEST_PASSWORD });
    const pair = `${TEST_USER}:${TEST_PASSWORD}`;
    expect(options.secretForms).toEqual(secretForms([TEST_PASSWORD, pair]));
    // base64(user:password) does not contain base64(password), so it must be a form of its own.
    const encoded = options.headers.authorization.slice("Basic ".length);
    expect(encoded).not.toContain(Buffer.from(TEST_PASSWORD).toString("base64").replace(/=+$/, ""));
    expect(options.secretForms).toContain(encoded.replace(/=+$/, ""));
    expect(options.secretForms).toContain(pair);
    expect(options.secretForms).toContain(encodeURIComponent(pair));
  });

  test("a token shaped as a JWT adds each of its segments", () => {
    const jwt = [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
      Buffer.from('{"sub":"reader"}').toString("base64url"),
      Buffer.from("signature-stand-in").toString("base64url"),
    ].join(".");
    const forms = build("influxdb3", { ...LOCAL, password: jwt }).secretForms;
    expect(forms).toEqual(secretForms([jwt]));
    for (const segment of jwt.split(".")) expect(forms).toContain(segment);
  });
});

describe("I7 and E15: a secret never travels in the clear outside the machine without consent", () => {
  const secret = { password: TEST_PASSWORD };
  /** A stand-in that differs from the word "password", which the sentence itself holds, so its absence is provable. */
  const MARKER_PASSWORD = "password-second";

  test("the sentence is the spec's, word for word", () => {
    expect(INFLUX_CONNECTION_SENTENCES.plaintext).toBe(PLAINTEXT);
  });

  test.each([
    ["absent", {}],
    ["null", { ssl: null }],
    ["disable", { ssl: { mode: "disable" } }],
  ])("a secret with the TLS panel %s to a remote host is refused, and the host is never repeated", (_name, ssl) => {
    for (const type of TYPES) {
      for (const host of ["influx.example.com", "localhost.example", "128.0.0.1", "::ffff:10.0.0.1"]) {
        const message = refusal(type, { password: MARKER_PASSWORD, ...ssl, host }).message;
        expect(message).toBe(PLAINTEXT);
        expect(message).not.toContain(host);
        expect(message).not.toContain(MARKER_PASSWORD);
      }
    }
  });

  test("a consent that is not exactly true lifts nothing", () => {
    for (const allowInsecureAuth of [false, undefined, null, "true", 1]) {
      expect(refusal("influxdb", { ...secret, ...REMOTE, allowInsecureAuth }).message).toBe(PLAINTEXT);
    }
  });

  test.each(["127.0.0.1", "127.255.0.1", "::1", "::ffff:127.0.0.1", "localhost", "LOCALHOST"])(
    "a secret over no TLS to the loopback host %s opens",
    (host) => {
      expect(build("influxdb3", { ...secret, host }).headers).toEqual({ authorization: `Bearer ${TEST_PASSWORD}` });
    },
  );

  test("a tunnel-shaped connection opens: the secret crosses the network inside SSH", () => {
    expect(tunnelled("influxdb", secret, { host: "influx.example.com", port: 8086 }).headers).toEqual({
      authorization: `Token ${TEST_PASSWORD}`,
    });
  });

  test("no secret opens anywhere, and a TLS mode opens a remote host", () => {
    for (const type of TYPES) {
      expect(build(type, REMOTE).headers).toEqual({});
      expect(build(type, { ...secret, ...REMOTE, ssl: { mode: "require" } }).tls).toMatchObject({
        rejectUnauthorized: false,
      });
    }
  });

  test("allowInsecureAuth: true lifts the refusal with SSL mode disable or no panel, for that connection", () => {
    for (const type of TYPES) {
      for (const ssl of [{}, { ssl: null }, { ssl: { mode: "disable" } }]) {
        const options = build(type, { ...secret, ...REMOTE, ...ssl, allowInsecureAuth: true });
        expect(options.tls).toBeNull();
        expect(options.origin.scheme).toBe("http");
        expect(options.headers).toEqual({ authorization: `${SCHEME[type]} ${TEST_PASSWORD}` });
      }
    }
  });

  test("allowInsecureAuth: true with another TLS mode is accepted and ignored: TLS stays on", () => {
    const options = build("influxdb", { ...secret, ...REMOTE, ssl: { mode: "require" }, allowInsecureAuth: true });
    expect(options.tls).toMatchObject({ rejectUnauthorized: false });
    expect(options.origin.scheme).toBe("https");
  });
});

describe("the SSL / TLS panel through nodeTlsMaterial, never retried weaker", () => {
  test("disable and an absent panel are plaintext; require does not verify; every verify mode verifies", () => {
    expect(build("influxdb").tls).toBeNull();
    expect(build("influxdb", { ssl: { mode: "disable" } }).tls).toBeNull();
    expect(build("influxdb", { ssl: { mode: "require" } }).tls?.rejectUnauthorized).toBe(false);
    for (const mode of ["verify-system", "verify-ca", "verify-full"]) {
      expect(build("influxdb3", { ssl: { mode } }).tls?.rejectUnauthorized).toBe(true);
    }
  });

  test("a panel of the wrong kind is refused in the shared words, as InfluxDB's", () => {
    expect(refusal("influxdb", { ssl: "on" }).message).toBe("Invalid ssl: expected an object");
    expect(refusal("influxdb3", { ssl: { mode: "prefer" } }).message).toBe(
      "Invalid ssl.mode: expected disable, require, verify-system, verify-ca or verify-full",
    );
  });

  test("the identity is the host, an IPv6 literal without its brackets, and the far end through a tunnel", () => {
    expect(build("influxdb", TLS_FULL).tls?.identity).toBe("influx.test");
    expect(build("influxdb", { ...TLS_FULL, host: "[::1]" }).tls?.identity).toBe("::1");
    const options = tunnelled("influxdb3", TLS_FULL, { host: "influx.internal", port: 8181 });
    expect(options.tls?.identity).toBe("influx.internal");
    expect(options.origin).toEqual({ scheme: "https", host: "127.0.0.1", port: 41_001 });
  });
});

describe("the database field", () => {
  test("it is optional: absent, null and empty read as none", () => {
    for (const type of TYPES) {
      expect(build(type).database).toBeUndefined();
      expect(build(type, { database: null }).database).toBeUndefined();
      expect(build(type, { database: "" }).database).toBeUndefined();
    }
  });

  test("1 to 255 characters are kept as written", () => {
    expect(build("influxdb", { database: "d" }).database).toBe("d");
    expect(build("influxdb3", { database: 'we"ird name;x' }).database).toBe('we"ird name;x');
    expect(build("influxdb", { database: "d".repeat(255) }).database).toHaveLength(255);
  });

  test("256 characters are refused naming the field, never the value", () => {
    const database = "d".repeat(256);
    const error = refusal("influxdb", { database });
    expect(error.message).toBe("The connection's database is longer than 255 characters.");
    expect(error.message).not.toContain(database);
  });

  test.each(["a\u0000b", "a\nb", "a\tb", "\u001f"])("the C0 control in %j is refused", (database) => {
    for (const type of TYPES) {
      const error = refusal(type, { database });
      expect(error.message).toBe("The connection's database holds a control character.");
      expect(error.message).toBe(INFLUX_CONNECTION_SENTENCES.databaseControl);
    }
  });

  test("a database that is not a string is refused naming the field", () => {
    expect(refusal("influxdb3", { database: 7 }).message).toBe(
      "The connection's database must be a string; nothing was sent.",
    );
  });
});

describe("R23 and E12: the read-only seed stage, after resolution, before any socket", () => {
  const SEED_REFUSED =
    "This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.";

  test("readOnlySeed is readOnly: true with a seedId, and nothing else", () => {
    for (const type of TYPES) {
      expect(build(type, { ...LOCAL, readOnly: true, seedId: "s1", password: TEST_PASSWORD }).readOnlySeed).toBe(true);
      expect(build(type, { readOnly: true }).readOnlySeed).toBe(false);
      expect(build(type, { readOnly: true, seedId: "" }).readOnlySeed).toBe(false);
      expect(build(type, { readOnly: false, seedId: "s1" }).readOnlySeed).toBe(false);
      expect(build(type, { seedId: "s1" }).readOnlySeed).toBe(false);
      expect(build(type).readOnlySeed).toBe(false);
    }
  });

  test("a read-only seed with no secret is refused with the type's no-secret message", () => {
    expect(refusal("influxdb", { readOnly: true, seedId: "s1" }).message).toBe(
      `Credential warning: An InfluxDB 1.x server with authentication off, its default, and an InfluxDB 3 server started with --without-auth accept any credential or none, so a read-only seed without a password or token promises a boundary the server does not keep. ${SEED_REFUSED}`,
    );
    expect(refusal("influxdb3", { readOnly: true, seedId: "s1", password: "" }).message).toBe(
      `Credential warning: An InfluxDB 3 server started with --without-auth accepts any token or none, so a read-only seed without a token promises a boundary the server does not keep. ${SEED_REFUSED}`,
    );
  });

  test("a connection that is not a read-only seed opens with no secret", () => {
    expect(build("influxdb", { readOnly: true }).headers).toEqual({});
    expect(build("influxdb3", { seedId: "s1" }).headers).toEqual({});
  });

  test("a readOnly that is not a boolean is refused naming the field", () => {
    for (const type of TYPES) {
      expect(refusal(type, { readOnly: null }).message).toBe("readOnly must be true or false.");
      expect(refusal(type, { readOnly: "yes" }).message).toBe("readOnly must be true or false.");
    }
    expect(refusal("influxdb", { readOnly: true, seedId: 7 }).message).toBe(
      "The connection's seedId must be a string; nothing was sent.",
    );
  });
});

describe("the bounds of 5.5 and the timeouts", () => {
  test("the constants are the spec's", () => {
    expect(INFLUX_MAX_IN_FLIGHT).toBe(2);
    expect(INFLUX_LIMITER_OPTIONS).toEqual({ perProvider: 2, perEngine: 2, queueDepth: 64 });
    expect(INFLUX_RESPONSE_CAP_BYTES).toBe(33_554_432);
    expect(INFLUX_SURFACE_TIMEOUT_MS).toBe(10_000);
    expect(INFLUX_ROW_CUT).toBe(10_000);
    expect(INFLUX_CELL_BUDGET).toBe(250_000);
    expect(INFLUX_LIST_CAP).toBe(2000);
  });

  test("the socket bound is the in-flight bound, and the response cap is 32 MiB", () => {
    for (const type of TYPES) {
      expect(build(type).maxSockets).toBe(INFLUX_MAX_IN_FLIGHT);
      expect(build(type).responseCapBytes).toBe(INFLUX_RESPONSE_CAP_BYTES);
    }
  });

  test("the query timeout is the call deadline, within the dialog's bound", () => {
    expect(build("influxdb", {}, 5000).callTimeoutMs).toBe(5000);
    expect(build("influxdb", {}, 2_147_483_647).callTimeoutMs).toBe(2_147_483_647);
    for (const queryTimeout of [0, 1.5, 2_147_483_648, Number.NaN]) {
      expect(refusal("influxdb3", {}, queryTimeout).message).toBe(
        "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
      );
    }
  });

  test("the surface deadline is min(10 s, query timeout)", () => {
    expect(build("influxdb", {}, 30_000).surfaceTimeoutMs).toBe(10_000);
    expect(build("influxdb", {}, 10_000).surfaceTimeoutMs).toBe(10_000);
    expect(build("influxdb3", {}, 4000).surfaceTimeoutMs).toBe(4000);
    expect(build("influxdb3", {}, 1).surfaceTimeoutMs).toBe(1);
  });
});
