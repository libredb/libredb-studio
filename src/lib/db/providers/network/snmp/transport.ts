/**
 * The socket the SNMP client is given (SN-S4), and the only place its datagrams meet the valve.
 *
 * `net-snmp` takes a `dgramModule` option and calls `createSocket` on it, so this module is the
 * socket the library believes it has. Four measured facts shape it, all taken on 13 October 2026
 * under Node 24.14.0 and Bun 1.4.2, which agreed on every one.
 *
 * ONE: a UDP socket connected to its target has the kernel drop datagrams from every other
 * sender. That is the inbound half of SN-S4, and it is stronger than a check of our own because
 * the datagram never reaches this process.
 *
 * TWO: `send(buffer, port, host, callback)` on a connected socket throws
 * ERR_SOCKET_DGRAM_IS_CONNECTED, synchronously, and the callback is never called. The library
 * passes the target to every send, so handing it a connected socket unchanged would hang every
 * request: no success, no failure, no timeout. The wrapper therefore validates the target the
 * library passes and then sends without it.
 *
 * THREE: the guard belongs here, in the module the library is handed, and not in a patch on the
 * socket's own send. The library has one send call site and it is always
 * send(buffer, 0, length, port, host, cb) (`index.js:2579` of 3.29.2). A patched socket
 * nevertheless sees a second shape, send([buffer], port, host, cb), and that shape is the
 * runtime's rather than the library's: a datagram sent before the bind completes is queued, and
 * the queue is flushed by re-entering the same public send. Measured with `node:dgram` alone and
 * no SNMP code, sending before bind shows both shapes and sending after bind shows only the
 * first. So a patch on the socket inspects the same datagram twice and the shapes it sees depend
 * on a race; this facade sits above the queue and sees the library's one call. Both shapes are
 * still accepted here, and a payload list is joined before it is read, because the cost is a few
 * lines and the failure it guards against is bytes reaching the wire unread.
 *
 * FOUR: handing a guard to the socket's `lookup` option does not work. The library's socket calls
 * `lookup` for the bind address as well as the target, and a guard that refuses the bind address
 * leaves the request with no callback and no timeout, which is the same hang as TWO. So no lookup
 * is installed: the name is resolved once by the caller, every answer is checked, and the socket
 * is connected to the checked literal, which is also what the library is given as its target.
 */
import { QueryError } from "@/lib/db/errors";
import type { Socket as DgramSocket } from "node:dgram";
import { inspectOutbound, ValveRefusal, type ValveVerdict } from "./valve";

export interface GuardedTarget {
  /** An IP literal that has already been through the address checks. Never a name. */
  readonly address: string;
  readonly port: number;
}

export interface SendRecord {
  readonly bytes: number;
  readonly verdict: ValveVerdict;
}

export interface GuardedSocketOptions {
  readonly target: GuardedTarget;
  /** Injected so tests can drive the wrapper without opening a socket. */
  readonly createRawSocket: () => DgramSocket;
  /** Called for every datagram the valve passed, so the live check can count what left. */
  readonly onSend?: (record: SendRecord) => void;
}

export class EgressRefusal extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "EgressRefusal";
    Object.setPrototypeOf(this, EgressRefusal.prototype);
  }
}

/** The slice of Node's dgram socket that `net-snmp` 3.29.2 actually calls. */
/** Exported so the client can name it; the guard, not `node:dgram`, defines this surface. */
export interface ClientFacingSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(...args: unknown[]): void;
  close(callback?: () => void): void;
  address(): unknown;
  /**
   * Both of these are called. `unref()` runs right after the socket is made, and `ref()` runs
   * when the first request is registered (`index.js:2555` of 3.29.2). A facade that offers only
   * `unref` throws there, which is how this interface was found to be short: the first end to end
   * run against the real client failed on `this.dgram.ref is not a function`, and no test written
   * against a reproduction of the call shapes could have caught it.
   */
  unref(): unknown;
  ref(): unknown;
  bind(...args: unknown[]): unknown;
}

/** Everything the library may pass as a payload, joined into the bytes that would go out. */
function payloadBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => {
      if (!(part instanceof Uint8Array)) {
        throw new EgressRefusal("refused a send whose payload list holds something that is not bytes");
      }
      return part;
    });
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return joined;
  }
  throw new EgressRefusal("refused a send whose payload is neither bytes nor a list of bytes");
}

/**
 * The two shapes, read into one form. `send(buffer, offset, length, port, host, cb)` and
 * `send(payload, port, host, cb)` are both the library's, measured; anything else is refused
 * rather than guessed at, because guessing the target position is how a check ends up reading
 * a callback as a host.
 */
function readSendCall(args: readonly unknown[]): {
  bytes: Uint8Array;
  port: number;
  host: string;
  callback?: (error?: Error | null, sent?: number) => void;
} {
  const last = args[args.length - 1];
  const callback = typeof last === "function" ? (last as (error?: Error | null, sent?: number) => void) : undefined;

  if (args.length >= 5 && typeof args[1] === "number" && typeof args[2] === "number") {
    const whole = payloadBytes(args[0]);
    const offset = args[1] as number;
    const length = args[2] as number;
    if (offset < 0 || length < 0 || offset + length > whole.length) {
      throw new EgressRefusal("refused a send whose offset and length fall outside its payload");
    }
    if (typeof args[3] !== "number" || typeof args[4] !== "string") {
      throw new EgressRefusal("refused a send whose target is not a port and an address");
    }
    return { bytes: whole.subarray(offset, offset + length), port: args[3], host: args[4], callback };
  }

  if (args.length >= 3 && typeof args[1] === "number" && typeof args[2] === "string") {
    return { bytes: payloadBytes(args[0]), port: args[1], host: args[2], callback };
  }

  throw new EgressRefusal(`refused a send in a shape this wrapper does not know (${args.length} arguments)`);
}

/**
 * A socket the client may use, which can only ever reach `target` and can only ever carry a
 * read PDU it is able to read.
 *
 * `connect` is called once by `start`, and after that every send goes out without an address,
 * because a connected socket refuses one. The target the library passes is still read and
 * checked: it is the only thing that tells us the library is still aiming where we aimed it.
 */
export function createGuardedSocketFactory(options: GuardedSocketOptions): {
  dgramModule: { createSocket: (type: string) => ClientFacingSocket };
  start: () => Promise<void>;
} {
  const { target, createRawSocket, onSend } = options;
  let raw: DgramSocket | undefined;
  let connected = false;

  const facade: ClientFacingSocket = {
    on: (event, listener) => raw?.on(event as never, listener as never),
    bind: (...args) => (raw as unknown as ClientFacingSocket)?.bind(...args),
    address: () => raw?.address(),
    unref: () => raw?.unref(),
    ref: () => raw?.ref(),
    close: (callback) => raw?.close(callback),
    send: (...args: unknown[]) => {
      const call = readSendCall(args);

      if (call.port !== target.port || call.host !== target.address) {
        const refusal = new EgressRefusal(
          `refused a datagram addressed to ${call.host}:${call.port}, which is not this connection's agent at ${target.address}:${target.port}`,
        );
        if (call.callback) {
          call.callback(refusal);
          return;
        }
        throw refusal;
      }

      let verdict: ValveVerdict;
      try {
        verdict = inspectOutbound(call.bytes);
      } catch (error) {
        if (error instanceof ValveRefusal && call.callback) {
          call.callback(error);
          return;
        }
        throw error;
      }

      onSend?.({ bytes: call.bytes.length, verdict });

      // No address here, deliberately: the socket is connected, and passing one throws
      // synchronously without ever calling this callback.
      if (!connected || raw === undefined) {
        const refusal = new EgressRefusal("refused a send before the socket was connected to its checked address");
        if (call.callback) {
          call.callback(refusal);
          return;
        }
        throw refusal;
      }
      raw.send(call.bytes, (error: Error | null, sent: number) => call.callback?.(error, sent));
    },
  };

  return {
    dgramModule: {
      createSocket: () => {
        raw = createRawSocket();
        return facade;
      },
    },
    start: () =>
      new Promise<void>((resolve, reject) => {
        if (raw === undefined) {
          reject(new EgressRefusal("the client has not asked for a socket yet"));
          return;
        }
        raw.connect(target.port, target.address, () => {
          connected = true;
          resolve();
        });
      }),
  };
}
