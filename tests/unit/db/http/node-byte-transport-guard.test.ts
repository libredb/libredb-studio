/**
 * The egress guard on the byte transport, unmocked (byte transport design 3.9), as node-transport-guard.test.ts runs
 * it on the text transport: with DB_HTTP_BLOCK_PRIVATE_HOSTS on, the guard runs first, so its sentence wins and its
 * lookup, whose blocked list holds every link-local network, goes on the Agent; with it off, loopback is reachable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { httpOrigin } from "@/lib/db/http/endpoint";
import { createNodeByteTransport, type NodeByteTransport } from "@/lib/db/http/node-transport";
import { closeAll, rawAnswer, rawHttpListener } from "../../../helpers/node-transport-fixtures";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];
const BLOCKED = "Invalid host: this HTTP database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS";
const transports: NodeByteTransport[] = [];
const OK = (): Buffer => rawAnswer("200 OK", ["content-length: 2"], "ok");

afterEach(async () => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
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

describe("with the guard on", () => {
  test("localhost is refused by the guard's lookup on the Agent with the guard's sentence, and nothing is accepted", async () => {
    const listener = await rawHttpListener(OK);
    process.env[FLAG] = "true";
    const transport = createNodeByteTransport({
      origin: httpOrigin("http", "localhost", listener.port),
      tls: null,
      maxSockets: 4,
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
    process.env[FLAG] = "true";
    let error: Error | undefined;
    try {
      createNodeByteTransport({
        origin: { scheme: "http", host: "169.254.169.254", port: 80 },
        tls: null,
        maxSockets: 1,
        headers: {},
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toBe(BLOCKED);
  });
});

describe("with the guard off", () => {
  test("127.0.0.1 reaches the listener, the control for the refusals above", async () => {
    delete process.env[FLAG];
    const listener = await rawHttpListener(OK);
    const transport = createNodeByteTransport({
      origin: httpOrigin("http", "127.0.0.1", listener.port),
      tls: null,
      maxSockets: 4,
      headers: {},
    });
    transports.push(transport);
    expect((await send(transport)).bytes.toString()).toBe("ok");
    expect(listener.accepted()).toBe(1);
  });
});
