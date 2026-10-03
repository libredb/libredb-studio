/**
 * The Qdrant connection (vector-family spec 6.2): QE1's endpoint, QE4's credential, VF1's plaintext rule (QE5), the
 * TLS mapping of QE6, the seed stage of 3.12 (QE22), the read-only source, the query timeout and the secret forms.
 * Every refusal is a DatabaseConfigError raised before any client exists, and none repeats the value it refuses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  buildQdrantConnectionOptions,
  QDRANT_DEFAULT_PORT,
  QDRANT_MAX_IN_FLIGHT,
  QDRANT_RESPONSE_CAP_BYTES,
} from "@/lib/db/providers/vector/qdrant/connection-options";
import { secretForms } from "@/lib/db/utils/server-text";
import { type DatabaseConnection, type DatabaseType, TUNNEL_FAR_END } from "@/lib/types";
import {
  declareCredentialWarnings,
  SYNTHETIC_JWT,
  SYNTHETIC_NO_SECRET,
} from "../../../helpers/synthetic-credential-warnings";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const CONTEXT = { executionReadOnly: false, queryTimeout: 30_000 };
const EXITS = [
  "Choose an SSL mode under SSL / TLS",
  "connect through an SSH tunnel",
  "if authentication is off on this server, clear the API key",
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
    name: "Qdrant",
    type: "qdrant",
    host: "qdrant.test",
    port: 6333,
    createdAt: new Date(0),
    ...overrides,
  } as unknown as DatabaseConnection;
}

const build = (overrides: Record<string, unknown> = {}, context = CONTEXT) =>
  buildQdrantConnectionOptions(connection(overrides), context);

function tunnelled(overrides: Record<string, unknown>, farEnd: { host: string; port: number }) {
  return buildQdrantConnectionOptions(
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
    expect(String((error as DatabaseConfigError).provider)).toBe("qdrant");
    return error as DatabaseConfigError;
  }
  throw new Error("buildQdrantConnectionOptions answered, though this case must be refused");
}

const TLS_FULL = { ssl: { mode: "verify-full" } };

describe("QE1: the endpoint is exactly what it claims", () => {
  test("the origin is the validated host and port over http, 6333 by default", () => {
    expect(build().origin).toEqual({ scheme: "http", host: "qdrant.test", port: 6333 });
    expect(build({ port: undefined }).origin.port).toBe(QDRANT_DEFAULT_PORT);
    expect(build({ port: "6343" }).origin.port).toBe(6343);
    expect(build().endpoint).toEqual({ host: "qdrant.test", port: 6333 });
  });

  test("TLS makes the origin https on the same port", () => {
    expect(build(TLS_FULL).origin).toEqual({ scheme: "https", host: "qdrant.test", port: 6333 });
  });

  test("an IPv6 literal is bracketed in the origin and bare in the endpoint, written either way", () => {
    for (const host of ["::1", "[::1]"]) {
      const options = build({ host });
      expect(options.origin.host).toBe("[::1]");
      expect(options.endpoint.host).toBe("::1");
    }
  });

  test.each([
    "http://localhost:6333",
    "qdrant.test:6333",
    "qdrant.test/collections",
    "user@qdrant.test",
    "qdrant.test?x=1",
    "qdrant.test#a",
    "127.1",
    "",
    7,
    null,
  ])("the host %j is refused in the shared validator's words, as Qdrant's, and never repeated", (host) => {
    const error = refusal({ host });
    expect(error.message).toBe("Invalid host: expected a hostname, an IPv4 address or an IPv6 address");
  });

  test.each([0, 65_536, 1.5, "6333a", -1])("the port %j is refused", (port) => {
    expect(refusal({ port }).message).toBe("Invalid port: expected an integer from 1 to 65535");
  });

  test("with the egress guard on, a private literal host is refused before anything else is read", () => {
    process.env[FLAG] = "true";
    expect(refusal({ host: "10.0.0.5", user: "someone" }).message).toBe(
      "Invalid host: this HTTP database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS",
    );
    expect(build({ host: "qdrant.example.com" }).origin.host).toBe("qdrant.example.com");
  });

  test("through a tunnel the origin is the local forward and the endpoint the far end", () => {
    const options = tunnelled({}, { host: "qdrant.internal", port: 6333 });
    expect(options.origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 41_001 });
    expect(options.endpoint).toEqual({ host: "qdrant.internal", port: 6333 });
  });

  test("a far end that is no host or port is refused like the connection's own", () => {
    expect(() => tunnelled({}, { host: "a/b", port: 6333 })).toThrow("Invalid host");
    expect(() => tunnelled({}, { host: "qdrant.internal", port: 0 })).toThrow("Invalid port");
  });

  test("a tunnel that is on but arrived with no far end is refused, so Qdrant is never dialled past it", () => {
    expect(refusal({ sshTunnel: { enabled: true } }).message).toContain("SSH tunnel is on");
    expect(build({ sshTunnel: { enabled: false } }).origin.host).toBe("qdrant.test");
    expect(build({ sshTunnel: null }).origin.host).toBe("qdrant.test");
    expect(refusal({ sshTunnel: "on" }).message).toBe(
      "The connection's sshTunnel must be an object; nothing was sent.",
    );
    expect(refusal({ sshTunnel: [] }).message).toBe("The connection's sshTunnel must be an object; nothing was sent.");
    expect(refusal({ sshTunnel: { enabled: "yes" } }).message).toBe(
      "The connection's sshTunnel.enabled must be true or false; nothing was sent.",
    );
  });
});

describe("QE4: the credential is validated and never echoed", () => {
  const local = { host: "127.0.0.1" };

  test("the secret travels as one api-key header and nothing else", () => {
    expect(build({ ...local, password: TEST_PASSWORD }).headers).toEqual({ "api-key": TEST_PASSWORD });
  });

  test("no secret sends no header: an empty string and null are absent", () => {
    expect(build().headers).toEqual({});
    expect(build({ password: "" }).headers).toEqual({});
    expect(build({ password: null, user: "" }).headers).toEqual({});
    expect(build({ user: null }).secretForms).toEqual([]);
  });

  test.each([
    ["a line feed", "abc\n"],
    ["a carriage return", "a\rb"],
    ["a NUL", "abc\u0000"],
    ["a tab", "a\tb"],
    ["a DEL", "abc\u007f"],
    ["a non-breaking space", "abc\u00a0"],
    ["a curly quote", "\u201cabc\u201d"],
    ["a character outside Latin-1", "abc\u4e2d"],
  ])("a secret holding %s is refused naming the field, never the value", (_what, password) => {
    const error = refusal({ ...local, password });
    expect(error.message).toBe(
      "The connection's password (the API key or JWT) holds a line break, a NUL or another character outside printable ASCII; remove it. Nothing was sent.",
    );
    expect(error.message).not.toContain(password);
  });

  test("a secret that is not a string is refused naming the field", () => {
    for (const password of [12_345, true, { key: TEST_PASSWORD }, [TEST_PASSWORD]]) {
      expect(refusal({ ...local, password }).message).toBe(
        "The connection's password must be a string; nothing was sent.",
      );
    }
  });

  test("a user is refused naming the field, because Qdrant has no user name", () => {
    const error = refusal({ ...local, user: "admin", password: TEST_PASSWORD });
    expect(error.message).toBe(
      "Qdrant has no user name: clear the connection's user, and put the API key or JWT in the password. Nothing was sent.",
    );
    expect(error.message).not.toContain("admin");
    expect(refusal({ ...local, user: 7 }).message).toBe("The connection's user must be a string; nothing was sent.");
  });

  test("the secret forms cover the key, and each segment of a JWT (3.9, VF9)", () => {
    expect(build({ ...local, password: TEST_PASSWORD }).secretForms).toEqual(secretForms([TEST_PASSWORD]));
    const jwt = [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
      Buffer.from('{"access":"r"}').toString("base64url"),
      Buffer.from("signature-stand-in").toString("base64url"),
    ].join(".");
    const forms = build({ ...local, password: jwt }).secretForms;
    expect(forms).toEqual(secretForms([jwt]));
    for (const segment of jwt.split(".")) expect(forms).toContain(segment);
  });
});

describe("VF1 and QE5: a secret never travels in the clear outside the machine", () => {
  const secret = { password: TEST_PASSWORD };

  test.each([
    ["absent", {}],
    ["null", { ssl: null }],
    ["disable", { ssl: { mode: "disable" } }],
  ])("a secret with the TLS panel %s to a remote host is refused with all three exits", (_name, ssl) => {
    for (const host of ["qdrant.example.com", "localhost.example", "128.0.0.1", "::ffff:10.0.0.1"]) {
      const message = refusal({ ...secret, ...ssl, host }).message;
      expect(message).toStartWith(
        "This connection would send its API key without TLS to a host that is not this machine",
      );
      for (const exit of EXITS) expect(message).toContain(exit);
      expect(message).not.toContain(host);
      expect(message).not.toContain(TEST_PASSWORD);
    }
  });

  test.each(["127.0.0.1", "127.255.0.1", "::1", "::ffff:127.0.0.1", "localhost", "LOCALHOST"])(
    "a secret over no TLS to the loopback host %s opens",
    (host) => {
      expect(build({ ...secret, host }).headers).toEqual({ "api-key": TEST_PASSWORD });
    },
  );

  test("a tunnel-shaped connection opens: the secret crosses the network inside SSH", () => {
    expect(tunnelled(secret, { host: "qdrant.example.com", port: 6333 }).headers).toEqual({ "api-key": TEST_PASSWORD });
  });

  test("no secret opens anywhere, and TLS require opens a remote host", () => {
    expect(build({ host: "qdrant.example.com" }).headers).toEqual({});
    expect(build({ ...secret, host: "qdrant.example.com", ssl: { mode: "require" } }).tls).toMatchObject({
      rejectUnauthorized: false,
    });
  });
});

describe("QE6: the SSL / TLS panel through nodeTlsMaterial, never retried weaker", () => {
  test("disable and an absent panel are plaintext; require does not verify; every verify mode verifies", () => {
    expect(build().tls).toBeNull();
    expect(build({ ssl: { mode: "disable" } }).tls).toBeNull();
    expect(build({ ssl: { mode: "require" } }).tls?.rejectUnauthorized).toBe(false);
    for (const mode of ["verify-system", "verify-ca", "verify-full"]) {
      expect(build({ ssl: { mode } }).tls?.rejectUnauthorized).toBe(true);
    }
    expect(build({ ssl: {} }).tls?.rejectUnauthorized).toBe(true);
  });

  test("the CA, the client certificate and its key are passed as bytes", () => {
    const tls = build({ ssl: { mode: "verify-full", caCert: "CA", clientCert: "CERT", clientKey: "KEY" } }).tls;
    expect(tls?.ca?.toString()).toBe("CA");
    expect(tls?.cert?.toString()).toBe("CERT");
    expect(tls?.key?.toString()).toBe("KEY");
  });

  test("a panel of the wrong kind is refused in the shared words, as Qdrant's", () => {
    expect(refusal({ ssl: "on" }).message).toBe("Invalid ssl: expected an object");
    expect(refusal({ ssl: { mode: "prefer" } }).message).toBe(
      "Invalid ssl.mode: expected disable, require, verify-system, verify-ca or verify-full",
    );
    expect(refusal({ ssl: { mode: "verify-full", clientCert: "CERT" } }).message).toBe(
      "Invalid ssl.clientCert and ssl.clientKey: give both or neither",
    );
  });

  test("the identity is the host, an IPv6 literal without its brackets", () => {
    expect(build(TLS_FULL).tls?.identity).toBe("qdrant.test");
    expect(build({ ...TLS_FULL, host: "10.0.0.5" }).tls?.identity).toBe("10.0.0.5");
    expect(build({ ...TLS_FULL, host: "[::1]" }).tls?.identity).toBe("::1");
  });

  test("through a tunnel the identity is the far end, never the local forward", () => {
    const options = tunnelled(TLS_FULL, { host: "qdrant.internal", port: 6333 });
    expect(options.tls?.identity).toBe("qdrant.internal");
    expect(options.origin).toEqual({ scheme: "https", host: "127.0.0.1", port: 41_001 });
  });
});

describe("the read-only source, the bounds and the query timeout", () => {
  test("read-only comes from the connection, a seed, or the execution profile, in that order", () => {
    expect(build({ readOnly: true }).readOnly).toBe("connection");
    expect(build({ readOnly: true, seedId: "s1" }).readOnly).toBe("seed");
    expect(build({ readOnly: true, seedId: "" }).readOnly).toBe("connection");
    expect(build({}, { ...CONTEXT, executionReadOnly: true }).readOnly).toBe("execution-profile");
    expect(build({ readOnly: false }, { ...CONTEXT, executionReadOnly: true }).readOnly).toBe("execution-profile");
    expect(build().readOnly).toBeUndefined();
    expect(Object.hasOwn(build(), "readOnly")).toBe(false);
    expect(refusal({ readOnly: null }).message).toBe("readOnly must be true or false.");
    expect(refusal({ readOnly: "yes" }).message).toBe("readOnly must be true or false.");
    expect(refusal({ readOnly: true, seedId: 7 }).message).toBe(
      "The connection's seedId must be a string; nothing was sent.",
    );
  });

  test("the socket bound is the in-flight bound, and the response cap is 16 MiB", () => {
    expect(build().maxSockets).toBe(QDRANT_MAX_IN_FLIGHT);
    expect(QDRANT_MAX_IN_FLIGHT).toBe(4);
    expect(build().responseCapBytes).toBe(QDRANT_RESPONSE_CAP_BYTES);
    expect(QDRANT_RESPONSE_CAP_BYTES).toBe(16_777_216);
  });

  test("the query timeout is the deadline cap, within the dialog's bound", () => {
    expect(build({}, { ...CONTEXT, queryTimeout: 5000 }).callTimeoutMs).toBe(5000);
    for (const queryTimeout of [0, 1.5, 2_147_483_648, Number.NaN]) {
      expect(refusal({}, { ...CONTEXT, queryTimeout }).message).toBe(
        "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
      );
    }
  });
});

describe("QE22: the seed stage of 3.12, after resolution, before any socket", () => {
  let undo: () => void = () => undefined;
  afterEach(() => undo());

  test("a read-only seed with no secret is refused where the type declares it; anything else passes", () => {
    undo = declareCredentialWarnings("qdrant" as DatabaseType, [SYNTHETIC_NO_SECRET, SYNTHETIC_JWT]);
    const seed = { readOnly: true, seedId: "s1", host: "127.0.0.1" };
    expect(refusal(seed).message).toBe(
      `Credential warning: ${SYNTHETIC_NO_SECRET.message} This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.`,
    );
    // A seed holding a key loads, whatever the key can do: Studio cannot tell what an opaque key allows.
    expect(build({ ...seed, password: TEST_PASSWORD }).readOnly).toBe("seed");
    // Not a seed, or a seed that is not read-only: the dialog's warning is the only reader there.
    expect(build({ readOnly: true, host: "127.0.0.1" }).readOnly).toBe("connection");
    expect(build({ seedId: "s1", host: "127.0.0.1" }).headers).toEqual({});
  });

  test("with no declaration for the type, a read-only seed without a secret passes this stage", () => {
    expect(build({ readOnly: true, seedId: "s1" }).readOnly).toBe("seed");
  });
});
