/**
 * Is a Modbus server there, and are its tables the fixture's? Two questions, asked separately.
 *
 * `--speaks` asks only whether something answers MODBUS: a reply whose MBAP header echoes the
 * transaction id and the unit id, with protocol id 0 and a length that covers what arrived. An
 * exception response counts - a device that refuses is still a device.
 *
 * `--tables` asks whether the known register answers the value `docker/modbus/modbus_server.json`
 * is configured with.
 *
 * WHY TWO, when the second plainly implies the first. Not for coverage: for telling the two
 * failures apart. A run where nothing speaks Modbus has measured nothing about this repository,
 * and a run where a server speaks but answers another table's values has measured the fixture and
 * found it wrong. Collapsed into one check those arrive in the same sentence, and the reader
 * cannot tell a device that never came up from a device serving the wrong data.
 *
 * WHY NOT `/dev/tcp`. The first question used to be whether the port accepted a connection, and
 * MEASURED, against a published container port that is answered by Docker itself: 5 ms for the
 * accept against 332 ms for the server actually behind it. A published port accepts while nothing
 * inside the container is listening, so "the port is open" is not a readiness fact at all.
 *
 * Both build their frames here rather than going through `ModbusProvider`, because a readiness
 * check that runs through the thing being measured cannot tell a broken fixture from a broken
 * provider, and would name the wrong one.
 *
 * Exits 0 when its own question is answered yes, 1 otherwise, and says which it was.
 * `MODBUS_PROBE` overrides the default address.
 */
import { connect } from "node:net";

const DEFAULT_TARGET = "127.0.0.1:1502";
/** The value `docker/modbus/modbus_server.json` answers at holding register 0 (`7000 + 11 x 0`). */
const EXPECTED = 7000;
const BUDGET_MS = 3000;
const TRANSACTION = 0x4242;
const UNIT = 1;

const mode = process.argv[2];
if (mode !== "--speaks" && mode !== "--tables") {
  console.log("modbus-ready-probe: give it --speaks or --tables; nothing was dialled.");
  process.exit(2);
}

const target = process.env.MODBUS_PROBE ?? DEFAULT_TARGET;
const host = target.slice(0, target.lastIndexOf(":"));
const port = Number(target.slice(target.lastIndexOf(":") + 1));

const refuse = (sentence: string): never => {
  console.log(`modbus-ready-probe ${mode}: ${sentence}`);
  process.exit(1);
};

const socket = connect(port, host);
const giveUp = setTimeout(() => {
  socket.destroy();
  refuse(`${target} accepted a connection and answered nothing in ${BUDGET_MS} ms.`);
}, BUDGET_MS);

socket.on("error", (error: Error) => {
  clearTimeout(giveUp);
  refuse(`${target} could not be reached: ${error.message}`);
});

socket.on("connect", () => {
  // Read one holding register at address 0: function code 3, address 0, quantity 1.
  const pdu = Buffer.from([3, 0, 0, 0, 1]);
  const header = Buffer.alloc(7);
  header.writeUInt16BE(TRANSACTION, 0);
  header.writeUInt16BE(pdu.length + 1, 4);
  header[6] = UNIT;
  socket.write(Buffer.concat([header, pdu]));
});

socket.on("data", (adu: Buffer) => {
  clearTimeout(giveUp);
  socket.destroy();

  // The MBAP header, which is the part a server that speaks this protocol cannot get wrong.
  const speaks =
    adu.length >= 8 &&
    adu.readUInt16BE(0) === TRANSACTION &&
    adu.readUInt16BE(2) === 0 &&
    adu.readUInt16BE(4) === adu.length - 6 &&
    adu[6] === UNIT;
  if (!speaks) {
    refuse(`${target} answered ${adu.length} bytes that are not a Modbus reply; nothing there speaks this protocol.`);
  }
  if (mode === "--speaks") process.exit(0);

  // An exception response is a server speaking, and a fixture that refuses the read it was built
  // to answer: the first question passes it, this one must not.
  if ((adu[7] ?? 0) & 0x80) {
    refuse(`${target} refused the read with exception ${adu[8]}; its tables are not loaded.`);
  }
  const answered = adu.length >= 11 ? adu.readUInt16BE(9) : -1;
  if (answered !== EXPECTED) {
    refuse(`${target} answered ${answered} at holding register 0, wanted ${EXPECTED}; this is not the fixture.`);
  }
  process.exit(0);
});
