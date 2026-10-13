/**
 * Reading inbound frames, bounded before anything is buffered, and checked against the request.
 *
 * WHY THE BOUND COMES FIRST. MEASURED by the issue author of #1723 against the two leading npm
 * clients: `modbus-serial` 8.0.25 buffers up to 65541 bytes for a frame whose MBAP length says so,
 * and a 0xFFFF length ended only at the request timeout; `jsmodbus` 5.0.0 has no bound at all and
 * behaved the same. A Studio written reader can refuse at the header instead, which is the whole
 * reason the client is ours: the bound has to be applied before the body is read, and no package
 * measured lets a caller set one.
 *
 * WHY A STRAY TRANSACTION ID IS DISCARDED AND NOT TURNED INTO AN ERROR. TCP 4.4.1.3 says "If the
 * Transaction Identifier doesn't refer to any MODBUS pending transaction, the response must be
 * discarded." MEASURED by the issue author: `jsmodbus` fails the pending request on such a frame
 * instead, which turns another device's late answer into this request's failure.
 *
 * WHY THE BYTE COUNT IS CHECKED AGAINST THE REQUEST. A frame that echoes the function code but
 * carries the wrong number of bytes is not a short read to patch up, it is a frame we cannot
 * attribute. The caller closes the connection on any of these, because the next answer to arrive
 * may belong to the request we just gave up on.
 */
import { MBAP_HEADER_BYTES, MBAP_LENGTH_MAX, MBAP_LENGTH_MIN, PROTOCOL_ID } from "./constants";

export class ModbusFramingError extends Error {}

export interface InboundFrame {
  readonly transactionId: number;
  readonly unitId: number;
  readonly functionCode: number;
  /** The PDU after the function code. */
  readonly body: Buffer;
  readonly isException: boolean;
  readonly exceptionCode?: number;
}

/**
 * Pulls complete frames out of a growing buffer. Refuses at the header: a frame whose length field
 * is out of range is a defect in the peer, and nothing after that header is read.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** How many bytes are held. A caller asserts this does not grow with what a peer sends. */
  get buffered(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): InboundFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: InboundFrame[] = [];
    for (;;) {
      if (this.buffer.length < MBAP_HEADER_BYTES) return frames;

      const protocolId = this.buffer.readUInt16BE(2);
      if (protocolId !== PROTOCOL_ID)
        throw new ModbusFramingError(`The device sent protocol id ${protocolId}, and Modbus TCP defines only 0.`);

      const length = this.buffer.readUInt16BE(4);
      if (length < MBAP_LENGTH_MIN || length > MBAP_LENGTH_MAX)
        throw new ModbusFramingError(
          `The device sent an MBAP length of ${length}, outside the ${MBAP_LENGTH_MIN} to ${MBAP_LENGTH_MAX} a Modbus TCP frame allows. Nothing after the header was read.`,
        );

      const total = MBAP_HEADER_BYTES + length - 1;
      if (this.buffer.length < total) return frames;

      const frame = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);

      const functionCode = frame[MBAP_HEADER_BYTES] ?? 0;
      const isException = (functionCode & 0x80) !== 0;
      frames.push({
        transactionId: frame.readUInt16BE(0),
        unitId: frame[6] ?? 0,
        functionCode: isException ? functionCode & 0x7f : functionCode,
        body: Buffer.from(frame.subarray(MBAP_HEADER_BYTES + 1)),
        isException,
        exceptionCode: isException ? frame[MBAP_HEADER_BYTES + 1] : undefined,
      });
    }
  }
}

export interface Expectation {
  readonly transactionId: number;
  readonly unitId: number;
  readonly functionCode: number;
  /** Bits or registers asked for; undefined for an identification read, whose length is the device's. */
  readonly quantity?: number;
  readonly isBits?: boolean;
}

export type Match =
  | { readonly kind: "answer"; readonly frame: InboundFrame }
  | { readonly kind: "exception"; readonly code: number }
  | { readonly kind: "discard"; readonly why: string };

/**
 * Decides what one inbound frame is, against the request that is outstanding. Returns `discard` for
 * a frame nobody asked for, and throws for a frame that claims to answer this request and cannot.
 */
export function matchToRequest(frame: InboundFrame, expect: Expectation): Match {
  if (frame.transactionId !== expect.transactionId)
    return {
      kind: "discard",
      why: `A frame arrived with transaction id ${frame.transactionId} while ${expect.transactionId} was outstanding, so it was discarded.`,
    };

  if (frame.unitId !== expect.unitId)
    throw new ModbusFramingError(
      `The answer to transaction ${expect.transactionId} carried unit id ${frame.unitId} and the request asked unit ${expect.unitId}.`,
    );

  if (frame.functionCode !== expect.functionCode)
    throw new ModbusFramingError(
      `The answer to transaction ${expect.transactionId} carried function code ${frame.functionCode} and the request sent ${expect.functionCode}.`,
    );

  if (frame.isException) {
    const code = frame.exceptionCode;
    if (code === undefined) throw new ModbusFramingError(`An exception answer carried no exception code.`);
    return { kind: "exception", code };
  }

  if (expect.quantity !== undefined) {
    const declared = frame.body[0];
    const expected = expect.isBits === true ? Math.ceil(expect.quantity / 8) : expect.quantity * 2;
    if (declared !== expected)
      throw new ModbusFramingError(
        `The answer declared ${declared} byte(s) and a read of ${expect.quantity} ${expect.isBits === true ? "bits" : "registers"} must answer ${expected}.`,
      );
    if (frame.body.length - 1 !== expected)
      throw new ModbusFramingError(`The answer declared ${declared} byte(s) and carried ${frame.body.length - 1}.`);
  }

  return { kind: "answer", frame };
}
