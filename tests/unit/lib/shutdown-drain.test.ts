/**
 * The request drain (src/lib/shutdown-drain.ts): it learns the HTTP servers and the responses in flight from
 * node:diagnostics_channel's `http.server.request.start` channel, and at the shutdown closes the servers to new
 * connections and waits at most `DRAIN_DEADLINE_MS` for the responses in flight (docs/DISTRIBUTION.md#stopping-the-server).
 *
 * Bun publishes nothing on the channel, so every case but the first drives the drain through a stand-in source
 * (tests/helpers/request-starts-stand-in.ts); the channel itself is watched on Node by
 * tests/unit/lib/shutdown-drain-runtimes.test.ts. The deadline runs on fake timers, and a case settles the drain's
 * promise with a plain await before it asserts, never with a timer-settled promise assertion.
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import diagnostics_channel from "node:diagnostics_channel";
import { logger } from "@/lib/logger";
import { DRAIN_DEADLINE_MS, REQUEST_START_CHANNEL, type RequestDrain, trackRequests } from "@/lib/shutdown-drain";
import {
  requestStart,
  requestStartsStandIn,
  standInResponse,
  standInServer,
} from "../../helpers/request-starts-stand-in";

let spies: ReturnType<typeof spyOn>[] = [];
let drains: RequestDrain[] = [];

/** A drain on a fresh stand-in source, stopped after the case. */
function tracker() {
  const source = requestStartsStandIn();
  const drain = trackRequests(source.starts);
  drains.push(drain);
  return { source, drain };
}

/** Lets every pending promise settle, over a few turns: bun's fake timers leave setImmediate real. */
function settle(turns = 3): Promise<void> {
  return new Promise((resolve) => setImmediate(() => (turns > 1 ? settle(turns - 1).then(resolve) : resolve())));
}

beforeEach(() => {
  spies = (["error", "warn", "info"] as const).map((level) => spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(() => {
  jest.useRealTimers();
  for (const drain of drains) drain.stop();
  drains = [];
  for (const spy of spies) spy.mockRestore();
});

describe("trackRequests", () => {
  test("subscribes to http.server.request.start once, and stop() unsubscribes", () => {
    expect(REQUEST_START_CHANNEL).toBe("http.server.request.start");
    const { source, drain } = tracker();
    expect(source.subscriptions()).toBe(1);
    expect(source.unsubscriptions()).toBe(0);
    drain.stop();
    expect(source.unsubscriptions()).toBe(1);

    // The default source is node:diagnostics_channel itself.
    expect(diagnostics_channel.hasSubscribers(REQUEST_START_CHANNEL)).toBe(false);
    const real = trackRequests();
    expect(diagnostics_channel.hasSubscribers(REQUEST_START_CHANNEL)).toBe(true);
    real.stop();
    expect(diagnostics_channel.hasSubscribers(REQUEST_START_CHANNEL)).toBe(false);
  });

  test("tracks each server once and each response until its close, a finished or an aborted one alike", () => {
    const { source, drain } = tracker();
    const server = standInServer();
    const finished = standInResponse();
    const aborted = standInResponse();
    const open = standInResponse();

    source.publish(requestStart(server, finished));
    source.publish(requestStart(server, aborted));
    source.publish(requestStart(server, open));
    expect(drain.tracked()).toEqual({ servers: 1, inFlight: 3 });

    finished.end();
    aborted.abort();
    expect(drain.tracked()).toEqual({ servers: 1, inFlight: 1 });
    expect(server.calls).toEqual([]);
  });

  test("at the drain it closes every server it has seen to new connections, and answers how many", async () => {
    const { source, drain } = tracker();
    const first = standInServer();
    const second = standInServer();
    const unseen = standInServer();
    const a = standInResponse();
    const b = standInResponse();
    source.publish(requestStart(first, a));
    source.publish(requestStart(second, b));
    a.end();
    b.end();

    const outcome = await drain.drain();

    expect(outcome).toEqual({ servers: 2, cut: 0 });
    expect(first.calls).toEqual(["close"]);
    expect(second.calls).toEqual(["close"]);
    expect(unseen.calls).toEqual([]);
  });

  test("it answers once the last response in flight has closed, with no cut", async () => {
    const { source, drain } = tracker();
    const server = standInServer();
    const first = standInResponse();
    const last = standInResponse();
    source.publish(requestStart(server, first));
    source.publish(requestStart(server, last));
    let answered = false;

    const run = drain.drain().then((outcome) => {
      answered = true;
      return outcome;
    });
    await settle();
    expect(answered).toBe(false);
    first.end();
    await settle();
    expect(answered).toBe(false);
    last.end();

    expect(await run).toEqual({ servers: 1, cut: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a response that closes during the drain closes its server's idle connections, so a kept-alive connection ends with its answer", async () => {
    const { source, drain } = tracker();
    const busy = standInServer();
    const quiet = standInServer();
    const response = standInResponse();
    const before = standInResponse();
    source.publish(requestStart(quiet, before));
    before.end();
    source.publish(requestStart(busy, response));

    const run = drain.drain();
    expect(busy.calls).toEqual(["close"]);
    response.end();

    expect(await run).toEqual({ servers: 2, cut: 0 });
    expect(busy.calls).toEqual(["close", "closeIdleConnections"]);
    // A response that closed before the drain closed no idle connections.
    expect(quiet.calls).toEqual(["close"]);
  });

  test("a request that starts during the drain is waited for too", async () => {
    const { source, drain } = tracker();
    const server = standInServer();
    const first = standInResponse();
    const late = standInResponse();
    source.publish(requestStart(server, first));
    let answered = false;

    const run = drain.drain().then((outcome) => {
      answered = true;
      return outcome;
    });
    // A request on a connection already open, which the server's close does not refuse.
    source.publish(requestStart(server, late));
    first.end();
    await settle();
    expect(answered).toBe(false);
    expect(drain.tracked()).toEqual({ servers: 1, inFlight: 1 });
    late.end();

    expect(await run).toEqual({ servers: 1, cut: 0 });
    expect(server.calls).toEqual(["close", "closeIdleConnections", "closeIdleConnections"]);
  });

  test("with no response in flight it answers at once", async () => {
    const { drain } = tracker();
    jest.useFakeTimers();

    expect(await drain.drain()).toEqual({ servers: 0, cut: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a response still open after 5 s is cut: the drain answers the count and warns with it", async () => {
    const { source, drain } = tracker();
    const server = standInServer();
    source.publish(requestStart(server, standInResponse()));
    source.publish(requestStart(server, standInResponse()));
    jest.useFakeTimers();
    let answered = false;

    const run = drain.drain().then((outcome) => {
      answered = true;
      return outcome;
    });
    jest.advanceTimersByTime(DRAIN_DEADLINE_MS - 1);
    await settle();
    expect(answered).toBe(false);
    jest.advanceTimersByTime(1);
    const outcome = await run;

    expect(DRAIN_DEADLINE_MS).toBe(5000);
    expect(outcome).toEqual({ servers: 1, cut: 2 });
    expect(logger.warn).toHaveBeenCalledWith("Requests in flight cut at the drain deadline", {
      route: "shutdown",
      pending: 2,
    });
  });

  test("the drain runs once: a second call answers the first run", async () => {
    const { source, drain } = tracker();
    const server = standInServer();
    const response = standInResponse();
    source.publish(requestStart(server, response));

    const first = drain.drain();
    const second = drain.drain();
    response.end();

    expect(second).toBe(first);
    expect(await second).toEqual({ servers: 1, cut: 0 });
    expect(server.calls).toEqual(["close", "closeIdleConnections"]);
  });

  test("a message without the server or the response it uses throws an error naming the channel", () => {
    const { source } = tracker();
    const server = standInServer();
    const response = standInResponse();

    for (const message of [
      undefined,
      "not a message",
      {},
      { server, response: {} },
      { server: {}, response },
      { server: { close() {} }, response },
      { response },
      { server },
    ]) {
      expect(() => source.publish(message)).toThrow(
        "A message on http.server.request.start has no server with close() and closeIdleConnections() or no response with once(): the experimental channel changed in this Node.js release (src/lib/shutdown-drain.ts)",
      );
    }
  });
});
