/**
 * `mbaps` against a real TLS endpoint, which this provider could not reach.
 *
 * WHAT WAS MEASURED, AND WHY THESE THREE CASES. A reviewer stood up a stunnel endpoint with a
 * private CA and ran the dialog against it three times: plain TCP answered five rows with 7000 on
 * screen; the same device over `mbaps`, with the CA pasted into the panel, answered none and said
 * `read ECONNRESET`; and a correct client against that same endpoint read
 * `7000, 7011, 7022, 7033, 7044`. The third reading is what made it a product defect rather than a
 * broken fixture: the endpoint was sound and the product could not reach it.
 *
 * `read ECONNRESET` is also the symptom that says WHICH defect it was. The provider tested
 * `config.ssl?.enabled`, a field `SSLConfig` does not have, so the branch was never taken and
 * plain Modbus bytes went to a TLS listener, which resets. An empty `tls: {}` would have failed
 * differently - a handshake that cannot verify - and the distinction is the reason the fourth case
 * below asserts the symptom and not just the failure.
 *
 * The CA here signed the certificate for `localhost`, `127.0.0.1` and `::1`, so the host the panel
 * is checked against is the host the test dials.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { Socket } from "node:net";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import { loadTlsFixtures } from "../../helpers/tls-fixtures";
import type { DatabaseConnection, SSLConfig } from "@/lib/types";

const TLS = loadTlsFixtures();
const holding = (address: number): number => 7000 + 11 * address;
const servers: (TlsServer | NetServer)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Answers function 3 the way a device does, and nothing else: these cases are about the transport. */
function answer(socket: Socket, adu: Buffer): void {
  const transactionId = adu.readUInt16BE(0);
  const unitId = adu[6] ?? 0;
  const address = adu.readUInt16BE(8);
  const quantity = adu.readUInt16BE(10);
  const body = Buffer.alloc(quantity * 2);
  for (let at = 0; at < quantity; at += 1) body.writeUInt16BE(holding(address + at), at * 2);
  const pdu = Buffer.concat([Buffer.from([3, body.length]), body]);
  const head = Buffer.alloc(7);
  head.writeUInt16BE(transactionId, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(pdu.length + 1, 4);
  head[6] = unitId;
  socket.write(Buffer.concat([head, pdu]));
}

async function listening(server: TlsServer | NetServer): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the device did not take a port");
  return address.port;
}

/** A device that speaks Modbus over TLS, as `mbaps` does. */
const mbapsDevice = (): Promise<number> =>
  listening(
    createTlsServer({ cert: TLS.server.cert, key: TLS.server.key }, (socket) => {
      socket.on("data", (adu: Buffer) => answer(socket, adu));
      socket.on("error", () => undefined);
    }),
  );

/** The same device with no TLS, which is the control. */
const mbapDevice = (): Promise<number> =>
  listening(
    createNetServer((socket) => {
      socket.on("data", (adu: Buffer) => answer(socket, adu));
      socket.on("error", () => undefined);
    }),
  );

const read = (port: number, ssl?: SSLConfig) =>
  new ModbusProvider({
    id: "m",
    name: "device",
    type: "modbus",
    host: "127.0.0.1",
    port,
    ...(ssl === undefined ? {} : { ssl }),
  } as DatabaseConnection).query('{"unit":1,"table":"holding_register","address":0,"count":5}');

describe("mbaps, against a device that really speaks TLS", () => {
  test("the control: plain TCP with no panel answers five rows", async () => {
    const port = await mbapDevice();

    const result = await read(port);

    expect(result.rows).toHaveLength(5);
    expect(result.rows.map((row) => row.value)).toEqual([7000, 7011, 7022, 7033, 7044]);
  });

  test("the panel's CA reaches the handshake, and the same five rows come back over TLS", async () => {
    const port = await mbapsDevice();

    const result = await read(port, { mode: "verify-ca", caCert: TLS.ca });

    expect(result.rows).toHaveLength(5);
    expect(result.rows.map((row) => row.value)).toEqual([7000, 7011, 7022, 7033, 7044]);
  });

  test("a CA that signed nothing here is refused, and the sentence is about the certificate", async () => {
    // The positive control's mirror: the transport works, so what this measures is that the panel's
    // trust anchor is actually APPLIED rather than carried and ignored. A provider that passed an
    // empty material would verify against the system store and fail here too - but it would fail
    // for every CA alike, including the right one, which the case above rules out.
    const port = await mbapsDevice();

    const error = await read(port, { mode: "verify-ca", caCert: TLS.otherCa }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/certificate|self.signed|unable to (verify|get)/i);
  });

  test("no panel against a TLS device is the defect's own symptom: a reset, not a handshake failure", async () => {
    // This is what the reviewer saw, and it is the reading that named the cause: with the panel
    // unread, Modbus bytes go to a TLS listener and the listener resets. Keeping it as a case means
    // the next hand who makes the provider stop reading the panel sees the same sentence the user
    // saw, rather than a generic failure.
    const port = await mbapsDevice();

    const error = await read(port).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/certificate/i);
  });
});
