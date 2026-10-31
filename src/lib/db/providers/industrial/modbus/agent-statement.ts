/**
 * The agent's reader of one Modbus read request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. The request is the console's own, in the console's three shapes, read by the console's own parser
 * (`parseReadRequest` in `request.ts`), so a request is read by one grammar wherever it is written:
 *
 *   {"read": ["name", ...]}                                   points the connection's register map names
 *   {"unit": U, "table": T, "address": A, "count": N, ...}    one block of one table, optionally decoded
 *   {"identify": "basic" | "regular" | "extended"}            the device identification objects (43/14)
 *
 * The console's schema is strict already: a key a shape does not name is refused, and the protocol's bounds (unit 1 to
 * 255, never the broadcast unit 0, an address inside the table, at most 125 registers or 2000 bits) are `checkRead`'s.
 * The admission has no connection in hand, so it reads a point name's shape only; the provider reads the same text
 * against the connection's map again before anything is sent.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the five request builders of `pdu.ts`,
 * none of which takes a function code from its caller, and the valve of `valve.ts`, which re-reads every outbound frame
 * before `socket.write` and refuses anything but the four reads and 43/14. This is what lets the model read why it was
 * refused, before anything is sent.
 */
import { ModbusRequestError } from "./pdu";
import { parseReadRequest, type ReadRequest } from "./request";

const NOTHING_SENT = "Nothing was sent.";

/** What agent mode reads on Modbus, in the words every refusal of the reader repeats. */
export const MODBUS_AGENT_READS = `Agent mode on Modbus reads with one JSON request per read, written as the console writes it: {"read": ["name", ...]} reads points the connection's register map names; {"unit": 1, "table": "holding_register", "address": 0, "count": 10} reads one block of one table (coil, discrete_input, holding_register or input_register; unit 1 to 255, at most 125 registers or 2000 bits), and may add "type", "wordOrder" and "byteOrder" to decode registers; {"identify": "basic"} reads the device identification objects (basic, regular or extended). Only Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers and Read Device Identification are ever sent, never a write.`;

export const MODBUS_AGENT_SENTENCES = {
  reads: MODBUS_AGENT_READS,
  /** `message` is the console parser's refusal; the list of reads follows it. */
  request: (message: string): string => `${message.replace(/\.$/, "")}. ${MODBUS_AGENT_READS} ${NOTHING_SENT}`,
} as const;

export type ModbusAgentReading =
  | { readonly ok: true; readonly plan: ReadRequest }
  | { readonly ok: false; readonly code: "request"; readonly message: string };

/**
 * One agent request read to the read the provider sends, or to why it sends nothing. Never sends anything.
 * `knownNames` is the connection's map, when the reader has one; `null` reads a point name's shape alone.
 */
export function readModbusAgentStatement(
  text: string,
  knownNames: ReadonlySet<string> | null = null,
): ModbusAgentReading {
  try {
    return { ok: true, plan: parseReadRequest(text, knownNames) };
  } catch (error) {
    // The console's parser and `checkRead` refuse with a ModbusRequestError only; anything else is a defect.
    if (!(error instanceof ModbusRequestError)) throw error;
    return { ok: false, code: "request", message: MODBUS_AGENT_SENTENCES.request(error.message) };
  }
}
