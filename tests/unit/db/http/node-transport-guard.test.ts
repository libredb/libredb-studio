/**
 * The egress guard on the shared REST transport, unmocked (vector-family spec 3.7, R44 QM1).
 *
 * With DB_HTTP_BLOCK_PRIVATE_HOSTS on, an IP literal is refused when the transport is built, before any socket, because
 * a literal never reaches a lookup; a name is refused by the guard's lookup, which runs on the connection's own Agent.
 * The listeners count what reaches them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport } from "@/lib/db/http/node-transport";
import { closeAll, httpListener, jsonAnswer } from "../../../helpers/node-transport-fixtures";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];
const BLOCKED = "Invalid host: this HTTP database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS";
const transports: NodeTransport[] = [];

afterEach(async () => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("with the guard on", () => {
  test("127.0.0.1 is refused when the transport is built, before any socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    // Built while the guard is off: httpOrigin runs the literal check too, and this test is the transport's own.
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    process.env[FLAG] = "true";
    const error = refusal(() => createNodeTransport({ origin, tls: null, maxSockets: 4, headers: {} }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(BLOCKED);
    expect(listener.accepted()).toBe(0);
  });

  test.each(["[::1]", "10.0.0.5", "169.254.169.254"])("%s is refused the same way", (host) => {
    const origin = httpOrigin("http", host, 6333);
    process.env[FLAG] = "true";
    const error = refusal(() => createNodeTransport({ origin, tls: null, maxSockets: 4, headers: {} }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(BLOCKED);
  });

  test("a name that resolves to loopback is refused by the guard's lookup on the Agent, with the guard's own error", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    process.env[FLAG] = "true";
    const origin = httpOrigin("http", "localhost", listener.port);
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 4,
      headers: { "api-key": "guard-secret-key" },
    });
    transports.push(transport);
    let error: Error | undefined;
    try {
      await transport.request({
        method: "GET",
        url: endpointUrl(origin, "/"),
        signal: AbortSignal.timeout(5000),
        maxResponseBytes: 1024,
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error?.message).toBe(BLOCKED);
    expect(listener.accepted()).toBe(0);
  });

  test("an unreadable flag fails closed when the transport is built", () => {
    const origin = httpOrigin("http", "db.example.com", 6333);
    process.env[FLAG] = "sometimes";
    const error = refusal(() => createNodeTransport({ origin, tls: null, maxSockets: 4, headers: {} }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid DB_HTTP_BLOCK_PRIVATE_HOSTS: expected true or false");
  });
});

describe("with the guard off", () => {
  test("127.0.0.1 reaches the listener, the control for the refusals above", async () => {
    delete process.env[FLAG];
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const transport = createNodeTransport({ origin, tls: null, maxSockets: 4, headers: {} });
    transports.push(transport);
    const answer = await transport.request({
      method: "GET",
      url: endpointUrl(origin, "/"),
      signal: AbortSignal.timeout(5000),
      maxResponseBytes: 1024,
    });
    expect(answer.status).toBe(200);
    expect(listener.accepted()).toBe(1);
  });
});
