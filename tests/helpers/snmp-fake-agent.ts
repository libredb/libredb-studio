/**
 * A small SNMPv2c agent over a real UDP socket, for the agent read tests: it holds a tree of instances in agent order
 * and answers a Get, a GetNext and a GetBulk the way RFC 3416 has an agent answer them, and it records every request
 * it was sent in full (PDU type, community, identifiers, non-repeaters and max-repetitions), so a test pins what left
 * the provider and not only what came back.
 *
 * It is not a model of the provider's encoder: each datagram is read with the BER reader and each answer is built
 * from the tree, so a request never sent cannot be received.
 */
import { createSocket, type Socket } from "node:dgram";
import {
  readChildren,
  readField,
  writeInteger,
  writeOctetString,
  writeOid,
  writeSequence,
} from "@/lib/db/providers/network/snmp/ber";
import { compareOid } from "@/lib/db/providers/network/snmp/objects";

export interface FakeAgentRequest {
  readonly pdu: number;
  readonly community: string;
  readonly oids: readonly string[];
  /** The PDU's second integer: error-status on a Get and a GetNext, non-repeaters on a GetBulk. */
  readonly second: number;
  /** The PDU's third integer: error-index on a Get and a GetNext, max-repetitions on a GetBulk. */
  readonly third: number;
}

export interface FakeValue {
  readonly tag: number;
  readonly bytes: Uint8Array;
}

export const text = (value: string): FakeValue => ({ tag: 0x04, bytes: new TextEncoder().encode(value) });
export const octets = (...bytes: number[]): FakeValue => ({ tag: 0x04, bytes: Uint8Array.from(bytes) });
export const integer = (value: number): FakeValue => ({ tag: 0x02, bytes: Uint8Array.of(value) });
export const ticks = (value: number): FakeValue => ({ tag: 0x43, bytes: Uint8Array.of(value) });

export interface FakeAgentOptions {
  /** Answers the n-th request (1-based) with this error-status and the request's own varbinds. */
  readonly errorStatus?: (request: number) => number;
  /** Requests (1-based) the agent does not answer at all. */
  readonly silentOn?: (request: number) => boolean;
  /** Replaces the n-th answer's varbinds, for answers no conforming agent sends. */
  readonly rewrite?: (request: number, varbinds: Array<[number[], FakeValue]>) => Array<[number[], FakeValue]>;
}

export interface FakeAgent {
  readonly port: number;
  readonly requests: FakeAgentRequest[];
  readonly close: () => void;
}

const NO_SUCH_OBJECT: FakeValue = { tag: 0x80, bytes: new Uint8Array(0) };
const END_OF_MIB_VIEW: FakeValue = { tag: 0x82, bytes: new Uint8Array(0) };

function decodeOid(bytes: Uint8Array): number[] {
  const out = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const octet of bytes.slice(1)) {
    value = value * 128 + (octet & 0x7f);
    if ((octet & 0x80) === 0) {
      out.push(value);
      value = 0;
    }
  }
  return out;
}

const integerOf = (bytes: Uint8Array): number => [...bytes].reduce((n, b) => n * 256 + b, 0);

function field(tag: number, content: Uint8Array): Uint8Array {
  const length =
    content.length < 0x80
      ? Uint8Array.of(content.length)
      : Uint8Array.of(0x82, content.length >> 8, content.length & 0xff);
  return Uint8Array.from([tag, ...length, ...content]);
}

/** Starts an agent answering from `tree`, keyed by dotted identifier. */
export async function startFakeAgent(
  tree: ReadonlyMap<string, FakeValue>,
  options: FakeAgentOptions = {},
): Promise<FakeAgent> {
  const ordered = [...tree.entries()]
    .map(([oid, value]) => [oid.split(".").map(Number), value] as [number[], FakeValue])
    .sort((a, b) => compareOid(a[0], b[0]));
  const next = (oid: readonly number[]): [number[], FakeValue] => {
    const found = ordered.find(([candidate]) => compareOid(candidate, oid) > 0);
    return found ?? [[...oid], END_OF_MIB_VIEW];
  };
  const requests: FakeAgentRequest[] = [];
  const socket: Socket = createSocket("udp4");
  socket.on("message", (datagram, from) => {
    const bytes = Uint8Array.from(datagram);
    const [, communityField, pduField] = readChildren(bytes, readField(bytes, 0));
    const pdu = readChildren(bytes, pduField);
    const asked = readChildren(bytes, pdu[3], 1000).map((entry) => {
      const oid = readChildren(bytes, entry)[0];
      return decodeOid(bytes.slice(oid.start, oid.end));
    });
    const request: FakeAgentRequest = {
      pdu: pduField.tag,
      community: new TextDecoder().decode(bytes.slice(communityField.start, communityField.end)),
      oids: asked.map((oid) => oid.join(".")),
      second: integerOf(bytes.slice(pdu[1].start, pdu[1].end)),
      third: integerOf(bytes.slice(pdu[2].start, pdu[2].end)),
    };
    requests.push(request);
    const number = requests.length;
    if (options.silentOn?.(number) === true) return;
    const status = options.errorStatus?.(number) ?? 0;
    let varbinds: Array<[number[], FakeValue]>;
    if (status !== 0) {
      varbinds = asked.map((oid) => [oid, { tag: 0x05, bytes: new Uint8Array(0) }]);
    } else if (pduField.tag === 0xa0) {
      varbinds = asked.map((oid) => [oid, tree.get(oid.join(".")) ?? NO_SUCH_OBJECT]);
    } else if (pduField.tag === 0xa1) {
      varbinds = asked.map((oid) => next(oid));
    } else {
      varbinds = [];
      let from = asked[0];
      for (let i = 0; i < request.third; i += 1) {
        const step = next(from);
        varbinds.push(step);
        if (step[1] === END_OF_MIB_VIEW) break;
        from = step[0];
      }
    }
    if (options.rewrite !== undefined) varbinds = options.rewrite(number, varbinds);
    const answer = writeSequence([
      writeInteger(1),
      writeOctetString(new TextEncoder().encode("echo")),
      writeSequence(
        [
          field(0x02, bytes.slice(pdu[0].start, pdu[0].end)),
          writeInteger(status),
          writeInteger(status === 0 ? 0 : 1),
          writeSequence(varbinds.map(([oid, value]) => writeSequence([writeOid(oid), field(value.tag, value.bytes)]))),
        ],
        0xa2,
      ),
    ]);
    socket.send(answer, from.port, from.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  let open = true;
  const close = () => {
    if (open) socket.close();
    open = false;
  };
  return { port: (socket.address() as { port: number }).port, requests, close };
}
