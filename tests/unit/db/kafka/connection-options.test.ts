import { describe, expect, spyOn, test } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import { DatabaseConfigError } from "@/lib/db/errors";
import { KafkaError } from "@/lib/db/providers/stream/kafka/client";
import { kafkaConnectionOptions } from "@/lib/db/providers/stream/kafka/connection-options";

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

  test("TLS maps the panel, with the Couchbase rejectUnauthorized rule", () => {
    const tls = kafkaConnectionOptions(
      { ...base, ssl: { mode: "verify-ca", caCert: "CA", clientCert: "CERT", clientKey: "KEY" } } as DatabaseConnection,
      1,
    ).tls;
    expect(tls).toEqual({ ca: "CA", cert: "CERT", key: "KEY", rejectUnauthorized: true });
    expect(
      kafkaConnectionOptions({ ...base, ssl: { mode: "require" } } as DatabaseConnection, 1).tls?.rejectUnauthorized,
    ).toBe(false);
    expect(
      kafkaConnectionOptions(
        { ...base, ssl: { mode: "verify-full", rejectUnauthorized: false } } as DatabaseConnection,
        1,
      ).tls?.rejectUnauthorized,
    ).toBe(false);
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
      withTls({ saslMechanism: "SCRAM-SHA-512", user: "reader", password: "s3cret" }),
      1,
    );
    expect(options.sasl).toEqual({ mechanism: "SCRAM-SHA-512", username: "reader", password: "s3cret" });
  });

  test("K3: SASL with TLS disabled is refused, for every mechanism", () => {
    for (const mechanism of ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"] as const) {
      expect(() => kafkaConnectionOptions({ ...base, saslMechanism: mechanism, user: "u", password: "p" }, 1)).toThrow(
        /requires TLS/,
      );
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
