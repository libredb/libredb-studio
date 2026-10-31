/**
 * The agent's SNMP client: the only way an agent read reaches the socket.
 *
 * It holds three requests, a Get, a GetNext and a GetBulk, RFC 3411 section 2.8's Read Class, and nothing that names
 * any other PDU type: no Set, no notification, no Response. Each one goes through the provider's own exchange
 * (`client.ts`), whose valve (`valve.ts`) parses every outgoing datagram and refuses any PDU outside the Read Class, so
 * a write would have to get past both. A GetBulk's max-repetitions is checked against the documented cap and the
 * varbinds-per-request bound before it is sent (`checkBulkRequest`), and a request carries at most the documented
 * number of identifiers.
 *
 * One client per agent read, over an exchange opened for that read alone and closed when it ends, so no socket,
 * request id or pending answer of one read reaches the next.
 */
import { randomInt } from "node:crypto";
import type { Exchange } from "./client";
import type { SnmpFailure } from "./errors";
import type { Response } from "./message";
import { checkBulkRequest } from "./statement";
import { PDU_GET, PDU_GET_BULK, PDU_GET_NEXT } from "./valve";

export interface SnmpAgentClient {
  readonly get: (oids: readonly (readonly number[])[]) => Promise<Response | SnmpFailure>;
  readonly getNext: (oids: readonly (readonly number[])[]) => Promise<Response | SnmpFailure>;
  readonly getBulk: (oid: readonly number[], maxRepetitions: number) => Promise<Response | SnmpFailure>;
}

/** A request id from `node:crypto`, as every console request takes one, so an answer cannot be guessed onto it. */
const requestId = (): number => randomInt(1, 0x7fffffff);

/** The agent's three reads over one exchange. */
export function createSnmpAgentClient(exchange: Exchange): SnmpAgentClient {
  return Object.freeze<SnmpAgentClient>({
    get: (oids) => exchange.send(PDU_GET, requestId(), oids, undefined),
    getNext: (oids) => exchange.send(PDU_GET_NEXT, requestId(), oids, undefined),
    getBulk: (oid, maxRepetitions) => {
      checkBulkRequest(0, maxRepetitions, 1);
      return exchange.send(PDU_GET_BULK, requestId(), [oid], { nonRepeaters: 0, maxRepetitions });
    },
  });
}
