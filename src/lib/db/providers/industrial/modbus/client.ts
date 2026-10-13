/**
 * The one socket a read opens, and the only module of this provider that imports `node:net` or
 * `node:tls`.
 *
 * WHY THE EGRESS RULE IS CALLED EXACTLY AS THE SHARED HELPER EXPECTS, AND NOT "CAREFULLY". This is
 * the shape that matters, read from `src/lib/db/http/egress-policy.ts` rather than inferred:
 *
 *   `assertPublicLiteralHost` checks the flag ITSELF and returns early when it is off (line 82).
 *   `assertPublicDnsAnswers` checks NO flag and always enforces (line 91).
 *   `guardedNodeOptions` returns `{}` when the flag is off (line 130), so the lookup is never
 *   installed and `assertPublicDnsAnswers` is never reached.
 *
 * So the flag check lives in the CALLER, and the only correct way to use the DNS guard is to let
 * `socketEgress` decide whether to hand one back. Calling `assertPublicDnsAnswers` directly, or
 * installing the lookup unconditionally, refuses every name-addressed device even with the flag
 * off. For this provider that is the common case rather than an edge: a programmable controller
 * sits on a local network and is usually addressed by name. The rule is therefore: ask
 * `socketEgress` once, and install what it returns only if it returned something.
 *
 * `refusesLinkLocal` is a CHOICE with a cost, and the cost runs the other way here than it does for
 * a broker. Passing `true` also refuses a device that lost its DHCP lease and self-assigned a
 * 169.254 address, which is a real Modbus device an operator may need to read. Passing `false`
 * leaves the IPv4 link-local range reachable, which is where a cloud instance's metadata lives.
 * This module defaults to `true`, the safer end, and takes the other as an explicit argument so the
 * decision is visible at the call site rather than buried here. Issue #1723 MB-S8 leaves it open.
 */
import { connect as netConnect, type LookupFunction, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { socketEgress } from "@/lib/db/http/egress-policy";
import { DIAL_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./constants";
import {
  FrameReader,
  matchToRequest,
  type Exchange,
  type Expectation,
  type InboundFrame,
  type Match,
} from "./framing";

/** What this module needs of a socket. Node's `Socket` and `TLSSocket` both satisfy it. */
export interface ModbusSocket {
  write(data: Uint8Array): boolean;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  setTimeout(ms: number, listener?: () => void): unknown;
  destroy(): unknown;
  readonly destroyed: boolean;
}

export interface Endpoint {
  readonly host: string;
  readonly port: number;
  readonly tls?: Record<string, unknown>;
  /** See the module comment: `true` is the safer end and refuses a self-assigned device. */
  readonly refusesLinkLocal?: boolean;
}

export class ModbusDialError extends Error {}
export class ModbusDialTimeout extends Error {}

/**
 * The socket boundary. Every failure that leaves this module leaves through here.
 *
 * WHY `ConnectionError` AND NOT `QueryError`. The test is scope, not type. A socket that errors or
 * closes has not failed one read, it has ended the connection: the next read on it cannot work
 * either, so reporting it per read would leave each surface answering "unavailable" while the
 * connection looked healthy. The Kubernetes provider's object layer states the same rule the other
 * way round, that a closed or failing connection fails every kind alike and rises.
 *
 * WHY IT IS SELECTIVE. The shared egress guard's own refusal passes through UNCHANGED, by identity,
 * so the user reads the guard's words rather than ours. A programming mistake passes through too,
 * for the reason that dressing one as a device problem sends the reader to the device.
 *
 * WHY THIS EXISTS AT ALL: the first version of this module handed `socket.on("error")` straight to
 * `reject`, so a device that reset the connection surfaced as a raw `ECONNRESET`. One of this
 * module's own tests caught it, intermittently, which is the worst way to learn it: a race decided
 * whether the suite was green.
 */
export function atSocketBoundary(error: unknown, endpoint: Endpoint): unknown {
  if (error instanceof DatabaseConfigError) return error;
  if (error instanceof ConnectionError) return error;
  if (error instanceof ModbusDialTimeout || error instanceof ModbusDialError)
    return new ConnectionError(error.message, undefined, endpoint.host, endpoint.port);
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string")
    return new ConnectionError(
      `The connection to ${endpoint.host}:${endpoint.port} failed: ${error.message}`,
      undefined,
      endpoint.host,
      endpoint.port,
    );
  return error;
}

/** The seam the tests use. A test that dialled would be a test of the network. */
export type Dialer = (endpoint: Endpoint, options?: DialOptions) => Promise<ModbusSocket>;

/**
 * How a socket is made, and how long the dial may take.
 *
 * `connect` exists because the dial timer cannot otherwise be tested for what it claims. A real
 * loopback listener connects immediately, and an unroutable address makes the test depend on the
 * network's behaviour rather than on ours. With this seam a test supplies a socket that never
 * announces itself, and the timer is measured directly. It was added after a mutation showed the
 * timer was unbound: setting it to zero left the whole suite green.
 */
export interface DialOptions {
  readonly connect?: (target: Record<string, unknown>, tls: boolean) => Socket;
  readonly dialTimeoutMs?: number;
}

/**
 * Opens one socket. One attempt, no retry: a read that may have reached a device is never sent
 * again, because a read can change a device's state (issue #1723 section 6, item 9).
 */
export const dialModbus: Dialer = (endpoint, options = {}) =>
  new Promise<ModbusSocket>((resolve, reject) => {
    const dialTimeoutMs = options.dialTimeoutMs ?? DIAL_TIMEOUT_MS;
    const make =
      options.connect ??
      ((target: Record<string, unknown>, tls: boolean) =>
        tls ? tlsConnect(target as never) : netConnect(target as never));
    let lookup: LookupFunction | undefined;
    try {
      // The shared rule decides. When the flag is off this is `undefined` and no lookup is
      // installed, which is what lets a name-addressed local device be read at all.
      lookup = socketEgress(endpoint.host, {
        refusesLinkLocal: endpoint.refusesLinkLocal ?? true,
      });
    } catch (error) {
      // The guard's own DatabaseConfigError, rethrown unchanged so the user reads its words.
      reject(error);
      return;
    }

    const target = {
      host: endpoint.host,
      port: endpoint.port,
      // TCP_NODELAY, as the messaging guide's TCP parameterization recommends: a Modbus request is
      // one small write and waiting to coalesce it only adds latency.
      noDelay: true,
      ...(lookup ? { lookup } : {}),
    };

    const socket: Socket = make(
      endpoint.tls === undefined ? target : { ...target, ...endpoint.tls },
      endpoint.tls !== undefined,
    );

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(atSocketBoundary(error, endpoint));
    };

    // The dial carries its own timer for the reason section 5.1 of the specification measured:
    // with no timer of its own, a connect to a listener that never accepts took 134 seconds.
    socket.setTimeout(dialTimeoutMs, () =>
      fail(new ModbusDialTimeout(`The device did not accept a connection within ${dialTimeoutMs} ms.`)),
    );
    socket.on("error", (error) => fail(error));
    socket.once(endpoint.tls === undefined ? "connect" : "secureConnect", () => {
      if (settled) return;
      settled = true;
      // The dial timer is replaced by the request timer: they measure different things, and a dial
      // timer left running would end a healthy connection mid-read.
      socket.setTimeout(0);
      resolve(socket);
    });
  });

/**
 * One exchange on an open socket: write one ADU, read one complete frame, bounded.
 *
 * The bound is the frame reader's, applied at the header before anything is buffered. Nothing here
 * accumulates on its own, which is the whole reason the reader exists.
 */
/**
 * `expect` IS REQUIRED, and it was optional in the first version of this function, which is the
 * fault this comment is about. Without it the first frame off the wire was resolved as the answer:
 * a late answer to a request we had already given up on would have been read as the answer to this
 * one (TCP 4.4.1.3 exists for exactly that), and a stray frame arriving in the SAME chunk as the
 * real answer would have hidden it, because only `frames[0]` was looked at. `matchToRequest` was
 * written for this, tested, and never called - an unwired name reads as a rule that holds.
 */
export function exchangeOnce(
  socket: ModbusSocket,
  adu: Buffer,
  options: { readonly expect: Expectation; readonly timeoutMs?: number; readonly endpoint?: Endpoint },
): Promise<Exchange> {
  const where = options.endpoint ?? { host: "the device", port: 0 };
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise<Exchange>((resolve, reject) => {
    const reader = new FrameReader();
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () =>
        done(() =>
          reject(atSocketBoundary(new ModbusDialTimeout(`The device did not answer within ${timeoutMs} ms.`), where)),
        ),
      timeoutMs,
    );
    socket.on("data", (chunk) => {
      let frames: InboundFrame[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        done(() => reject(atSocketBoundary(error, where)));
        return;
      }
      for (const frame of frames) {
        let match: Match;
        try {
          match = matchToRequest(frame, options.expect);
        } catch (error) {
          done(() => reject(atSocketBoundary(error, where)));
          return;
        }
        // A frame nobody asked for is dropped and the wait goes on, which is the only reading
        // under which a device that answers late does not corrupt the next read.
        if (match.kind === "discard") continue;
        done(() => resolve(match));
        return;
      }
    });
    socket.on("error", (error) => done(() => reject(atSocketBoundary(error, where))));
    socket.on("close", () =>
      done(() =>
        reject(atSocketBoundary(new ModbusDialError("The device closed the connection before answering."), where)),
      ),
    );
    socket.write(adu);
  });
}
