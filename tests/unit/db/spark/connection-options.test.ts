/**
 * The Apache Spark connection's fields to the options its channel opens with: every refusal is a
 * DatabaseConfigError raised before any socket, none repeats the value it refuses, the token is never sent without
 * TLS to a host that is neither loopback nor tunnelled, an IP identity is checked through spark.invalid, and the
 * tunnel's far end is the identity and the plaintext rule's host.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  buildSparkConnectionOptions,
  SPARK_FIELD_SENTENCES,
  sparkErrorConnection,
} from "@/lib/db/providers/sql/spark/connection-options";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TOKEN = "spark-test-token";
const { ca } = loadTlsFixtures();
const base = { id: "c1", name: "spark", type: "spark", host: "spark.test" } as unknown as DatabaseConnection;
const config = (overrides: Record<string, unknown> = {}) =>
  ({ ...base, ...overrides }) as DatabaseConnection & WithTunnelFarEnd;
const build = (overrides: Record<string, unknown> = {}, queryTimeout = 60_000) =>
  buildSparkConnectionOptions(config(overrides), { queryTimeout });
const TUNNEL_ON = { sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u" } };
const TUNNELLED = {
  ...TUNNEL_ON,
  host: "127.0.0.1",
  port: 40123,
  [TUNNEL_FAR_END]: { host: "spark.remote", port: 15002 },
};

function refusal(overrides: Record<string, unknown>, queryTimeout = 60_000): DatabaseConfigError {
  try {
    build(overrides, queryTimeout);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as DatabaseConfigError).provider).toBe("spark");
    return error as DatabaseConfigError;
  }
  throw new Error("the options were built, though this case expects a refusal");
}

describe("defaults and the target", () => {
  test("a host alone: port 15002, plaintext, no token, the query timeout as the call timeout", () => {
    expect(build()).toStrictEqual({
      target: "dns:spark.test:15002",
      endpoint: { host: "spark.test", port: 15002 },
      callTimeoutMs: 60_000,
      secretForms: [],
    });
  });

  test("a port, an IPv6 host, a catalog and a namespace", () => {
    const options = build({ host: "::1", port: 15003, database: "spark_catalog", schema: "a.`b.c`" });
    expect(options.target).toBe("dns:[::1]:15003");
    expect(options.endpoint).toStrictEqual({ host: "::1", port: 15003 });
    expect(options.catalog).toBe("spark_catalog");
    expect(options.namespace).toStrictEqual(["a", "b.c"]);
  });

  test("blank optional fields read as absent", () => {
    const options = build({ user: "", password: "", database: "  ", schema: "" });
    expect(options.token).toBeUndefined();
    expect(options.catalog).toBeUndefined();
    expect(options.namespace).toBeUndefined();
    const nulls = { user: null, password: null, database: null, schema: null, ssl: null, sshTunnel: null };
    expect(build(nulls)).toStrictEqual(build());
    expect(build({ database: "\t", schema: "   " })).toStrictEqual(build());
  });

  test("a Catalog that is not blank is trimmed, then checked; a Namespace is checked as written, as the dialog checks it", () => {
    expect(build({ database: " spark_catalog " }).catalog).toBe("spark_catalog");
    expect(build({ database: "\tmy cat " }).catalog).toBe("my cat");
    expect(refusal({ database: " a.b " }).message).toBe(SPARK_FIELD_SENTENCES.catalogFormat);
    for (const schema of [" a", "a ", " a.b "]) {
      expect(refusal({ schema }).message).toBe(SPARK_FIELD_SENTENCES.namespaceFormat);
    }
  });

  test("the query timeout bounds are whole milliseconds from 1 to 2147483647", () => {
    expect(build({}, 1).callTimeoutMs).toBe(1);
    expect(build({}, 2_147_483_647).callTimeoutMs).toBe(2_147_483_647);
  });
});

describe("the token", () => {
  test("to a remote host without TLS it is refused with the shared sentence naming the token, and no opt-out", () => {
    const error = refusal({ password: TOKEN });
    expect(error.message).toContain("send its token without TLS");
    expect(error.message).not.toContain(TOKEN);
    expect(refusal({ password: TOKEN, allowInsecureAuth: true }).message).toBe(error.message);
    expect(refusal({ password: TOKEN, ssl: { mode: "disable" } }).message).toBe(error.message);
  });

  test("to loopback, over TLS and through a tunnel it is sent, and its forms are the secret forms", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) expect(build({ host, password: TOKEN }).token).toBe(TOKEN);
    const tls = build({ password: TOKEN, ssl: { mode: "verify-full", caCert: ca } });
    expect(tls.token).toBe(TOKEN);
    expect(tls.secretForms).toContain(TOKEN);
    expect(tls.secretForms).toContain(Buffer.from(TOKEN).toString("base64").replace(/=+$/, ""));
    const tunnelled = build({ ...TUNNELLED, password: TOKEN });
    expect(tunnelled.token).toBe(TOKEN);
    expect(tunnelled.target).toBe("dns:127.0.0.1:40123");
    expect(tunnelled.endpoint).toStrictEqual({ host: "spark.remote", port: 15002 });
    expect(tunnelled.secretForms).toStrictEqual(tls.secretForms);
  });

  test("a token with a line break or a NUL is refused without repeating it", () => {
    for (const password of [`${TOKEN}\n`, `a\rb`, "a\0b"]) {
      const error = refusal({ host: "127.0.0.1", password });
      expect(error.message).toBe(SPARK_FIELD_SENTENCES.tokenCharacters);
    }
    expect(refusal({ password: 42 }).message).toContain("password");
  });

  test("a token with a space at either end is refused, the all-space token included; inner spaces are kept", () => {
    for (const password of [" ", "  ", " abc", "abc "]) {
      const error = refusal({ host: "127.0.0.1", password });
      expect(error.message).toBe(SPARK_FIELD_SENTENCES.tokenCharacters);
    }
    expect(build({ host: "127.0.0.1", password: "a b" }).token).toBe("a b");
    expect(build({ host: "127.0.0.1", password: "abc" }).token).toBe("abc");
  });

  test("a token outside printable ASCII is refused with tokenCharacters, and the message never holds it", () => {
    for (const password of ["a\rb", "a\nb", "a\0b", "caf\u00e9", "a\u00a0b", "a\tb"]) {
      const error = refusal({ host: "127.0.0.1", password });
      expect(error.message).toBe(SPARK_FIELD_SENTENCES.tokenCharacters);
      expect(error.message).not.toContain(password);
    }
  });
});

describe("SPARK_FIELD_SENTENCES", () => {
  test("holds the seven field refusals word for word, frozen", () => {
    expect(Object.isFrozen(SPARK_FIELD_SENTENCES)).toBe(true);
    expect(SPARK_FIELD_SENTENCES).toStrictEqual({
      hostEmpty:
        "Host is required: the name or address of the Spark Connect server, or of the TLS proxy in front of it. Nothing was sent.",
      tokenCharacters:
        "Token takes printable ASCII with no space at either end: a gRPC header cannot carry other characters, and Spark compares the token exactly. Nothing was sent.",
      catalogFormat:
        "Catalog takes one catalog name without dots, as spark.sql.catalog.<name> names it. Nothing was sent.",
      namespaceFormat:
        "Namespace takes a Spark SQL namespace: parts joined by dots, each a letter or _ followed by letters, digits or _, or written in backticks with a backtick doubled; at most 8 parts. Nothing was sent.",
      userNotTaken:
        "Apache Spark connections take no user: every Studio request uses one fixed Spark Connect user id, and Token is the credential. Clear User. Nothing was sent.",
      tunnelNotOpened:
        "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Apache Spark was not dialled directly: the tunnel opens only when both Host and Port are set.",
      queryTimeout: "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
    });
  });
});

describe("TLS identity", () => {
  test("a name is its own identity, an IP is checked through spark.invalid, and the tunnel's far end is the identity", () => {
    const named = build({ ssl: { mode: "verify-full", caCert: ca } }).tls;
    expect(named?.identity).toBe("spark.test");
    expect(named?.serverNameOverride).toBe("spark.test");
    const ip = build({ host: "10.1.2.3", ssl: { mode: "verify-full", caCert: ca } }).tls;
    expect(ip?.identityIsIp).toBe(true);
    expect(ip?.serverNameOverride).toBe("spark.invalid");
    const tunnelled = build({ ...TUNNELLED, ssl: { mode: "verify-ca", caCert: ca } }).tls;
    expect(tunnelled?.identity).toBe("spark.remote");
  });

  test("mode disable is plaintext", () => {
    expect(build({ ssl: { mode: "disable" } }).tls).toBeUndefined();
  });

  test("the panel's own sentences name Apache Spark and are Spark's errors", () => {
    const error = refusal({ ssl: { mode: "verify-full", caCert: "not a certificate" } });
    expect(error.message).toContain("the CA that issued Apache Spark's server certificate");
  });
});

describe("the SSH tunnel", () => {
  test("a tunnel that is off, or whose switch is null, is no tunnel, and an array is no tunnel object", () => {
    expect(build({ sshTunnel: { ...TUNNEL_ON.sshTunnel, enabled: false } })).toStrictEqual(build());
    expect(build({ sshTunnel: { enabled: null } })).toStrictEqual(build());
    expect(refusal({ sshTunnel: [TUNNEL_ON.sshTunnel] }).message).toBe(
      "The connection's sshTunnel must be an object; nothing was sent.",
    );
  });

  test("the far end is read as Host and Port are: lower-cased, and refused with the shared sentences", () => {
    const farEnd = (end: { host: string; port: number }) => ({ ...TUNNELLED, [TUNNEL_FAR_END]: end });
    expect(build(farEnd({ host: "Spark.Remote", port: 15002 })).endpoint).toStrictEqual({
      host: "spark.remote",
      port: 15002,
    });
    expect(refusal(farEnd({ host: "spark.remote", port: 70000 })).message).toStartWith("Invalid port");
    expect(refusal(farEnd({ host: "spark.remote:15002", port: 15002 })).message).toStartWith(
      "Host takes a name or address only",
    );
  });
});

describe("every field refusal, before any socket", () => {
  test.each([
    ["no host", { host: undefined }, SPARK_FIELD_SENTENCES.hostEmpty],
    ["a null host", { host: null }, SPARK_FIELD_SENTENCES.hostEmpty],
    ["a blank host", { host: "   " }, SPARK_FIELD_SENTENCES.hostEmpty],
    ["a user", { user: "alice" }, SPARK_FIELD_SENTENCES.userNotTaken],
    ["a user of spaces", { user: " " }, SPARK_FIELD_SENTENCES.userNotTaken],
    ["a user that is not text", { user: 42 }, SPARK_FIELD_SENTENCES.userNotTaken],
    ["a catalog with a dot", { database: "a.b" }, SPARK_FIELD_SENTENCES.catalogFormat],
    ["a catalog with a control character", { database: "a\tb" }, SPARK_FIELD_SENTENCES.catalogFormat],
    ["a catalog of 256 characters", { database: "c".repeat(256) }, SPARK_FIELD_SENTENCES.catalogFormat],
    ["a malformed namespace", { schema: "a..b" }, SPARK_FIELD_SENTENCES.namespaceFormat],
    ["a namespace of nine parts", { schema: "a.b.c.d.e.f.g.h.i" }, SPARK_FIELD_SENTENCES.namespaceFormat],
    ["a tunnel that did not open", TUNNEL_ON, SPARK_FIELD_SENTENCES.tunnelNotOpened],
  ] as const)("%s", (_name, overrides, sentence) => {
    const error = refusal(overrides);
    expect(error.message).toBe(sentence);
  });

  test("a host with a port or a scheme gets the shared Host sentence, and a bad port the shared port sentence", () => {
    expect(refusal({ host: "spark.test:15002" }).message).not.toContain("spark.test:15002");
    expect(refusal({ host: "sc://spark.test" }).message).not.toContain("sc://");
    expect(refusal({ port: 70000 }).message).not.toContain("70000");
    // The shared sentences, re-raised as Spark's errors, never Spark's own Host sentence.
    for (const host of ["spark.test:15002", "sc://spark.test"]) {
      expect(refusal({ host }).message).toStartWith("Host takes a name or address only");
    }
    expect(refusal({ host: 42 }).message).toStartWith("Invalid host");
    expect(refusal({ port: 70000 }).message).toStartWith("Invalid port");
  });

  test.each([0, -1, 1.5, 2_147_483_648, Number.NaN])("a query timeout of %p", (queryTimeout) => {
    expect(refusal({}, queryTimeout).message).toBe(SPARK_FIELD_SENTENCES.queryTimeout);
  });

  test.each([
    ["password", { password: 42 }, "The connection's password must be a string; nothing was sent."],
    ["database", { database: 42 }, "The connection's database must be a string; nothing was sent."],
    ["schema", { schema: 42 }, "The connection's schema must be a string; nothing was sent."],
    ["sshTunnel", { sshTunnel: "on" }, "The connection's sshTunnel must be an object; nothing was sent."],
    [
      "sshTunnel.enabled",
      { sshTunnel: { enabled: "yes" } },
      "The connection's sshTunnel.enabled must be true or false; nothing was sent.",
    ],
    ["ssl", { ssl: "on" }, "The connection's ssl must be an object; nothing was sent."],
  ] as const)("a %s of the wrong type is refused by its type, naming the field", (_field, overrides, sentence) => {
    expect(refusal(overrides).message).toBe(sentence);
  });

  test("no sentence repeats the value it refuses", () => {
    for (const [overrides, value] of [
      [{ user: "alice-the-admin" }, "alice-the-admin"],
      [{ database: "secret.catalog" }, "secret.catalog"],
      [{ schema: "bad..ns" }, "bad..ns"],
    ] as const) {
      expect(refusal(overrides).message).not.toContain(value);
    }
  });
});

describe("the rules run in one fixed order, so the earlier of two refusals answers", () => {
  test.each([
    ["the tunnel before the host", TUNNEL_ON, { host: "" }],
    ["the host before the port", { host: "" }, { port: 70000 }],
    ["the port before the user", { port: 70000 }, { user: "alice" }],
    ["the user before the token", { user: "alice" }, { password: "a\nb" }],
    ["the token before the catalog", { password: "a\nb" }, { database: "a.b" }],
    ["the catalog before the namespace", { database: "a.b" }, { schema: "a..b" }],
    ["the namespace before the TLS panel", { schema: "a..b" }, { ssl: { mode: "bogus" } }],
    ["the TLS panel before the plaintext rule", { ssl: { mode: "bogus" } }, { password: TOKEN }],
  ] as const)("%s", (_name, earlier, later) => {
    const first = refusal(earlier).message;
    expect(refusal(later).message).not.toBe(first);
    expect(refusal({ ...earlier, ...later }).message).toBe(first);
  });

  test("the plaintext rule before the query timeout", () => {
    const first = refusal({ password: TOKEN }).message;
    expect(refusal({}, 0).message).not.toBe(first);
    expect(refusal({ password: TOKEN }, 0).message).toBe(first);
  });
});

describe("sparkErrorConnection", () => {
  test("the configured endpoint and the secret forms, which every sentence is worded with", () => {
    const options = build({ host: "127.0.0.1", password: TOKEN });
    expect(sparkErrorConnection(options)).toStrictEqual({
      host: "127.0.0.1",
      port: 15002,
      secretForms: options.secretForms,
    });
  });

  test("under a tunnel it names the far end, never the local forward", () => {
    const options = build(TUNNELLED);
    expect(sparkErrorConnection(options)).toStrictEqual({ host: "spark.remote", port: 15002, secretForms: [] });
  });
});
