/**
 * Reading the SSL / TLS panel, which this provider did not do.
 *
 * The condition was `config.ssl?.enabled === true` and `SSLConfig` carries no `enabled` - it
 * carries `mode`, and `enabled` is the SSH tunnel's word - so the branch was never taken and
 * `mbaps` was unreachable from the dialog. Six sentences in the product said otherwise: the
 * dialog's own comment ("the SSL panel turns it on"), the refusal for exception 01 ("it refused
 * the certificate's role"), the no-revocation sentence, and three lines of `docs/providers`.
 *
 * These cases are the panel, not the socket: `modbusEndpoint` is a pure step over a connection
 * record, so what the panel yields is measured without opening anything.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { modbusEndpoint } from "@/lib/db/providers/industrial/modbus/connection-options";
import type { DatabaseConnection, SSLConfig } from "@/lib/types";

const PEM = ["-----BEGIN CERTIFICATE-----", "MIIBkTCB+w==", "-----END CERTIFICATE-----"].join("\n");
const KEY = ["-----BEGIN PRIVATE KEY-----", "MIIBkTCB+w==", "-----END PRIVATE KEY-----"].join("\n");

const connection = (extra: Partial<DatabaseConnection> = {}): DatabaseConnection =>
  ({ id: "m", name: "device", type: "modbus", host: "plant.internal", port: 502, ...extra }) as DatabaseConnection;

describe("the dial target", () => {
  test("host and port as the connection gives them", () => {
    expect(modbusEndpoint(connection())).toEqual({ host: "plant.internal", port: 502 });
  });

  test("502 where no port is set, and the local device where no host is", () => {
    const endpoint = modbusEndpoint(connection({ host: undefined, port: undefined }));

    expect(endpoint).toEqual({ host: "127.0.0.1", port: 502 });
  });
});

describe("the SSL / TLS panel reaches the dial", () => {
  test("no panel is a plain mbap dial, and `tls` is absent rather than empty", () => {
    // Absent, not `{}`: the client branches on `endpoint.tls === undefined` to choose between a
    // net and a TLS socket, so an empty object would ask for a handshake with no material.
    expect(modbusEndpoint(connection())).not.toHaveProperty("tls");
  });

  test("`disable` is no TLS, not TLS that verifies nothing", () => {
    expect(modbusEndpoint(connection({ ssl: { mode: "disable" } }))).not.toHaveProperty("tls");
  });

  test("a verifying mode asks for a handshake that checks the chain", () => {
    const endpoint = modbusEndpoint(connection({ ssl: { mode: "verify-full" } }));

    expect(endpoint.tls?.rejectUnauthorized).toBe(true);
    // The host the user typed, which is what the certificate is checked against - not the address
    // the lookup returned.
    expect(endpoint.tls?.identity).toBe("plant.internal");
  });

  test("the trust anchor and the client pair are carried, which is what mbaps roles need", () => {
    // The refusal for exception 01 says a device "refused the certificate's role", so the client
    // pair is the half of the panel that sentence depends on.
    const endpoint = modbusEndpoint(
      connection({ ssl: { mode: "verify-full", caCert: PEM, clientCert: PEM, clientKey: KEY } }),
    );

    expect(endpoint.tls?.ca?.toString()).toContain("BEGIN CERTIFICATE");
    expect(endpoint.tls?.cert?.toString()).toContain("BEGIN CERTIFICATE");
    expect(endpoint.tls?.key?.toString()).toContain("BEGIN PRIVATE KEY");
  });

  test("half a client pair is refused rather than dialled with half of one", () => {
    const half = { mode: "verify-full", clientCert: PEM } as SSLConfig;

    expect(() => modbusEndpoint(connection({ ssl: half }))).toThrow(DatabaseConfigError);
  });

  test("a mode the panel does not define is refused, not read as one that verifies", () => {
    const wrong = { mode: "sometimes" } as unknown as SSLConfig;

    expect(() => modbusEndpoint(connection({ ssl: wrong }))).toThrow(DatabaseConfigError);
  });

  test("a panel with no mode verifies, which is the opposite of what the old condition did", () => {
    // MEASURED rather than assumed: the first writing of this case expected a refusal, and the
    // shared reader instead defaults the mode to `verify-full`. That default is the whole point
    // here. The old condition read `enabled` - the SSH tunnel's word, absent from `SSLConfig` -
    // and when it was missing it dialled PLAIN. A panel the user switched on now verifies even
    // when the mode is the one thing they did not set.
    const noMode = { enabled: true } as unknown as SSLConfig;

    const endpoint = modbusEndpoint(connection({ ssl: noMode }));

    expect(endpoint.tls?.rejectUnauthorized).toBe(true);
    expect(endpoint.tls?.identity).toBe("plant.internal");
  });
});
