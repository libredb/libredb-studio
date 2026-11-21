/**
 * The two library calls `dialNetconf` needs, against the real Node runtime and the real ssh2.
 *
 * Everything that decides anything lives in `dial.ts` and is tested without a network. This file
 * holds only the parts that cannot be: opening a TCP socket, running the SSH handshake, and
 * turning ssh2's channel into the byte transport the session reads. It is kept separate so that
 * the rules above it stay measurable, and so this file has nothing in it to get wrong except the
 * two things below, which are easy to get wrong and are written out for that reason.
 */
import { connect as netConnect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { Client } from "ssh2";
import type { SocketPort, SshPort, SshSession } from "./dial";
import type { Transport } from "./session";

export const nodeSocketPort: SocketPort = {
  connect: (options): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = netConnect({
        host: options.host,
        port: options.port,
        noDelay: options.noDelay,
        // The egress policy's lookup, when it answered one, checks the addresses and hands the
        // checked one to the socket, so the address dialled is the address checked.
        ...(options.lookup === undefined ? {} : { lookup: options.lookup as never }),
      });
      const onError = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        // ssh2 takes the socket from here and installs its own error handling. Leaving this
        // listener attached would make a later socket error settle a promise that is already
        // settled; removing it would leave the socket with no 'error' listener at all, which
        // in Node throws. So it is replaced rather than removed.
        socket.removeListener("error", onError);
        socket.on("error", () => {});
        resolve(socket);
      });
    }),
};

/**
 * One NETCONF channel as the session's transport.
 *
 * The decoder is the point of this function. ssh2 delivers bytes, and a NETCONF reply holds UTF-8:
 * a device name or a description can carry a character whose bytes land in two different TCP
 * segments. `chunk.toString("utf8")` on each segment turns that character into two replacement
 * characters, and the reply still parses, so nothing fails and the value is simply wrong.
 * `StringDecoder` holds an incomplete sequence back until its remaining bytes arrive.
 */
export interface ChannelLike {
  write(text: string, encoding: "utf8"): unknown;
  on(event: "data", handler: (chunk: Buffer) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  once(event: "close", handler: () => void): unknown;
  end(): unknown;
  /** The channel's error stream, a stream of its own that can fail on its own. */
  readonly stderr: { on(event: "error", handler: (error: Error) => void): unknown };
}

export interface ClientLike {
  once(event: "close", handler: () => void): unknown;
  end(): unknown;
}

export function transportOf(channel: ChannelLike, client: ClientLike): Transport {
  const decoder = new StringDecoder("utf8");
  // The channel and its error stream are both streams, and an `error` event with no listener is
  // thrown out of the emitter. ssh2 1.17.0 emits none on the channel, because it overrides the
  // stream's own `destroy()`, but the error stream keeps the stream's own: data the device sends on
  // it after the channel's end fails it. So both are listened to from the moment the transport
  // exists, which is inside ssh2's subsystem callback, and not from the session's subscription,
  // which runs later, in a promise continuation after the dial resolves. A failure that arrives
  // before the session listens is kept, the first one, and handed over a microtask after it
  // subscribes, once its hello wait is set up. The session ends with it as a named error.
  let failed: ((error: Error) => void) | null = null;
  let early: Error | null = null;
  const fail = (error: Error): void => {
    if (failed !== null) failed(error);
    else early ??= error;
  };
  channel.on("error", fail);
  channel.stderr.on("error", fail);
  return {
    write: (text) => void channel.write(text, "utf8"),
    onData: (handler) => {
      channel.on("data", (chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (text !== "") handler(text);
      });
    },
    onClose: (handler) => {
      // Either end can go first: the channel closes when the device ends the session, and the
      // client closes when the connection drops under it. The session has to hear both, and it
      // treats a second close as the same close.
      channel.once("close", handler);
      client.once("close", handler);
    },
    onError: (handler) => {
      // The client's own errors have a listener for life in `nodeSshPort` below.
      failed = handler;
      const kept = early;
      if (kept !== null) queueMicrotask(() => handler(kept));
    },
    close: () => {
      channel.end();
      client.end();
    },
  };
}

export const nodeSshPort: SshPort = {
  connect: (options): SshSession => {
    const client = new Client();
    // ssh2 reads the private key before it takes the socket, and throws from here when it cannot
    // read it. The socket was dialled for this client and nothing else will close it, so it is
    // closed before the throw reaches the dial, which reports it as a configuration error.
    try {
      client.connect({
        sock: options.sock as never,
        username: options.username,
        readyTimeout: options.readyTimeout,
        ...(options.password === undefined ? {} : { password: options.password }),
        ...(options.privateKey === undefined ? {} : { privateKey: options.privateKey }),
        ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
        hostVerifier: options.hostVerifier,
        // No agent, no keyboard-interactive and no host-based authentication: the connection's own
        // credential is the only one offered, so nothing on the machine running Studio can be
        // substituted for it (Y-S5, a security decision has one path).
        tryKeyboard: false,
      });
    } catch (error) {
      (options.sock as Socket).destroy();
      throw error;
    }
    return {
      onReady: (handler) => void client.once("ready", handler),
      // `on` and not `once`, which is a defect this fixed rather than a preference. MEASURED on a
      // port that listens and never speaks: the dial's deadline rejects, and ssh2 then raises
      // "Connection lost before handshake" on the same client a moment later. With a one-shot
      // listener that second error has nobody to go to, so it surfaced as an unhandled error from
      // inside `ssh2/lib/protocol/utils.js` - a refusal that was already answered correctly,
      // leaving a crash behind it. The dial's own handler ignores anything after it has settled,
      // so the extra deliveries cost nothing and the process stays quiet.
      onError: (handler) => void client.on("error", handler),
      subsystem: (name, handler) => {
        client.subsys(name, (error, channel) => {
          if (error || channel === undefined) {
            handler(error ?? new Error("the device opened no channel for this subsystem"), null);
            return;
          }
          handler(null, transportOf(channel, client));
        });
      },
      end: () => void client.end(),
    };
  },
};
