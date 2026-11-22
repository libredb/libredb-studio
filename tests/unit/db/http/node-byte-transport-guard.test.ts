/**
 * The egress guard on the byte transport, unmocked (byte transport design 3.9), as node-transport-guard.test.ts runs
 * it on the text transport: the transport decides by the egress decision it is handed in its options' `egress` and
 * reads no setting. With a blocking decision the guard runs first, so its sentence wins and its lookup, whose blocked
 * list holds every link-local network, goes on the Agent; with an allowing one, loopback is reachable. Built without a
 * decision, the transport refuses by name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST as BLOCKED, EGRESS_DECISION_MISSING } from "@/lib/db/http/egress-policy";
import { httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeByteTransport,
  type NodeByteTransport,
  type NodeByteTransportOptions,
} from "@/lib/db/http/node-transport";
import { closeAll, rawAnswer, rawHttpListener } from "../../../helpers/node-transport-fixtures";
import { setEgressFlag } from "../../../helpers/egress-flag";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];
const transports: NodeByteTransport[] = [];
const OK = (): Buffer => rawAnswer("200 OK", ["content-length: 2"], "ok");

afterEach(async () => {
  setEgressFlag(original);
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function send(transport: NodeByteTransport) {
  return transport.request({
    method: "GET",
    target: { path: "/b/k", query: "" },
    signal: AbortSignal.timeout(5000),
    maxResponseBytes: 1024,
  });
}

function refusal(run: () => unknown): Error | undefined {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

describe("built without an egress decision", () => {
  test("a byte transport built without an egress decision refuses by name, before any Agent is built", () => {
    setEgressFlag(undefined);
    // A JavaScript caller, or a cast: the type asks for the decision.
    const options = {
      origin: httpOrigin("http", "db.example.com", 9000, ALLOWS_PRIVATE_HOSTS),
      tls: null,
      maxSockets: 4,
      headers: {},
    } as unknown as NodeByteTransportOptions;
    const error = refusal(() => createNodeByteTransport(options));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error?.message).toBe(EGRESS_DECISION_MISSING);
  });
});

describe("handed a blocking decision", () => {
  test("127.0.0.1 is refused when a byte transport handed a blocking decision is built, before any socket, while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset", async () => {
    setEgressFlag(undefined);
    const listener = await rawHttpListener(OK);
    const error = refusal(() =>
      createNodeByteTransport({
        origin: httpOrigin("http", "127.0.0.1", listener.port, ALLOWS_PRIVATE_HOSTS),
        tls: null,
        maxSockets: 4,
        egress: BLOCKS_PRIVATE_HOSTS,
        headers: {},
      }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error?.message).toBe(BLOCKED);
    expect(listener.accepted()).toBe(0);
  });

  test("localhost is refused by the guard's lookup on the Agent of a byte transport handed a blocking decision, with the guard's sentence, and nothing is accepted", async () => {
    setEgressFlag(undefined);
    const listener = await rawHttpListener(OK);
    const transport = createNodeByteTransport({
      origin: httpOrigin("http", "localhost", listener.port, ALLOWS_PRIVATE_HOSTS),
      tls: null,
      maxSockets: 4,
      egress: BLOCKS_PRIVATE_HOSTS,
      headers: {},
    });
    transports.push(transport);
    let error: Error | undefined;
    try {
      await send(transport);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error?.message).toBe(BLOCKED);
    expect(listener.accepted()).toBe(0);
  });

  test("a link-local literal gets the guard's sentence, because the guard runs first", () => {
    setEgressFlag(undefined);
    const error = refusal(() =>
      createNodeByteTransport({
        origin: { scheme: "http", host: "169.254.169.254", port: 80 },
        tls: null,
        maxSockets: 1,
        egress: BLOCKS_PRIVATE_HOSTS,
        headers: {},
      }),
    );
    expect(error?.message).toBe(BLOCKED);
  });
});

describe("handed an allowing decision", () => {
  test("127.0.0.1 reaches the listener for a byte transport handed an allowing decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is true", async () => {
    setEgressFlag("true");
    const listener = await rawHttpListener(OK);
    const transport = createNodeByteTransport({
      origin: httpOrigin("http", "127.0.0.1", listener.port, ALLOWS_PRIVATE_HOSTS),
      tls: null,
      maxSockets: 4,
      egress: ALLOWS_PRIVATE_HOSTS,
      headers: {},
    });
    transports.push(transport);
    expect((await send(transport)).bytes.toString()).toBe("ok");
    expect(listener.accepted()).toBe(1);
  });
});
