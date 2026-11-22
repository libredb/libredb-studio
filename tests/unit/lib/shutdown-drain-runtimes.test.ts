/**
 * The watch on node:diagnostics_channel's `http.server.request.start` channel, which the request drain
 * (src/lib/shutdown-drain.ts) reads and which Node.js 24 and 26 document as Stability 1 Experimental.
 *
 * It runs one Node child per binary that NODE_TRANSPORT_NODES lists (or the node on PATH), so the required
 * "Unit & Integration Tests" job runs it on Node 24 in the suite and once more on the Node release the images' runner
 * stage names (tests/unit/ci-image-node.test.ts). A release that changes the channel's shape, renames it or stops
 * publishing on it fails here by the channel's name, on the pull request that brings that release.
 *
 * Each child runs a bundle of the real drain module and starts a plain node:http server on 127.0.0.1. It records every
 * message the channel publishes with a raw subscriber of its own, and drives the real `trackRequests()` through a
 * request the client aborts and through a drain with a request in flight on a kept-alive connection. On a second
 * server it drives a drain over two raw connections whose next request has begun, which Node.js does not count as
 * idle: one pipelines the first byte of its next request behind the answer in flight, the other has sent part of a
 * request's headers. On a third server it drives one drain over four raw connections: two complete requests pipelined
 * behind no answer yet, a request pipelined behind an answer in flight once the drain has begun, a request pipelined
 * behind an answer that went out with the drain's Connection: close, which Node.js never answers, and a kept-alive
 * connection whose answer's headers went out before the drain, which only `closeIdleConnections()` ends. A write is
 * known to have reached the server when the server's side of the connection has read it (`bytesRead`).
 *
 * No Bun child: Bun's node:http publishes nothing on the channel (measured on Bun 1.4.4, none of four requests), so
 * the drain has nothing to watch there, and `exitOwnerAtBoot()` in src/lib/shutdown-handler.ts refuses Studio's exit
 * on Bun (tests/unit/lib/shutdown-handler.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type diagnosticsChannel from "node:diagnostics_channel";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type httpModule from "node:http";
import type netModule from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { trackRequests } from "@/lib/shutdown-drain";

const DRAIN = join(import.meta.dir, "..", "..", "..", "src", "lib", "shutdown-drain.ts");

interface Shape {
  readonly keys: string[];
  readonly request: boolean;
  readonly response: boolean;
  readonly socket: boolean;
  readonly server: boolean;
  readonly serverIsTheListeningOne: boolean;
  readonly url?: string;
}

interface Answer {
  readonly ok: boolean;
  readonly status?: number;
  readonly code?: string;
}

interface Report {
  readonly runtime: string;
  readonly shapes: Shape[];
  readonly abort: { readonly inFlightWhileOpen: number; readonly inFlightAfterAbort: number };
  readonly drain: {
    readonly trackedAtDrain: { servers: number; inFlight: number };
    readonly fresh: Answer;
    readonly held: Answer;
    readonly outcome: { servers: number; cut: number };
    readonly afterOnKeptAlive: Answer;
    readonly serverClosed: boolean;
    readonly messagesAfterDrain: number;
  };
  readonly begun: {
    readonly outcome: { servers: number; cut: number };
    readonly pipelined: Wire;
    readonly partial: Wire;
    readonly servedAfterDrain: string[];
  };
  readonly pipeline: {
    readonly outcome: { servers: number; cut: number };
    readonly unanswered: number;
    readonly queuedEndedAtDrain: boolean;
    readonly queued: Wire;
    readonly late: Wire;
    readonly sent: Wire;
    readonly flushed: Wire;
    readonly servedAfterDrain: string[];
  };
}

/** What a raw client connection received: the status lines and Connection headers of its answers, and whether it ended. */
interface Wire {
  readonly statuses: string[];
  readonly connection: string[];
  readonly ended: boolean;
}

/**
 * Runs every case in turn. SELF-CONTAINED ON PURPOSE: each child runs this function's own text, so it names nothing
 * but its parameters and the runtime's globals.
 */
async function runCases(
  track: typeof trackRequests,
  channels: typeof diagnosticsChannel,
  http: typeof httpModule,
  net: typeof netModule,
  channel: string,
): Promise<Report> {
  const shapes: Shape[] = [];
  const record = (message: unknown) => {
    const fields = (message ?? {}) as Record<string, unknown>;
    shapes.push({
      keys: Object.keys(fields).sort(),
      request: fields.request instanceof http.IncomingMessage,
      response: fields.response instanceof http.ServerResponse,
      socket: fields.socket instanceof net.Socket,
      server: fields.server instanceof http.Server,
      // The server is created below, before any request can reach this subscriber.
      serverIsTheListeningOne: fields.server === listening,
      url: (fields.request as { url?: string } | undefined)?.url,
    });
  };
  channels.subscribe(channel, record);
  const drain = track();

  // Settles once the server's handler has the request for the path.
  const waiting = new Map<string, () => void>();
  const arrival = (path: string) => new Promise<void>((resolve) => waiting.set(path, resolve));
  let release: () => void = () => {};
  const listening = http.createServer((request, response) => {
    waiting.get(request.url ?? "")?.();
    if (request.url === "/held") {
      release = () => response.end("held");
      return;
    }
    if (request.url === "/hang") return;
    response.end("fast");
  });
  const closed = new Promise<boolean>((resolve) => listening.once("close", () => resolve(true)));
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", () => resolve()));
  const port = (listening.address() as { port: number }).port;

  const get = (
    path: string,
    agent: httpModule.Agent | false,
    onRequest?: (request: httpModule.ClientRequest) => void,
  ) =>
    new Promise<Answer>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path, agent }, (response) => {
        response.resume();
        response.on("end", () => resolve({ ok: true, status: response.statusCode }));
      });
      request.on("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, code: error.code }));
      onRequest?.(request);
    });

  // A request the client aborts once the server has it: its response closes, so the drain stops counting it.
  const hangArrived = arrival("/hang");
  let hangRequest: httpModule.ClientRequest | undefined;
  const hang = get("/hang", false, (request) => {
    hangRequest = request;
  });
  await hangArrived;
  const inFlightWhileOpen = drain.tracked().inFlight;
  hangRequest?.destroy();
  await hang;
  for (let turn = 0; turn < 100 && drain.tracked().inFlight > 0; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const inFlightAfterAbort = drain.tracked().inFlight;

  // A kept-alive connection with one request answered, then a request held in flight across the drain.
  const keptAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await get("/fast", keptAlive);
  const heldArrived = arrival("/held");
  const held = get("/held", keptAlive);
  await heldArrived;
  const trackedAtDrain = drain.tracked();
  const shapesBeforeDrain = shapes.length;
  const drained = drain.drain();
  const fresh = await get("/fast", false);
  release();
  const heldAnswer = await held;
  const outcome = await drained;
  const afterOnKeptAlive = await get("/fast", keptAlive);
  // The server's close callback fires once its last connection has ended.
  const serverClosed = await Promise.race([
    closed,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  keptAlive.destroy();
  drain.stop();
  const messagesAfterDrain = shapes.length - shapesBeforeDrain;
  channels.unsubscribe(channel, record);

  // Two kept-alive connections whose next request has begun at the drain on a fresh server: one pipelines the first
  // byte of its next request behind an answer held in flight, the other has sent only part of a request's headers.
  const second = track();
  let drainedAt = false;
  const servedAfterDrain: string[] = [];
  let releaseSecond: () => void = () => {};
  const secondArrived = new Map<string, () => void>();
  const secondServer = http.createServer((request, response) => {
    if (drainedAt) servedAfterDrain.push(request.url ?? "");
    secondArrived.get(request.url ?? "")?.();
    if (request.url === "/held") {
      releaseSecond = () => response.end("held");
      return;
    }
    response.end("fast");
  });
  const serverSockets: netModule.Socket[] = [];
  secondServer.on("connection", (socket) => serverSockets.push(socket));
  await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", () => resolve()));
  const secondPort = (secondServer.address() as { port: number }).port;

  // A raw client connection to the server on `port`, whose accepted sockets `accepted` collects.
  const connect = async (port: number, sockets: netModule.Socket[]) => {
    const accepted = sockets.length;
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    let ended = false;
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
    });
    const closed = new Promise<void>((resolve) =>
      socket.on("close", () => {
        ended = true;
        resolve();
      }),
    );
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    while (sockets.length === accepted) await new Promise((resolve) => setImmediate(resolve));
    const server = sockets[accepted] as netModule.Socket;
    // Settles once the server's side of the connection has read `total` bytes: the signal that a write reached it.
    const readBy = async (total: number) => {
      while (server.bytesRead < total && !server.destroyed) await new Promise((resolve) => setImmediate(resolve));
    };
    const answers = () => text.match(/HTTP\/1\.1 \d+/g) ?? [];
    const untilAnswers = async (count: number) => {
      while (answers().length < count && !socket.destroyed) await new Promise((resolve) => setImmediate(resolve));
    };
    let sent = 0;
    const send = async (part: string) => {
      sent += Buffer.byteLength(part, "latin1");
      socket.write(part);
      await readBy(sent);
    };
    const wire = (): Wire => ({
      statuses: answers(),
      connection: (text.match(/^connection: .*$/gim) ?? []).map((line) => line.toLowerCase().trim()),
      ended,
    });
    return { socket, closed, send, untilAnswers, wire };
  };
  const open = () => connect(secondPort, serverSockets);
  const warm = "GET /warm HTTP/1.1\r\nHost: drain\r\n\r\n";

  const pipelined = await open();
  await pipelined.send(warm);
  await pipelined.untilAnswers(1);
  const partial = await open();
  await partial.send(warm);
  await partial.untilAnswers(1);
  const heldOnSecond = new Promise<void>((resolve) => secondArrived.set("/held", resolve));
  await pipelined.send("GET /held HTTP/1.1\r\nHost: drain\r\n\r\n");
  await heldOnSecond;
  await partial.send("GET /partial HTTP/1.1\r\nHost: drain\r\n");

  const secondDrained = second.drain();
  await pipelined.send("G");
  releaseSecond();
  const begunOutcome = await secondDrained;
  drainedAt = true;
  // A connection the server keeps open after its answer would carry the begun request on: complete it and see.
  const ends = (connection: { closed: Promise<void> }) =>
    Promise.race([connection.closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
  await pipelined.untilAnswers(2);
  await ends(pipelined);
  if (!pipelined.wire().ended) {
    await pipelined.send("ET /after HTTP/1.1\r\nHost: drain\r\n\r\n");
    await pipelined.untilAnswers(3);
  }
  await partial.send("\r\n");
  await partial.untilAnswers(2);
  await ends(partial);
  const begun = { pipelined: pipelined.wire(), partial: partial.wire(), servedAfterDrain };
  pipelined.socket.destroy();
  partial.socket.destroy();
  secondServer.close();
  second.stop();

  // Four raw connections across one drain on a third server. `queued` has two complete requests pipelined behind no
  // answer yet, both held in flight. `late` has an answer held in flight, and a complete request pipelined behind it
  // once the drain has begun. `sent` has an answer held in flight whose headers go out during the drain, with the
  // Connection: close the drain gave it, and then a request pipelined behind it, which Node.js dispatches and never
  // answers. `flushed` is kept alive with an answer whose headers went out before the drain and that ends during it.
  const third = track();
  let thirdDrainedAt = false;
  const servedAfterThirdDrain: string[] = [];
  const thirdArrived = new Map<string, () => void>();
  const thirdHeld = new Map<string, httpModule.ServerResponse>();
  const thirdServer = http.createServer((request, response) => {
    const path = request.url ?? "";
    if (thirdDrainedAt) servedAfterThirdDrain.push(path);
    if (path === "/flushed") response.flushHeaders();
    if (["/first", "/queued", "/late", "/sent", "/flushed"].includes(path)) thirdHeld.set(path, response);
    else response.end("fast");
    thirdArrived.get(path)?.();
  });
  const thirdSockets: netModule.Socket[] = [];
  thirdServer.on("connection", (socket) => thirdSockets.push(socket));
  await new Promise<void>((resolve) => thirdServer.listen(0, "127.0.0.1", () => resolve()));
  const thirdPort = (thirdServer.address() as { port: number }).port;
  const reaches = (path: string) => new Promise<void>((resolve) => thirdArrived.set(path, resolve));
  const answer = (path: string) => (thirdHeld.get(path) as httpModule.ServerResponse).end(path);

  const queued = await connect(thirdPort, thirdSockets);
  const bothQueued = Promise.all([reaches("/first"), reaches("/queued")]);
  await queued.send("GET /first HTTP/1.1\r\nHost: drain\r\n\r\nGET /queued HTTP/1.1\r\nHost: drain\r\n\r\n");
  await bothQueued;
  const late = await connect(thirdPort, thirdSockets);
  const lateArrived = reaches("/late");
  await late.send("GET /late HTTP/1.1\r\nHost: drain\r\n\r\n");
  await lateArrived;
  const sent = await connect(thirdPort, thirdSockets);
  const sentArrived = reaches("/sent");
  await sent.send("GET /sent HTTP/1.1\r\nHost: drain\r\n\r\n");
  await sentArrived;
  const flushed = await connect(thirdPort, thirdSockets);
  const flushedArrived = reaches("/flushed");
  await flushed.send("GET /flushed HTTP/1.1\r\nHost: drain\r\n\r\n");
  await flushedArrived;
  await flushed.untilAnswers(1);

  let queuedEndedAtDrain = false;
  const thirdDrained = third.drain().then((outcome) => {
    queuedEndedAtDrain = (thirdHeld.get("/queued") as httpModule.ServerResponse).writableEnded;
    return outcome;
  });
  const lateNextArrived = reaches("/late-next");
  await late.send("GET /late-next HTTP/1.1\r\nHost: drain\r\n\r\n");
  await lateNextArrived;
  answer("/late");
  (thirdHeld.get("/sent") as httpModule.ServerResponse).flushHeaders();
  await sent.untilAnswers(1);
  const behindArrived = reaches("/behind");
  await sent.send("GET /behind HTTP/1.1\r\nHost: drain\r\n\r\n");
  await behindArrived;
  answer("/sent");
  answer("/flushed");
  answer("/first");
  await queued.untilAnswers(1);
  answer("/queued");
  const pipelineOutcome = await thirdDrained;
  thirdDrainedAt = true;
  await Promise.all([queued, late, sent, flushed].map(ends));
  if (!flushed.wire().ended) {
    await flushed.send("GET /after HTTP/1.1\r\nHost: drain\r\n\r\n");
    await flushed.untilAnswers(2);
  }
  const pipeline = {
    outcome: pipelineOutcome,
    unanswered: third.unanswered(),
    queuedEndedAtDrain,
    queued: queued.wire(),
    late: late.wire(),
    sent: sent.wire(),
    flushed: flushed.wire(),
    servedAfterDrain: servedAfterThirdDrain,
  };
  for (const connection of [queued, late, sent, flushed]) connection.socket.destroy();
  thirdServer.close();
  third.stop();

  return {
    runtime: process.version,
    shapes: shapes.slice(0, shapesBeforeDrain),
    abort: { inFlightWhileOpen, inFlightAfterAbort },
    drain: { trackedAtDrain, fresh, held: heldAnswer, outcome, afterOnKeptAlive, serverClosed, messagesAfterDrain },
    begun: { outcome: begunOutcome, ...begun },
    pipeline,
  };
}

function binaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodes = listed === undefined ? [Bun.which("node")] : listed.split(delimiter).filter((entry) => entry !== "");
  if (nodes.length === 0 || nodes.includes(null)) {
    throw new Error("No Node binary: set NODE_TRANSPORT_NODES or put Node 24 or later on PATH");
  }
  return nodes as string[];
}

let dir: string;
const runs: Report[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shutdown-drain-"));
  const at = (file: string) => join(dir, file);
  writeFileSync(
    at("child.ts"),
    [
      'import diagnostics_channel from "node:diagnostics_channel";',
      'import http from "node:http";',
      'import net from "node:net";',
      `import { REQUEST_START_CHANNEL, trackRequests } from ${JSON.stringify(DRAIN)};`,
      `const runCases = ${runCases.toString()};`,
      "const report = await runCases(trackRequests, diagnostics_channel, http, net, REQUEST_START_CHANNEL);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
  for (const binary of binaries()) {
    const child = Bun.spawn([binary, at("child.js")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`The child ${binary} exited ${exitCode}: ${stderr}`);
    runs.push(JSON.parse(stdout.trim().split("\n").at(-1) as string) as Report);
  }
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the request drain on every listed Node", () => {
  test("a Node child ran for every listed binary, each one Node 24 or 26", () => {
    expect(runs.length).toBe(binaries().length);
    for (const run of runs) expect(["24", "26"]).toContain(run.runtime.slice(1).split(".")[0]);
  });

  test("node:diagnostics_channel's experimental http.server.request.start channel delivers request, response, socket and server, the server being the one that received the request, on every listed Node", () => {
    for (const { runtime, shapes } of runs) {
      const expected = (url: string): Shape => ({
        keys: ["request", "response", "server", "socket"],
        request: true,
        response: true,
        socket: true,
        server: true,
        serverIsTheListeningOne: true,
        url,
      });
      expect({ runtime, shapes }).toEqual({ runtime, shapes: ["/hang", "/fast", "/held"].map(expected) });
    }
  });

  test("on every listed Node the drain closes the server to new connections, answers the request in flight, ends its kept-alive connection with that answer, and reports one server and no cut", () => {
    for (const { runtime, drain } of runs) {
      expect({ runtime, drain }).toMatchObject({
        runtime,
        drain: {
          trackedAtDrain: { servers: 1, inFlight: 1 },
          fresh: { ok: false, code: "ECONNREFUSED" },
          held: { ok: true, status: 200 },
          outcome: { servers: 1, cut: 0 },
          afterOnKeptAlive: { ok: false },
          serverClosed: true,
          messagesAfterDrain: 0,
        },
      });
    }
  });

  test("on every listed Node a connection whose next request has begun at the drain serves at most that request, answered with Connection: close, and then ends", () => {
    for (const { runtime, begun } of runs) {
      expect({ runtime, begun }).toEqual({
        runtime,
        begun: {
          outcome: { servers: 1, cut: 0 },
          // The first byte of the next request was pipelined behind the answer in flight: that answer closes it.
          pipelined: {
            statuses: ["HTTP/1.1 200", "HTTP/1.1 200"],
            connection: ["connection: keep-alive", "connection: close"],
            ended: true,
          },
          // Only part of a request's headers had arrived, so the connection was not idle: the request is served after
          // the drain, once, with Connection: close.
          partial: {
            statuses: ["HTTP/1.1 200", "HTTP/1.1 200"],
            connection: ["connection: keep-alive", "connection: close"],
            ended: true,
          },
          servedAfterDrain: ["/partial"],
        },
      });
    }
  });

  test("on every listed Node the drain answers every request pipelined behind an answer in flight and waits for each, ends a kept-alive connection whose answer's headers went out before it with that answer, and a request pipelined behind an answer that went out with Connection: close is never answered", () => {
    for (const { runtime, pipeline } of runs) {
      expect({ runtime, pipeline }).toEqual({
        runtime,
        pipeline: {
          outcome: { servers: 1, cut: 0 },
          // The request behind the answer that went out with Connection: close.
          unanswered: 1,
          // The drain settled only once the handler had answered the queued request.
          queuedEndedAtDrain: true,
          // Only the newest request on the connection carries Connection: close, so the one before it keeps the
          // connection for it.
          queued: {
            statuses: ["HTTP/1.1 200", "HTTP/1.1 200"],
            connection: ["connection: keep-alive", "connection: close"],
            ended: true,
          },
          // The request pipelined during the drain took Connection: close from the answer before it, which then went
          // out with no Connection header, so the HTTP/1.1 connection persisted for the request behind it.
          late: {
            statuses: ["HTTP/1.1 200", "HTTP/1.1 200"],
            connection: ["connection: close"],
            ended: true,
          },
          // Node.js ends the connection after the answer that went out with Connection: close, so the request behind
          // it reaches its handler but gets no answer.
          sent: { statuses: ["HTTP/1.1 200"], connection: ["connection: close"], ended: true },
          // The answer's headers went out keep-alive before the drain; its server closes the idle connection after it.
          flushed: { statuses: ["HTTP/1.1 200"], connection: ["connection: keep-alive"], ended: true },
          servedAfterDrain: [],
        },
      });
    }
  });

  test("on every listed Node a request the client aborts closes its response, so the drain does not wait for it", () => {
    for (const { runtime, abort } of runs) {
      expect({ runtime, abort }).toEqual({ runtime, abort: { inFlightWhileOpen: 1, inFlightAfterAbort: 0 } });
    }
  });
});
