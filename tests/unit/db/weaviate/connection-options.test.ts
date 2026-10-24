/**
 * The Weaviate connection (#1566 spec 6.1, doc section 4): the endpoint check (W1), the bearer token, the plaintext
 * rule (W2), the TLS mapping, the tunnel's far end, the read-only source and the seed stage, the query timeout and
 * the secret forms. Every refusal is a DatabaseConfigError raised before any client exists, and none repeats the
 * value it refuses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST } from "@/lib/db/http/egress-policy";
import {
  buildWeaviateConnectionOptions,
  WEAVIATE_DEFAULT_PORT,
  WEAVIATE_MAX_IN_FLIGHT,
  WEAVIATE_RESPONSE_CAP_BYTES,
} from "@/lib/db/providers/vector/weaviate/connection-options";
import { secretForms } from "@/lib/db/utils/server-text";
import { type DatabaseConnection, TUNNEL_FAR_END } from "@/lib/types";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const CONTEXT = { executionReadOnly: false, queryTimeout: 30_000 };
const EXITS = [
  "Choose an SSL mode under SSL / TLS",
  "connect through an SSH tunnel",
  "if authentication is off on this server, clear the API key or token",
];
const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalFlag = process.env[FLAG];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

function connection(overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "c1",
    name: "Weaviate",
    type: "weaviate",
    host: "weaviate.test",
    port: 8080,
    createdAt: new Date(0),
    ...overrides,
  } as unknown as DatabaseConnection;
}

const build = (overrides: Record<string, unknown> = {}, context = CONTEXT) =>
  buildWeaviateConnectionOptions(connection(overrides), context);

function tunnelled(overrides: Record<string, unknown>, farEnd: { host: string; port: number }) {
  return buildWeaviateConnectionOptions(
    {
      ...connection({ host: "127.0.0.1", port: 41_001, sshTunnel: { enabled: true }, ...overrides }),
      [TUNNEL_FAR_END]: farEnd,
    },
    CONTEXT,
  );
}

function refusal(overrides: Record<string, unknown>, context = CONTEXT): DatabaseConfigError {
  try {
    build(overrides, context);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(String((error as DatabaseConfigError).provider)).toBe("weaviate");
    return error as DatabaseConfigError;
  }
  throw new Error("buildWeaviateConnectionOptions answered, though this case must be refused");
}

const TLS_FULL = { ssl: { mode: "verify-full" } };
const LOCAL = { host: "127.0.0.1" };

describe("W1: the endpoint is exactly what it claims", () => {
  test("the origin is the validated host and port over http, 8080 by default", () => {
    expect(build().origin).toEqual({ scheme: "http", host: "weaviate.test", port: 8080 });
    expect(WEAVIATE_DEFAULT_PORT).toBe(8080);
    expect(build({ port: undefined }).origin.port).toBe(8080);
    expect(build({ port: null }).origin.port).toBe(8080);
    expect(build({ port: "8443" }).origin.port).toBe(8443);
    expect(build().endpoint).toEqual({ host: "weaviate.test", port: 8080 });
  });

  test("TLS makes the origin https on the same port", () => {
    expect(build(TLS_FULL).origin).toEqual({ scheme: "https", host: "weaviate.test", port: 8080 });
  });

  test("an IPv6 literal is bracketed in the origin and bare in the endpoint, written either way", () => {
    for (const host of ["::1", "[::1]"]) {
      const options = build({ host });
      expect(options.origin.host).toBe("[::1]");
      expect(options.endpoint.host).toBe("::1");
    }
  });

  test.each([
    "http://localhost:8080",
    "weaviate.test:8080",
    "weaviate.test/v1",
    "user@weaviate.test",
    "weaviate.test?x=1",
    "",
    7,
    null,
  ])("the host %j is refused in the shared validator's words, as Weaviate's, and never repeated", (host) => {
    expect(refusal({ host }).message).toBe("Invalid host: expected a hostname, an IPv4 address or an IPv6 address");
  });

  test.each([0, 65_536, 1.5, "8080a", -1])("the port %j is refused", (port) => {
    expect(refusal({ port }).message).toBe("Invalid port: expected an integer from 1 to 65535");
  });

  test("with the egress guard on, a private literal host is refused before anything else is read", () => {
    process.env[FLAG] = "true";
    expect(refusal({ host: "10.0.0.5", user: "someone" }).message).toBe(BLOCKED_HOST);
    expect(build({ host: "weaviate.example.com" }).origin.host).toBe("weaviate.example.com");
  });
});

describe("the SSH tunnel: the local forward is dialled, the far end is what sentences and TLS name", () => {
  test("through a tunnel the origin is the local forward and the endpoint the far end", () => {
    const options = tunnelled({}, { host: "weaviate.internal", port: 8080 });
    expect(options.origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 41_001 });
    expect(options.endpoint).toEqual({ host: "weaviate.internal", port: 8080 });
    expect(tunnelled({}, { host: "[fd00::5]", port: 8080 }).endpoint.host).toBe("fd00::5");
  });

  test("a far end that is no host or port is refused like the connection's own, as Weaviate's", () => {
    for (const [farEnd, words] of [
      [{ host: "a/b", port: 8080 }, "Invalid host"],
      [{ host: "weaviate.internal", port: 0 }, "Invalid port"],
    ] as const) {
      let thrown: unknown;
      try {
        tunnelled({}, farEnd);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DatabaseConfigError);
      expect(String((thrown as DatabaseConfigError).provider)).toBe("weaviate");
      expect((thrown as Error).message).toStartWith(words);
    }
  });

  test("a tunnel that is on but arrived with no far end is refused, so Weaviate is never dialled past it", () => {
    expect(refusal({ sshTunnel: { enabled: true } }).message).toBe(
      "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Weaviate was not dialled directly: the tunnel opens only when both Host and Port are set.",
    );
    expect(build({ sshTunnel: { enabled: false } }).origin.host).toBe("weaviate.test");
    expect(build({ sshTunnel: { enabled: null } }).origin.host).toBe("weaviate.test");
    expect(build({ sshTunnel: null }).origin.host).toBe("weaviate.test");
  });

  test("a tunnel field of the wrong type is refused naming the field", () => {
    for (const sshTunnel of ["on", [], 1]) {
      expect(refusal({ sshTunnel }).message).toBe("The connection's sshTunnel must be an object; nothing was sent.");
    }
    expect(refusal({ sshTunnel: { enabled: "yes" } }).message).toBe(
      "The connection's sshTunnel.enabled must be true or false; nothing was sent.",
    );
  });
});

describe("the bearer token is validated and never echoed", () => {
  test("the secret travels as one Authorization: Bearer header and nothing else", () => {
    expect(build({ ...LOCAL, password: TEST_PASSWORD }).headers).toEqual({ authorization: `Bearer ${TEST_PASSWORD}` });
  });

  test("no secret sends no header: an empty string and null are absent", () => {
    expect(build().headers).toEqual({});
    expect(build({ password: "" }).headers).toEqual({});
    expect(build({ password: null, user: "" }).headers).toEqual({});
    expect(build({ user: null }).secretForms).toEqual([]);
  });

  test.each([
    ["a space", "abc def"],
    ["a line feed", "abc\n"],
    ["a carriage return", "a\rb"],
    ["a NUL", "abc\u0000"],
    ["a tab", "a\tb"],
    ["a DEL", "abc\u007f"],
    ["a non-breaking space", "abc "],
    ["a character outside Latin-1", "abc中"],
  ])("a secret holding %s is refused naming the field, never the value", (_what, password) => {
    const error = refusal({ ...LOCAL, password });
    expect(error.message).toBe(
      "The connection's password (the API key or token) holds a space, a line break, a NUL or another character outside printable ASCII; remove it. Nothing was sent.",
    );
    expect(error.message).not.toContain(password);
  });

  test("a secret that is not a string is refused naming the field", () => {
    for (const password of [12_345, true, { key: TEST_PASSWORD }, [TEST_PASSWORD]]) {
      expect(refusal({ ...LOCAL, password }).message).toBe(
        "The connection's password must be a string; nothing was sent.",
      );
    }
  });

  test("a user is refused naming the field, because Weaviate takes none", () => {
    const error = refusal({ ...LOCAL, user: "admin", password: TEST_PASSWORD });
    expect(error.message).toBe(
      "Weaviate takes no user name: clear the connection's user, and put the API key or OIDC access token in the password. Nothing was sent.",
    );
    expect(error.message).not.toContain("admin");
    expect(refusal({ ...LOCAL, user: 7 }).message).toBe("The connection's user must be a string; nothing was sent.");
  });

  test("the secret forms are the token's, and each segment of a JWT-shaped OIDC token", () => {
    expect(build({ ...LOCAL, password: TEST_PASSWORD }).secretForms).toEqual(secretForms([TEST_PASSWORD]));
    const jwt = [
      Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"),
      Buffer.from('{"sub":"reader"}').toString("base64url"),
      Buffer.from("signature-stand-in").toString("base64url"),
    ].join(".");
    const options = build({ ...LOCAL, password: jwt });
    expect(options.headers).toEqual({ authorization: `Bearer ${jwt}` });
    expect(options.secretForms).toEqual(secretForms([jwt]));
    for (const segment of jwt.split(".")) expect(options.secretForms).toContain(segment);
  });
});

describe("W2: a secret never travels in the clear outside the machine", () => {
  const secret = { password: TEST_PASSWORD };

  test.each([
    ["absent", {}],
    ["null", { ssl: null }],
    ["disable", { ssl: { mode: "disable" } }],
  ])("a secret with the TLS panel %s to a remote host is refused with all three exits", (_name, ssl) => {
    for (const host of ["weaviate.example.com", "localhost.example", "128.0.0.1"]) {
      const message = refusal({ ...secret, ...ssl, host }).message;
      expect(message).toStartWith(
        "This connection would send its API key or token without TLS to a host that is not this machine",
      );
      for (const exit of EXITS) expect(message).toContain(exit);
      expect(message).not.toContain(host);
      expect(message).not.toContain(TEST_PASSWORD);
    }
  });

  test.each(["127.0.0.1", "::1", "localhost"])("a secret over no TLS to the loopback host %s opens", (host) => {
    expect(build({ ...secret, host }).headers).toEqual({ authorization: `Bearer ${TEST_PASSWORD}` });
  });

  test("the rule reads the far end under a tunnel, and a tunnel carries the secret inside SSH", () => {
    expect(tunnelled(secret, { host: "weaviate.example.com", port: 8080 }).headers).toEqual({
      authorization: `Bearer ${TEST_PASSWORD}`,
    });
  });

  test("no secret opens anywhere, and TLS require opens a remote host", () => {
    expect(build({ host: "weaviate.example.com" }).headers).toEqual({});
    expect(build({ ...secret, host: "weaviate.example.com", ssl: { mode: "require" } }).tls).toMatchObject({
      rejectUnauthorized: false,
    });
  });
});

describe("the SSL / TLS panel through nodeTlsMaterial", () => {
  test("disable and an absent panel are plaintext; require does not verify; every verify mode verifies", () => {
    expect(build().tls).toBeNull();
    expect(build({ ssl: { mode: "disable" } }).tls).toBeNull();
    expect(build({ ssl: { mode: "require" } }).tls?.rejectUnauthorized).toBe(false);
    for (const mode of ["verify-system", "verify-ca", "verify-full"]) {
      expect(build({ ssl: { mode } }).tls?.rejectUnauthorized).toBe(true);
    }
  });

  test("the CA, the client certificate and its key are passed as bytes", () => {
    const tls = build({ ssl: { mode: "verify-full", caCert: "CA", clientCert: "CERT", clientKey: "KEY" } }).tls;
    expect(tls?.ca?.toString()).toBe("CA");
    expect(tls?.cert?.toString()).toBe("CERT");
    expect(tls?.key?.toString()).toBe("KEY");
  });

  test("a panel of the wrong kind is refused in the shared words, as Weaviate's", () => {
    expect(refusal({ ssl: "on" }).message).toBe("Invalid ssl: expected an object");
    expect(refusal({ ssl: { mode: "prefer" } }).message).toBe(
      "Invalid ssl.mode: expected disable, require, verify-system, verify-ca or verify-full",
    );
  });

  test("the identity is the endpoint host, without brackets, and the far end under a tunnel", () => {
    expect(build(TLS_FULL).tls?.identity).toBe("weaviate.test");
    expect(build({ ...TLS_FULL, host: "[::1]" }).tls?.identity).toBe("::1");
    const options = tunnelled(TLS_FULL, { host: "weaviate.internal", port: 8080 });
    expect(options.tls?.identity).toBe("weaviate.internal");
    expect(options.origin).toEqual({ scheme: "https", host: "127.0.0.1", port: 41_001 });
  });
});

describe("the read-only source, the bounds and the query timeout", () => {
  test("read-only comes from the connection, a seed, or the execution profile, in that order", () => {
    const keyed = { ...LOCAL, password: TEST_PASSWORD };
    expect(build({ readOnly: true }).readOnly).toBe("connection");
    expect(build({ readOnly: true, seedId: "s1", ...keyed }).readOnly).toBe("seed");
    expect(build({ readOnly: true, seedId: "" }).readOnly).toBe("connection");
    expect(build({ readOnly: true, seedId: null }).readOnly).toBe("connection");
    expect(build({}, { ...CONTEXT, executionReadOnly: true }).readOnly).toBe("execution-profile");
    expect(build({ readOnly: false }, { ...CONTEXT, executionReadOnly: true }).readOnly).toBe("execution-profile");
    expect(Object.hasOwn(build(), "readOnly")).toBe(false);
    expect(Object.hasOwn(build({ readOnly: false }), "readOnly")).toBe(false);
  });

  test("a readOnly that is not a boolean, and a seedId that is not text, are refused", () => {
    expect(refusal({ readOnly: "yes" }).message).toBe("readOnly must be true or false.");
    expect(refusal({ readOnly: null }).message).toBe("readOnly must be true or false.");
    expect(refusal({ readOnly: true, seedId: 7 }).message).toBe(
      "The connection's seedId must be a string; nothing was sent.",
    );
  });

  test("the socket bound is the in-flight bound, and the response cap is 16 MiB", () => {
    expect(build().maxSockets).toBe(WEAVIATE_MAX_IN_FLIGHT);
    expect(WEAVIATE_MAX_IN_FLIGHT).toBe(4);
    expect(build().responseCapBytes).toBe(WEAVIATE_RESPONSE_CAP_BYTES);
    expect(WEAVIATE_RESPONSE_CAP_BYTES).toBe(16_777_216);
  });

  test("the query timeout is the deadline cap, within the dialog's bound", () => {
    expect(build({}, { ...CONTEXT, queryTimeout: 1 }).callTimeoutMs).toBe(1);
    expect(build({}, { ...CONTEXT, queryTimeout: 2_147_483_647 }).callTimeoutMs).toBe(2_147_483_647);
    for (const queryTimeout of [0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusal({}, { ...CONTEXT, queryTimeout }).message).toBe(
        "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
      );
    }
  });
});

describe("the seed stage: a read-only seed without a key is refused, before any client exists", () => {
  test("the weaviate record's no-secret entry refuses a read-only seed without a key", () => {
    expect(refusal({ readOnly: true, seedId: "s1" }).message).toBe(
      "Credential warning: A Weaviate server with anonymous access on, its default, answers a request that carries no key and grants it every write, so a read-only seed without a key promises a boundary the server does not keep. This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.",
    );
    expect(refusal({ readOnly: true, seedId: "s1", password: "" }).message).toStartWith("Credential warning: ");
  });

  test("a seed holding a key, a seed that is not read-only, and a read-only connection that is no seed pass", () => {
    expect(build({ readOnly: true, seedId: "s1", ...LOCAL, password: TEST_PASSWORD }).readOnly).toBe("seed");
    expect(build({ seedId: "s1" }).headers).toEqual({});
    expect(build({ readOnly: true }).readOnly).toBe("connection");
  });
});
