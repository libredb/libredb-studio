import { describe, expect, spyOn, test } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import { DatabaseConfigError } from "@/lib/db/errors";
import { KafkaError } from "@/lib/db/providers/stream/kafka/client";
import { kafkaConnectionOptions } from "@/lib/db/providers/stream/kafka/connection-options";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";

const base = {
  id: "k",
  name: "k",
  type: "kafka",
  host: "broker-1",
  port: 9092,
  createdAt: new Date(),
} as unknown as DatabaseConnection;
const withTls = (extra: Partial<DatabaseConnection>) =>
  ({ ...base, ssl: { mode: "verify-full", caCert: "CA" }, ...extra }) as DatabaseConnection;

describe("kafkaConnectionOptions", () => {
  test("no auth: host, port, no TLS, no SASL", () => {
    expect(kafkaConnectionOptions(base, 30_000)).toEqual({
      clientId: "libredb-studio",
      broker: { host: "broker-1", port: 9092 },
      timeoutMs: 30_000,
    });
  });

  test("port defaults to 9092", () => {
    expect(kafkaConnectionOptions({ ...base, port: undefined }, 1).broker.port).toBe(9092);
  });

  test("an IPv6 literal is passed without brackets, because the client takes a host and a port", () => {
    expect(kafkaConnectionOptions({ ...base, host: "::1" }, 1).broker.host).toBe("::1");
  });

  test("K1: a host or port carrying URL syntax is refused before anything else, without echoing it", () => {
    // A zone (`%lo`, `%eth0`) is the one form a weaker check would pass on to a real socket.
    for (const host of ["a:1", "a/b", "u@a", "a b", "a%25b", "::1%lo", "fe80::1%eth0"]) {
      const error = (() => {
        try {
          kafkaConnectionOptions({ ...base, host }, 1);
        } catch (thrown) {
          return thrown as Error;
        }
      })();
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error?.message).not.toContain(host);
    }
    for (const port of [0, 70000]) {
      expect(() => kafkaConnectionOptions({ ...base, port }, 1)).toThrow(DatabaseConfigError);
    }
  });

  test("K1: the address is refused before the TLS panel or the mechanism is read", () => {
    // Each of these is refused by its own rule, as a KafkaError, when the address passes.
    const rest = { ssl: "on", saslMechanism: "hunter2", user: "u", password: "p" };
    for (const address of [{ host: "a:1" }, { port: 0 }]) {
      const connection = { ...base, ...address, ...rest } as unknown as DatabaseConnection;
      expect(() => kafkaConnectionOptions(connection, 1)).toThrow(DatabaseConfigError);
    }
  });

  test("TLS maps the panel, with the Couchbase rejectUnauthorized rule", () => {
    const tls = kafkaConnectionOptions(
      { ...base, ssl: { mode: "verify-ca", caCert: "CA", clientCert: "CERT", clientKey: "KEY" } } as DatabaseConnection,
      1,
    ).tls;
    expect(tls).toEqual({ ca: "CA", cert: "CERT", key: "KEY", rejectUnauthorized: true });
    // verify-system verifies against the runtime's trust store: no CA of its own, and never unverified.
    expect(kafkaConnectionOptions({ ...base, ssl: { mode: "verify-system" } } as DatabaseConnection, 1).tls).toEqual({
      rejectUnauthorized: true,
    });
    expect(
      kafkaConnectionOptions({ ...base, ssl: { mode: "require" } } as DatabaseConnection, 1).tls?.rejectUnauthorized,
    ).toBe(false);
    expect(
      kafkaConnectionOptions(
        { ...base, ssl: { mode: "verify-full", rejectUnauthorized: false } } as DatabaseConnection,
        1,
      ).tls?.rejectUnauthorized,
    ).toBe(false);
    // The explicit flag wins in both directions: true makes require verify.
    expect(
      kafkaConnectionOptions({ ...base, ssl: { mode: "require", rejectUnauthorized: true } } as DatabaseConnection, 1)
        .tls?.rejectUnauthorized,
    ).toBe(true);
    expect(kafkaConnectionOptions({ ...base, ssl: { mode: "disable" } } as DatabaseConnection, 1).tls).toBeUndefined();
  });

  test("SNI: a DNS host over TLS sends its server name; an IP literal and a plaintext connection send none", () => {
    expect(kafkaConnectionOptions(withTls({}), 1).tlsServerName).toBe(true);
    expect(kafkaConnectionOptions(withTls({ host: "10.0.0.7" }), 1).tlsServerName).toBeUndefined();
    expect(kafkaConnectionOptions(withTls({ host: "::1" }), 1).tlsServerName).toBeUndefined();
    expect(kafkaConnectionOptions(base, 1).tlsServerName).toBeUndefined();
  });

  test("an SSH tunnel is refused, because the brokers are reached at the addresses they advertise", () => {
    const tunnelled = {
      ...base,
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password", password: "p" },
    } as DatabaseConnection;
    expect(() => kafkaConnectionOptions(tunnelled, 1)).toThrow(/SSH tunnel/);
    const off = { ...tunnelled, sshTunnel: { ...tunnelled.sshTunnel!, enabled: false } } as DatabaseConnection;
    expect(kafkaConnectionOptions(off, 1).broker.host).toBe("broker-1");
  });

  test("SASL over TLS is built from user, password and mechanism", () => {
    const options = kafkaConnectionOptions(
      withTls({ saslMechanism: "SCRAM-SHA-512", user: "reader", password: TEST_PASSWORD }),
      1,
    );
    expect(options.sasl).toEqual({ mechanism: "SCRAM-SHA-512", username: "reader", password: TEST_PASSWORD });
  });

  test("K3: SASL with TLS disabled is refused, for every mechanism", () => {
    for (const mechanism of ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"] as const) {
      expect(() => kafkaConnectionOptions({ ...base, saslMechanism: mechanism, user: "u", password: "p" }, 1)).toThrow(
        /requires TLS/,
      );
      // A TLS panel set to disable is plaintext too, which a seed file or the API can send; the
      // dialog sends no panel for it.
      expect(() =>
        kafkaConnectionOptions(
          {
            ...base,
            ssl: { mode: "disable" },
            saslMechanism: mechanism,
            user: "u",
            password: "p",
          } as DatabaseConnection,
          1,
        ),
      ).toThrow(`${mechanism} requires TLS`);
    }
  });

  test("K3: CR, LF or NUL in a credential is refused and the value never appears", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    for (const password of ["abc\n", "a\rb", "a\0b"]) {
      let message = "";
      try {
        kafkaConnectionOptions(withTls({ saslMechanism: "PLAIN", user: "u", password }), 1);
      } catch (error) {
        expect(error).toBeInstanceOf(KafkaError);
        expect((error as KafkaError).category).toBe("invalid-config");
        message = (error as Error).message;
      }
      expect(message).not.toContain(password);
      expect(message).toContain("password");
    }
    let userMessage = "";
    try {
      kafkaConnectionOptions(withTls({ saslMechanism: "PLAIN", user: "reader\n", password: "p" }), 1);
    } catch (error) {
      userMessage = (error as Error).message;
    }
    expect(userMessage).toContain("user");
    expect(userMessage).not.toContain("reader");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  test("a user or password without a mechanism is refused, not silently dropped", () => {
    expect(() => kafkaConnectionOptions({ ...base, user: "u" }, 1)).toThrow(/SASL mechanism/);
    expect(() => kafkaConnectionOptions({ ...base, password: "p" }, 1)).toThrow(/SASL mechanism/);
  });

  test("an unknown mechanism is refused", () => {
    expect(() =>
      kafkaConnectionOptions(withTls({ saslMechanism: "OAUTHBEARER" as never, user: "u", password: "p" }), 1),
    ).toThrow(/PLAIN, SCRAM-SHA-256 or SCRAM-SHA-512/);
  });
});

/**
 * A connection sent to the API reaches the options as the caller wrote it (`resolveConnection`
 * hands an inline connection on untouched), so a field can hold any JSON value. The client checks
 * none: its SCRAM step reads the user as a string inside its socket handler, where a number throws
 * past every caller, and its PLAIN step joins the credential into text, so `["reader"]` would
 * authenticate as `reader`.
 */
describe("kafkaConnectionOptions, each field as a caller may write it: another type, null, empty or a near miss", () => {
  /** The message of the refusal the options raise for this connection, which is a configuration refusal. */
  const refusalOf = (connection: unknown): string => {
    let thrown: unknown;
    try {
      kafkaConnectionOptions(connection as DatabaseConnection, 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KafkaError);
    expect((thrown as KafkaError).category).toBe("invalid-config");
    return (thrown as KafkaError).message;
  };
  const mapped = (connection: unknown) => kafkaConnectionOptions(connection as DatabaseConnection, 1);
  const TLS_ON = { mode: "verify-full", caCert: "CA" };
  const UNKNOWN_MECHANISM = "The SASL mechanism must be PLAIN, SCRAM-SHA-256 or SCRAM-SHA-512";
  /** Each value, and the text of it a message that echoed it would carry. */
  const NOT_A_STRING = [
    ["a number", 1001, "1001"],
    ["a boolean", true, "true"],
    ["an array", ["reader"], "reader"],
    ["an object", { name: "reader" }, "reader"],
  ] as const;

  test.each(
    (["user", "password"] as const).flatMap((field) =>
      (["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512", undefined] as const).flatMap((mechanism) =>
        NOT_A_STRING.map(([label, value, shown]) => [field, label, mechanism ?? "no mechanism", value, shown] as const),
      ),
    ),
  )(
    "a %s that is %s, with %s, is refused naming the field and never the value",
    (field, _label, mechanism, value, shown) => {
      const message = refusalOf({
        ...base,
        ssl: TLS_ON,
        ...(mechanism === "no mechanism" ? {} : { saslMechanism: mechanism }),
        user: "someone",
        password: TEST_PASSWORD,
        [field]: value,
      });
      expect(message).toBe(`The connection's ${field} must be a string; nothing was sent`);
      expect(message).not.toContain(shown);
    },
  );

  test("a user or password that is null reads as absent, as a JSON body writes an absent field", () => {
    expect(mapped({ ...base, user: null, password: null }).sasl).toBeUndefined();
    expect(mapped({ ...base, ssl: TLS_ON, saslMechanism: "PLAIN", user: "reader", password: null }).sasl).toEqual({
      mechanism: "PLAIN",
      username: "reader",
      password: "",
    });
  });

  /**
   * The mechanism is the one field whose null is no absence: only an absent mechanism means none. The
   * dialog's None writes no mechanism at all and a seed file's null or "" is refused when it loads, so
   * either reaches the options only from a caller who wrote it, and it is a name the list does not hold.
   */
  test.each(
    ([null, ""] as const).flatMap((mechanism) =>
      (
        [
          ["no user or password", {}],
          ["a user and a password", { user: "reader", password: TEST_PASSWORD }],
        ] as const
      ).map(([label, credential]) => [JSON.stringify(mechanism), label, mechanism, credential] as const),
    ),
  )(
    "a saslMechanism of %s with %s over TLS is refused as an unknown mechanism, never read as none",
    (_shown, _label, mechanism, credential) => {
      expect(refusalOf({ ...base, ssl: TLS_ON, saslMechanism: mechanism, ...credential })).toBe(UNKNOWN_MECHANISM);
    },
  );

  test.each([
    ["in lower case", "plain"],
    ["in mixed case", "Scram-Sha-512"],
    ["with a leading space", " PLAIN"],
    ["with a trailing space", "SCRAM-SHA-256 "],
    ["an Object.prototype member", "toString"],
    ["a number", 1],
    ["false", false],
    ["true", true],
    ["an array holding a mechanism", ["PLAIN"]],
    ["an object", {}],
  ])(
    "a saslMechanism that is %s is refused as an unknown mechanism, never matched loosely or coerced",
    (_label, mechanism) => {
      expect(
        refusalOf({ ...base, ssl: TLS_ON, saslMechanism: mechanism, user: "reader", password: TEST_PASSWORD }),
      ).toBe(UNKNOWN_MECHANISM);
    },
  );

  test("an unknown mechanism is refused before TLS is asked for, so its refusal never quotes it", () => {
    // A secret pasted into the wrong field is the value a refusal must not repeat.
    for (const mechanism of ["hunter2", null, ""]) {
      expect(refusalOf({ ...base, saslMechanism: mechanism, user: "reader", password: TEST_PASSWORD })).toBe(
        UNKNOWN_MECHANISM,
      );
    }
  });

  test.each(["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"] as const)("%s reaches the client as itself", (mechanism) => {
    const { sasl } = mapped({
      ...base,
      ssl: TLS_ON,
      saslMechanism: mechanism,
      user: "reader",
      password: TEST_PASSWORD,
    });
    expect(sasl).toEqual({ mechanism, username: "reader", password: TEST_PASSWORD });
  });

  test("a user or password with no mechanism is refused as a missing mechanism, one of spaces included", () => {
    for (const credential of [{ user: "reader" }, { password: TEST_PASSWORD }, { user: " " }, { password: " " }]) {
      expect(refusalOf({ ...base, ...credential })).toBe(
        "A Kafka user or password needs a SASL mechanism: choose PLAIN or SCRAM, or clear both fields",
      );
    }
  });

  test("the dialog's empty user and password are no credential: no SASL and no refusal", () => {
    // The dialog writes both fields for Kafka, empty when the connection authenticates with nothing.
    expect(mapped({ ...base, user: "", password: "" })).toEqual({
      clientId: "libredb-studio",
      broker: { host: "broker-1", port: 9092 },
      timeoutMs: 1,
    });
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["an array holding a host", ["broker-1"]],
  ])("a host that is %s is refused by the shared validator, never defaulted or coerced", (_label, host) => {
    expect(() => mapped({ ...base, host })).toThrow(DatabaseConfigError);
  });

  test("the client is handed the host the validator answers, an IPv6 literal without its brackets", () => {
    expect(mapped({ ...base, host: "[::1]" }).broker.host).toBe("::1");
    expect(mapped({ ...base, host: "Broker-1.Example" }).broker.host).toBe("broker-1.example");
    // A bracketed literal is an IP literal too, which is no legal server name.
    expect(mapped({ ...base, host: "[::1]", ssl: TLS_ON }).tlsServerName).toBeUndefined();
  });

  test("a null port reads as absent, so the default, and the client is handed the port the validator answers", () => {
    expect(mapped({ ...base, port: null }).broker.port).toBe(9092);
    expect(mapped({ ...base, port: "9093" }).broker.port).toBe(9093);
    expect(() => mapped({ ...base, port: "" })).toThrow(DatabaseConfigError);
  });

  test.each([
    ["true", true],
    ["false", false],
    ["a string", "require"],
    ["a number", 1],
    ["an array", [{ mode: "require" }]],
  ])("an ssl that is %s is refused, never read as a TLS panel", (_label, ssl) => {
    expect(refusalOf({ ...base, ssl })).toBe("The connection's ssl must be an object; nothing was sent");
  });

  test("an ssl that is null reads as absent: no TLS, so SASL is refused as sent in the clear", () => {
    expect(mapped({ ...base, ssl: null }).tls).toBeUndefined();
    expect(refusalOf({ ...base, ssl: null, saslMechanism: "PLAIN", user: "u", password: "p" })).toContain(
      "PLAIN requires TLS",
    );
  });

  test.each([
    ["a mode no SSLMode names", "prefer"],
    ["a mode in capitals", "REQUIRE"],
    ["a mode with a trailing space", "disable "],
    ["an Object.prototype member", "toString"],
    ["an array holding a mode", ["disable"]],
    ["a number", 1],
    ["a boolean", true],
    // Only null reads as absent: these are no mode either.
    ["an empty string", ""],
    ["false", false],
    ["zero", 0],
  ])("an ssl.mode that is %s is refused, naming the modes it may be", (_label, mode) => {
    expect(refusalOf({ ...base, ssl: { mode } })).toBe(
      "The connection's ssl.mode must be disable, require, verify-system, verify-ca or verify-full; nothing was sent",
    );
  });

  test("a TLS panel with no mode, which a seed file may carry, is read as a verifying one", () => {
    expect(mapped({ ...base, ssl: {} }).tls).toEqual({ rejectUnauthorized: true });
    expect(mapped({ ...base, ssl: { mode: null, caCert: "CA" } }).tls).toEqual({ ca: "CA", rejectUnauthorized: true });
  });

  test.each(
    (["caCert", "clientCert", "clientKey"] as const).flatMap((field) =>
      NOT_A_STRING.map(([label, value, shown]) => [field, label, value, shown] as const),
    ),
  )("an ssl.%s that is %s is refused naming the field and never the value", (field, _label, value, shown) => {
    const message = refusalOf({ ...base, ssl: { mode: "verify-ca", caCert: "CA", [field]: value } });
    expect(message).toBe(`The connection's ssl.${field} must be a string; nothing was sent`);
    expect(message).not.toContain(shown);
  });

  test.each(
    (["caCert", "clientCert", "clientKey"] as const).flatMap((field) =>
      (
        [
          ["empty", ""],
          ["null", null],
        ] as const
      ).map(([label, value]) => [field, label, value] as const),
    ),
  )("an ssl.%s that is %s is left out, as a panel with nothing pasted", (field, _label, value) => {
    expect(mapped({ ...base, ssl: { mode: "verify-ca", [field]: value } }).tls).toEqual({ rejectUnauthorized: true });
  });

  test.each([
    ["a string", "no"],
    ["a number", 0],
    ["an array", [false]],
  ])("an ssl.rejectUnauthorized that is %s is refused naming the field", (_label, rejectUnauthorized) => {
    expect(refusalOf({ ...base, ssl: { mode: "require", rejectUnauthorized } })).toBe(
      "The connection's ssl.rejectUnauthorized must be true or false; nothing was sent",
    );
  });

  test("an ssl.rejectUnauthorized that is null reads as absent, so the mode decides", () => {
    expect(mapped({ ...base, ssl: { mode: "require", rejectUnauthorized: null } }).tls?.rejectUnauthorized).toBe(false);
    expect(mapped({ ...base, ssl: { mode: "verify-full", rejectUnauthorized: null } }).tls?.rejectUnauthorized).toBe(
      true,
    );
  });

  test("the panel is checked whatever its mode, disable included", () => {
    for (const field of ["caCert", "clientCert", "clientKey"] as const) {
      expect(refusalOf({ ...base, ssl: { mode: "disable", [field]: 1001 } })).toBe(
        `The connection's ssl.${field} must be a string; nothing was sent`,
      );
    }
    expect(refusalOf({ ...base, ssl: { mode: "disable", rejectUnauthorized: "no" } })).toBe(
      "The connection's ssl.rejectUnauthorized must be true or false; nothing was sent",
    );
  });

  test.each([
    ["a string", "true"],
    ["a number", 1],
    ["an object", {}],
  ])(
    "an sshTunnel.enabled that is %s is refused, because the server opens a tunnel for any value JavaScript reads as true",
    (_label, enabled) => {
      expect(refusalOf({ ...base, sshTunnel: { enabled, host: "bastion", port: 22, username: "u" } })).toBe(
        "The connection's sshTunnel.enabled must be true or false; nothing was sent",
      );
    },
  );

  test.each([
    ["an empty string", ""],
    ["zero", 0],
  ])(
    "an sshTunnel.enabled that is %s is refused for its type too, though the server opens no tunnel for it",
    (_label, enabled) => {
      expect(refusalOf({ ...base, sshTunnel: { enabled, host: "bastion", port: 22, username: "u" } })).toBe(
        "The connection's sshTunnel.enabled must be true or false; nothing was sent",
      );
    },
  );

  test("an sshTunnel.enabled that is null reads as absent, as a tunnel switched off", () => {
    expect(mapped({ ...base, sshTunnel: { enabled: null, host: "bastion", port: 22, username: "u" } }).broker).toEqual({
      host: "broker-1",
      port: 9092,
    });
  });

  test("an sshTunnel that is null reads as absent, as no tunnel", () => {
    expect(mapped({ ...base, sshTunnel: null }).broker).toEqual({ host: "broker-1", port: 9092 });
  });

  test.each([
    ["true", true],
    ["a string", "yes"],
    ["an array", [{ enabled: true }]],
  ])(
    "an sshTunnel that is %s is refused, as an ssl that is not an object is, never read as no tunnel",
    (_label, sshTunnel) => {
      expect(refusalOf({ ...base, sshTunnel })).toBe("The connection's sshTunnel must be an object; nothing was sent");
    },
  );

  test("an enabled tunnel is refused first, before the address or anything else is read", () => {
    expect(
      refusalOf({
        ...base,
        host: "a:1",
        ssl: "on",
        saslMechanism: null,
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u" },
      }),
    ).toStartWith("Kafka does not run through an SSH tunnel");
  });
});
