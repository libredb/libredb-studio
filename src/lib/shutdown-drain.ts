/**
 * The request drain: where Studio's shutdown handler owns the exit (src/lib/shutdown-handler.ts), it closes the HTTP
 * server and waits for the requests in flight before the shutdown hooks run, so the query events those requests record
 * are in the hooks' flush (docs/DISTRIBUTION.md#stopping-the-server).
 *
 * - Why it exists. With `NEXT_MANUAL_SIG_HANDLE` set, Next.js's `startServer` (`next/dist/server/lib/start-server.js`)
 *   installs no signal handler, so nothing closes its HTTP server or waits for the requests in flight. Next.js offers
 *   no documented way to reach that server or to drain it, and the standalone output rules out a custom server.
 * - How it learns the servers and the requests. node:diagnostics_channel's built-in `http.server.request.start`
 *   channel publishes one message per request a node:http server receives, naming the `request`, the `response`, the
 *   `socket` and the `server`. Node.js 24 and 26 document the module as stable and the HTTP channels as Stability 1
 *   Experimental, so tests/unit/lib/shutdown-drain-runtimes.test.ts watches the channel on Node 24 and on the Node
 *   release the images ship, in the required CI job. A message without the server or the response the drain uses
 *   throws an Error naming the channel; node:diagnostics_channel raises an error thrown by a subscriber as an uncaught
 *   exception, so the uncaught-exception exit ends the process with 70 at the first request of a release whose channel
 *   changed shape. There is no degraded mode. A release that renamed the channel or stopped publishing on it would
 *   deliver nothing: the runtime test fails on it, and the handler's start line shows `servers=0` on a running server.
 * - What it does. `trackRequests()` subscribes at once and keeps every server it has seen and every response in
 *   flight until the response's `close`, which a finished response and one whose client went away both emit.
 *   `drain()` gives each response in flight whose headers have not gone out `Connection: close`, and so does every
 *   request that starts from then on, so Node.js ends that connection after the answer whatever the client has begun
 *   sending on it. It calls `server.close()` on every server seen, which refuses new connections and closes the idle
 *   ones; from then on each tracked response that closes calls `closeIdleConnections()` on its own server, so a
 *   kept-alive connection whose answer's headers went out before the drain ends with its last answer too. It settles
 *   once no response is in flight, a request that started during the drain on a connection already open included,
 *   or after `DRAIN_DEADLINE_MS`, warning with the count still in flight. It runs once per tracker and never rejects.
 *   `tracked()` goes on counting until `stop()`, so the handler reads at the exit what is still in flight.
 * - Limits. A request that reached a server before the subscription, in the first fraction of a second of the boot,
 *   is not seen. A server that has received no request since the subscription is not known, so it keeps accepting
 *   connections until the exit. A response still running at the deadline keeps running until the exit cuts it.
 *   Busy connections are never cut: `closeAllConnections()` would only move the cut earlier. A connection whose next
 *   request has begun at the drain, part of its headers or its first byte received, is not idle by Node.js's
 *   definition, so neither `close()` nor `closeIdleConnections()` ends it: it serves that one request, with
 *   `Connection: close`, even after the drain has settled. On Node.js 24 so does an accepted connection that has sent
 *   nothing yet, which Node.js 26 closes at `close()`. tests/unit/lib/shutdown-drain-runtimes.test.ts holds the begun
 *   request on every listed Node. A WebSocket upgrade is not a response, and Studio serves none.
 * - Node only. Bun's node:http publishes nothing on the channel (measured on Bun 1.4.4), so on Bun the drain would see
 *   no server and no request. The server runs on Bun under `bun --bun run start` and `bunx --bun`, and under
 *   `bun start` and `bunx` on a host without Node.js, since package.json `start` and bin/studio.js spawn
 *   `process.execPath`; `exitOwnerAtBoot()` in src/lib/shutdown-handler.ts refuses Studio's exit there.
 * - Test seam: `trackRequests()` takes the source of request starts, so a unit test under Bun hands it a stand-in
 *   (tests/helpers/request-starts-stand-in.ts), and `stop()` unsubscribes.
 */
import diagnostics_channel from "node:diagnostics_channel";
import { logger } from "@/lib/logger";

/** The built-in node:diagnostics_channel channel the drain reads, published once per request a server receives. */
export const REQUEST_START_CHANNEL = "http.server.request.start";

/** How long the drain waits for the requests in flight. */
export const DRAIN_DEADLINE_MS = 5000;

/** Subscribes a message handler to the request starts, and returns the function that unsubscribes it. */
export type RequestStarts = (onMessage: (message: unknown) => void) => () => void;

/** The request starts of node:diagnostics_channel's `http.server.request.start` channel. */
export const nodeRequestStarts: RequestStarts = (onMessage) => {
  const handler = (message: unknown): void => onMessage(message);
  diagnostics_channel.subscribe(REQUEST_START_CHANNEL, handler);
  return () => {
    diagnostics_channel.unsubscribe(REQUEST_START_CHANNEL, handler);
  };
};

/** How a drain ended: how many servers it closed, and how many responses were still in flight at the deadline. */
export interface DrainOutcome {
  readonly servers: number;
  readonly cut: number;
}

export interface RequestDrain {
  /** The servers seen and the responses in flight now. */
  tracked(): { servers: number; inFlight: number };
  /** Closes every server seen and waits for the responses in flight; once per tracker, a later call joins the run. */
  drain(): Promise<DrainOutcome>;
  /** Unsubscribes. */
  stop(): void;
}

/** The part of a node:http server the drain uses. */
interface DrainServer {
  close(): unknown;
  closeIdleConnections(): void;
}

/** The part of a node:http response the drain uses. */
interface DrainResponse {
  once(event: "close", listener: () => void): unknown;
  readonly headersSent: boolean;
  setHeader(name: string, value: string): unknown;
}

function malformed(): Error {
  return new Error(
    `A message on ${REQUEST_START_CHANNEL} has no server with close() and closeIdleConnections() or no response with once(), setHeader() and headersSent: the experimental channel changed in this Node.js release (src/lib/shutdown-drain.ts)`,
  );
}

/**
 * Asks Node.js to end the response's connection once the response ends, whatever the client has begun sending on it
 * since (RFC 9112 section 9.6); a response whose headers have gone out keeps them.
 */
function closeWithAnswer(response: DrainResponse): void {
  if (!response.headersSent) response.setHeader("Connection", "close");
}

/** The server and the response a message names, or an Error naming the channel when either is not what it uses. */
function fieldsOf(message: unknown): { server: DrainServer; response: DrainResponse } {
  if (typeof message !== "object" || message === null) throw malformed();
  const { server, response } = message as { server?: Partial<DrainServer>; response?: Partial<DrainResponse> };
  if (
    typeof server?.close !== "function" ||
    typeof server.closeIdleConnections !== "function" ||
    typeof response?.once !== "function" ||
    typeof response.setHeader !== "function" ||
    typeof response.headersSent !== "boolean"
  ) {
    throw malformed();
  }
  return { server: server as DrainServer, response: response as DrainResponse };
}

/** Subscribes to the request starts at once and answers the drain over the servers and responses they name. */
export function trackRequests(starts: RequestStarts = nodeRequestStarts): RequestDrain {
  const servers = new Set<DrainServer>();
  const inFlight = new Set<DrainResponse>();
  let draining = false;
  let drained: () => void = () => {};
  let run: Promise<DrainOutcome> | undefined;

  const unsubscribe = starts((message) => {
    const { server, response } = fieldsOf(message);
    servers.add(server);
    inFlight.add(response);
    if (draining) closeWithAnswer(response);
    response.once("close", () => {
      inFlight.delete(response);
      if (!draining) return;
      server.closeIdleConnections();
      if (inFlight.size === 0) drained();
    });
  });

  async function drainAll(): Promise<DrainOutcome> {
    draining = true;
    const closed = servers.size;
    for (const response of inFlight) closeWithAnswer(response);
    for (const server of servers) server.close();
    if (inFlight.size > 0) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        drained = resolve;
        deadline = setTimeout(resolve, DRAIN_DEADLINE_MS);
      });
      clearTimeout(deadline);
    }
    const cut = inFlight.size;
    if (cut > 0) logger.warn("Requests in flight cut at the drain deadline", { route: "shutdown", pending: cut });
    return { servers: closed, cut };
  }

  return {
    tracked: () => ({ servers: servers.size, inFlight: inFlight.size }),
    drain() {
      run ??= drainAll();
      return run;
    },
    stop: unsubscribe,
  };
}
