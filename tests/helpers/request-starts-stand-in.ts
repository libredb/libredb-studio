/**
 * Stand-ins for what the request drain (src/lib/shutdown-drain.ts) reads from node:diagnostics_channel's
 * `http.server.request.start` channel: a source of request starts, the server and the response each message names.
 *
 * Bun's node:http publishes nothing on the channel (measured on Bun 1.4.4), so a unit test under Bun drives the drain
 * through this source instead: it counts subscriptions and unsubscriptions and hands each published message to every
 * handler still subscribed, synchronously, as Node.js does. The server records each `close` and
 * `closeIdleConnections` call; the response is an EventEmitter whose `end()` emits `close` once, as a finished
 * response does, and whose `abort()` emits it too, as a response whose client went away does.
 */
import { EventEmitter } from "node:events";
import type { RequestStarts } from "@/lib/shutdown-drain";

export interface RequestStartsStandIn {
  /** The source to hand the drain. */
  readonly starts: RequestStarts;
  /** How many times the drain subscribed. */
  subscriptions(): number;
  /** How many times the drain unsubscribed. */
  unsubscriptions(): number;
  /** Hands `message` to every handler still subscribed, as the channel does when a server receives a request. */
  publish(message: unknown): void;
}

/** Returns a fresh source with nothing subscribed. */
export function requestStartsStandIn(): RequestStartsStandIn {
  const handlers = new Set<(message: unknown) => void>();
  let subscribed = 0;
  let unsubscribed = 0;
  return {
    starts: (onMessage) => {
      subscribed += 1;
      const handler = (message: unknown) => onMessage(message);
      handlers.add(handler);
      return () => {
        unsubscribed += 1;
        handlers.delete(handler);
      };
    },
    subscriptions: () => subscribed,
    unsubscriptions: () => unsubscribed,
    publish(message) {
      for (const handler of [...handlers]) handler(message);
    },
  };
}

export interface StandInServer {
  close(): StandInServer;
  closeIdleConnections(): void;
  /** Every call, in order. */
  readonly calls: ("close" | "closeIdleConnections")[];
}

/** Returns a server that records each `close` and `closeIdleConnections` call. */
export function standInServer(): StandInServer {
  const calls: StandInServer["calls"] = [];
  const server: StandInServer = {
    calls,
    close() {
      calls.push("close");
      return server;
    },
    closeIdleConnections() {
      calls.push("closeIdleConnections");
    },
  };
  return server;
}

export interface StandInResponse extends EventEmitter {
  /** Ends the response as a finished one does: emits `close` once. */
  end(): void;
  /** Ends the response as one whose client went away does: emits `close` once. */
  abort(): void;
}

/** Returns a response in flight: an EventEmitter that emits `close` once, on `end()` or `abort()`. */
export function standInResponse(): StandInResponse {
  const response = new EventEmitter() as StandInResponse;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    response.emit("close");
  };
  response.end = close;
  response.abort = close;
  return response;
}

/** A message as the channel publishes it, with the two fields the drain reads. */
export function requestStart(server: StandInServer, response: StandInResponse): { server: unknown; response: unknown } {
  return { server, response };
}
