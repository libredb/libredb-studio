/**
 * The Milvus connection (vector-family spec 5.2): E1's endpoint, E4's credentials, VF1's plaintext rule, E6's TLS
 * mode mapping and identity, the seed stage of 3.12 (E22), the read-only source, the query timeout and the secret
 * forms. Every refusal is a DatabaseConfigError raised before any client exists, and none repeats the value it
 * refuses. The TLS material checks are Task 9's half of this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  buildMilvusConnectionOptions,
  MILVUS_DEFAULT_DATABASE,
  MILVUS_DEFAULT_PORT,
  MILVUS_IP_SERVER_NAME,
  MILVUS_RECEIVE_CAP_BYTES,
  milvusErrorConnection,
} from "@/lib/db/providers/vector/milvus/connection-options";
import { secretForms } from "@/lib/db/utils/server-text";
import { type DatabaseConnection, type DatabaseType, TUNNEL_FAR_END } from "@/lib/types";
import {
  declareCredentialWarnings,
  SYNTHETIC_NO_SECRET,
  SYNTHETIC_PAIR,
  SYNTHETIC_PASSWORD,
} from "../../../helpers/synthetic-credential-warnings";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const CONTEXT = { executionReadOnly: false, queryTimeout: 30_000 };
const EXITS = [
  "Choose an SSL mode under SSL / TLS",
  "connect through an SSH tunnel",
  "if authentication is off on this server, clear the password",
];

function connection(overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "c1",
    name: "Milvus",
    type: "milvus",
    host: "milvus.test",
    port: 19530,
    createdAt: new Date(0),
    ...overrides,
  } as unknown as DatabaseConnection;
}

const build = (overrides: Record<string, unknown> = {}, context = CONTEXT) =>
  buildMilvusConnectionOptions(connection(overrides), context);

function refusal(overrides: Record<string, unknown>, context = CONTEXT): DatabaseConfigError {
  try {
    build(overrides, context);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    // Held as a string until part D registers the type-id, so the assertion types without "milvus" in DatabaseType.
    const provider: string | undefined = (error as DatabaseConfigError).provider;
    expect(provider).toBe("milvus");
    return error as DatabaseConfigError;
  }
  throw new Error("buildMilvusConnectionOptions answered, though this case must be refused");
}

const TLS_FULL = { ssl: { mode: "verify-full" } };

describe("E1: the endpoint is exactly what it claims", () => {
  test("the target is dns: and the validated host and port; 19530 by default", () => {
    expect(build().target).toBe("dns:milvus.test:19530");
    expect(build({ port: undefined }).target).toBe(`dns:milvus.test:${MILVUS_DEFAULT_PORT}`);
    expect(build().endpoint).toEqual({ host: "milvus.test", port: 19530 });
  });

  test.each(["unix", "dns", "ipv4", "ipv6"])("a host named %s stays a dns: name, never a resolver", (host) => {
    expect(build({ host }).target).toBe(`dns:${host}:19530`);
  });

  test("an IPv6 literal is bracketed in the target and bare in the endpoint, written either way", () => {
    for (const host of ["::1", "[::1]"]) {
      const options = build({ host });
      expect(options.target).toBe("dns:[::1]:19530");
      expect(options.endpoint.host).toBe("::1");
    }
  });

  test("a scheme or a port in Host is refused naming the Host field, before any client exists", () => {
    for (const host of ["http://localhost", "https://milvus.test:443", "milvus.test:19530"]) {
      expect(refusal({ host }).message).toBe(
        "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.",
      );
    }
  });

  test("an invalid port is refused in the shared validator's words, as Milvus's", () => {
    expect(refusal({ port: 70_000 }).message).toMatch(/port/i);
  });

  test("through a tunnel the target is the local forward and the endpoint the far end", () => {
    const options = buildMilvusConnectionOptions(
      {
        ...connection({ host: "127.0.0.1", port: 41_001, sshTunnel: { enabled: true } }),
        [TUNNEL_FAR_END]: { host: "milvus.internal", port: 19530 },
      },
      CONTEXT,
    );
    expect(options.target).toBe("dns:127.0.0.1:41001");
    expect(options.endpoint).toEqual({ host: "milvus.internal", port: 19530 });
  });

  test("a tunnel that is on but arrived with no far end is refused, so Milvus is never dialled past it", () => {
    expect(refusal({ sshTunnel: { enabled: true } }).message).toContain("SSH tunnel is on");
  });
});

describe("E4: credentials are validated and never echoed", () => {
  test("a line break or a NUL is refused before anything is sent, and never repeated", () => {
    for (const [field, value] of [
      ["password", "abc\n"],
      ["password", "a\rb"],
      ["user", "ro\0ot"],
    ] as const) {
      const error = refusal({ [field]: value, host: "127.0.0.1" });
      expect(error.message).toBe(
        `The connection's ${field} holds a line break or a NUL character; remove it. Nothing was sent.`,
      );
      expect(error.message).not.toContain(value);
    }
  });

  test("an empty string and null are absent", () => {
    expect(build({ user: "", password: null }).auth).toEqual({ kind: "none" });
    expect(build({ user: null, password: "" }).secretForms).toEqual([]);
  });

  test("a value that is not a string is refused naming the field, never the value", () => {
    expect(refusal({ password: 12345, host: "127.0.0.1" }).message).toBe(
      "The connection's password must be a string; nothing was sent.",
    );
  });

  test("a user name outside Milvus's rule is refused before dialling (R04 F23)", () => {
    for (const user of ["1root", "_root", "a".repeat(33), "ro ot"]) {
      expect(refusal({ user, password: TEST_PASSWORD, host: "127.0.0.1" }).message).toBe(
        "The Milvus user name must start with a letter, hold only letters, digits, _, . and -, and be at most 32 characters.",
      );
    }
    expect(build({ user: "a".repeat(32), password: TEST_PASSWORD, host: "127.0.0.1" }).auth.kind).toBe("password");
    expect(build({ user: "db_admin.ops-1", password: TEST_PASSWORD, host: "127.0.0.1" }).auth.kind).toBe("password");
  });

  test("a user with no password is sent as that user and an empty password, which is no secret (E4)", () => {
    const options = build({ user: "root", password: "", host: "milvus.example.com" });
    expect(options.auth).toEqual({ kind: "password", user: "root", password: "" });
    expect(options.principal).toBe("root");
    expect(options.secretForms).toEqual([]);
  });

  test("a user and a password are a pair; a password alone is a token (5.2)", () => {
    expect(build({ user: "root", password: TEST_PASSWORD, host: "127.0.0.1" }).auth).toEqual({
      kind: "password",
      user: "root",
      password: TEST_PASSWORD,
    });
    expect(build({ password: TEST_PASSWORD, host: "127.0.0.1" }).auth).toEqual({ kind: "token", token: TEST_PASSWORD });
  });

  test("the principal is E33's: the user, the part of a user:password token before its colon, else token", () => {
    expect(build({ user: "reader", password: TEST_PASSWORD, host: "127.0.0.1" }).principal).toBe("reader");
    expect(build({ password: `root:${TEST_PASSWORD}`, host: "127.0.0.1" }).principal).toBe("root");
    expect(build({ password: TEST_PASSWORD, host: "127.0.0.1" }).principal).toBe("token");
    expect(build({ password: `:${TEST_PASSWORD}`, host: "127.0.0.1" }).principal).toBe("token");
    expect(build().principal).toBeUndefined();
  });

  test("the secret forms cover what is sent and what a server could echo (3.9, VF9)", () => {
    expect(build({ user: "root", password: TEST_PASSWORD, host: "127.0.0.1" }).secretForms).toEqual(
      secretForms([TEST_PASSWORD, `root:${TEST_PASSWORD}`]),
    );
    expect(build({ password: `root:${TEST_PASSWORD}`, host: "127.0.0.1" }).secretForms).toEqual(
      secretForms([`root:${TEST_PASSWORD}`, TEST_PASSWORD]),
    );
    expect(build({ password: TEST_PASSWORD, host: "127.0.0.1" }).secretForms).toEqual(secretForms([TEST_PASSWORD]));
  });
});

describe("VF1 and E5: a secret never travels in the clear outside the machine", () => {
  const secret = { user: "root", password: TEST_PASSWORD };

  test.each([
    ["absent", {}],
    ["null", { ssl: null }],
    ["disable", { ssl: { mode: "disable" } }],
  ])("a secret with the TLS panel %s to a remote host is refused with all three exits", (_name, ssl) => {
    for (const host of ["milvus.example.com", "localhost.example", "128.0.0.1", "::ffff:10.0.0.1"]) {
      const message = refusal({ ...secret, ...ssl, host }).message;
      for (const exit of EXITS) expect(message).toContain(exit);
      expect(message).not.toContain(host);
    }
  });

  test.each(["127.0.0.1", "127.255.0.1", "::1", "::ffff:127.0.0.1", "localhost", "LOCALHOST"])(
    "a secret over no TLS to the loopback host %s opens",
    (host) => {
      expect(build({ ...secret, host }).auth.kind).toBe("password");
    },
  );

  test("a token alone is a secret too", () => {
    expect(refusal({ password: TEST_PASSWORD, host: "milvus.example.com" }).message).toContain(EXITS[2]);
  });

  test("a tunnel-shaped connection opens: the secret crosses the network inside SSH", () => {
    const options = buildMilvusConnectionOptions(
      {
        ...connection({ ...secret, host: "127.0.0.1", port: 41_001, sshTunnel: { enabled: true } }),
        [TUNNEL_FAR_END]: { host: "milvus.example.com", port: 19530 },
      },
      CONTEXT,
    );
    expect(options.auth.kind).toBe("password");
  });

  test("no secret opens anywhere, and TLS require opens a remote host", () => {
    expect(build({ host: "milvus.example.com" }).auth).toEqual({ kind: "none" });
    expect(build({ ...secret, host: "milvus.example.com", ssl: { mode: "require" } }).tls?.verify).toBe(false);
  });
});

describe("E6: the five SSL modes map through one record, never retried weaker", () => {
  test("disable is no TLS; require encrypts and verifies nothing; every verify mode verifies", () => {
    expect(build({ ssl: { mode: "disable" } }).tls).toBeUndefined();
    expect(build({ ssl: { mode: "require" } }).tls).toMatchObject({ mode: "require", verify: false });
    for (const mode of ["verify-system", "verify-ca", "verify-full"]) {
      expect(build({ ssl: { mode } }).tls).toMatchObject({ mode, verify: true });
    }
  });

  test("rejectUnauthorized decides when it is set, and a panel with no mode verifies", () => {
    expect(build({ ssl: { mode: "verify-full", rejectUnauthorized: false } }).tls?.verify).toBe(false);
    expect(build({ ssl: { mode: "require", rejectUnauthorized: true } }).tls?.verify).toBe(true);
    expect(build({ ssl: {} }).tls).toMatchObject({ mode: "verify-full", verify: true });
  });

  test("a mode outside SSLMode, or a panel that is not an object, is refused naming the field", () => {
    expect(refusal({ ssl: { mode: "prefer" } }).message).toBe(
      "The connection's ssl.mode must be disable, require, verify-system, verify-ca or verify-full; nothing was sent.",
    );
    expect(refusal({ ssl: "on" }).message).toBe("The connection's ssl must be an object; nothing was sent.");
  });

  test("a DNS identity is the host, set as the override; an IP identity is overridden with milvus.invalid", () => {
    expect(build(TLS_FULL).tls).toMatchObject({
      identity: "milvus.test",
      identityIsIp: false,
      serverNameOverride: "milvus.test",
    });
    expect(build({ ...TLS_FULL, host: "10.0.0.5" }).tls).toMatchObject({
      identity: "10.0.0.5",
      identityIsIp: true,
      serverNameOverride: MILVUS_IP_SERVER_NAME,
    });
    expect(build({ ...TLS_FULL, host: "[::1]" }).tls).toMatchObject({ identity: "::1", identityIsIp: true });
  });

  test("through a tunnel the TLS identity is the far end, never the local forward", () => {
    const options = buildMilvusConnectionOptions(
      {
        ...connection({ ...TLS_FULL, host: "127.0.0.1", port: 41_001, sshTunnel: { enabled: true } }),
        [TUNNEL_FAR_END]: { host: "10.0.0.5", port: 19530 },
      },
      CONTEXT,
    );
    expect(options.tls).toMatchObject({
      identity: "10.0.0.5",
      identityIsIp: true,
      serverNameOverride: MILVUS_IP_SERVER_NAME,
    });
  });

  test("a client certificate and key go together, refused in words before any channel", () => {
    expect(refusal({ ssl: { mode: "verify-full", clientCert: "x" } }).message).toBe(
      "The Client Certificate and the Client Private Key under SSL / TLS go together: add the missing one, or clear both.",
    );
    expect(refusal({ ssl: { mode: "verify-full", clientKey: "x" } }).message).toContain("go together");
  });
});

describe("the database, the read-only source and the query timeout", () => {
  test("the database defaults to default, and a name outside Milvus's rule is refused", () => {
    expect(build().database).toBe(MILVUS_DEFAULT_DATABASE);
    expect(build({ database: "probe_db" }).database).toBe("probe_db");
    expect(refusal({ database: "probe-db" }).message).toBe(
      "The Milvus database name must start with a letter or _, hold only letters, digits and _, and be at most 255 characters.",
    );
  });

  test("read-only comes from the connection, a seed, or the execution profile, in that order", () => {
    expect(build({ readOnly: true }).readOnly).toBe("connection");
    // A seed with a credential of its own, which no declared warning names, so the seed stage passes it in part D too.
    expect(
      build({ readOnly: true, seedId: "s1", host: "127.0.0.1", user: "reader", password: TEST_PASSWORD }).readOnly,
    ).toBe("seed");
    expect(build({}, { ...CONTEXT, executionReadOnly: true }).readOnly).toBe("execution-profile");
    expect(build().readOnly).toBeUndefined();
    expect(refusal({ readOnly: null }).message).toBe("readOnly must be true or false.");
  });

  test("the query timeout is the deadline cap, within the dialog's bound", () => {
    expect(build({}, { ...CONTEXT, queryTimeout: 5000 }).callTimeoutMs).toBe(5000);
    for (const queryTimeout of [0, 1.5, 2_147_483_648]) {
      expect(refusal({}, { ...CONTEXT, queryTimeout }).message).toBe(
        "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
      );
    }
    expect(build().receiveCapBytes).toBe(MILVUS_RECEIVE_CAP_BYTES);
  });

  test("the error connection names the far end, the identity and whether the runtime reports a TLS cause", () => {
    expect(milvusErrorConnection(build({ ...TLS_FULL, host: "10.0.0.5" }))).toEqual({
      host: "10.0.0.5",
      port: 19530,
      tls: { serverName: "10.0.0.5", clientCertificate: false },
      runtimeReportsTlsCause: typeof Bun === "undefined",
      receiveCapBytes: MILVUS_RECEIVE_CAP_BYTES,
      timeoutMs: 30_000,
    });
    expect(milvusErrorConnection(build()).tls).toBeUndefined();
  });
});

describe("E22: the seed stage of 3.12, after resolution, before any socket", () => {
  let undo: () => void = () => undefined;
  afterEach(() => undo());

  test("a read-only seed with a declared pair, or with no password, is refused; anything else passes", () => {
    undo = declareCredentialWarnings("milvus" as DatabaseType, [SYNTHETIC_PAIR, SYNTHETIC_NO_SECRET]);
    const seed = { readOnly: true, seedId: "s1", host: "127.0.0.1" };
    const pair = refusal({ ...seed, user: SYNTHETIC_PAIR.user, password: SYNTHETIC_PASSWORD });
    expect(pair.message).toBe(
      `Credential warning: ${SYNTHETIC_PAIR.message} This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.`,
    );
    expect(pair.message).not.toContain(SYNTHETIC_PASSWORD);
    // The pair written as one token in the password box is the same pair (3.12's colon rule).
    expect(refusal({ ...seed, password: `${SYNTHETIC_PAIR.user}:${SYNTHETIC_PASSWORD}` }).message).toStartWith(
      `Credential warning: ${SYNTHETIC_PAIR.message}`,
    );
    expect(refusal(seed).message).toStartWith(`Credential warning: ${SYNTHETIC_NO_SECRET.message}`);
    expect(build({ ...seed, user: "reader", password: TEST_PASSWORD }).readOnly).toBe("seed");
    // Not a seed, or a seed that is not read-only: the dialog's warning is the only reader there.
    expect(build({ readOnly: true, host: "127.0.0.1" }).auth).toEqual({ kind: "none" });
    expect(build({ seedId: "s1", host: "127.0.0.1" }).auth).toEqual({ kind: "none" });
  });
});
