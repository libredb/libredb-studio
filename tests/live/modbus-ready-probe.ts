/**
 * Is the Modbus fixture ANSWERING, not merely listening?
 *
 * The readiness check in `docker/modbus/ci-step.yml` asks two independent questions, and this is
 * the second. The first is that the port accepts a connection, which is not enough on its own:
 * MEASURED, a listener that accepts TCP and answers nothing passes it, so a fixture with no data
 * behind it would be called ready and the live check that followed would fail for a reason that
 * reads like a product defect.
 *
 * It builds the frame by hand rather than going through `ModbusProvider`, because a readiness
 * check that goes through the thing being measured cannot tell a broken fixture from a broken
 * provider, and would name the wrong one.
 *
 * Exits 0 when the device answers the fixture's first holding register, 1 otherwise, and says
 * which of the two it was. `MODBUS_PROBE` overrides the default address.
 */
import { connect } from "node:net";

const DEFAULT_TARGET = "127.0.0.1:1502";
/** The value `docker/modbus/modbus_server.json` answers at holding register 0 (`7000 + 11 x 0`). */
const EXPECTED = 7000;
const BUDGET_MS = 3000;

const target = process.env.MODBUS_PROBE ?? DEFAULT_TARGET;
const host = target.slice(0, target.lastIndexOf(":"));
const port = Number(target.slice(target.lastIndexOf(":") + 1));

const socket = connect(port, host);
const giveUp = setTimeout(() => {
  console.log(`modbus-ready-probe: ${target} accepted a connection and answered nothing in ${BUDGET_MS} ms.`);
  socket.destroy();
  process.exit(1);
}, BUDGET_MS);

socket.on("error", (error: Error) => {
  clearTimeout(giveUp);
  console.log(`modbus-ready-probe: ${target} could not be reached: ${error.message}`);
  process.exit(1);
});

socket.on("connect", () => {
  // Read one holding register at address 0: function code 3, address 0, quantity 1.
  const pdu = Buffer.from([3, 0, 0, 0, 1]);
  const header = Buffer.alloc(7);
  header.writeUInt16BE(0x4242, 0);
  header.writeUInt16BE(pdu.length + 1, 4);
  header[6] = 1;
  socket.write(Buffer.concat([header, pdu]));
});

socket.on("data", (adu: Buffer) => {
  clearTimeout(giveUp);
  socket.destroy();
  // 7 bytes of MBAP, then the function code and the byte count, then the register.
  const answered = adu.length >= 11 ? adu.readUInt16BE(9) : -1;
  if (answered !== EXPECTED) {
    console.log(`modbus-ready-probe: ${target} answered ${answered}, wanted ${EXPECTED}; its tables are not loaded.`);
    process.exit(1);
  }
  process.exit(0);
});
