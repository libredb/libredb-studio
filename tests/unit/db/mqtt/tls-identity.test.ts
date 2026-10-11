/**
 * Verified TLS against a real socket, which is where this provider was broken (`docs/providers/mqtt.md` 4.5).
 *
 * THE SERVER NAME AND THE IDENTITY ARE TWO DIFFERENT THINGS, and conflating them made every `verify-` mode
 * unusable. Node refuses an IP literal as `servername`, so the first version substituted the unresolvable
 * `mqtt.invalid` - and Node then checked the certificate against that name as well, so a broker addressed by
 * IP failed with `ERR_TLS_CERT_ALTNAME_INVALID` however correct its IP SAN. Through an SSH tunnel it was
 * worse: the host is the local forward, so the certificate was checked against `127.0.0.1` instead of against
 * the broker at the far end.
 *
 * No unit test saw any of it, because none opened a real TLS socket. These do. The server is `node:tls` with
 * the repository's throwaway material from `tests/fixtures/tls/`, whose certificate carries
 * `DNS:localhost, IP:127.0.0.1, IP:::1` - exactly the shape a self-hosted broker presents.
 *
 * A bare TLS server is not a broker, so a connection that gets through the handshake fails on the MQTT
 * handshake instead. THAT IS THE ASSERTION: reaching "sent no CONNACK" means the certificate was accepted,
 * and a certificate error means it was not.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:tls";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import { loadTlsFixtures } from "@/../tests/helpers/tls-fixtures";
import { TUNNEL_FAR_END, type DatabaseConnection, type SSLMode } from "@/lib/types";

const tls = loadTlsFixtures();
const servers: Server[] = [];

afterAll(() => {
  for (const server of servers) server.close();
});

/** A TLS server presenting the fixture's certificate, which has both a DNS and an IP SAN. */
async function tlsServer(): Promise<number> {
  const server = createServer({ cert: tls.server.cert, key: tls.server.key }, () => {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function connection(over: Record<string, unknown>): DatabaseConnection {
  return {
    id: "mqtt-tls",
    name: "mqtt-tls",
    type: "mqtt",
    host: "127.0.0.1",
    ...over,
  } as unknown as DatabaseConnection;
}

/** What a read against a non-broker TLS server settles as, so the two outcomes are told apart by name. */
async function outcome(provider: MqttProvider): Promise<string> {
  try {
    await provider.connect();
    return "connected";
  } catch (error) {
    return (error as Error).message;
  }
}

const GOT_THROUGH = /sent no CONNACK|did not finish/;

describe("verified TLS to a broker addressed by IP", () => {
  /**
   * The case Cevheri measured: `verify-ca` and `verify-full` to `127.0.0.1`. Before the fix both failed with
   * `ERR_TLS_CERT_ALTNAME_INVALID`, because the certificate was checked against `mqtt.invalid`.
   */
  test("connects in every verifying mode, because the certificate is checked against the address", async () => {
    const port = await tlsServer();
    for (const mode of ["verify-ca", "verify-full"] as const satisfies readonly SSLMode[]) {
      const said = await outcome(new MqttProvider(connection({ port, ssl: { mode, caCert: tls.ca } })));
      if (!GOT_THROUGH.test(said)) throw new Error(`${mode} did not get past the TLS handshake: ${said}`);
      expect(said).not.toMatch(/ALTNAME|certificate|ServerName/i);
    }
  }, 30_000);

  /** `require` verifies nothing, so it got through before the fix too; it is the control, not the proof. */
  test("connects in require, which verifies nothing", async () => {
    const port = await tlsServer();
    const said = await outcome(new MqttProvider(connection({ port, ssl: { mode: "require" } })));
    expect(said).toMatch(GOT_THROUGH);
  }, 30_000);

  /**
   * AND IT STILL REFUSES THE WRONG CERTIFICATE. A fix that made verification pass by weakening it would also
   * satisfy the test above, so the other half is asserted here: the wrong CA fails, by name.
   */
  test("refuses a certificate signed by a CA the connection does not name", async () => {
    const port = await tlsServer();
    const said = await outcome(new MqttProvider(connection({ port, ssl: { mode: "verify-ca", caCert: tls.otherCa } })));
    expect(said).not.toMatch(GOT_THROUGH);
    expect(said).toMatch(/certificate/i);
  }, 30_000);

  /** A client certificate reaches the server, which is the third box the panel draws. */
  test("sends the client certificate the panel carries", async () => {
    const seen: boolean[] = [];
    const server = createServer(
      { cert: tls.server.cert, key: tls.server.key, requestCert: true, ca: tls.clientCa },
      (socket) => {
        seen.push(socket.authorized);
      },
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    await outcome(
      new MqttProvider(
        connection({
          port,
          ssl: { mode: "verify-ca", caCert: tls.ca, clientCert: tls.client.cert, clientKey: tls.client.key },
        }),
      ),
    );
    expect(seen).toEqual([true]);
  }, 30_000);
});

describe("verified TLS through an SSH tunnel", () => {
  /**
   * The far end is the identity, never the local forward. The socket dials `127.0.0.1`, and the certificate
   * must be checked against the broker's own name: the fixture's certificate carries `DNS:localhost`, so a
   * far end of `localhost` is accepted and one the certificate does not name is not.
   */
  test("checks the certificate against the far end, not against the forward", async () => {
    const port = await tlsServer();
    const said = await outcome(
      new MqttProvider(
        connection({
          port,
          ssl: { mode: "verify-full", caCert: tls.ca },
          sshTunnel: { enabled: true },
          [TUNNEL_FAR_END]: { host: "localhost", port: 8883 },
        }),
      ),
    );
    if (!GOT_THROUGH.test(said)) throw new Error(`a tunnelled verify-full did not get through: ${said}`);
  }, 30_000);

  test("and refuses a far end the certificate does not name", async () => {
    const port = await tlsServer();
    const said = await outcome(
      new MqttProvider(
        connection({
          port,
          ssl: { mode: "verify-full", caCert: tls.ca },
          sshTunnel: { enabled: true },
          [TUNNEL_FAR_END]: { host: "broker.elsewhere.test", port: 8883 },
        }),
      ),
    );
    expect(said).not.toMatch(GOT_THROUGH);
    expect(said).toMatch(/altname|Hostname|certificate/i);
  }, 30_000);
});
